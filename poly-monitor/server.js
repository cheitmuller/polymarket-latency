const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// State
let state = {
  binancePrice: null,
  binancePriceHistory: [],
  polymarketUp: null,
  polymarketDown: null,
  polymarketLiquidityUp: 0,
  polymarketLiquidityDown: 0,
  marketEndTime: null,
  marketSlug: null,
  latencyEvents: [],
  lastBinanceUpdate: null,
  lastPolymarketUpdate: null
};

// Current market tracking for 15-minute market transitions
let currentMarket = {
  slug: null,
  tokenIds: [],
  endTime: null,
  isStale: false,
  closed: false,
  acceptingOrders: true
};

// Track price for movement detection - multiple thresholds
const THRESHOLDS = [
  { name: '0.05%', value: 0.0005, color: '#888' },
  { name: '0.10%', value: 0.0010, color: '#ffaa00' },
  { name: '0.15%', value: 0.0015, color: '#ff4444' }
];
const CHECKPOINT_RESET_MS = 5000; // Reset checkpoint every 5 seconds

// Track separately for each threshold
let thresholdTrackers = THRESHOLDS.map(t => ({
  ...t,
  checkpoint: null,
  checkpointTime: null,
  triggered: false // Prevent multiple triggers in same window
}));

// Binance WebSocket for BTC/USDT
function connectBinance() {
  const binanceWs = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@trade');

  binanceWs.on('open', () => {
    console.log('Connected to Binance WebSocket');
  });

  binanceWs.on('message', (data) => {
    try {
      const trade = JSON.parse(data);
      const price = parseFloat(trade.p);
      const now = Date.now();

      state.binancePrice = price;
      state.lastBinanceUpdate = now;

      // Store price history for 1m/5m calculations
      state.binancePriceHistory.push({ price, time: now });
      // Keep only last 5 minutes of data
      const fiveMinAgo = now - 5 * 60 * 1000;
      state.binancePriceHistory = state.binancePriceHistory.filter(p => p.time > fiveMinAgo);

      // Latency detection logic - check all thresholds
      for (let tracker of thresholdTrackers) {
        if (tracker.checkpoint === null) {
          tracker.checkpoint = price;
          tracker.checkpointTime = now;
          tracker.triggered = false;
        } else {
          // Reset checkpoint periodically
          if (now - tracker.checkpointTime > CHECKPOINT_RESET_MS) {
            tracker.checkpoint = price;
            tracker.checkpointTime = now;
            tracker.triggered = false;
          } else if (!tracker.triggered) {
            // Check for significant move (only if not already triggered in this window)
            const move = (price - tracker.checkpoint) / tracker.checkpoint;
            if (Math.abs(move) >= tracker.value) {
              // Log latency event with samples array for tracking reaction time
              const event = {
                time: new Date().toISOString(),
                threshold: tracker.name,
                thresholdColor: tracker.color,
                binancePrice: price,
                binanceMove: (move * 100).toFixed(3) + '%',
                polyUp: state.polymarketUp,
                polyDown: state.polymarketDown,
                polyLiqUp: state.polymarketLiquidityUp,
                polyLiqDown: state.polymarketLiquidityDown,
                samples: [{
                  offset: 'T+0',
                  polyUp: state.polymarketUp,
                  polyDown: state.polymarketDown
                }]
              };
              state.latencyEvents.unshift(event);
              // Keep only last 50 events (reduced since each has more data now)
              if (state.latencyEvents.length > 50) {
                state.latencyEvents = state.latencyEvents.slice(0, 50);
              }
              console.log(`Latency event [${tracker.name}]:`, {
                time: event.time,
                threshold: event.threshold,
                binanceMove: event.binanceMove,
                polyUp: event.polyUp,
                polyDown: event.polyDown
              });
              tracker.triggered = true; // Prevent re-triggering until reset

              // Start async sampling (don't await - let it run in background)
              startLatencySampling(event);
            }
          }
        }
      }
    } catch (e) {
      console.error('Binance parse error:', e);
    }
  });

  binanceWs.on('error', (err) => {
    console.error('Binance WebSocket error:', err);
  });

  binanceWs.on('close', () => {
    console.log('Binance WebSocket closed, reconnecting in 3s...');
    setTimeout(connectBinance, 3000);
  });
}

// Check if current market data indicates a resolved/stale market
function isMarketStale() {
  // No data yet
  if (state.polymarketUp === null || state.polymarketDown === null) return true;

  // Both at extreme LOW values = resolved (both sides worthless after resolution)
  if (state.polymarketUp <= 0.03 && state.polymarketDown <= 0.03) return true;

  // One side at extreme HIGH, other at extreme LOW = resolved (one side won)
  // e.g., UP=0.99/DOWN=0.01 or UP=0.999/DOWN=0
  if ((state.polymarketUp >= 0.97 && state.polymarketDown <= 0.03) ||
      (state.polymarketDown >= 0.97 && state.polymarketUp <= 0.03)) {
    return true;
  }

  // Sum should be close to 1.0 for active market
  // Resolved markets often show sum way off (like 0.02 or 1.98)
  const sum = state.polymarketUp + state.polymarketDown;
  if (sum < 0.85 || sum > 1.15) return true;

  // Check if market end time has passed
  if (state.marketEndTime && Date.now() > state.marketEndTime) {
    return true;
  }

  // Check if market is explicitly closed
  if (currentMarket.closed || !currentMarket.acceptingOrders) return true;

  return false;
}

// Generate slug for a specific 15-minute window (uses UTC)
// Note: Polymarket slugs use the START time of the window, not the end
function generateSlugForTime(targetTime) {
  const minutes = targetTime.getUTCMinutes();
  // Calculate the start of the current 15-minute window
  const windowStart = Math.floor(minutes / 15) * 15;

  const startTime = new Date(targetTime);
  startTime.setUTCMinutes(windowStart, 0, 0);

  // End time is 15 minutes after start
  const endTime = new Date(startTime.getTime() + 15 * 60 * 1000);

  const startUnix = Math.floor(startTime.getTime() / 1000);
  return {
    slug: `btc-updown-15m-${startUnix}`,
    endTime: endTime.getTime()
  };
}

// Find current 15-minute market (legacy function for backward compatibility)
function getCurrentMarketSlug() {
  const now = new Date();
  const { slug, endTime } = generateSlugForTime(now);
  state.marketEndTime = endTime;
  return slug;
}

// Get best bid price from order book (highest price someone will pay)
// Note: Polymarket CLOB returns bids sorted ascending by price, so best bid is LAST
function getBestBidPrice(book) {
  if (!book.bids || book.bids.length === 0) return 0;
  // Best bid is the highest price = last element in ascending-sorted array
  return parseFloat(book.bids[book.bids.length - 1].price);
}

// Get total bid liquidity from order book
function getTotalBidLiquidity(book) {
  if (!book.bids || book.bids.length === 0) return 0;
  return book.bids.reduce((sum, b) => sum + parseFloat(b.size), 0);
}

// Fetch current Polymarket prices directly from CLOB
async function fetchPolymarketPrices() {
  const tokens = currentMarket.tokenIds;
  if (!tokens || tokens.length < 2) {
    return { up: state.polymarketUp, down: state.polymarketDown };
  }

  try {
    const [upBookRes, downBookRes] = await Promise.all([
      fetch(`https://clob.polymarket.com/book?token_id=${tokens[0]}`),
      fetch(`https://clob.polymarket.com/book?token_id=${tokens[1]}`)
    ]);

    const upBook = await upBookRes.json();
    const downBook = await downBookRes.json();

    return {
      up: getBestBidPrice(upBook),
      down: getBestBidPrice(downBook)
    };
  } catch (e) {
    console.error('Error fetching Polymarket prices:', e.message);
    return { up: state.polymarketUp, down: state.polymarketDown };
  }
}

// Start sampling Polymarket after a latency event trigger
async function startLatencySampling(event) {
  const SAMPLE_INTERVAL_MS = 2000;
  const SAMPLE_DURATION_MS = 20000;
  const numSamples = SAMPLE_DURATION_MS / SAMPLE_INTERVAL_MS; // 10 more samples after T+0

  // T+0 is already captured in the event
  console.log(`[LATENCY SAMPLING] Starting 20s sampling for ${event.threshold} event`);

  for (let i = 1; i <= numSamples; i++) {
    await new Promise(resolve => setTimeout(resolve, SAMPLE_INTERVAL_MS));

    const prices = await fetchPolymarketPrices();
    const offsetSec = i * 2;
    const sample = {
      offset: `T+${offsetSec}`,
      polyUp: prices.up,
      polyDown: prices.down
    };

    event.samples.push(sample);
    console.log(`[LATENCY SAMPLE] ${event.threshold} ${sample.offset}: UP=${prices.up} DOWN=${prices.down}`);
  }

  console.log(`[LATENCY SAMPLING] Completed for ${event.threshold} event`);
}

// Check if order book shows a healthy active market
async function isOrderBookActive(tokens) {
  if (!tokens || tokens.length < 2) return false;

  try {
    const [upBookRes, downBookRes] = await Promise.all([
      fetch(`https://clob.polymarket.com/book?token_id=${tokens[0]}`),
      fetch(`https://clob.polymarket.com/book?token_id=${tokens[1]}`)
    ]);

    const upBook = await upBookRes.json();
    const downBook = await downBookRes.json();

    const upPrice = getBestBidPrice(upBook);
    const downPrice = getBestBidPrice(downBook);

    // Check if prices indicate an active market
    // Both at extreme LOW = stale (resolved)
    if (upPrice <= 0.03 && downPrice <= 0.03) return false;

    // Sum should be close to 1.0
    const sum = upPrice + downPrice;
    if (sum < 0.85 || sum > 1.15) return false;

    return true;
  } catch (e) {
    console.error('Error checking order book:', e.message);
    return false;
  }
}

// Find an active market by trying different time windows
async function findActiveMarket() {
  const now = new Date();
  const candidates = [];

  // Generate slugs for current window first (most likely), then next, then previous
  for (let offsetMinutes = 0; offsetMinutes <= 30; offsetMinutes += 15) {
    const targetTime = new Date(now.getTime() + offsetMinutes * 60 * 1000);
    const { slug, endTime } = generateSlugForTime(targetTime);
    candidates.push({ slug, endTime });
  }

  // Try previous window last (least likely to be active)
  const prevTime = new Date(now.getTime() - 15 * 60 * 1000);
  const { slug: prevSlug, endTime: prevEndTime } = generateSlugForTime(prevTime);
  candidates.push({ slug: prevSlug, endTime: prevEndTime });

  // Try each candidate - check both API status AND order book health
  for (const candidate of candidates) {
    try {
      const marketRes = await fetch(`https://gamma-api.polymarket.com/markets?slug=${candidate.slug}`);
      const markets = await marketRes.json();

      if (markets && markets.length > 0) {
        const market = markets[0];
        const closed = market.closed === true || market.closed === 'true';
        const acceptingOrders = market.acceptingOrders !== false && market.acceptingOrders !== 'false';

        if (!closed && acceptingOrders) {
          const tokens = JSON.parse(market.clobTokenIds || '[]');

          // Also verify order book is healthy (not stale)
          const bookActive = await isOrderBookActive(tokens);
          if (bookActive) {
            console.log(`[MARKET FOUND] ${candidate.slug} is active with healthy order book`);
            return {
              slug: candidate.slug,
              tokenIds: tokens,
              endTime: candidate.endTime,
              closed: closed,
              acceptingOrders: acceptingOrders,
              isStale: false
            };
          } else {
            console.log(`[MARKET SKIP] ${candidate.slug} has stale order book`);
          }
        }
      }
    } catch (e) {
      console.error(`Error checking market ${candidate.slug}:`, e.message);
    }
  }

  // Fallback: query gamma API for recent btc-updown-15m markets
  try {
    const searchRes = await fetch('https://gamma-api.polymarket.com/markets?limit=10&tag=btc-updown-15m&closed=false');
    const searchMarkets = await searchRes.json();

    if (searchMarkets && searchMarkets.length > 0) {
      for (const market of searchMarkets) {
        const closed = market.closed === true || market.closed === 'true';
        const acceptingOrders = market.acceptingOrders !== false && market.acceptingOrders !== 'false';

        if (!closed && acceptingOrders && market.slug && market.slug.startsWith('btc-updown-15m-')) {
          const tokens = JSON.parse(market.clobTokenIds || '[]');

          // Check order book health
          const bookActive = await isOrderBookActive(tokens);
          if (bookActive) {
            // Extract end time from slug
            const endUnixMatch = market.slug.match(/btc-updown-15m-(\d+)/);
            const endTime = endUnixMatch ? parseInt(endUnixMatch[1]) * 1000 : null;

            return {
              slug: market.slug,
              tokenIds: tokens,
              endTime: endTime,
              closed: closed,
              acceptingOrders: acceptingOrders,
              isStale: false
            };
          }
        }
      }
    }
  } catch (e) {
    console.error('Error searching for active markets:', e.message);
  }

  return null;
}

// Poll Polymarket CLOB API
async function pollPolymarket() {
  try {
    // Check if we need to find a new market (stale or no current market)
    const needNewMarket = !currentMarket.slug || isMarketStale();

    if (needNewMarket) {
      const oldSlug = currentMarket.slug;
      const newMarket = await findActiveMarket();

      if (newMarket && newMarket.slug !== currentMarket.slug) {
        console.log(`[MARKET SWITCH] ${oldSlug || 'none'} -> ${newMarket.slug} at ${new Date().toISOString()}`);
        currentMarket = newMarket;
        state.marketSlug = newMarket.slug;
        state.marketEndTime = newMarket.endTime;
      } else if (!newMarket && !currentMarket.slug) {
        // No market found and no current market - use fallback
        const slug = getCurrentMarketSlug();
        state.marketSlug = slug;
        console.log(`[MARKET FALLBACK] Using calculated slug: ${slug}`);
      }
    }

    // Use current market's tokens if available, otherwise fetch from API
    let tokens = currentMarket.tokenIds;

    if (!tokens || tokens.length < 2) {
      const slug = state.marketSlug || getCurrentMarketSlug();
      const marketRes = await fetch(`https://gamma-api.polymarket.com/markets?slug=${slug}`);
      const markets = await marketRes.json();

      if (markets && markets.length > 0) {
        const market = markets[0];
        tokens = JSON.parse(market.clobTokenIds || '[]');
        currentMarket.tokenIds = tokens;

        // Update market state flags
        currentMarket.closed = market.closed === true || market.closed === 'true';
        currentMarket.acceptingOrders = market.acceptingOrders !== false && market.acceptingOrders !== 'false';

        if (currentMarket.closed || !currentMarket.acceptingOrders) {
          console.log(`[MARKET STATUS] ${slug} closed=${currentMarket.closed} acceptingOrders=${currentMarket.acceptingOrders}`);
        }
      }
    }

    if (tokens && tokens.length >= 2) {
      // Fetch order book for both tokens
      const [upBookRes, downBookRes] = await Promise.all([
        fetch(`https://clob.polymarket.com/book?token_id=${tokens[0]}`),
        fetch(`https://clob.polymarket.com/book?token_id=${tokens[1]}`)
      ]);

      const upBook = await upBookRes.json();
      const downBook = await downBookRes.json();

      // Get best bid prices (what you can sell at = market odds)
      // Note: Polymarket CLOB returns bids sorted ascending, so best bid is LAST
      state.polymarketUp = getBestBidPrice(upBook);
      state.polymarketLiquidityUp = getTotalBidLiquidity(upBook);
      state.polymarketDown = getBestBidPrice(downBook);
      state.polymarketLiquidityDown = getTotalBidLiquidity(downBook);

      state.lastPolymarketUpdate = Date.now();

      // Log stale detection for debugging
      if (isMarketStale()) {
        const sum = (state.polymarketUp || 0) + (state.polymarketDown || 0);
        console.log(`[STALE DETECTED] UP=${state.polymarketUp} DOWN=${state.polymarketDown} SUM=${sum.toFixed(3)} slug=${state.marketSlug}`);
      }
    }
  } catch (e) {
    console.error('Polymarket poll error:', e.message);
  }
}

// Broadcast state to all connected clients
function broadcastState() {
  const now = Date.now();

  // Calculate 1m and 5m price changes
  const oneMinAgo = now - 60 * 1000;
  const fiveMinAgo = now - 5 * 60 * 1000;

  const pricesOneMinAgo = state.binancePriceHistory.filter(p => p.time <= oneMinAgo);
  const pricesFiveMinAgo = state.binancePriceHistory.filter(p => p.time <= fiveMinAgo);

  const price1mAgo = pricesOneMinAgo.length > 0 ? pricesOneMinAgo[pricesOneMinAgo.length - 1].price : null;
  const price5mAgo = pricesFiveMinAgo.length > 0 ? pricesFiveMinAgo[pricesFiveMinAgo.length - 1].price : null;

  const payload = {
    binancePrice: state.binancePrice,
    change1m: price1mAgo && state.binancePrice ? ((state.binancePrice - price1mAgo) / price1mAgo * 100) : null,
    change5m: price5mAgo && state.binancePrice ? ((state.binancePrice - price5mAgo) / price5mAgo * 100) : null,
    polymarketUp: state.polymarketUp,
    polymarketDown: state.polymarketDown,
    polymarketLiquidityUp: state.polymarketLiquidityUp,
    polymarketLiquidityDown: state.polymarketLiquidityDown,
    marketEndTime: state.marketEndTime,
    marketSlug: state.marketSlug,
    latencyEvents: state.latencyEvents,
    upDownSum: state.polymarketUp !== null && state.polymarketDown !== null
      ? state.polymarketUp + state.polymarketDown
      : null
  };

  const message = JSON.stringify(payload);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Serve dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Start everything
connectBinance();
pollPolymarket();
setInterval(pollPolymarket, 2000);
setInterval(broadcastState, 1000);

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
