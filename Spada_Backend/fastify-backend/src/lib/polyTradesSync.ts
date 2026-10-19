/**
 * Pure helpers for Polymarket Data API /trades sync planning.
 *
 * v1 /trades rejects offset > 10000. Dense windows must be bisected into
 * smaller start/end ranges (each with its own offset budget). Never invents
 * trades or candle volume when the provider returns nothing.
 */

/** Modest page size; API allows up to 10000 but smaller pages keep sync controllable */
export const POLY_TRADES_PAGE_LIMIT = 500;
/** Data API v1 rejects offset beyond 10000 */
export const POLY_TRADES_MAX_OFFSET = 10_000;
/** Initial time-window size before optional bisection */
export const POLY_TRADES_WINDOW_SEC = 6 * 60 * 60;
/** Do not bisect below this width (seconds) */
export const POLY_TRADES_MIN_WINDOW_SEC = 5 * 60;
/** Max recursive bisects per original window (prevents runaway fan-out) */
export const POLY_TRADES_MAX_BISECT_DEPTH = 6;
export const POLY_TRADES_REQUEST_DELAY_MS = 150;

/** Default markets processed per candle-sync cycle (rotating). */
export const DEFAULT_CANDLE_SYNC_MARKET_LIMIT = 40;
export const MAX_CANDLE_SYNC_MARKET_LIMIT = 200;

export type TimeWindow = { startSec: number; endSec: number };

export function planTradeWindows(
  startSec: number,
  endSec: number,
  windowSec: number = POLY_TRADES_WINDOW_SEC
): TimeWindow[] {
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
    return [];
  }
  const step = Math.max(1, Math.floor(windowSec));
  const out: TimeWindow[] = [];
  for (let wStart = startSec; wStart < endSec; wStart += step) {
    out.push({ startSec: wStart, endSec: Math.min(wStart + step, endSec) });
  }
  return out;
}

/** Split a dense window into two halves when the offset budget is exhausted. */
export function bisectTimeWindow(window: TimeWindow): TimeWindow[] | null {
  const { startSec, endSec } = window;
  const span = endSec - startSec;
  if (span < POLY_TRADES_MIN_WINDOW_SEC * 2) return null;
  const mid = startSec + Math.floor(span / 2);
  if (mid <= startSec || mid >= endSec) return null;
  return [
    { startSec, endSec: mid },
    { startSec: mid, endSec },
  ];
}

export function canBisectWindow(window: TimeWindow, depth: number): boolean {
  if (depth >= POLY_TRADES_MAX_BISECT_DEPTH) return false;
  return bisectTimeWindow(window) != null;
}

/**
 * Stable round-robin offset for market sync batches.
 * Returns the next cursor after consuming `limit` rows from `total`.
 */
export function nextRotatedOffset(
  total: number,
  limit: number,
  currentOffset: number
): { offset: number; nextOffset: number; wrap: boolean } {
  const n = Math.max(0, Math.floor(total));
  const page = Math.max(1, Math.floor(limit));
  if (n === 0) return { offset: 0, nextOffset: 0, wrap: false };
  const offset = ((Math.floor(currentOffset) % n) + n) % n;
  const next = (offset + page) % n;
  return { offset, nextOffset: next, wrap: offset + page > n };
}

/** Parse CANDLE_SYNC_MARKET_LIMIT (clamped to [1, MAX]). */
export function parseCandleSyncMarketLimit(
  raw: string | undefined,
  fallback: number = DEFAULT_CANDLE_SYNC_MARKET_LIMIT
): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  const floored = Math.floor(n);
  // Reject (0, 1) fractions that would floor to 0 (e.g. "0.9").
  if (floored < 1) return fallback;
  return Math.min(MAX_CANDLE_SYNC_MARKET_LIMIT, floored);
}

/**
 * Build inclusive ranges for a rotated page, handling wrap-around
 * (e.g. offset near end → [offset, total) + [0, remainder)).
 */
export function rotatedPageRanges(
  total: number,
  limit: number,
  offset: number
): Array<{ from: number; to: number }> {
  const n = Math.max(0, Math.floor(total));
  const page = Math.max(1, Math.floor(limit));
  if (n === 0) return [];
  const start = ((Math.floor(offset) % n) + n) % n;
  const take = Math.min(page, n);
  if (start + take <= n) {
    return [{ from: start, to: start + take - 1 }];
  }
  const firstLen = n - start;
  const secondLen = take - firstLen;
  return [
    { from: start, to: n - 1 },
    { from: 0, to: secondLen - 1 },
  ];
}

export type TradeVolumeBucket = { volume: number; tradeCount: number };

export function tradeDedupeKey(trade: {
  asset?: unknown;
  transactionHash?: unknown;
  timestamp?: unknown;
  size?: unknown;
  price?: unknown;
  side?: unknown;
  // v2 snake_case
  token_id?: unknown;
  transaction_hash?: unknown;
}): string | null {
  const asset = trade?.asset != null
    ? String(trade.asset)
    : trade?.token_id != null
      ? String(trade.token_id)
      : '';
  if (!asset) return null;
  const tx = trade?.transactionHash ?? trade?.transaction_hash;
  if (tx) return `${String(tx)}:${asset}`;
  const ts = trade?.timestamp ?? '';
  const size = trade?.size ?? '';
  const price = trade?.price ?? '';
  const side = trade?.side ?? '';
  return `${asset}|${ts}|${size}|${price}|${side}`;
}

/**
 * Apply one trade into 1m volume buckets. Returns false if skipped (wrong token,
 * duplicate, or invalid). Does not invent size when missing/non-positive.
 */
export function accumulateTradeVolume(
  volumes: Map<number, TradeVolumeBucket>,
  seen: Set<string>,
  trade: any,
  tokenId: string,
  window: TimeWindow,
  bucketSec: number = 60
): boolean {
  const asset =
    trade?.asset != null
      ? String(trade.asset)
      : trade?.token_id != null
        ? String(trade.token_id)
        : '';
  if (asset !== tokenId) return false;

  const tsSec = Number(trade.timestamp);
  if (!Number.isFinite(tsSec)) return false;
  if (tsSec < window.startSec || tsSec > window.endSec) return false;

  const key = tradeDedupeKey(trade);
  if (!key || seen.has(key)) return false;
  seen.add(key);

  const size = Number(trade.size ?? 0);
  if (!Number.isFinite(size) || size <= 0) return false;

  const bucket = Math.floor(tsSec / bucketSec) * bucketSec;
  const existing = volumes.get(bucket);
  if (!existing) {
    volumes.set(bucket, { volume: size, tradeCount: 1 });
  } else {
    existing.volume += size;
    existing.tradeCount += 1;
  }
  return true;
}

/** Retry backoff delays for 429 / 5xx (ms). */
export function retryDelayMs(attempt: number, status?: number): number {
  const a = Math.max(0, attempt);
  if (status === 429) return (a + 1) * 2000;
  return (a + 1) * 500;
}

export function shouldRetryHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * After a full page at the offset cap, decide whether to bisect or accept
 * incomplete coverage for this window.
 */
export function resolveOffsetCapAction(
  window: TimeWindow,
  depth: number,
  pageLength: number,
  pageLimit: number = POLY_TRADES_PAGE_LIMIT
): 'bisect' | 'incomplete' {
  if (pageLength < pageLimit) return 'incomplete';
  if (canBisectWindow(window, depth)) return 'bisect';
  return 'incomplete';
}
