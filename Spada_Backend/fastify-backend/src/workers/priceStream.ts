import 'dotenv/config';
import WebSocket from 'ws';
import { supabaseAdmin } from '../lib/supabase.js';
import { broadcastPriceUpdate } from '../routes/websocket.js';

interface PriceUpdate {
  canonicalId: string;
  prices: number[];
}

interface TokenMapping {
  canonicalId: string;
  outcomeIndex: number; // For multi: 0=Option1, 1=Option2. For binary: 0=YES, 1=NO.
  isMulti: boolean;
}

const updateQueue = new Map<string, PriceUpdate>();
const tokenToCanonicalMap = new Map<string, TokenMapping>();

// Holds the full array of prices for every market so multi-outcome arrays aren't truncated
const marketPrices = new Map<string, number[]>();

async function getActivePolymarketAssetIds(): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from('markets')
    .select('canonical_id, raw_data, active, prices')
    .eq('platform', 'polymarket')
    .eq('active', true)
    .order('updated_at', { ascending: false })
    .limit(200);

  if (error || !data) return [];

  const assetIds = new Set<string>();
  tokenToCanonicalMap.clear();
  marketPrices.clear();

  for (const market of data) {
    const raw = market.raw_data ?? {};
    const marketCanonicalId = market.canonical_id;
    const isMulti = marketCanonicalId.includes('_event_');

    // Store the existing full price array into memory
    marketPrices.set(marketCanonicalId, Array.isArray(market.prices) ? [...market.prices] : []);

    // Register tokens with their specific outcome index
    if (isMulti) {
      if (Array.isArray(raw.clobTokenIds)) {
        raw.clobTokenIds.forEach((id: any, idx: number) => {
          if (id) {
            const strId = String(id);
            assetIds.add(strId);
            tokenToCanonicalMap.set(strId, {
              canonicalId: marketCanonicalId,
              outcomeIndex: idx,
              isMulti: true,
            });
          }
        });
      }
    } else {
      if (Array.isArray(raw.tokens)) {
        raw.tokens.forEach((token: any, idx: number) => {
          const id = token?.token_id ?? token?.clobTokenId ?? token?.id;
          if (id) {
            const strId = String(id);
            assetIds.add(strId);
            tokenToCanonicalMap.set(strId, {
              canonicalId: marketCanonicalId,
              outcomeIndex: idx,
              isMulti: false,
            });
          }
        });
      } else if (Array.isArray(raw.clobTokenIds)) {
        raw.clobTokenIds.forEach((id: any, idx: number) => {
          if (id) {
            const strId = String(id);
            assetIds.add(strId);
            tokenToCanonicalMap.set(strId, {
              canonicalId: marketCanonicalId,
              outcomeIndex: idx,
              isMulti: false,
            });
          }
        });
      }
    }
  }

  return [...assetIds];
}

// Safely updates a single index without destroying the rest of the array
function recordPrice(assetId: string, rawPrice: number) {
  const mapping = tokenToCanonicalMap.get(assetId);
  if (!mapping || rawPrice <= 0 || rawPrice >= 1) return;

  const { canonicalId, outcomeIndex, isMulti } = mapping;
  const currentPrices = marketPrices.get(canonicalId) || [];

  if (isMulti) {
    // Multi-outcome: Only update the specific candidate's odds
    currentPrices[outcomeIndex] = Number(rawPrice.toFixed(4));
  } else {
    // Binary: Calculate NO based on YES, or vice versa
    let yesPrice = rawPrice;
    let noPrice = Number((1 - rawPrice).toFixed(4));

    if (outcomeIndex === 1) {
      noPrice = rawPrice;
      yesPrice = Number((1 - rawPrice).toFixed(4));
    }

    currentPrices[0] = yesPrice;
    currentPrices[1] = noPrice;
  }

  marketPrices.set(canonicalId, currentPrices);

  updateQueue.set(canonicalId, {
    canonicalId,
    prices: [...currentPrices],
  });
}

function handlePolymarketMessage(payload: unknown, ws: WebSocket): void {
  const messages = Array.isArray(payload) ? payload : [payload];

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const event = message as any;

    const eventType = event.event_type ?? event.type ?? 'unknown';

    // 1. Dynamic subscription
    if (eventType === 'new_market' && Array.isArray(event.assets_ids)) {
      const isMulti = event.assets_ids.length > 2;
      const canonicalId = `polymarket_${event.market || event.condition_id || event.assets_ids[0]}`;

      if (!marketPrices.has(canonicalId)) {
        marketPrices.set(canonicalId, new Array(event.assets_ids.length).fill(0));
      }

      event.assets_ids.forEach((id: string, idx: number) => {
        const strId = String(id);
        if (!tokenToCanonicalMap.has(strId)) {
          tokenToCanonicalMap.set(strId, {
            canonicalId,
            outcomeIndex: idx,
            isMulti,
          });
        }
      });

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          operation: 'subscribe',
          assets_ids: event.assets_ids,
          custom_feature_enabled: true,
        }));
      }
      continue;
    }

    // 2. Orderbook Snapshots
    if (eventType === 'book' && event.asset_id) {
      const bestBid = Number(event.bids?.[0]?.price ?? 0);
      const bestAsk = Number(event.asks?.[0]?.price ?? 0);
      const midPrice = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;

      if (midPrice > 0) recordPrice(event.asset_id, midPrice);
      continue;
    }

    // 3. Best Bid / Ask
    if (eventType === 'best_bid_ask' && event.asset_id) {
      const bestBid = Number(event.best_bid ?? 0);
      const bestAsk = Number(event.best_ask ?? 0);
      const midPrice = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;

      if (midPrice > 0) recordPrice(event.asset_id, midPrice);
      continue;
    }

    // 4. Last Trade Price
    if (eventType === 'last_trade_price' && event.asset_id) {
      const price = Number(event.price ?? 0);
      if (price > 0) recordPrice(event.asset_id, price);
      continue;
    }

    // 5. Price Changes (Ticks)
    if (eventType === 'price_change' && Array.isArray(event.price_changes)) {
      for (const change of event.price_changes) {
        const assetId = change?.asset_id;
        const price = Number(change?.price ?? change?.best_bid ?? 0);
        if (assetId && price > 0) recordPrice(assetId, price);
      }
    }
  }
}

async function connectPolymarketStream(): Promise<void> {
  const assetIds = await getActivePolymarketAssetIds();
  if (assetIds.length === 0) {
    setTimeout(() => connectPolymarketStream().catch(console.error), 10000);
    return;
  }

  const ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');
  let pingInterval: NodeJS.Timeout | undefined;
  let watchdogInterval: NodeJS.Timeout | undefined;
  let lastMessageAt = Date.now();

  ws.on('open', () => {
    ws.send(JSON.stringify({
      assets_ids: assetIds,
      type: 'market',
      initial_dump: true,
      custom_feature_enabled: true,
    }));

    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send('PING');
    }, 5000);

    watchdogInterval = setInterval(() => {
      if (Date.now() - lastMessageAt > 60000) {
        ws.close();
      }
    }, 10000);
  });

  ws.on('message', (data: WebSocket.Data) => {
    lastMessageAt = Date.now();
    const payload = data.toString().trim();
    if (payload.toLowerCase() === 'pong' || payload === 'INVALID OPERATION') return;

    try {
      handlePolymarketMessage(JSON.parse(payload), ws);
    } catch {
      // Ignored plain text
    }
  });

  ws.on('close', () => {
    if (pingInterval) clearInterval(pingInterval);
    if (watchdogInterval) clearInterval(watchdogInterval);
    setTimeout(() => connectPolymarketStream().catch(console.error), 5000);
  });

  ws.on('error', (error) => console.error('[Price Stream] WS error:', error.message));
}

async function flushPriceUpdates(): Promise<void> {
  if (updateQueue.size === 0) return;

  const updates = [...updateQueue.values()];
  updateQueue.clear();

  for (const update of updates) {
    broadcastPriceUpdate(update.canonicalId, update.prices);
  }

  await Promise.all(
    updates.map((update) =>
      supabaseAdmin
        .from('markets')
        .update({
          prices: update.prices,
          updated_at: new Date().toISOString(),
        })
        .eq('canonical_id', update.canonicalId)
    )
  );
}

export function startPriceStreamWorker(): void {
  connectPolymarketStream().catch(console.error);
  setInterval(() => flushPriceUpdates().catch(console.error), 2000);
}

if (process.argv[1]?.endsWith('priceStream.ts')) {
  startPriceStreamWorker();
}