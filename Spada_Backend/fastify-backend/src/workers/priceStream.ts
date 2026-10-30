import 'dotenv/config';
import WebSocket from 'ws';
import { livePinnedIds, watchLivePins } from '../lib/livePins.js';
import { rememberLiveQuote } from '../lib/liveQuotes.js';
import { venueLookup } from '../lib/venueDns.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { broadcastPriceUpdate } from '../routes/websocket.js';
import { buildKalshiWsAuthHeaders, kalshiGet, KALSHI_WS_URL } from '../lib/kalshiClient.js';
import { candleAggregator } from '../services/candleAggregator.js';
import { pricesNeedPersist } from '../lib/pricePersist.js';
import {
  countRecentTicks,
  formatPriceStreamCoverage,
  parsePriceStreamMarketLimit,
  selectMarketsForPriceStream,
  type StreamMarketRow,
} from '../lib/priceStreamPlan.js';

interface PriceUpdate {
  canonicalId: string;
  prices: number[];
}

interface TokenMapping {
  canonicalId: string;
  outcomeIndex: number; // multi: outcome idx; binary: 0=YES, 1=NO
  isMulti: boolean;
}

const POLY_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
/** Keep chunks modest — large type:market bursts return INVALID OPERATION */
const POLY_CHUNK_SIZE = 50;
const POLY_PING_MS = 10_000;
const POLY_PONG_TIMEOUT_MS = 30_000;
const POLY_REFRESH_MS = 5 * 60_000;
const KALSHI_CHUNK_SIZE = 100;
const KALSHI_REFRESH_MS = 5 * 60_000;
const FLUSH_MS = 1000;
/** Persist closed 1m buckets quickly so forming-candle DB rungs stay fresh. */
const CANDLE_FLUSH_MS = 5_000;
const RECONNECT_BASE_MS = 5000;

const updateQueue = new Map<string, PriceUpdate>();
const marketPrices = new Map<string, number[]>();
/** Last prices successfully written to markets. Unchanged ticks stay on the socket only. */
const lastPersistedPrices = new Map<string, number[]>();
/** Last live tick wall-clock per canonical_id (coverage metrics). */
const lastTickAtByMarket = new Map<string, number>();
/** Fair-rotate cursors (in-memory; reset on process restart). */
let polyStreamRotateCursor = 0;
let kalshiStreamRotateCursor = 0;

/** Polymarket token_id → market mapping */
const tokenToCanonicalMap = new Map<string, TokenMapping>();
/** Kalshi ticker → canonical_id */
const tickerToCanonicalMap = new Map<string, string>();

interface ResolvedPin {
  canonicalId: string;
  platform: 'kalshi' | 'polymarket';
  ticker: string | null;
  tokens: Array<{ id: string; outcomeIndex: number; isMulti: boolean }>;
  prices: number[] | null;
}

/** Markets a browser currently has open. Kept across the 5-minute rotation. */
const resolvedPins = new Map<string, ResolvedPin>();
const pinLoads = new Map<string, Promise<void>>();

function mergePinnedKalshiTickers(tickers: string[]): void {
  for (const pin of resolvedPins.values()) {
    if (pin.platform !== 'kalshi' || !pin.ticker) continue;
    if (!tickerToCanonicalMap.has(pin.ticker)) {
      tickers.push(pin.ticker);
      tickerToCanonicalMap.set(pin.ticker, pin.canonicalId);
    }
    if (!marketPrices.has(pin.canonicalId)) {
      marketPrices.set(pin.canonicalId, pin.prices ?? [0.5, 0.5]);
    }
  }
}

function mergePinnedPolymarketTokens(assetIds: string[]): void {
  for (const pin of resolvedPins.values()) {
    if (pin.platform !== 'polymarket') continue;
    if (!marketPrices.has(pin.canonicalId)) {
      marketPrices.set(
        pin.canonicalId,
        pin.prices ?? new Array(Math.max(pin.tokens.length, 2)).fill(0)
      );
    }
    for (const token of pin.tokens) {
      if (tokenToCanonicalMap.has(token.id)) continue;
      assetIds.push(token.id);
      tokenToCanonicalMap.set(token.id, {
        canonicalId: pin.canonicalId,
        outcomeIndex: token.outcomeIndex,
        isMulti: token.isMulti,
      });
    }
  }
}

const RECENT_TICK_WINDOW_MS = 5 * 60_000;

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function clampProb(n: number): number | null {
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 1) return null;
  return Number(n.toFixed(4));
}

function queuePriceUpdate(canonicalId: string, prices: number[]) {
  const next = [...prices];
  marketPrices.set(canonicalId, next);
  rememberLiveQuote(canonicalId, next);
  updateQueue.set(canonicalId, { canonicalId, prices: [...next] });
}

function recordPolymarketPrice(
  assetId: string,
  rawPrice: number,
  options: { isTrade?: boolean; volume?: number } = {}
) {
  const mapping = tokenToCanonicalMap.get(String(assetId));
  const price = clampProb(rawPrice);
  if (!mapping || price == null) return;

  const { canonicalId, outcomeIndex, isMulti } = mapping;
  const currentPrices = [...(marketPrices.get(canonicalId) || [])];

  if (isMulti) {
    currentPrices[outcomeIndex] = price;
  } else {
    let yesPrice = price;
    let noPrice = clampProb(1 - price) ?? Number((1 - price).toFixed(4));
    if (outcomeIndex === 1) {
      noPrice = price;
      yesPrice = clampProb(1 - price) ?? Number((1 - price).toFixed(4));
    }
    currentPrices[0] = yesPrice;
    currentPrices[1] = noPrice;
  }

  queuePriceUpdate(canonicalId, currentPrices);
  lastTickAtByMarket.set(canonicalId, Date.now());

  // OHLC series is keyed by CLOB token_id (matches polymarket_ohlc / get_candles)
  candleAggregator.ingestLiveTick('polymarket', String(assetId), price, {
    isTrade: options.isTrade,
    volume: options.volume,
  });
}

function recordKalshiYesPrice(
  ticker: string,
  yesPriceRaw: number,
  options: { isTrade?: boolean; volume?: number } = {}
) {
  const canonicalId = tickerToCanonicalMap.get(String(ticker));
  const yesPrice = clampProb(yesPriceRaw);
  if (!canonicalId || yesPrice == null) return;

  const noPrice = clampProb(1 - yesPrice) ?? Number((1 - yesPrice).toFixed(4));
  queuePriceUpdate(canonicalId, [yesPrice, noPrice]);
  lastTickAtByMarket.set(canonicalId, Date.now());
  candleAggregator.ingestLiveTick('kalshi', String(ticker), yesPrice, {
    isTrade: options.isTrade,
    volume: options.volume,
  });
}

/** Live chart price: CLOB midpoint only. Requires both bid and ask. */
function clobMidpoint(bestBid: number, bestAsk: number): number | null {
  if (!(Number.isFinite(bestBid) && Number.isFinite(bestAsk))) return null;
  if (!(bestBid > 0 && bestAsk > 0)) return null;
  return (bestBid + bestAsk) / 2;
}

/** Kalshi live chart price from ticker bid/ask (dollars or cents). */
function extractKalshiMidpoint(payload: Record<string, any>): number | null {
  if (payload.yes_bid_dollars != null && payload.yes_ask_dollars != null) {
    return clobMidpoint(Number(payload.yes_bid_dollars), Number(payload.yes_ask_dollars));
  }
  if (payload.yes_bid != null && payload.yes_ask != null) {
    const bid = Number(payload.yes_bid);
    const ask = Number(payload.yes_ask);
    if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
      return (bid + ask) / 200;
    }
  }
  return null;
}

/** Kalshi trade fill price for candle volume only (not live chart). */
function extractKalshiTradePrice(payload: Record<string, any>): number | null {
  if (payload.price_dollars != null) {
    const p = Number(payload.price_dollars);
    if (Number.isFinite(p) && p > 0) return p;
  }
  if (payload.price != null || payload.yes_price != null) {
    const cents = Number(payload.price ?? payload.yes_price);
    if (Number.isFinite(cents) && cents > 0) return cents / 100;
  }
  if (payload.last_price_dollars != null) {
    const last = Number(payload.last_price_dollars);
    if (Number.isFinite(last) && last >= 0 && last <= 1) return last;
  }
  return extractKalshiMidpoint(payload);
}

function parseTokenIds(raw: any): string[] {
  const value = raw?.clobTokenIds ?? raw?.clob_token_ids;
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
    } catch {
      return value ? [value] : [];
    }
  }
  if (Array.isArray(raw?.tokens)) {
    return raw.tokens
      .map((t: any) => t?.token_id ?? t?.clobTokenId ?? t?.id)
      .filter(Boolean)
      .map(String);
  }
  return [];
}

async function loadWatchlistIdsForPlatform(
  platform: 'polymarket' | 'kalshi'
): Promise<string[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from('watchlist')
      .select('canonical_id')
      .like('canonical_id', `${platform}_%`)
      .limit(200);
    if (error) {
      console.warn(`[Price Stream][${platform}] watchlist:`, error.message.slice(0, 120));
      return [];
    }
    return [...new Set((data ?? []).map((r) => String(r.canonical_id)).filter(Boolean))];
  } catch (err: any) {
    console.warn(`[Price Stream][${platform}] watchlist failed:`, err?.message ?? err);
    return [];
  }
}

async function countActiveMarkets(platform: 'polymarket' | 'kalshi'): Promise<number | null> {
  const { count, error } = await supabaseAdmin
    .from('markets')
    .select('canonical_id', { count: 'estimated', head: true })
    .eq('platform', platform)
    .eq('active', true);
  if (error) return null;
  return count ?? null;
}

async function loadStreamMarketPools(
  platform: 'polymarket' | 'kalshi',
  pageSize: number
): Promise<{ highVolume: StreamMarketRow[]; rotatePool: StreamMarketRow[] }> {
  const rotateLimit = Math.max(pageSize, Math.min(pageSize * 4, 600));

  // Order by the primary key. ORDER BY volume scans and sorts the whole
  // catalogue and was cancelled by the database statement timeout.
  const selectCols =
    'canonical_id, platform, external_id, volume, active, updated_at, prices';

  let rotQuery = supabaseAdmin
    .from('markets')
    .select(selectCols)
    .eq('active', true);

  if (platform === 'polymarket') {
    rotQuery = rotQuery
      .gte('canonical_id', 'polymarket_')
      .lt('canonical_id', 'polymarket_\uffff');
  } else if (platform === 'kalshi') {
    rotQuery = rotQuery
      .gte('canonical_id', 'kalshi_')
      .lt('canonical_id', 'kalshi_\uffff')
      .not('canonical_id', 'ilike', '%CROSSCATEGORY%');
  }

  const rotRes = await rotQuery
    .order('canonical_id', { ascending: true })
    .limit(rotateLimit);

  if (rotRes.error) {
    console.error(`[Price Stream][${platform}] rotate pool:`, rotRes.error.message);
  }

  const toRow = (m: Record<string, any>): StreamMarketRow => ({
    canonical_id: String(m.canonical_id),
    platform: String(m.platform),
    external_id: m.external_id != null ? String(m.external_id) : null,
    volume: m.volume != null ? Number(m.volume) : null,
    active: m.active,
    updated_at: m.updated_at != null ? String(m.updated_at) : null,
    meta: {
      prices: m.prices,
    },
  });

  const rotatePool = (rotRes.data ?? []).map(toRow);
  const highVolume = [...rotatePool].sort(
    (a, b) => Number(b.volume ?? 0) - Number(a.volume ?? 0)
  );
  return { highVolume, rotatePool };
}

/** CLOB token ids for the markets actually subscribed, not the whole candidate pool. */
async function loadPolymarketClobTokens(
  ids: string[]
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  for (const chunk of chunkArray(unique, 50)) {
    const { data, error } = await supabaseAdmin
      .from('markets')
      .select('canonical_id, clob_token_ids:raw_data->clobTokenIds, tokens:raw_data->tokens')
      .in('canonical_id', chunk);
    if (error) {
      console.warn(
        '[Price Stream][polymarket] token lookup:',
        error.message.slice(0, 160)
      );
      continue;
    }
    for (const row of data ?? []) {
      out.set(String(row.canonical_id), {
        clobTokenIds: row.clob_token_ids,
        tokens: row.tokens,
      });
    }
  }
  return out;
}

/**
 * Fair selection within PRICE_STREAM_MARKET_LIMIT (default 150).
 * Watchlist + high-volume + rotate — not pure updated_at (avoids starving quiet markets).
 */
async function loadActivePolymarketMarkets(): Promise<string[]> {
  const started = Date.now();
  const pageSize = parsePriceStreamMarketLimit(process.env.PRICE_STREAM_MARKET_LIMIT);
  const [watchedIds, pools, eligibleActive] = await Promise.all([
    loadWatchlistIdsForPlatform('polymarket'),
    loadStreamMarketPools('polymarket', pageSize),
    countActiveMarkets('polymarket'),
  ]);

  const selection = selectMarketsForPriceStream({
    pageSize,
    watchedIds,
    highVolumeMarkets: pools.highVolume,
    rotatePool: pools.rotatePool,
    rotateCursor: polyStreamRotateCursor,
  });
  polyStreamRotateCursor = selection.nextRotateOffset;

  const assetIds: string[] = [];
  for (const key of [...tokenToCanonicalMap.keys()]) {
    tokenToCanonicalMap.delete(key);
  }

  const tokenRaw = await loadPolymarketClobTokens(
    selection.markets.map((market) => market.canonical_id)
  );

  for (const market of selection.markets) {
    const raw = tokenRaw.get(market.canonical_id) ?? {};
    const prices = market.meta?.prices;
    const canonicalId = market.canonical_id;
    const isMulti = canonicalId.includes('_event_');
    const tokens = parseTokenIds(raw);

    if (!marketPrices.has(canonicalId)) {
      marketPrices.set(
        canonicalId,
        Array.isArray(prices) ? [...(prices as number[])] : new Array(Math.max(tokens.length, 2)).fill(0)
      );
    }

    const subscribeTokens = isMulti ? tokens : tokens.slice(0, 1);
    subscribeTokens.forEach((id, idx) => {
      assetIds.push(id);
      tokenToCanonicalMap.set(id, {
        canonicalId,
        outcomeIndex: idx,
        isMulti,
      });
    });
  }

  mergePinnedPolymarketTokens(assetIds);
  const subscribed = [...new Set(assetIds)];
  console.log(
    formatPriceStreamCoverage({
      platform: 'Polymarket',
      eligibleActive,
      selected: selection.markets.length,
      subscribedTokensOrTickers: subscribed.length,
      watchCount: selection.watchCount,
      volumeCount: selection.volumeCount,
      rotateCount: selection.rotateCount,
      pageSize: selection.pageSize,
      rotateOffset: selection.rotateOffset,
      recentTickMarkets: countRecentTicks(
        lastTickAtByMarket,
        Date.now(),
        RECENT_TICK_WINDOW_MS
      ),
      durationMs: Date.now() - started,
    })
  );

  return subscribed;
}

async function loadActiveKalshiTickers(): Promise<string[]> {
  const started = Date.now();
  const pageSize = parsePriceStreamMarketLimit(process.env.PRICE_STREAM_MARKET_LIMIT);
  const [watchedIds, pools, eligibleActive] = await Promise.all([
    loadWatchlistIdsForPlatform('kalshi'),
    loadStreamMarketPools('kalshi', pageSize),
    countActiveMarkets('kalshi'),
  ]);

  const selection = selectMarketsForPriceStream({
    pageSize,
    watchedIds,
    highVolumeMarkets: pools.highVolume,
    rotatePool: pools.rotatePool,
    rotateCursor: kalshiStreamRotateCursor,
  });
  kalshiStreamRotateCursor = selection.nextRotateOffset;

  tickerToCanonicalMap.clear();
  const tickers: string[] = [];

  for (const market of selection.markets) {
    const ticker = String(market.external_id || '').trim();
    if (!ticker || ticker.includes('CROSSCATEGORY') || ticker.startsWith('KXMVE')) continue;
    tickers.push(ticker);
    tickerToCanonicalMap.set(ticker, market.canonical_id);
    const prices = market.meta?.prices;
    if (!marketPrices.has(market.canonical_id)) {
      marketPrices.set(
        market.canonical_id,
        Array.isArray(prices) ? [...(prices as number[])] : [0.5, 0.5]
      );
    }
  }

  mergePinnedKalshiTickers(tickers);

  console.log(
    formatPriceStreamCoverage({
      platform: 'Kalshi',
      eligibleActive,
      selected: selection.markets.length,
      subscribedTokensOrTickers: tickers.length,
      watchCount: selection.watchCount,
      volumeCount: selection.volumeCount,
      rotateCount: selection.rotateCount,
      pageSize: selection.pageSize,
      rotateOffset: selection.rotateOffset,
      recentTickMarkets: countRecentTicks(
        lastTickAtByMarket,
        Date.now(),
        RECENT_TICK_WINDOW_MS
      ),
      durationMs: Date.now() - started,
    })
  );

  return tickers;
}

function handlePolymarketMessage(payload: unknown, ws: WebSocket): void {
  const messages = Array.isArray(payload) ? payload : [payload];

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const event = message as any;
    const eventType = event.event_type ?? event.type ?? 'unknown';

    if (eventType === 'new_market' && Array.isArray(event.assets_ids)) {
      const isMulti = event.assets_ids.length > 2;
      const canonicalId = `polymarket_${event.market || event.condition_id || event.assets_ids[0]}`;

      if (!marketPrices.has(canonicalId)) {
        marketPrices.set(canonicalId, new Array(event.assets_ids.length).fill(0));
      }

      event.assets_ids.forEach((id: string, idx: number) => {
        const strId = String(id);
        if (!tokenToCanonicalMap.has(strId)) {
          tokenToCanonicalMap.set(strId, { canonicalId, outcomeIndex: idx, isMulti });
        }
      });

      if (ws.readyState === WebSocket.OPEN) {
        for (const chunk of chunkArray(event.assets_ids.map(String), POLY_CHUNK_SIZE)) {
          ws.send(
            JSON.stringify({
              operation: 'subscribe',
              assets_ids: chunk,
              custom_feature_enabled: true,
            })
          );
        }
      }
      continue;
    }

    // Live chart prices: CLOB midpoint only (never last trade / one-sided quotes).
    if (eventType === 'book' && event.asset_id) {
      const bids = Array.isArray(event.bids) ? event.bids : [];
      const asks = Array.isArray(event.asks) ? event.asks : [];
      const mid = clobMidpoint(Number(bids[0]?.price ?? NaN), Number(asks[0]?.price ?? NaN));
      if (mid != null) recordPolymarketPrice(event.asset_id, mid);
      continue;
    }

    if (eventType === 'best_bid_ask' && event.asset_id) {
      const mid = clobMidpoint(Number(event.best_bid ?? NaN), Number(event.best_ask ?? NaN));
      if (mid != null) recordPolymarketPrice(event.asset_id, mid);
      continue;
    }

    // Trades feed candle volume only — do not overwrite live chart midpoint.
    if (eventType === 'last_trade_price' && event.asset_id) {
      const price = clampProb(Number(event.price ?? 0));
      const size = Number(event.size ?? event.trade_size ?? 0);
      if (price != null && tokenToCanonicalMap.has(String(event.asset_id))) {
        candleAggregator.ingestLiveTick('polymarket', String(event.asset_id), price, {
          isTrade: true,
          volume: Number.isFinite(size) && size > 0 ? size : 0,
        });
      }
      continue;
    }

    if (eventType === 'price_change' && Array.isArray(event.price_changes)) {
      for (const change of event.price_changes) {
        const assetId = change?.asset_id;
        const mid = clobMidpoint(Number(change?.best_bid ?? NaN), Number(change?.best_ask ?? NaN));
        if (assetId && mid != null) {
          recordPolymarketPrice(assetId, mid);
        }
      }
    }
  }
}

// ─── Polymarket live WS ───────────────────────────────────────────────────────

let polyWs: WebSocket | null = null;
let polyPingTimer: NodeJS.Timeout | undefined;
let polyRefreshTimer: NodeJS.Timeout | undefined;
let polyLastPongAt = Date.now();
let polySubscribed = new Set<string>();
let polyReconnectAttempt = 0;

function subscribePolymarketTokens(ws: WebSocket, tokenIds: string[], initial: boolean) {
  if (!tokenIds.length || ws.readyState !== WebSocket.OPEN) return;

  const chunks = chunkArray(tokenIds, POLY_CHUNK_SIZE);
  chunks.forEach((chunk, idx) => {
    // Only the first subscribe on a fresh socket may use type:"market".
    // Extra type:"market" frames (or huge bursts) return INVALID OPERATION.
    if (initial && idx === 0) {
      ws.send(
        JSON.stringify({
          type: 'market',
          assets_ids: chunk,
          custom_feature_enabled: true,
        })
      );
    } else {
      ws.send(
        JSON.stringify({
          assets_ids: chunk,
          operation: 'subscribe',
          custom_feature_enabled: true,
        })
      );
    }
  });
}

function unsubscribePolymarketTokens(ws: WebSocket, tokenIds: string[]) {
  if (!tokenIds.length || ws.readyState !== WebSocket.OPEN) return;
  for (const chunk of chunkArray(tokenIds, POLY_CHUNK_SIZE)) {
    ws.send(
      JSON.stringify({
        assets_ids: chunk,
        operation: 'unsubscribe',
        custom_feature_enabled: true,
      })
    );
  }
}

async function refreshPolymarketSubscriptions(initial = false) {
  const nextIds = await loadActivePolymarketMarkets();
  const nextSet = new Set(nextIds);
  const toAdd = nextIds.filter((id) => !polySubscribed.has(id));
  const toRemove = [...polySubscribed].filter((id) => !nextSet.has(id));

  if (polyWs?.readyState === WebSocket.OPEN) {
    if (initial) {
      subscribePolymarketTokens(polyWs, nextIds, true);
    } else {
      subscribePolymarketTokens(polyWs, toAdd, false);
      unsubscribePolymarketTokens(polyWs, toRemove);
    }
  }

  polySubscribed = nextSet;
  console.log(
    `[Price Stream][Polymarket] subscribe refresh: tokens=${nextIds.length} +${toAdd.length} -${toRemove.length}${initial ? ' (initial)' : ''}`
  );
}

async function connectPolymarketStream(): Promise<void> {
  if (polyWs) {
    try {
      polyWs.removeAllListeners();
      polyWs.terminate();
    } catch {
      // ignore
    }
    polyWs = null;
  }

  const assetIds = await loadActivePolymarketMarkets();
  if (assetIds.length === 0) {
    console.warn('[Price Stream][Polymarket] no active token ids — retry in 10s');
    setTimeout(() => connectPolymarketStream().catch(console.error), 10_000);
    return;
  }

  console.log(`[Price Stream][Polymarket] connecting ${POLY_WS_URL} (${assetIds.length} tokens)`);
  const ws = new WebSocket(POLY_WS_URL, { lookup: venueLookup });
  polyWs = ws;

  ws.on('open', async () => {
    polyReconnectAttempt = 0;
    polyLastPongAt = Date.now();
    console.log('[Price Stream][Polymarket] WebSocket connected');
    try {
      await refreshPolymarketSubscriptions(true);
    } catch (err: any) {
      console.error('[Price Stream][Polymarket] initial subscribe:', err.message);
    }

    clearInterval(polyPingTimer);
    polyPingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send('PING');
      if (Date.now() - polyLastPongAt > POLY_PONG_TIMEOUT_MS) {
        console.warn('[Price Stream][Polymarket] PONG timeout — reconnecting');
        ws.close();
      }
    }, POLY_PING_MS);

    clearInterval(polyRefreshTimer);
    polyRefreshTimer = setInterval(() => {
      refreshPolymarketSubscriptions(false).catch((err) =>
        console.error('[Price Stream][Polymarket] refresh:', err.message)
      );
    }, POLY_REFRESH_MS);
  });

  ws.on('message', (data: WebSocket.Data) => {
    const payload = data.toString().trim();
    if (payload === 'PONG' || payload.toLowerCase() === 'pong') {
      polyLastPongAt = Date.now();
      return;
    }
    if (payload === 'INVALID OPERATION') {
      console.warn('[Price Stream][Polymarket] INVALID OPERATION');
      return;
    }
    polyLastPongAt = Date.now();
    try {
      handlePolymarketMessage(JSON.parse(payload), ws);
    } catch {
      // ignore non-JSON
    }
  });

  ws.on('close', (code) => {
    console.warn(`[Price Stream][Polymarket] closed code=${code}`);
    clearInterval(polyPingTimer);
    clearInterval(polyRefreshTimer);
    polySubscribed.clear();
    polyReconnectAttempt += 1;
    const delay = Math.min(30_000, RECONNECT_BASE_MS * 2 ** Math.min(polyReconnectAttempt, 4));
    setTimeout(() => connectPolymarketStream().catch(console.error), delay);
  });

  ws.on('error', (error) => {
    console.error('[Price Stream][Polymarket] WS error:', error.message);
  });
}

// ─── Kalshi live WS ───────────────────────────────────────────────────────────

let kalshiWs: WebSocket | null = null;
let kalshiRefreshTimer: NodeJS.Timeout | undefined;
let kalshiSubscribed = new Set<string>();
let kalshiChannelSids = new Map<string, number>();
/** Tickers pinned before the Kalshi subscribe ack (sid) exists. */
const pendingKalshiAdds = new Set<string>();
let kalshiMsgId = 1;
let kalshiReconnectAttempt = 0;

function kalshiSend(ws: WebSocket, payload: Record<string, unknown>) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ id: kalshiMsgId++, ...payload }));
}

function subscribeKalshiTickers(ws: WebSocket, tickers: string[]) {
  if (!tickers.length) return;
  for (const chunk of chunkArray(tickers, KALSHI_CHUNK_SIZE)) {
    kalshiSend(ws, {
      cmd: 'subscribe',
      params: {
        channels: ['ticker', 'trade'],
        market_tickers: chunk,
      },
    });
  }
}

function updateKalshiSubscription(ws: WebSocket, action: 'add_markets' | 'delete_markets', tickers: string[]) {
  if (!tickers.length || kalshiChannelSids.size === 0) return;
  for (const sid of kalshiChannelSids.values()) {
    for (const chunk of chunkArray(tickers, KALSHI_CHUNK_SIZE)) {
      kalshiSend(ws, {
        cmd: 'update_subscription',
        params: {
          sids: [sid],
          action,
          market_tickers: chunk,
        },
      });
    }
  }
}

function flushPendingKalshiAdds(): void {
  if (!pendingKalshiAdds.size || kalshiWs?.readyState !== WebSocket.OPEN || kalshiChannelSids.size === 0) {
    return;
  }
  const tickers = [...pendingKalshiAdds];
  pendingKalshiAdds.clear();
  updateKalshiSubscription(kalshiWs!, 'add_markets', tickers);
  console.log(`[Price Stream][Kalshi] pinned ${tickers.join(',')}`);
}

function pushKalshiPin(ticker: string): void {
  if (!ticker || kalshiSubscribed.has(ticker)) return;
  kalshiSubscribed.add(ticker);
  if (kalshiWs?.readyState !== WebSocket.OPEN || kalshiChannelSids.size === 0) {
    pendingKalshiAdds.add(ticker);
    return;
  }
  updateKalshiSubscription(kalshiWs, 'add_markets', [ticker]);
  console.log(`[Price Stream][Kalshi] pinned ${ticker}`);
}

function pushPolymarketPin(tokenIds: string[]): void {
  const fresh = tokenIds.filter((id) => id && !polySubscribed.has(id));
  if (!fresh.length) return;
  for (const id of fresh) polySubscribed.add(id);
  if (polyWs?.readyState === WebSocket.OPEN) {
    subscribePolymarketTokens(polyWs, fresh, false);
    console.log(`[Price Stream][Polymarket] pinned ${fresh.length} token(s)`);
  }
}

function seedKalshiPin(ticker: string): void {
  if (!ticker || ticker.includes('CROSSCATEGORY') || ticker.startsWith('KXMVE')) return;
  void kalshiGet(`/markets/${encodeURIComponent(ticker)}`)
    .then((body: any) => {
      const market = body?.market ?? body ?? {};
      const mid = extractKalshiMidpoint(market) ?? extractKalshiTradePrice(market);
      if (mid == null) {
        console.warn(
          `[Price Stream][Kalshi] pin snapshot ${ticker} has no price keys=${Object.keys(market).slice(0, 12).join(',')}`
        );
        return;
      }
      console.log(`[Price Stream][Kalshi] pin snapshot ${ticker} mid=${mid}`);
      recordKalshiYesPrice(ticker, mid);
    })
    .catch((err: any) => {
      console.warn(`[Price Stream][Kalshi] pin snapshot ${ticker}:`, err?.message ?? err);
    });
}

function applyResolvedPin(pin: ResolvedPin): void {
  if (pin.platform === 'kalshi' && pin.ticker) {
    if (pin.ticker.includes('CROSSCATEGORY') || pin.ticker.startsWith('KXMVE')) return;
    tickerToCanonicalMap.set(pin.ticker, pin.canonicalId);
    if (!marketPrices.has(pin.canonicalId)) {
      marketPrices.set(pin.canonicalId, pin.prices ?? [0.5, 0.5]);
    }
    if (pin.prices?.some((price) => Number.isFinite(price) && price > 0)) {
      queuePriceUpdate(pin.canonicalId, pin.prices);
    }
    pushKalshiPin(pin.ticker);
    seedKalshiPin(pin.ticker);
    return;
  }
  if (pin.platform !== 'polymarket') return;
  if (!marketPrices.has(pin.canonicalId)) {
    marketPrices.set(
      pin.canonicalId,
      pin.prices ?? new Array(Math.max(pin.tokens.length, 2)).fill(0)
    );
  }
  for (const token of pin.tokens) {
    tokenToCanonicalMap.set(token.id, {
      canonicalId: pin.canonicalId,
      outcomeIndex: token.outcomeIndex,
      isMulti: token.isMulti,
    });
  }
  const prices = pin.prices ?? [];
  if (prices.some((price) => Number.isFinite(price) && price > 0)) {
    queuePriceUpdate(pin.canonicalId, prices);
  }
  pushPolymarketPin(pin.tokens.map((token) => token.id));
}

async function loadAndApplyPin(canonicalId: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from('markets')
    .select('canonical_id, platform, external_id, prices, raw_data')
    .eq('canonical_id', canonicalId)
    .maybeSingle();

  if (!livePinnedIds().includes(canonicalId)) return;
  if (error || !data) {
    console.warn(`[Price Stream] pin miss ${canonicalId}: ${error?.message ?? 'not in markets'}`);
    return;
  }

  const platform = String(data.platform);
  const prices = Array.isArray(data.prices)
    ? (data.prices as unknown[]).map((price) => Number(price))
    : null;

  if (platform === 'kalshi') {
    const ticker = String(data.external_id || canonicalId.replace(/^kalshi_/, '')).trim();
    if (!ticker) return;
    const pin: ResolvedPin = {
      canonicalId,
      platform: 'kalshi',
      ticker,
      tokens: [],
      prices,
    };
    resolvedPins.set(canonicalId, pin);
    applyResolvedPin(pin);
    return;
  }

  if (platform !== 'polymarket') return;
  const tokens = parseTokenIds(data.raw_data ?? {});
  const isMulti = canonicalId.includes('_event_') || tokens.length > 2;
  const subscribeTokens = (isMulti ? tokens : tokens.slice(0, 1)).filter(Boolean);
  const pin: ResolvedPin = {
    canonicalId,
    platform: 'polymarket',
    ticker: null,
    tokens: subscribeTokens.map((id, outcomeIndex) => ({ id, outcomeIndex, isMulti })),
    prices,
  };
  resolvedPins.set(canonicalId, pin);
  applyResolvedPin(pin);
}

function attachPinnedMarket(canonicalId: string): Promise<void> {
  const existing = resolvedPins.get(canonicalId);
  if (existing) {
    applyResolvedPin(existing);
    return Promise.resolve();
  }
  const inflight = pinLoads.get(canonicalId);
  if (inflight) return inflight;
  const job = loadAndApplyPin(canonicalId).finally(() => {
    pinLoads.delete(canonicalId);
  });
  pinLoads.set(canonicalId, job);
  return job;
}

function detachPinnedMarket(canonicalId: string): void {
  resolvedPins.delete(canonicalId);
}

async function refreshKalshiSubscriptions(initial = false) {
  const nextTickers = await loadActiveKalshiTickers();
  const nextSet = new Set(nextTickers);
  const toAdd = nextTickers.filter((t) => !kalshiSubscribed.has(t));
  const toRemove = [...kalshiSubscribed].filter((t) => !nextSet.has(t));

  if (kalshiWs?.readyState === WebSocket.OPEN) {
    if (initial || kalshiChannelSids.size === 0) {
      if (nextTickers.length > 0) subscribeKalshiTickers(kalshiWs, nextTickers);
    } else {
      updateKalshiSubscription(kalshiWs, 'add_markets', toAdd);
      updateKalshiSubscription(kalshiWs, 'delete_markets', toRemove);
    }
  }

  kalshiSubscribed = nextSet;
  console.log(
    `[Price Stream][Kalshi] subscribe refresh: tickers=${nextTickers.length} +${toAdd.length} -${toRemove.length}${initial ? ' (initial)' : ''}`
  );
}

let kalshiDropsLogged = 0;

function handleKalshiMessage(raw: string) {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  switch (msg.type) {
    case 'subscribed': {
      const channel = msg.msg?.channel ?? msg.channel;
      const sid = msg.msg?.sid ?? msg.sid;
      if (channel && sid != null) {
        kalshiChannelSids.set(channel, sid);
        flushPendingKalshiAdds();
      }
      break;
    }
    case 'ticker': {
      const payload = msg.msg ?? msg;
      const ticker = payload.market_ticker != null ? String(payload.market_ticker) : '';
      if (!ticker) break;
      // Live chart: bid/ask midpoint only (same principle as Polymarket CLOB mid).
      const mid = extractKalshiMidpoint(payload);
      if (mid == null) {
        if (kalshiDropsLogged < 5) {
          kalshiDropsLogged += 1;
          console.warn(
            `[Price Stream][Kalshi] ticker without mid ${ticker} bid=${payload.yes_bid_dollars ?? payload.yes_bid} ask=${payload.yes_ask_dollars ?? payload.yes_ask}`
          );
        }
        break;
      }
      recordKalshiYesPrice(ticker, mid);
      break;
    }
    case 'trade': {
      const payload = msg.msg ?? msg;
      const ticker = payload.market_ticker != null ? String(payload.market_ticker) : '';
      if (!ticker || !tickerToCanonicalMap.has(ticker)) break;
      // Trades feed candle volume only — do not overwrite live chart midpoint.
      const tradePrice = extractKalshiTradePrice(payload);
      if (tradePrice == null) break;
      let volume = 0;
      if (payload.count_fp != null && Number.isFinite(Number(payload.count_fp))) {
        volume = Number(payload.count_fp);
      } else if (payload.count != null && Number.isFinite(Number(payload.count))) {
        volume = Number(payload.count);
      }
      candleAggregator.ingestLiveTick('kalshi', ticker, tradePrice, {
        isTrade: true,
        volume,
      });
      break;
    }
    case 'error':
      console.error(
        `[Price Stream][Kalshi] ws error code=${msg.msg?.code}: ${msg.msg?.msg ?? 'unknown'}`
      );
      break;
    default:
      break;
  }
}

async function connectKalshiStream(): Promise<void> {
  if (kalshiWs) {
    try {
      kalshiWs.removeAllListeners();
      kalshiWs.terminate();
    } catch {
      // ignore
    }
    kalshiWs = null;
  }

  let headers: Record<string, string>;
  try {
    headers = buildKalshiWsAuthHeaders();
  } catch (err: any) {
    console.error('[Price Stream][Kalshi] missing credentials:', err.message);
    setTimeout(() => connectKalshiStream().catch(console.error), 15_000);
    return;
  }

  const tickers = await loadActiveKalshiTickers();
  if (tickers.length === 0) {
    console.warn('[Price Stream][Kalshi] no active tickers — retry in 10s');
    setTimeout(() => connectKalshiStream().catch(console.error), 10_000);
    return;
  }

  console.log(`[Price Stream][Kalshi] connecting ${KALSHI_WS_URL} (${tickers.length} tickers)`);
  const ws = new WebSocket(KALSHI_WS_URL, { headers, lookup: venueLookup });
  kalshiWs = ws;
  kalshiChannelSids.clear();
  kalshiMsgId = 1;

  ws.on('open', async () => {
    kalshiReconnectAttempt = 0;
    console.log('[Price Stream][Kalshi] WebSocket connected');
    try {
      await refreshKalshiSubscriptions(true);
    } catch (err: any) {
      console.error('[Price Stream][Kalshi] initial subscribe:', err.message);
    }

    clearInterval(kalshiRefreshTimer);
    kalshiRefreshTimer = setInterval(() => {
      refreshKalshiSubscriptions(false).catch((err) =>
        console.error('[Price Stream][Kalshi] refresh:', err.message)
      );
    }, KALSHI_REFRESH_MS);
  });

  ws.on('message', (data: WebSocket.Data) => {
    handleKalshiMessage(data.toString());
  });

  ws.on('unexpected-response', (_req, res) => {
    let body = '';
    res.on('data', (chunk) => {
      body += chunk;
    });
    res.on('end', () => {
      console.error(
        `[Price Stream][Kalshi] handshake failed status=${res.statusCode} ${body.slice(0, 300)}`
      );
    });
  });

  ws.on('close', (code) => {
    console.warn(`[Price Stream][Kalshi] closed code=${code}`);
    clearInterval(kalshiRefreshTimer);
    kalshiSubscribed.clear();
    kalshiChannelSids.clear();
    kalshiReconnectAttempt += 1;
    const delay = Math.min(30_000, RECONNECT_BASE_MS * 2 ** Math.min(kalshiReconnectAttempt, 4));
    setTimeout(() => connectKalshiStream().catch(console.error), delay);
  });

  ws.on('error', (error) => {
    console.error('[Price Stream][Kalshi] WS error:', error.message);
  });
}

// ─── Flush → Fastify client WebSocket (not Supabase Realtime) ─────────────────

async function flushPriceUpdates(): Promise<void> {
  if (updateQueue.size === 0) return;

  const updates = [...updateQueue.values()];
  updateQueue.clear();

  const timestamp = new Date().toISOString();

  // Primary: push live ticks to connected frontend sockets (/api/v1/ws)
  for (const update of updates) {
    broadcastPriceUpdate(update.canonicalId, update.prices);
  }

  // Secondary: persist in small concurrent batches (avoids Cloudflare 520 from burst updates)
  const CONCURRENCY = 8;
  const toWrite = updates.filter((update) =>
    pricesNeedPersist(lastPersistedPrices.get(update.canonicalId), update.prices)
  );
  for (let i = 0; i < toWrite.length; i += CONCURRENCY) {
    const slice = toWrite.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (update) => {
        const { error } = await supabaseAdmin
          .from('markets')
          .update({
            prices: update.prices,
            updated_at: timestamp,
          })
          .eq('canonical_id', update.canonicalId);
        if (!error) lastPersistedPrices.set(update.canonicalId, [...update.prices]);
        return error;
      })
    );

    for (const error of results) {
      if (!error) continue;
      const msg = String(error.message ?? '');
      if (msg.includes('<!DOCTYPE html') || msg.includes('520')) {
        console.warn(
          '[Price Stream] Supabase temporarily unavailable (520) — WS broadcast still delivered'
        );
        return; // stop further DB writes this flush; WS already succeeded
      }
      console.warn('[Price Stream] price persist warning:', msg.slice(0, 200));
    }
  }
}

export function startPriceStreamWorker(): void {
  console.log('[Price Stream] starting Polymarket + Kalshi exchange WebSockets → Fastify /api/v1/ws');
  watchLivePins((canonicalId, pinned) => {
    if (pinned) void attachPinnedMarket(canonicalId);
    else detachPinnedMarket(canonicalId);
  });
  connectPolymarketStream().catch(console.error);
  connectKalshiStream().catch(console.error);
  setInterval(() => flushPriceUpdates().catch(console.error), FLUSH_MS);
  // Candle persistence is separate so DB upserts never block WS price broadcast
  setInterval(() => {
    candleAggregator.flushLiveCandles().catch((err) =>
      console.warn('[Price Stream] candle flush:', err?.message ?? err)
    );
  }, CANDLE_FLUSH_MS);
}

if (process.argv[1]?.endsWith('priceStream.ts')) {
  startPriceStreamWorker();
}
