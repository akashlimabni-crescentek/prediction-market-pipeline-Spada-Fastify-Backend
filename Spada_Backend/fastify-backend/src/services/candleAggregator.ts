import { supabaseAdmin } from '../lib/supabase.js';
import { kalshiGet } from '../lib/kalshiClient.js';
import {
  GAP_FILL_CAP,
  SUB_INTERVAL_LADDER,
  applyLivePrice,
  bucketStartMs,
  buildFormingCandle,
  computeGapFills,
  intervalMs,
  maxCandlesForResolution,
  stripFormingBucket,
  type FormingCandleRow,
  type FormingSourceInterval,
  type LiveTailCandle,
} from '../lib/formingCandle.js';
import {
  DEFAULT_CANDLE_SYNC_MARKET_LIMIT,
  DEFAULT_CANDLE_SYNC_VOLUME_SHARE,
  DEFAULT_CANDLE_SYNC_WATCH_SHARE,
  formatCandleSyncStats,
  parseShare,
  selectMarketsForCandleSync,
  type CandleSyncCycleStats,
  type SyncMarketRow,
} from '../lib/candleSyncPlan.js';
import {
  POLY_TRADES_MAX_OFFSET,
  POLY_TRADES_PAGE_LIMIT,
  POLY_TRADES_REQUEST_DELAY_MS,
  POLY_TRADES_WINDOW_SEC,
  accumulateTradeVolume,
  bisectTimeWindow,
  nextRotatedOffset,
  parseCandleSyncMarketLimit,
  planTradeWindows,
  resolveOffsetCapAction,
  retryDelayMs,
  rotatedPageRanges,
  shouldRetryHttpStatus,
  type TimeWindow,
} from '../lib/polyTradesSync.js';

export interface Candle {
  ticker: string;
  bucket: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export const CANDLE_RESOLUTIONS = ['5m', '15m', '1h', '4h', '1d', '1w'] as const;
export type CandleResolution = (typeof CANDLE_RESOLUTIONS)[number];

/** Stored base interval that feeds get_candles aggregation */
export const BASE_OHLC_INTERVAL = '1m' as const;
export type StoredInterval = typeof BASE_OHLC_INTERVAL | CandleResolution;

type Platform = 'polymarket' | 'kalshi';

const RESOLUTION_SECONDS: Record<CandleResolution, number> = {
  '5m': 5 * 60,
  '15m': 15 * 60,
  '1h': 60 * 60,
  '4h': 4 * 60 * 60,
  '1d': 24 * 60 * 60,
  '1w': 7 * 24 * 60 * 60,
};

const INTERVAL_SECONDS: Record<StoredInterval, number> = {
  '1m': 60,
  ...RESOLUTION_SECONDS,
};

/** Lookback window large enough to fill resolution-aware bar budgets */
const LOOKBACK_SECONDS: Record<CandleResolution, number> = {
  '5m': 30 * 24 * 60 * 60,
  '15m': 30 * 24 * 60 * 60,
  '1h': 90 * 24 * 60 * 60,
  '4h': 90 * 24 * 60 * 60,
  '1d': 365 * 24 * 60 * 60,
  '1w': 365 * 24 * 60 * 60,
};

/** @deprecated Prefer maxCandlesForResolution — kept for callers/tests expecting a default. */
const MAX_CANDLES = 100;
const INTERVAL_1M_MS = 60_000;
const UPSERT_BATCH = 100;

interface OhlcRow {
  platform: Platform;
  ticker: string;
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trade_count: number;
  interval: StoredInterval;
}

interface LiveBucket {
  platform: Platform;
  ticker: string;
  startMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradeCount: number;
  hadActivity: boolean;
}

export function isCandleResolution(value: unknown): value is CandleResolution {
  return typeof value === 'string' && (CANDLE_RESOLUTIONS as readonly string[]).includes(value);
}

function floorToBucketSec(tsSec: number, bucketSec: number): number {
  return Math.floor(tsSec / bucketSec) * bucketSec;
}

function floorToBucketMs(tsMs: number, bucketMs: number): number {
  return Math.floor(tsMs / bucketMs) * bucketMs;
}

function roundPrice(n: number): number {
  return Number(n.toFixed(4));
}

function sortNewestFirst(candles: Candle[]): Candle[] {
  return candles.sort(
    (a, b) => new Date(b.bucket).getTime() - new Date(a.bucket).getTime()
  );
}

function limitCandles(candles: Candle[], resolution?: CandleResolution): Candle[] {
  const max = resolution ? maxCandlesForResolution(resolution) : MAX_CANDLES;
  return sortNewestFirst(candles).slice(0, max);
}

/** Aggregate fine-grained candles into a coarser resolution. */
function aggregateCandles(
  source: Candle[],
  resolution: CandleResolution,
  canonicalId: string
): Candle[] {
  const bucketSec = RESOLUTION_SECONDS[resolution];
  const buckets = new Map<number, Candle>();
  const ordered = [...source].sort(
    (a, b) => new Date(a.bucket).getTime() - new Date(b.bucket).getTime()
  );

  for (const c of ordered) {
    const tsSec = Math.floor(new Date(c.bucket).getTime() / 1000);
    if (!Number.isFinite(tsSec)) continue;
    const start = floorToBucketSec(tsSec, bucketSec);
    const existing = buckets.get(start);
    if (!existing) {
      buckets.set(start, {
        ticker: canonicalId,
        bucket: new Date(start * 1000).toISOString(),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume || 0,
      });
      continue;
    }
    existing.high = Math.max(existing.high, c.high);
    existing.low = Math.min(existing.low, c.low);
    existing.close = c.close;
    existing.volume += c.volume || 0;
  }

  return limitCandles([...buckets.values()], resolution);
}

/** Aggregate OhlcRow list into a coarser StoredInterval (ascending). */
function aggregateOhlcRows(source: OhlcRow[], target: StoredInterval): OhlcRow[] {
  const bucketSec = INTERVAL_SECONDS[target];
  const buckets = new Map<number, OhlcRow>();
  const ordered = [...source].sort(
    (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()
  );

  for (const c of ordered) {
    const tsSec = Math.floor(new Date(c.ts).getTime() / 1000);
    if (!Number.isFinite(tsSec)) continue;
    const start = floorToBucketSec(tsSec, bucketSec);
    const existing = buckets.get(start);
    if (!existing) {
      buckets.set(start, {
        platform: c.platform,
        ticker: c.ticker,
        ts: new Date(start * 1000).toISOString(),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume || 0,
        trade_count: c.trade_count || 0,
        interval: target,
      });
      continue;
    }
    existing.high = Math.max(existing.high, c.high);
    existing.low = Math.min(existing.low, c.low);
    existing.close = c.close;
    existing.volume += c.volume || 0;
    existing.trade_count += c.trade_count || 0;
  }

  return [...buckets.values()].sort(
    (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()
  );
}

function pointsToCandles(
  points: { t: number; p: number }[],
  resolution: CandleResolution,
  canonicalId: string
): Candle[] {
  const bucketSec = RESOLUTION_SECONDS[resolution];
  const buckets = new Map<number, { prices: number[]; count: number }>();
  const ordered = [...points].sort((a, b) => Number(a.t) - Number(b.t));

  for (const point of ordered) {
    if (point?.t == null || point?.p == null) continue;
    const price = Number(point.p);
    if (!Number.isFinite(price)) continue;
    const start = floorToBucketSec(Number(point.t), bucketSec);
    let bucket = buckets.get(start);
    if (!bucket) {
      bucket = { prices: [], count: 0 };
      buckets.set(start, bucket);
    }
    bucket.prices.push(price);
    bucket.count += 1;
  }

  const candles: Candle[] = [];
  for (const [bucketTs, data] of buckets.entries()) {
    const p = data.prices;
    candles.push({
      ticker: canonicalId,
      bucket: new Date(bucketTs * 1000).toISOString(),
      open: Number(p[0].toFixed(4)),
      high: Number(Math.max(...p).toFixed(4)),
      low: Number(Math.min(...p).toFixed(4)),
      close: Number(p[p.length - 1].toFixed(4)),
      // CLOB history has no trade volume — keep 0 for storage-compatible semantics.
      // (API-only fallback previously used count*50; storage must not invent volume.)
      volume: 0,
    });
  }
  return limitCandles(candles, resolution);
}

function pointsToOhlcRows(
  points: { t: number; p: number }[],
  platform: Platform,
  ticker: string,
  interval: StoredInterval
): OhlcRow[] {
  const bucketSec = INTERVAL_SECONDS[interval];
  const buckets = new Map<number, { open: number; high: number; low: number; close: number; count: number }>();

  const ordered = [...points].sort((a, b) => Number(a.t) - Number(b.t));
  for (const point of ordered) {
    if (point?.t == null || point?.p == null) continue;
    const price = Number(point.p);
    if (!Number.isFinite(price)) continue;
    const start = floorToBucketSec(Number(point.t), bucketSec);
    const existing = buckets.get(start);
    if (!existing) {
      buckets.set(start, {
        open: price,
        high: price,
        low: price,
        close: price,
        count: 1,
      });
    } else {
      existing.high = Math.max(existing.high, price);
      existing.low = Math.min(existing.low, price);
      existing.close = price;
      existing.count += 1;
    }
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([start, b]) => ({
      platform,
      ticker,
      ts: new Date(start * 1000).toISOString(),
      open: roundPrice(b.open),
      high: roundPrice(b.high),
      low: roundPrice(b.low),
      close: roundPrice(b.close),
      volume: 0,
      trade_count: b.count,
      interval,
      }));
    }

function mapRpcRows(
  rows: any[],
  canonicalId: string,
  resolution?: CandleResolution
): Candle[] {
  return limitCandles(
    (rows ?? []).map((row) => ({
      ticker: canonicalId,
      bucket: new Date(row.bucket_start ?? row.bucket ?? row.ts).toISOString(),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume || 0),
    })).filter(
      (c) =>
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close) &&
        !Number.isNaN(new Date(c.bucket).getTime())
    ),
    resolution
  );
}

/** CLOB token ids in outcome order. Index 0 stays the primary series. */
function polyTokenIds(raw: any): string[] {
  const value = raw?.clobTokenIds ?? raw?.clob_token_ids;
  if (Array.isArray(value)) return value.map((id) => String(id)).filter(Boolean);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((id) => String(id)).filter(Boolean);
    } catch {
      return value ? [value] : [];
    }
  }
  if (Array.isArray(raw?.tokens)) {
    return raw.tokens
      .map((token: any) => token?.token_id ?? token?.clobTokenId ?? token?.id)
      .filter(Boolean)
      .map(String);
  }
  return [];
}

function getPrimaryPolyToken(raw: any): string | null {
  const fromArray = raw?.clobTokenIds?.[0] || raw?.tokens?.[0]?.token_id || raw?.tokens?.[0]?.clobTokenId;
  if (fromArray) return String(fromArray);
  if (typeof raw?.clobTokenIds === 'string') {
    try {
      const parsed = JSON.parse(raw.clobTokenIds);
      if (Array.isArray(parsed) && parsed[0]) return String(parsed[0]);
    } catch {
      // ignore
    }
  }
  return null;
}

const POLY_DATA_API = 'https://data-api.polymarket.com';

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve Data API filter from stored market identity (no invented IDs). */
function getPolymarketTradeQuery(
  market: { canonical_id: string; external_id?: string | null; raw_data: any }
): { market?: string; eventId?: string } | null {
  const raw = market.raw_data ?? {};
  if (raw.conditionId) {
    return { market: String(raw.conditionId) };
  }
  if (typeof market.canonical_id === 'string' && market.canonical_id.startsWith('polymarket_event_')) {
    const eventId = String(market.external_id || market.canonical_id.replace('polymarket_event_', ''));
    if (/^\d+$/.test(eventId)) return { eventId };
  }
  const ext = market.external_id ? String(market.external_id) : '';
  if (/^0x[a-fA-F0-9]{64}$/.test(ext)) {
    return { market: ext };
  }
  return null;
}

async function fetchPolymarketDataApi(url: string): Promise<any> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (res.ok) {
        return res.json();
      }
      const body = await res.text().catch(() => '');
      lastError = new Error(`Data API ${res.status}${body ? `: ${body.slice(0, 120)}` : ''}`);
      // Permanent client errors (4xx except 429) must not be retried.
      if (!shouldRetryHttpStatus(res.status) || attempt >= 2) {
        throw lastError;
      }
      await sleepMs(retryDelayMs(attempt, res.status));
    } catch (err: any) {
      // Re-throw exhausted / non-retryable HTTP errors from the block above.
      if (err instanceof Error && err.message.startsWith('Data API ')) {
        const status = Number(/^Data API (\d+)/.exec(err.message)?.[1]);
        if (Number.isFinite(status) && !shouldRetryHttpStatus(status)) {
          throw err;
        }
        if (attempt >= 2) throw err;
      }
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt >= 2) break;
      await sleepMs(retryDelayMs(attempt));
    }
  }
  throw lastError ?? new Error('Data API request failed');
}

/**
 * Map chart resolution → Kalshi candlesticks `period_interval` (minutes).
 * Kalshi natively supports only 1 / 60 / 1440. Other resolutions are aggregated
 * from the finest suitable native period (never silently returned as 1h).
 *
 *   5m, 15m  → 1m  then aggregate
 *   1h       → 60  native
 *   4h       → 60  then aggregate (avoids 10k-bar cap of 1m over long windows)
 *   1d       → 1440 native
 *   1w       → 1440 then aggregate
 */
function kalshiNativePeriod(resolution: CandleResolution | '1m'): number {
  switch (resolution) {
    case '1m':
    case '5m':
    case '15m':
      return 1;
    case '1h':
    case '4h':
      return 60;
    case '1d':
    case '1w':
      return 1440;
    default:
      return 60;
  }
}

/** Normalize Kalshi price to 0–1 probability. Prefer *_dollars; treat raw >1 as cents. */
function kalshiPriceToProb(dollars: unknown, raw?: unknown): number {
  if (dollars != null && dollars !== '') {
    const n = Number(dollars);
    if (Number.isFinite(n)) return n;
  }
  if (raw != null && raw !== '') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return NaN;
    return n > 1 ? n / 100 : n;
  }
  return NaN;
}

function kalshiCandleVolume(candle: any): number {
  const fp = candle?.volume_fp;
  if (fp != null && fp !== '') {
    const n = Number(fp);
    if (Number.isFinite(n)) return n;
  }
  const v = Number(candle?.volume ?? 0);
  return Number.isFinite(v) ? v : 0;
}

/** Cap Kalshi window so period_interval * bars stays under API max (~10000). */
function kalshiWindowStartSec(resolution: CandleResolution | '1m', periodMinutes: number, endTs: number): number {
  const desired =
    resolution === '1m'
      ? 2 * 24 * 60 * 60
      : LOOKBACK_SECONDS[resolution as CandleResolution];
  const maxBars = 9000;
  const maxWindowSec = maxBars * periodMinutes * 60;
  return endTs - Math.min(desired, maxWindowSec);
}

function polymarketFidelityMinutes(resolution: CandleResolution | '1m'): number {
  switch (resolution) {
    case '1m':
      return 1;
    case '5m':
      return 5;
    case '15m':
      return 15;
    case '1h':
      return 60;
    case '4h':
      return 60;
    case '1d':
      return 1440;
    case '1w':
      return 1440;
    default:
      return 60;
  }
}

function liveKey(platform: Platform, ticker: string): string {
  return `${platform}:${ticker}`;
}

class CandleAggregator {
  /** Open 1m live buckets keyed by platform:ticker */
  private liveBuckets = new Map<string, LiveBucket>();
  /** Closed 1m buckets waiting for DB upsert */
  private closedQueue: OhlcRow[] = [];
  private flushing = false;
  /** Fair-rotation cursor over non-priority active markets (in-process). */
  private syncMarketCursor = 0;
  /** Prevent overlapping historical sync cycles. */
  private historySyncRunning = false;
  /** Last completed cycle stats (ops / health). */
  private lastSyncStats: CandleSyncCycleStats | null = null;

  /** Read-only snapshot of the last candle-sync cycle (no secrets). */
  getLastCandleSyncStats(): CandleSyncCycleStats | null {
    return this.lastSyncStats ? { ...this.lastSyncStats } : null;
  }

  /**
   * Resolution-aware OHLCV fetch.
   * Prefer Supabase get_candles (buckets stored 1m OHLC), then price_history, then exchange APIs.
   * Appends a forming candle for the open bucket (finer DB + live 1m tail).
   * Completed historical bars for the open bucket are stripped so they are not duplicated.
   */
  async getCandles(
    canonicalId: string,
    resolution: CandleResolution = '1h',
    outcomeIndex = 0
  ): Promise<Candle[]> {
    if (outcomeIndex > 0) {
      return this.getOutcomeCandles(canonicalId, resolution, outcomeIndex);
    }
    if (!isCandleResolution(resolution)) {
      throw new Error(
        `Unsupported resolution "${resolution}". Allowed: ${CANDLE_RESOLUTIONS.join(', ')}`
      );
    }

    const { data: market } = await supabaseAdmin
      .from('markets')
      .select('canonical_id, platform, external_id, raw_data, prices')
      .eq('canonical_id', canonicalId)
      .maybeSingle();

    if (!market) {
      if (resolution === '1h') {
        const fromView = await this.fromOhlcv1hView(canonicalId, canonicalId, resolution);
        if (fromView.length) return fromView;
      }
      return [];
    }

    let historical: Candle[] = [];

    const fromRpc = await this.fromGetCandlesRpc(market, resolution);
    if (fromRpc.length) {
      historical = fromRpc;
    } else {
      const fromHistory = await this.fromPriceHistory(market, resolution);
      if (fromHistory.length) {
        historical = fromHistory;
      } else if (resolution === '1h') {
        const tickers = [canonicalId, market.external_id].filter(Boolean).map(String);
        for (const ticker of tickers) {
          const fromView = await this.fromOhlcv1hView(ticker, canonicalId, resolution);
          if (fromView.length) {
            historical = fromView;
            break;
          }
        }
      } else if (market.platform === 'polymarket') {
        historical = await this.fromPolymarketApi(market, resolution);
      } else if (market.platform === 'kalshi') {
        historical = await this.fromKalshiApi(market, resolution);
      }
    }

    return this.withFormingCandle(market, resolution, historical);
  }

  /**
   * Fetch candles for a custom lookback (used by ratios: 7d of 5m bars).
   * Uses existing get_candles RPC / price_history without the chart MAX_CANDLES=100 trim.
   */
  async getCandlesSince(
    canonicalId: string,
    resolution: CandleResolution,
    fromMs: number,
    toMs = Date.now(),
    outcomeIndex = 0
  ): Promise<Candle[]> {
    if (outcomeIndex > 0) {
      return this.getOutcomeCandlesSince(canonicalId, resolution, fromMs, toMs, outcomeIndex);
    }
    if (!isCandleResolution(resolution)) {
      throw new Error(
        `Unsupported resolution "${resolution}". Allowed: ${CANDLE_RESOLUTIONS.join(', ')}`
      );
    }

    const { data: market } = await supabaseAdmin
      .from('markets')
      .select('canonical_id, platform, external_id, raw_data, prices')
      .eq('canonical_id', canonicalId)
      .maybeSingle();

    if (!market) return [];

    const platform = market.platform;
    let ticker: string | null = null;
    if (platform === 'kalshi') {
      ticker = market.external_id ? String(market.external_id) : null;
    } else if (platform === 'polymarket') {
      ticker = getPrimaryPolyToken(market.raw_data ?? {});
    }

    const inWindow = (rows: Candle[]) =>
      rows
        .filter((c) => {
          const t = new Date(c.bucket).getTime();
          return Number.isFinite(t) && t >= fromMs && t <= toMs;
        })
        .sort((a, b) => new Date(a.bucket).getTime() - new Date(b.bucket).getTime());

    // Price history is indexed by ticker. Start it with the RPC so a slow
    // aggregation does not add another round trip before we can answer.
    const historyPromise = this.fromPriceHistory(market, resolution).catch(() => [] as Candle[]);

    let rpcTimedOut = false;
    if (ticker) {
      try {
        const rpc = supabaseAdmin.rpc('get_candles', {
          p_platform: platform,
          p_ticker: ticker,
          p_bucket_seconds: RESOLUTION_SECONDS[resolution],
          p_from: new Date(fromMs).toISOString(),
          p_to: new Date(toMs).toISOString(),
        });
        const { data, error } = await Promise.race([
          rpc,
          new Promise<{ data: null; error: { message: string } }>((resolve) => {
            setTimeout(
              () => resolve({ data: null, error: { message: 'get_candles timed out' } }),
              4_000
            );
          }),
        ]);
        if (!error && Array.isArray(data) && data.length > 0) {
          // Do not apply chart MAX_CANDLES limit — ratios need full window.
          return mapRpcRows(data, market.canonical_id).sort(
            (a, b) => new Date(a.bucket).getTime() - new Date(b.bucket).getTime()
          );
        }
        rpcTimedOut = error?.message === 'get_candles timed out';
      } catch (err: any) {
        console.warn(`[CandleAggregator] getCandlesSince RPC: ${err?.message ?? err}`);
      }
    }

    const fromHistory = inWindow(await historyPromise);
    if (fromHistory.length) return fromHistory;

    // The venue call is the same fallback the chart uses. Skip it when the
    // database call already failed to answer: that second timeout was stacking
    // another ~4s onto ratios and still returned no bars.
    if (rpcTimedOut) return [];

    let fromApi: Candle[] = [];
    if (market.platform === 'polymarket') {
      fromApi = await this.fromPolymarketApi(market, resolution);
    } else if (market.platform === 'kalshi') {
      fromApi = await this.fromKalshiApi(market, resolution);
    }
    return inWindow(fromApi);
  }

  /**
   * History for a non-primary outcome. Stored series and the live forming
   * candle belong to token 0, so this reads that outcome's own CLOB token
   * and does not attach the primary forming bar.
   * Outcome 0 never enters here.
   */
  private async getOutcomeCandles(
    canonicalId: string,
    resolution: CandleResolution,
    outcomeIndex: number
  ): Promise<Candle[]> {
    if (!isCandleResolution(resolution)) {
      throw new Error(
        `Unsupported resolution "${resolution}". Allowed: ${CANDLE_RESOLUTIONS.join(', ')}`
      );
    }
    const scoped = await this.marketScopedToOutcome(canonicalId, outcomeIndex);
    if (!scoped) return [];

    const fromHistory = await this.fromPriceHistory(scoped, resolution);
    if (fromHistory.length) return limitCandles(fromHistory, resolution);

    const fromApi = await this.fromPolymarketApi(scoped, resolution);
    return limitCandles(fromApi, resolution);
  }

  /** Stored bars only for a non-primary outcome. No venue call on the 15s finer loop. */
  private async getOutcomeCandlesSince(
    canonicalId: string,
    resolution: CandleResolution,
    fromMs: number,
    toMs: number,
    outcomeIndex: number
  ): Promise<Candle[]> {
    if (!isCandleResolution(resolution)) {
      throw new Error(
        `Unsupported resolution "${resolution}". Allowed: ${CANDLE_RESOLUTIONS.join(', ')}`
      );
    }
    const scoped = await this.marketScopedToOutcome(canonicalId, outcomeIndex);
    if (!scoped) return [];

    const rows = await this.fromPriceHistory(scoped, resolution);
    return rows
      .filter((candle) => {
        const t = new Date(candle.bucket).getTime();
        return Number.isFinite(t) && t >= fromMs && t <= toMs;
      })
      .sort((a, b) => new Date(a.bucket).getTime() - new Date(b.bucket).getTime());
  }

  /**
   * Copy the market with clobTokenIds set to one outcome token so the existing
   * primary-token readers stay unchanged.
   */
  private async marketScopedToOutcome(
    canonicalId: string,
    outcomeIndex: number
  ): Promise<{ canonical_id: string; platform: string; external_id: string | null; raw_data: any } | null> {
    const { data: market } = await supabaseAdmin
      .from('markets')
      .select('canonical_id, platform, external_id, raw_data')
      .eq('canonical_id', canonicalId)
      .maybeSingle();
    if (!market || market.platform !== 'polymarket') return null;

    const tokenId = polyTokenIds(market.raw_data ?? {})[outcomeIndex];
    if (!tokenId) return null;

    return {
      canonical_id: market.canonical_id,
      platform: market.platform,
      external_id: market.external_id ? String(market.external_id) : null,
      raw_data: { ...(market.raw_data ?? {}), clobTokenIds: [tokenId] },
    };
  }

  /**
   * Ingest a live price tick into the current 1m bucket.
   * Does not block price broadcasting — persistence happens in flushLiveCandles().
   * Out-of-order ticks for a prior minute after the bucket rolled are ignored for
   * that closed minute (they open/update only the current bucket by wall clock).
   * Duplicate price ticks update OHLC but only `isTrade` adds volume.
   */
  ingestLiveTick(
    platform: Platform,
    ticker: string,
    price: number,
    options: { tsMs?: number; volume?: number; isTrade?: boolean } = {}
  ): void {
    if (!ticker || !Number.isFinite(price) || price < 0 || price > 1) return;

    const tsMs = options.tsMs ?? Date.now();
    const startMs = floorToBucketMs(tsMs, INTERVAL_1M_MS);
    const key = liveKey(platform, ticker);
    let bucket = this.liveBuckets.get(key);

    // Ignore ticks that belong to an already-closed minute (out-of-order / late).
    if (bucket && startMs < bucket.startMs) {
      return;
    }

    // Close current + carry-forward quiet minutes when the live bucket jumps.
    if (bucket && startMs > bucket.startMs) {
      this.advanceLiveBucketTo(key, bucket, startMs);
      bucket = this.liveBuckets.get(key);
    }

    if (!bucket) {
      bucket = {
        platform,
        ticker: String(ticker),
        startMs,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 0,
        tradeCount: 0,
        hadActivity: false,
      };
      this.liveBuckets.set(key, bucket);
    }

    applyLivePrice(bucket, price, {
      isTrade: options.isTrade,
      volume: options.volume,
    });
    bucket.hadActivity = true;
  }

  /**
   * Close the open 1m bucket and synthesize flat 1m bars for skipped quiet
   * minutes up to (but not including) `upToStartMs`.
   */
  private advanceLiveBucketTo(
    key: string,
    bucket: LiveBucket,
    upToStartMs: number
  ): void {
    if (bucket.hadActivity) {
      this.closedQueue.push(this.liveBucketToRow(bucket));
    }

    const { fills, capExceeded } = computeGapFills(
      bucket.startMs,
      upToStartMs,
      bucket.close,
      INTERVAL_1M_MS,
      { cap: GAP_FILL_CAP }
    );
    if (capExceeded) {
      console.warn(
        `[CandleAggregator] 1m gap-fill capped at ${GAP_FILL_CAP} for ${key} → ${new Date(upToStartMs).toISOString()}`
      );
    }
    for (const fill of fills) {
      this.closedQueue.push({
        platform: bucket.platform,
        ticker: bucket.ticker,
        ts: fill.ts,
        open: fill.open,
        high: fill.high,
        low: fill.low,
        close: fill.close,
        volume: 0,
        trade_count: 0,
        interval: BASE_OHLC_INTERVAL,
      });
    }

    // Open the new minute with carried close; caller applies the real tick next.
    const carry = fills.length ? fills[fills.length - 1].close : bucket.close;
    this.liveBuckets.set(key, {
      platform: bucket.platform,
      ticker: bucket.ticker,
      startMs: upToStartMs,
      open: carry,
      high: carry,
      low: carry,
      close: carry,
      volume: 0,
      tradeCount: 0,
      hadActivity: false,
    });
  }

  /** Peek open in-memory 1m bucket (not yet flushed). */
  peekLiveBucket(platform: Platform, ticker: string): LiveBucket | null {
    return this.liveBuckets.get(liveKey(platform, ticker)) ?? null;
  }

  /** Closed 1m rows waiting for DB upsert (flush lag bridge for forming candles). */
  peekPendingClosed1m(platform: Platform, ticker: string): OhlcRow[] {
    return this.closedQueue.filter(
      (r) => r.platform === platform && r.ticker === String(ticker)
    );
  }

  /** Persist closed 1m candles (and close any elapsed open buckets). Safe to call repeatedly. */
  async flushLiveCandles(): Promise<number> {
    if (this.flushing) return 0;
    this.flushing = true;
    try {
      this.closeElapsedLiveBuckets(Date.now());
      if (this.closedQueue.length === 0) return 0;

      const rows = this.closedQueue.splice(0, this.closedQueue.length);
      const written = await this.persistOhlc1m(rows);
      // Roll closed 1m into coarser price_history resolutions
      await this.persistPriceHistoryFrom1m(rows);
      return written;
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Historical backfill for active markets:
   * - 1m → polymarket_ohlc / kalshi_ohlc
   * - 5m…1w → polymarket_price_history / kalshi_price_history
   *
   * Priority mix (configurable shares):
   *   1) distinct watchlist markets
   *   2) high-volume active markets
   *   3) fair rotation over remaining active markets
   *
   * Env: CANDLE_SYNC_MARKET_LIMIT, CANDLE_SYNC_WATCH_SHARE, CANDLE_SYNC_VOLUME_SHARE.
   * Never invents candles when the venue has no history (0 rows = empty, not failure).
   */
  async syncActiveMarketHistory(
    limit: number = parseCandleSyncMarketLimit(
      process.env.CANDLE_SYNC_MARKET_LIMIT,
      DEFAULT_CANDLE_SYNC_MARKET_LIMIT
    )
  ): Promise<{ markets: number; rows: number; stats: CandleSyncCycleStats }> {
    const started = Date.now();
    const pageSize = parseCandleSyncMarketLimit(
      String(limit),
      DEFAULT_CANDLE_SYNC_MARKET_LIMIT
    );
    const watchShare = parseShare(
      process.env.CANDLE_SYNC_WATCH_SHARE,
      DEFAULT_CANDLE_SYNC_WATCH_SHARE
    );
    const volumeShare = parseShare(
      process.env.CANDLE_SYNC_VOLUME_SHARE,
      DEFAULT_CANDLE_SYNC_VOLUME_SHARE
    );

    if (this.historySyncRunning) {
      const stats: CandleSyncCycleStats = {
        eligibleActive: 0,
        watchlistDistinct: 0,
        processed: 0,
        ok: 0,
        empty: 0,
        failed: 0,
        rows: 0,
        watchCount: 0,
        volumeCount: 0,
        rotateCount: 0,
        skippedOverlap: true,
        pageSize,
        durationMs: 0,
      };
      this.lastSyncStats = stats;
      console.warn(formatCandleSyncStats(stats));
      return { markets: 0, rows: 0, stats };
    }

    this.historySyncRunning = true;
    try {
      const { count, error: countError } = await supabaseAdmin
        .from('markets')
        .select('canonical_id', { count: 'estimated', head: true })
        .eq('active', true);

      if (countError) {
        console.warn(`[CandleAggregator] sync count markets: ${countError.message}`);
      }
      const eligibleActive = count ?? 0;

      const watchedIds = await this.loadWatchedCanonicalIds();
      const highVolumeMarkets = await this.loadHighVolumeActiveMarkets(
        Math.max(pageSize * 3, 120)
      );

      // Slide a window across the full active catalogue so rotation is fair
      // (not stuck on the first N canonical_ids forever).
      const rotateWindow = Math.min(
        Math.max(eligibleActive, 0),
        Math.max(pageSize * 5, 200)
      );
      const { offset: rotateWindowOffset, nextOffset: nextRotateWindow } =
        nextRotatedOffset(eligibleActive, rotateWindow || 1, this.syncMarketCursor);
      this.syncMarketCursor = eligibleActive > 0 ? nextRotateWindow : 0;
      const rotatePool = await this.loadActiveMarketsByRanges(
        rotatedPageRanges(eligibleActive, rotateWindow || 1, rotateWindowOffset)
      );

      const selection = selectMarketsForCandleSync({
        pageSize,
        watchedIds,
        highVolumeMarkets,
        rotatePool,
        rotateCursor: 0,
        watchShare,
        volumeShare,
      });

      const markets = await this.hydrateSyncMarkets(selection.markets);

      let rows = 0;
      let ok = 0;
      let empty = 0;
      let failed = 0;

      for (const market of markets) {
        try {
          let written = 0;
          if (market.platform === 'polymarket') {
            written = await this.syncPolymarketHistory(market);
          } else if (market.platform === 'kalshi') {
            written = await this.syncKalshiHistory(market);
          } else {
            empty += 1;
            continue;
          }
          rows += written;
          if (written > 0) ok += 1;
          else empty += 1; // genuine no-history or no token — not fabricated
        } catch (err: any) {
          failed += 1;
          console.warn(
            `[CandleAggregator] sync ${market.canonical_id}: ${err?.message ?? err}`
          );
        }
      }

      const stats: CandleSyncCycleStats = {
        eligibleActive,
        watchlistDistinct: watchedIds.length,
        processed: markets.length,
        ok,
        empty,
        failed,
        rows,
        watchCount: selection.watchCount,
        volumeCount: selection.volumeCount,
        rotateCount: selection.rotateCount,
        skippedOverlap: false,
        pageSize,
        durationMs: Date.now() - started,
      };
      this.lastSyncStats = stats;
      console.log(formatCandleSyncStats(stats));
      return { markets: markets.length, rows, stats };
    } finally {
      this.historySyncRunning = false;
    }
  }

  private async loadWatchedCanonicalIds(): Promise<string[]> {
    try {
      const { data, error } = await supabaseAdmin
        .from('watchlist')
        .select('canonical_id')
        .limit(2000);
      if (error) {
        console.warn(`[CandleAggregator] watchlist load: ${error.message.slice(0, 200)}`);
        return [];
      }
      const ids = new Set<string>();
      for (const row of data ?? []) {
        if (row?.canonical_id) ids.add(String(row.canonical_id));
      }
      return [...ids];
    } catch (err: any) {
      console.warn(`[CandleAggregator] watchlist load failed: ${err?.message ?? err}`);
      return [];
    }
  }

  private async loadHighVolumeActiveMarkets(limit: number): Promise<SyncMarketRow[]> {
    const { data, error } = await supabaseAdmin
      .from('markets')
      .select('canonical_id, platform, external_id, volume, active')
      .eq('active', true)
      .order('canonical_id', { ascending: true })
      .limit(limit);
    if (error) {
      console.warn(`[CandleAggregator] volume markets: ${error.message.slice(0, 200)}`);
      return [];
    }
    return [...(data ?? [])].sort(
      (a, b) => Number(b.volume || 0) - Number(a.volume || 0)
    ) as SyncMarketRow[];
  }

  private async loadActiveMarketsByRanges(
    ranges: Array<{ from: number; to: number }>
  ): Promise<SyncMarketRow[]> {
    const out: SyncMarketRow[] = [];
    for (const range of ranges) {
      if (range.to < range.from) continue;
      const { data, error } = await supabaseAdmin
        .from('markets')
        .select('canonical_id, platform, external_id, volume, active')
        .eq('active', true)
        .order('canonical_id', { ascending: true })
        .range(range.from, range.to);
      if (error) {
        console.warn(`[CandleAggregator] rotate range: ${error.message.slice(0, 200)}`);
        continue;
      }
      if (data?.length) out.push(...(data as SyncMarketRow[]));
    }
    return out;
  }

  /** Ensure selected rows have platform/raw_data for venue sync (watch-only stubs). */
  private async hydrateSyncMarkets(rows: SyncMarketRow[]): Promise<
    Array<{
      canonical_id: string;
      platform: string;
      external_id: string | null;
      raw_data: any;
    }>
  > {
    const need = rows.filter((r) => r.raw_data == null || !r.platform);
    if (!need.length) {
      return rows.map((r) => ({
        canonical_id: r.canonical_id,
        platform: r.platform,
        external_id: r.external_id,
        raw_data: r.raw_data ?? {},
      }));
    }
    const ids = need.map((r) => r.canonical_id);
    const { data, error } = await supabaseAdmin
      .from('markets')
      .select('canonical_id, platform, external_id, raw_data, active')
      .in('canonical_id', ids)
      .eq('active', true);
    if (error) {
      console.warn(`[CandleAggregator] hydrate markets: ${error.message.slice(0, 200)}`);
    }
    const map = new Map((data ?? []).map((r) => [r.canonical_id, r]));
    const out: Array<{
      canonical_id: string;
      platform: string;
      external_id: string | null;
      raw_data: any;
    }> = [];
    for (const r of rows) {
      const full = map.get(r.canonical_id);
      if (full) {
        out.push({
          canonical_id: full.canonical_id,
          platform: full.platform,
          external_id: full.external_id,
          raw_data: full.raw_data ?? {},
        });
      } else if (r.platform && r.raw_data != null) {
        out.push({
          canonical_id: r.canonical_id,
          platform: r.platform,
          external_id: r.external_id,
          raw_data: r.raw_data,
        });
      }
      // Skip watch stubs that are inactive / missing — do not invent history.
    }
    return out;
  }

  /**
   * Two-lane merge: completed history + forming open bucket.
   * Does not persist the forming candle; does not invent gap-fill bars.
   */
  private async withFormingCandle(
    market: {
      canonical_id: string;
      platform: string;
      external_id: string | null;
      raw_data: any;
    },
    resolution: CandleResolution,
    historical: Candle[]
  ): Promise<Candle[]> {
    const nowMs = Date.now();
    const bucketMs = intervalMs(resolution);
    const formingStart = bucketStartMs(nowMs, bucketMs);
    // Keep provider/DB gaps as gaps — do not synthesize carry-forward bars here.
    const completed = stripFormingBucket(historical, formingStart);

    const platform = market.platform as Platform;
    if (platform !== 'polymarket' && platform !== 'kalshi') {
      return limitCandles(completed, resolution);
    }

    const ticker = this.resolveOhlcTicker(market);
    if (!ticker) {
      if (completed.length === 0) {
        console.warn(
          `[CandleAggregator] no OHLC ticker for forming candle: ${market.canonical_id}`
        );
      }
      return limitCandles(completed, resolution);
    }

    try {
      const ladder = SUB_INTERVAL_LADDER[resolution];
      const finerRowsByInterval = await this.loadFinerRowsForBucket(
        platform,
        ticker,
        ladder,
        formingStart,
        nowMs
      );

      const live = this.peekLiveBucket(platform, ticker);
      let liveTail: LiveTailCandle | null = null;
      if (live?.hadActivity && live.startMs >= formingStart && live.startMs < formingStart + bucketMs) {
        liveTail = {
          ts: new Date(live.startMs).toISOString(),
          open: live.open,
          high: live.high,
          low: live.low,
          close: live.close,
          volume: live.volume || 0,
        };
      }

      // If the open 1m was just closed into the queue but not flushed, treat as DB 1m.
      const pending = this.peekPendingClosed1m(platform, ticker);
      if (pending.length) {
        const asRows: FormingCandleRow[] = pending
          .filter((r) => {
            const t = new Date(r.ts).getTime();
            return t >= formingStart && t < formingStart + bucketMs;
          })
          .map((r) => ({
            ts: r.ts,
            open: r.open,
            high: r.high,
            low: r.low,
            close: r.close,
            volume: r.volume || 0,
          }));
        const existing1m = finerRowsByInterval['1m'] ?? [];
        const byTs = new Map(existing1m.map((r) => [r.ts, r]));
        for (const row of asRows) byTs.set(row.ts, row);
        finerRowsByInterval['1m'] = [...byTs.values()];
      }

      const { candle: forming } = buildFormingCandle({
        interval: resolution,
        bucketStartMs: formingStart,
        nowMs,
        ladder,
        finerRowsByInterval,
        liveTail,
      });

      if (!forming) {
        if (ladder.length && Object.values(finerRowsByInterval).every((r) => !r?.length) && !liveTail) {
          console.warn(
            `[CandleAggregator] forming candle empty (no finer/live data) ${market.canonical_id} ${resolution} bucket=${new Date(formingStart).toISOString()}`
          );
        }
        return limitCandles(completed, resolution);
      }

      const formingCandle: Candle = {
        ticker: market.canonical_id,
        bucket: forming.ts,
        open: forming.open,
        high: forming.high,
        low: forming.low,
        close: forming.close,
        volume: forming.volume,
      };

      return limitCandles([formingCandle, ...completed], resolution);
    } catch (err: any) {
      console.warn(
        `[CandleAggregator] forming candle failed ${market.canonical_id}: ${err?.message ?? err}`
      );
      return limitCandles(completed, resolution);
    }
  }

  private resolveOhlcTicker(market: {
    platform: string;
    external_id: string | null;
    raw_data: any;
  }): string | null {
    if (market.platform === 'kalshi') {
      return market.external_id ? String(market.external_id) : null;
    }
    if (market.platform === 'polymarket') {
      return getPrimaryPolyToken(market.raw_data ?? {});
    }
    return null;
  }

  /** Load finer stored candles inside [bucketStart, now) for forming composition. */
  private async loadFinerRowsForBucket(
    platform: Platform,
    ticker: string,
    ladder: FormingSourceInterval[],
    bucketStartMsValue: number,
    nowMs: number
  ): Promise<Partial<Record<FormingSourceInterval, FormingCandleRow[]>>> {
    const out: Partial<Record<FormingSourceInterval, FormingCandleRow[]>> = {};
    for (const iv of ladder) out[iv] = [];

    if (!ladder.length) return out;

    const fromIso = new Date(bucketStartMsValue).toISOString();
    const toIso = new Date(nowMs).toISOString();

    const needs1m = ladder.includes('1m');
    const coarse = ladder.filter((iv) => iv !== '1m') as CandleResolution[];

    if (needs1m) {
      try {
        if (platform === 'polymarket') {
          const { data, error } = await supabaseAdmin
            .from('polymarket_ohlc')
            .select('ts, open, high, low, close, volume')
            .eq('token_id', ticker)
            .eq('interval', BASE_OHLC_INTERVAL)
            .gte('ts', fromIso)
            .lt('ts', toIso)
            .order('ts', { ascending: true })
            .limit(500);
          if (error) {
            console.warn(
              `[CandleAggregator] finer 1m read polymarket: ${error.message.slice(0, 200)}`
            );
          } else {
            out['1m'] = (data ?? [])
              .map((row) => ({
                ts: new Date(row.ts).toISOString(),
                open: Number(row.open),
                high: Number(row.high),
                low: Number(row.low),
                close: Number(row.close),
                volume: Number(row.volume || 0),
              }))
              .filter(
                (r) =>
                  Number.isFinite(r.open) &&
                  Number.isFinite(r.high) &&
                  Number.isFinite(r.low) &&
                  Number.isFinite(r.close)
              );
          }
        } else {
          const { data, error } = await supabaseAdmin
            .from('kalshi_ohlc')
            .select('ts, open, high, low, close, volume')
            .eq('ticker', ticker)
            .eq('interval', BASE_OHLC_INTERVAL)
            .gte('ts', fromIso)
            .lt('ts', toIso)
            .order('ts', { ascending: true })
            .limit(500);
          if (error) {
            console.warn(
              `[CandleAggregator] finer 1m read kalshi: ${error.message.slice(0, 200)}`
            );
          } else {
            out['1m'] = (data ?? [])
              .map((row) => ({
                ts: new Date(row.ts).toISOString(),
                open: Number(row.open),
                high: Number(row.high),
                low: Number(row.low),
                close: Number(row.close),
                volume: Number(row.volume || 0),
              }))
              .filter(
                (r) =>
                  Number.isFinite(r.open) &&
                  Number.isFinite(r.high) &&
                  Number.isFinite(r.low) &&
                  Number.isFinite(r.close)
              );
          }
        }
      } catch (err: any) {
        console.warn(`[CandleAggregator] finer 1m load failed: ${err?.message ?? err}`);
      }
    }

    for (const iv of coarse) {
      try {
        if (platform === 'polymarket') {
          const { data, error } = await supabaseAdmin
            .from('polymarket_price_history')
            .select('ts, open, high, low, close, volume')
            .eq('token_id', ticker)
            .eq('interval', iv)
            .gte('ts', fromIso)
            .lt('ts', toIso)
            .order('ts', { ascending: true })
            .limit(200);
          if (error) {
            console.warn(
              `[CandleAggregator] finer ${iv} polymarket: ${error.message.slice(0, 200)}`
            );
            continue;
          }
          out[iv] = (data ?? [])
            .map((row) => ({
              ts: new Date(row.ts).toISOString(),
              open: Number(row.open),
              high: Number(row.high),
              low: Number(row.low),
              close: Number(row.close),
              volume: Number(row.volume || 0),
            }))
            .filter(
              (r) =>
                Number.isFinite(r.open) &&
                Number.isFinite(r.high) &&
                Number.isFinite(r.low) &&
                Number.isFinite(r.close)
            );
        } else {
          const { data, error } = await supabaseAdmin
            .from('kalshi_price_history')
            .select('ts, price_open, price_high, price_low, price_close, volume')
            .eq('ticker', ticker)
            .eq('interval', iv)
            .gte('ts', fromIso)
            .lt('ts', toIso)
            .order('ts', { ascending: true })
            .limit(200);
          if (error) {
            console.warn(
              `[CandleAggregator] finer ${iv} kalshi: ${error.message.slice(0, 200)}`
            );
            continue;
          }
          out[iv] = (data ?? [])
            .map((row) => ({
              ts: new Date(row.ts).toISOString(),
              open: Number(row.price_open),
              high: Number(row.price_high),
              low: Number(row.price_low),
              close: Number(row.price_close),
              volume: Number(row.volume || 0),
            }))
            .filter(
              (r) =>
                Number.isFinite(r.open) &&
                Number.isFinite(r.high) &&
                Number.isFinite(r.low) &&
                Number.isFinite(r.close)
            );
        }
      } catch (err: any) {
        console.warn(`[CandleAggregator] finer ${iv} load failed: ${err?.message ?? err}`);
      }
    }

    return out;
  }

  private liveBucketToRow(bucket: LiveBucket): OhlcRow {
    return {
      platform: bucket.platform,
      ticker: bucket.ticker,
      ts: new Date(bucket.startMs).toISOString(),
      open: roundPrice(bucket.open),
      high: roundPrice(bucket.high),
      low: roundPrice(bucket.low),
      close: roundPrice(bucket.close),
      volume: bucket.volume || 0,
      trade_count: bucket.tradeCount || 0,
      interval: BASE_OHLC_INTERVAL,
    };
  }

  private closeElapsedLiveBuckets(nowMs: number): void {
    // Only persist minutes that saw a tick on timer flush. Quiet gaps between
    // live ticks are carry-forward filled on the next ingest (V=0), not invented
    // from thin air when the provider never sent a price.
    for (const [key, bucket] of this.liveBuckets.entries()) {
      if (bucket.startMs + INTERVAL_1M_MS <= nowMs) {
        if (bucket.hadActivity) {
          this.closedQueue.push(this.liveBucketToRow(bucket));
        }
        this.liveBuckets.delete(key);
      }
    }
  }

  private async persistOhlc1m(rows: OhlcRow[]): Promise<number> {
    const poly = rows.filter((r) => r.platform === 'polymarket');
    const kalshi = rows.filter((r) => r.platform === 'kalshi');
    let written = 0;

    for (let i = 0; i < poly.length; i += UPSERT_BATCH) {
      const batch = poly.slice(i, i + UPSERT_BATCH).map((r) => ({
        token_id: r.ticker,
        ts: r.ts,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
        interval: BASE_OHLC_INTERVAL,
        trade_count: r.trade_count,
      }));
      const { error } = await supabaseAdmin
        .from('polymarket_ohlc')
        .upsert(batch, { onConflict: 'token_id,ts,interval' });
      if (error) {
        console.warn(`[CandleAggregator] polymarket_ohlc upsert: ${error.message.slice(0, 200)}`);
      } else {
        written += batch.length;
      }
    }

    for (let i = 0; i < kalshi.length; i += UPSERT_BATCH) {
      const batch = kalshi.slice(i, i + UPSERT_BATCH).map((r) => ({
        ticker: r.ticker,
        ts: r.ts,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
        interval: BASE_OHLC_INTERVAL,
        trade_count: r.trade_count,
      }));
      const { error } = await supabaseAdmin
        .from('kalshi_ohlc')
        .upsert(batch, { onConflict: 'ticker,ts,interval' });
      if (error) {
        console.warn(`[CandleAggregator] kalshi_ohlc upsert: ${error.message.slice(0, 200)}`);
      } else {
        written += batch.length;
      }
    }

    return written;
  }

  private async persistPriceHistoryFrom1m(rows1m: OhlcRow[]): Promise<number> {
    if (!rows1m.length) return 0;

    // Group by platform+ticker, then aggregate each resolution
    const byKey = new Map<string, OhlcRow[]>();
    for (const row of rows1m) {
      const key = liveKey(row.platform, row.ticker);
      const list = byKey.get(key) ?? [];
      list.push(row);
      byKey.set(key, list);
    }

    let written = 0;
    for (const group of byKey.values()) {
      const platform = group[0].platform;
      const ticker = group[0].ticker;
      for (const resolution of CANDLE_RESOLUTIONS) {
        const aggregated = aggregateOhlcRows(group, resolution);
        if (!aggregated.length) continue;
        // Merge with any existing partial bar already in DB for the open/closed bucket
        const merged = await this.mergePriceHistoryRows(platform, ticker, resolution, aggregated);
        written += await this.upsertPriceHistory(platform, merged);
      }
    }
    return written;
  }

  private async mergePriceHistoryRows(
    platform: Platform,
    ticker: string,
    resolution: CandleResolution,
    incoming: OhlcRow[]
  ): Promise<OhlcRow[]> {
    if (!incoming.length) return [];

    const tsList = incoming.map((r) => r.ts);
    const table = platform === 'polymarket' ? 'polymarket_price_history' : 'kalshi_price_history';
    const idCol = platform === 'polymarket' ? 'token_id' : 'ticker';

    const { data: existing, error } = await supabaseAdmin
      .from(table)
      .select('*')
      .eq(idCol, ticker)
      .eq('interval', resolution)
      .in('ts', tsList);

    if (error) {
      console.warn(`[CandleAggregator] ${table} merge read: ${error.message.slice(0, 200)}`);
      return incoming;
    }

    const existingByTs = new Map<string, OhlcRow>();
    for (const row of existing ?? []) {
      const ts = new Date(row.ts).toISOString();
      if (platform === 'polymarket') {
        existingByTs.set(ts, {
          platform,
          ticker,
          ts,
          open: Number(row.open),
          high: Number(row.high),
          low: Number(row.low),
          close: Number(row.close),
          volume: Number(row.volume || 0),
          trade_count: 0,
          interval: resolution,
        });
      } else {
        existingByTs.set(ts, {
          platform,
          ticker,
          ts,
          open: Number(row.price_open ?? row.open),
          high: Number(row.price_high ?? row.high),
          low: Number(row.price_low ?? row.low),
          close: Number(row.price_close ?? row.close),
          volume: Number(row.volume || 0),
          trade_count: 0,
          interval: resolution,
        });
      }
    }

    return incoming.map((row) => {
      const prev = existingByTs.get(new Date(row.ts).toISOString());
      if (!prev) return row;
      // Merge: keep earlier open, widen high/low, take newer close, sum volume
      return {
        ...row,
        open: prev.open,
        high: Math.max(prev.high, row.high),
        low: Math.min(prev.low, row.low),
        close: row.close,
        volume: (prev.volume || 0) + (row.volume || 0),
        trade_count: (prev.trade_count || 0) + (row.trade_count || 0),
      };
    });
  }

  private async upsertPriceHistory(platform: Platform, rows: OhlcRow[]): Promise<number> {
    if (!rows.length) return 0;
    let written = 0;

    if (platform === 'polymarket') {
      for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
        const batch = rows.slice(i, i + UPSERT_BATCH).map((r) => ({
          token_id: r.ticker,
          ts: r.ts,
          open: r.open,
          high: r.high,
          low: r.low,
          close: r.close,
          volume: r.volume,
          interval: r.interval,
        }));
        const { error } = await supabaseAdmin
          .from('polymarket_price_history')
          .upsert(batch, { onConflict: 'token_id,ts,interval' });
        if (error) {
          console.warn(
            `[CandleAggregator] polymarket_price_history upsert: ${error.message.slice(0, 200)}`
          );
        } else {
          written += batch.length;
        }
      }
    } else {
      for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
        const batch = rows.slice(i, i + UPSERT_BATCH).map((r) => ({
          ticker: r.ticker,
          ts: r.ts,
          interval: r.interval,
          price_open: r.open,
          price_high: r.high,
          price_low: r.low,
          price_close: r.close,
          price_mean: roundPrice((r.open + r.close) / 2),
          volume: r.volume,
        }));
        const { error } = await supabaseAdmin
          .from('kalshi_price_history')
          .upsert(batch, { onConflict: 'ticker,ts,interval' });
        if (error) {
          console.warn(
            `[CandleAggregator] kalshi_price_history upsert: ${error.message.slice(0, 200)}`
          );
        } else {
          written += batch.length;
        }
      }
    }

    return written;
  }

  private async fromOhlcv1hView(
    ticker: string,
    canonicalId = ticker,
    resolution: CandleResolution = '1h'
  ): Promise<Candle[]> {
    const max = maxCandlesForResolution(resolution);
    const { data: dbCandles } = await supabaseAdmin
      .from('ohlcv_1h_view')
      .select('ticker, bucket, open, high, low, close, volume')
      .eq('ticker', ticker)
      .order('bucket', { ascending: false })
      .limit(max);

    if (!dbCandles?.length) return [];

      return dbCandles.map((c) => ({
      ticker: canonicalId,
        bucket: c.bucket,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume || 0),
      }));
    }

  private async fromGetCandlesRpc(
    market: { canonical_id: string; platform: string; external_id: string | null; raw_data: any },
    resolution: CandleResolution
  ): Promise<Candle[]> {
    const platform = market.platform;
    let ticker: string | null = null;

    if (platform === 'kalshi') {
      ticker = market.external_id ? String(market.external_id) : null;
    } else if (platform === 'polymarket') {
      ticker = getPrimaryPolyToken(market.raw_data ?? {});
    }

    if (!ticker) return [];

    const now = Date.now();
    const p_to = new Date(now).toISOString();
    const windows = [
      new Date(now - LOOKBACK_SECONDS[resolution] * 1000).toISOString(),
      new Date(now - 2 * 365 * 24 * 60 * 60 * 1000).toISOString(),
    ];

    try {
      for (const p_from of windows) {
        const { data, error } = await supabaseAdmin.rpc('get_candles', {
          p_platform: platform,
          p_ticker: ticker,
          p_bucket_seconds: RESOLUTION_SECONDS[resolution],
          p_from,
          p_to,
        });

        if (error) {
          console.warn(`[CandleAggregator] get_candles RPC: ${error.message}`);
      return [];
        }
        if (Array.isArray(data) && data.length > 0) {
          return mapRpcRows(data, market.canonical_id, resolution);
        }
      }
      return [];
    } catch (err: any) {
      console.warn(`[CandleAggregator] get_candles RPC failed: ${err.message}`);
      return [];
    }
  }

  private async fromPriceHistory(
    market: { canonical_id: string; platform: string; external_id: string | null; raw_data: any },
    resolution: CandleResolution
  ): Promise<Candle[]> {
    const max = maxCandlesForResolution(resolution);
    if (market.platform === 'polymarket') {
      const tokenId = getPrimaryPolyToken(market.raw_data ?? {});
      if (!tokenId) return [];
      const { data, error } = await supabaseAdmin
        .from('polymarket_price_history')
        .select('ts, open, high, low, close, volume')
        .eq('token_id', tokenId)
        .eq('interval', resolution)
        .order('ts', { ascending: false })
        .limit(max);
      if (error) {
        console.warn(
          `[CandleAggregator] polymarket_price_history: ${error.message.slice(0, 200)}`
        );
        return [];
      }
      if (!data?.length) return [];
      return data.map((row) => ({
        ticker: market.canonical_id,
        bucket: new Date(row.ts).toISOString(),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume || 0),
      }));
    }

    if (market.platform === 'kalshi') {
      const ticker = market.external_id ? String(market.external_id) : null;
      if (!ticker) return [];
      const { data, error } = await supabaseAdmin
        .from('kalshi_price_history')
        .select('ts, price_open, price_high, price_low, price_close, volume')
        .eq('ticker', ticker)
        .eq('interval', resolution)
        .order('ts', { ascending: false })
        .limit(max);
      if (error) {
        console.warn(
          `[CandleAggregator] kalshi_price_history: ${error.message.slice(0, 200)}`
        );
        return [];
      }
      if (!data?.length) return [];
      return data
        .map((row) => ({
          ticker: market.canonical_id,
          bucket: new Date(row.ts).toISOString(),
          open: Number(row.price_open),
          high: Number(row.price_high),
          low: Number(row.price_low),
          close: Number(row.price_close),
          volume: Number(row.volume || 0),
        }))
        .filter(
          (c) =>
            Number.isFinite(c.open) &&
            Number.isFinite(c.high) &&
            Number.isFinite(c.low) &&
            Number.isFinite(c.close)
        );
    }

          return [];
        }

  private async fromPolymarketApi(
    market: { canonical_id: string; raw_data: any },
    resolution: CandleResolution
  ): Promise<Candle[]> {
    const tokenId = getPrimaryPolyToken(market.raw_data ?? {});
    if (!tokenId) return [];

    try {
      const history = await this.fetchPolymarketHistoryPoints(tokenId, resolution);
      if (!history.length) return [];
      return pointsToCandles(history, resolution, market.canonical_id);
      } catch (err: any) {
        console.error('[CandleAggregator] Polymarket history error:', err.message);
        return [];
      }
    }

  private async fetchPolymarketHistoryPoints(
    tokenId: string,
    resolution: CandleResolution | '1m'
  ): Promise<{ t: number; p: number }[]> {
    const endSec = Math.floor(Date.now() / 1000);
    const lookback =
      resolution === '1m' ? 2 * 24 * 60 * 60 : LOOKBACK_SECONDS[resolution];
    const startSec = endSec - lookback;
    const fidelity = polymarketFidelityMinutes(resolution);

    const attempts = [
      `https://clob.polymarket.com/prices-history?market=${encodeURIComponent(tokenId)}&startTs=${startSec}&endTs=${endSec}&fidelity=${fidelity}`,
      `https://clob.polymarket.com/prices-history?market=${encodeURIComponent(tokenId)}&interval=1w&fidelity=${fidelity}`,
      `https://clob.polymarket.com/prices-history?market=${encodeURIComponent(tokenId)}&interval=max&fidelity=${fidelity}`,
    ];

    for (const url of attempts) {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(4_000),
      });
      if (!res.ok) continue;
        const data = await res.json();
      const page = data.history || [];
      if (Array.isArray(page) && page.length > 0) return page;
    }
    return [];
  }

  private async fromKalshiApi(
    market: { canonical_id: string; external_id: string | null },
    resolution: CandleResolution
  ): Promise<Candle[]> {
    const ticker = market.external_id;
    if (!ticker) return [];

    try {
      const nativeCandles = await this.fetchKalshiNativeCandles(String(ticker), resolution);
      if (!nativeCandles.length) return [];

      const asApiCandles: Candle[] = nativeCandles.map((c) => ({
        ticker: market.canonical_id,
        bucket: c.ts,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));

      // Native Kalshi intervals that match the request exactly
      if (resolution === '1h' || resolution === '1d') {
        return limitCandles(asApiCandles, resolution);
      }

      // 5m/15m from 1m, 4h from 1h, 1w from 1d — never return wrong interval
      return aggregateCandles(asApiCandles, resolution, market.canonical_id);
    } catch (err: any) {
      console.error('[CandleAggregator] Kalshi candlesticks error:', err.message);
          return [];
    }
  }

  private async fetchKalshiNativeCandles(
    ticker: string,
    resolution: CandleResolution | '1m'
  ): Promise<OhlcRow[]> {
    const endTs = Math.floor(Date.now() / 1000);
    const periodInterval = kalshiNativePeriod(resolution);
    const startTs = kalshiWindowStartSec(resolution, periodInterval, endTs);

    const data = await kalshiGet('/markets/candlesticks', {
      market_tickers: String(ticker),
      start_ts: startTs,
      end_ts: endTs,
      period_interval: periodInterval,
    });

    const entry = Array.isArray(data?.markets) ? data.markets[0] : null;
    const sticks = entry?.candlesticks ?? [];
    if (!Array.isArray(sticks) || sticks.length === 0) return [];

    const nativeBucketSec = periodInterval * 60;
    const nativeInterval: StoredInterval =
      periodInterval === 1 ? '1m' : periodInterval === 60 ? '1h' : '1d';

    const rows: OhlcRow[] = [];
    for (const candle of sticks) {
      const price = candle.price ?? {};
      const open = kalshiPriceToProb(price.open_dollars, price.open);
      const high = kalshiPriceToProb(
        price.high_dollars ?? price.max_dollars,
        price.high ?? price.max
      );
      const low = kalshiPriceToProb(
        price.low_dollars ?? price.min_dollars,
        price.low ?? price.min
      );
      const close = kalshiPriceToProb(price.close_dollars, price.close);
      const tsSec = Number(candle.end_period_ts);
      if (!Number.isFinite(close) || !Number.isFinite(tsSec)) continue;

      // Kalshi end_period_ts → deterministic bucket start for the native period
      const bucketStart = floorToBucketSec(tsSec - 1, nativeBucketSec);
      const o = Number.isFinite(open) ? open : close;
      const h = Number.isFinite(high) ? high : Math.max(o, close);
      const l = Number.isFinite(low) ? low : Math.min(o, close);

      rows.push({
        platform: 'kalshi',
        ticker: String(ticker),
        ts: new Date(bucketStart * 1000).toISOString(),
        open: roundPrice(o),
        high: roundPrice(Math.max(h, o, close)),
        low: roundPrice(Math.min(l, o, close)),
        close: roundPrice(close),
        volume: kalshiCandleVolume(candle),
        trade_count: 0,
        interval: nativeInterval,
      });
    }
    return rows;
  }

  /**
   * Fetch Polymarket Data API trades and aggregate primary-token `size` into 1m buckets.
   * Dedupes by transactionHash+asset. Splits time into windows; when a window hits
   * the v1 offset=10000 cap, bisects the window (provider-recommended) instead of
   * inventing volume. Missing trades stay missing.
   */
  private async fetchPolymarketTradeVolumes1m(
    tokenId: string,
    query: { market?: string; eventId?: string },
    startSec: number,
    endSec: number
  ): Promise<Map<number, { volume: number; tradeCount: number }>> {
    const volumes = new Map<number, { volume: number; tradeCount: number }>();
    const seen = new Set<string>();
    const queue = planTradeWindows(startSec, endSec, POLY_TRADES_WINDOW_SEC).map(
      (w) => ({ window: w, depth: 0 })
    );

    while (queue.length) {
      const { window, depth } = queue.shift()!;
      const outcome = await this.fetchPolymarketTradesWindow(
        tokenId,
        query,
        window,
        volumes,
        seen
      );
      if (outcome === 'offset_cap') {
        const action = resolveOffsetCapAction(window, depth, POLY_TRADES_PAGE_LIMIT);
        if (action === 'bisect') {
          const halves = bisectTimeWindow(window);
          if (halves) {
            console.warn(
              `[CandleAggregator] Polymarket /trades offset cap ${window.startSec}-${window.endSec}; bisecting (depth=${depth + 1})`
            );
            for (const half of halves) {
              queue.push({ window: half, depth: depth + 1 });
            }
            continue;
          }
        }
        console.warn(
          `[CandleAggregator] Polymarket /trades hit offset cap in window ${window.startSec}-${window.endSec}; window may be incomplete`
        );
      }
      await sleepMs(POLY_TRADES_REQUEST_DELAY_MS);
    }

    return volumes;
  }

  /**
   * Page one start/end window. Returns `offset_cap` when the v1 offset budget is
   * exhausted with a full last page (caller should bisect).
   */
  private async fetchPolymarketTradesWindow(
    tokenId: string,
    query: { market?: string; eventId?: string },
    window: TimeWindow,
    volumes: Map<number, { volume: number; tradeCount: number }>,
    seen: Set<string>
  ): Promise<'ok' | 'offset_cap' | 'error'> {
    let offset = 0;
    let hitCap = false;

    while (offset <= POLY_TRADES_MAX_OFFSET) {
      const url = new URL(`${POLY_DATA_API}/trades`);
      if (query.market) url.searchParams.set('market', query.market);
      if (query.eventId) url.searchParams.set('eventId', query.eventId);
      url.searchParams.set('limit', String(POLY_TRADES_PAGE_LIMIT));
      url.searchParams.set('offset', String(offset));
      url.searchParams.set('start', String(window.startSec));
      url.searchParams.set('end', String(window.endSec));

      let page: any[];
      try {
        const data = await fetchPolymarketDataApi(url.toString());
        page = Array.isArray(data) ? data : [];
      } catch (err: any) {
        console.warn(
          `[CandleAggregator] Polymarket /trades window ${window.startSec}-${window.endSec}: ${err?.message ?? err}`
        );
        return 'error';
      }

      if (!page.length) break;

      let reachedPastWindow = false;
      for (const trade of page) {
        const tsSec = Number(trade.timestamp);
        if (Number.isFinite(tsSec) && tsSec < window.startSec) {
          reachedPastWindow = true;
        }
        accumulateTradeVolume(volumes, seen, trade, tokenId, window, INTERVAL_SECONDS['1m']);
      }

      if (page.length < POLY_TRADES_PAGE_LIMIT || reachedPastWindow) break;

      offset += POLY_TRADES_PAGE_LIMIT;
      if (offset > POLY_TRADES_MAX_OFFSET) {
        hitCap = true;
        break;
      }
      await sleepMs(POLY_TRADES_REQUEST_DELAY_MS);
    }

    return hitCap ? 'offset_cap' : 'ok';
  }

  /**
   * Attach trade-aggregated 1m volumes onto CLOB OHLC rows.
   * - Trade volume > 0 → replace (idempotent across syncs)
   * - Trade volume absent/0 → keep existing DB volume (never overwrite live volume with 0)
   */
  private async applyPolymarketTradeVolumes(
    tokenId: string,
    rows1m: OhlcRow[],
    tradeVolumes: Map<number, { volume: number; tradeCount: number }>
  ): Promise<OhlcRow[]> {
    if (!rows1m.length) return rows1m;

    const tsList = rows1m.map((r) => r.ts);
    const existingByTs = new Map<string, { volume: number; trade_count: number }>();

    for (let i = 0; i < tsList.length; i += 200) {
      const chunk = tsList.slice(i, i + 200);
      const { data, error } = await supabaseAdmin
        .from('polymarket_ohlc')
        .select('ts, volume, trade_count')
        .eq('token_id', tokenId)
        .eq('interval', BASE_OHLC_INTERVAL)
        .in('ts', chunk);
      if (error) {
        console.warn(`[CandleAggregator] ohlc volume read: ${error.message.slice(0, 200)}`);
        continue;
      }
      for (const row of data ?? []) {
        existingByTs.set(new Date(row.ts).toISOString(), {
          volume: Number(row.volume || 0),
          trade_count: Number(row.trade_count || 0),
        });
      }
    }

    const openBucketSec = floorToBucketSec(Math.floor(Date.now() / 1000), INTERVAL_SECONDS['1m']);

    return rows1m.map((row) => {
      const tsIso = new Date(row.ts).toISOString();
      const bucketSec = Math.floor(new Date(row.ts).getTime() / 1000);
      const trade = tradeVolumes.get(bucketSec);
      const existing = existingByTs.get(tsIso);
      const existingVol = existing?.volume ?? 0;

      if (trade && trade.volume > 0) {
        // Open (forming) minute: keep the larger of live vs historical partial window
        const volume =
          bucketSec === openBucketSec
            ? Math.max(existingVol, trade.volume)
            : trade.volume;
        return {
          ...row,
          volume,
          trade_count: Math.max(existing?.trade_count ?? 0, trade.tradeCount),
        };
      }

      if (existingVol > 0) {
        return {
          ...row,
          volume: existingVol,
          trade_count: existing?.trade_count ?? row.trade_count,
        };
      }

      return { ...row, volume: 0 };
    });
  }

  /** Upsert price_history without wiping pre-existing non-zero volume with zeros. */
  private async upsertPolymarketPriceHistorySafe(rows: OhlcRow[]): Promise<number> {
    if (!rows.length) return 0;

    const tsList = rows.map((r) => r.ts);
    const interval = rows[0].interval;
    const ticker = rows[0].ticker;
    const existingByTs = new Map<string, number>();

    for (let i = 0; i < tsList.length; i += 200) {
      const chunk = tsList.slice(i, i + 200);
      const { data } = await supabaseAdmin
        .from('polymarket_price_history')
        .select('ts, volume')
        .eq('token_id', ticker)
        .eq('interval', interval)
        .in('ts', chunk);
      for (const row of data ?? []) {
        existingByTs.set(new Date(row.ts).toISOString(), Number(row.volume || 0));
      }
    }

    const merged = rows.map((row) => {
      const prev = existingByTs.get(new Date(row.ts).toISOString()) ?? 0;
      const nextVol = Number(row.volume || 0);
      return {
        ...row,
        // Replace when we have trade volume; never clobber real volume with 0
        volume: nextVol > 0 ? nextVol : prev > 0 ? prev : 0,
      };
    });

    return this.upsertPriceHistory('polymarket', merged);
  }

  private async syncPolymarketHistory(market: {
    canonical_id: string;
    external_id?: string | null;
    raw_data: any;
  }): Promise<number> {
    const tokenId = getPrimaryPolyToken(market.raw_data ?? {});
    if (!tokenId) return 0;

    // Prefer 1m fidelity for base storage; fall back to 5m points if empty
    let points = await this.fetchPolymarketHistoryPoints(tokenId, '1m');
    if (!points.length) {
      points = await this.fetchPolymarketHistoryPoints(tokenId, '5m');
    }
    if (!points.length) return 0;

    // CLOB remains the sole OHLC source (volume starts at 0 here)
    const rows1m = pointsToOhlcRows(points, 'polymarket', tokenId, BASE_OHLC_INTERVAL);

    // Overlay real trade size from Data API /trades (volume only).
    // Use the same time span as the CLOB points we just bucketed (not a shorter fixed window).
    const pointTimes = points
      .map((p) => Number(p.t))
      .filter((t) => Number.isFinite(t) && t > 0);
    const endSec = Math.max(
      Math.floor(Date.now() / 1000),
      pointTimes.length ? Math.max(...pointTimes) : 0
    );
    const startSec = pointTimes.length
      ? Math.min(...pointTimes)
      : endSec - LOOKBACK_SECONDS['5m'];
    const tradeQuery = getPolymarketTradeQuery(market);
    let tradeVolumes = new Map<number, { volume: number; tradeCount: number }>();
    if (tradeQuery && endSec > startSec) {
      try {
        tradeVolumes = await this.fetchPolymarketTradeVolumes1m(
          tokenId,
          tradeQuery,
          startSec,
          endSec
        );
      } catch (err: any) {
        console.warn(
          `[CandleAggregator] trade volume sync ${market.canonical_id}: ${err?.message ?? err}`
        );
      }
    } else if (!tradeQuery) {
      console.warn(
        `[CandleAggregator] no conditionId/eventId for trade volume: ${market.canonical_id}`
      );
    }

    const rowsWithVolume = await this.applyPolymarketTradeVolumes(
      tokenId,
      rows1m,
      tradeVolumes
    );

    let written = await this.persistOhlc1m(rowsWithVolume);

    for (const resolution of CANDLE_RESOLUTIONS) {
      const aggregated = rowsWithVolume.length
        ? aggregateOhlcRows(rowsWithVolume, resolution)
        : pointsToOhlcRows(points, 'polymarket', tokenId, resolution);
      written += await this.upsertPolymarketPriceHistorySafe(aggregated);
    }

    return written;
  }

  private async syncKalshiHistory(market: {
    canonical_id: string;
    external_id: string | null;
  }): Promise<number> {
    const ticker = market.external_id ? String(market.external_id) : null;
    if (!ticker) return 0;

    const native1m = await this.fetchKalshiNativeCandles(ticker, '1m');
    let written = 0;
    if (native1m.length) {
      written += await this.persistOhlc1m(native1m);
    }

    // Build each stored resolution from the best native Kalshi period
    const source1m = native1m.length
      ? native1m
      : await this.fetchKalshiNativeCandles(ticker, '5m');
    const source1h = await this.fetchKalshiNativeCandles(ticker, '1h');
    const source1d = await this.fetchKalshiNativeCandles(ticker, '1d');

    const byResolution: Record<CandleResolution, OhlcRow[]> = {
      '5m': source1m.length ? aggregateOhlcRows(source1m, '5m') : [],
      '15m': source1m.length ? aggregateOhlcRows(source1m, '15m') : [],
      '1h': source1h.length
        ? source1h.map((r) => ({ ...r, interval: '1h' as const }))
        : source1m.length
          ? aggregateOhlcRows(source1m, '1h')
          : [],
      '4h': source1h.length
        ? aggregateOhlcRows(source1h, '4h')
        : source1m.length
          ? aggregateOhlcRows(source1m, '4h')
          : [],
      '1d': source1d.length
        ? source1d.map((r) => ({ ...r, interval: '1d' as const }))
        : source1h.length
          ? aggregateOhlcRows(source1h, '1d')
          : [],
      '1w': source1d.length
        ? aggregateOhlcRows(source1d, '1w')
        : source1h.length
          ? aggregateOhlcRows(source1h, '1w')
          : [],
    };

    for (const resolution of CANDLE_RESOLUTIONS) {
      written += await this.upsertPriceHistory('kalshi', byResolution[resolution]);
    }

    return written;
  }
}

export const candleAggregator = new CandleAggregator();
