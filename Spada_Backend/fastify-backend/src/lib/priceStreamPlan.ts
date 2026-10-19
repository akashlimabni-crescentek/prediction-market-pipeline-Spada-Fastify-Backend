/**
 * Fair market selection for live venue WebSocket subscriptions.
 * Keeps a hard per-venue cap (default 150) — does not invent markets or raise
 * undocumented vendor limits. Pure helpers for unit tests.
 */

import {
  nextRotatedOffset,
  rotatedPageRanges,
} from './polyTradesSync.js';
import { splitCycleQuotas } from './candleSyncPlan.js';

/** Application default — not a proven venue hard max. */
export const DEFAULT_PRICE_STREAM_MARKET_LIMIT = 150;
/** Safety ceiling even if env is mis-set. */
export const MAX_PRICE_STREAM_MARKET_LIMIT = 400;

export const DEFAULT_PRICE_STREAM_WATCH_SHARE = 0.25;
export const DEFAULT_PRICE_STREAM_VOLUME_SHARE = 0.35;

export type StreamMarketRow = {
  canonical_id: string;
  platform: string;
  external_id: string | null;
  volume?: number | null;
  active?: boolean | null;
  updated_at?: string | null;
  /** Opaque passthrough for caller (raw_data, prices, …). */
  meta?: Record<string, unknown> | null;
};

export type PriceStreamSelection = {
  markets: StreamMarketRow[];
  watchCount: number;
  volumeCount: number;
  rotateCount: number;
  pageSize: number;
  rotateOffset: number;
  nextRotateOffset: number;
  eligibleRotateTotal: number;
};

export type PriceStreamCoverageStats = {
  platform: string;
  eligibleActive: number | null;
  selected: number;
  subscribedTokensOrTickers: number;
  watchCount: number;
  volumeCount: number;
  rotateCount: number;
  pageSize: number;
  rotateOffset: number;
  recentTickMarkets: number | null;
  durationMs: number;
};

export function parsePriceStreamMarketLimit(
  raw: string | undefined,
  fallback = DEFAULT_PRICE_STREAM_MARKET_LIMIT
): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(MAX_PRICE_STREAM_MARKET_LIMIT, Math.floor(n));
}

/**
 * Select ≤ pageSize markets: watchlist → high volume → fair rotate remainder.
 * Dedupes by canonical_id. Does not invent rows.
 */
export function selectMarketsForPriceStream(input: {
  pageSize: number;
  watchedIds: string[];
  highVolumeMarkets: StreamMarketRow[];
  rotatePool: StreamMarketRow[];
  rotateCursor: number;
  watchShare?: number;
  volumeShare?: number;
}): PriceStreamSelection {
  const pageSize = parsePriceStreamMarketLimit(String(input.pageSize), input.pageSize);
  const { watchQuota, volumeQuota, rotateQuota } = splitCycleQuotas(
    pageSize,
    input.watchShare ?? DEFAULT_PRICE_STREAM_WATCH_SHARE,
    input.volumeShare ?? DEFAULT_PRICE_STREAM_VOLUME_SHARE
  );

  const selected: StreamMarketRow[] = [];
  const seen = new Set<string>();

  const take = (row: StreamMarketRow | undefined): boolean => {
    if (!row?.canonical_id || seen.has(row.canonical_id)) return false;
    if (row.active === false) return false;
    seen.add(row.canonical_id);
    selected.push(row);
    return true;
  };

  const byId = new Map<string, StreamMarketRow>();
  for (const m of input.highVolumeMarkets) byId.set(m.canonical_id, m);
  for (const m of input.rotatePool) {
    if (!byId.has(m.canonical_id)) byId.set(m.canonical_id, m);
  }

  let watchCount = 0;
  for (const id of input.watchedIds) {
    if (watchCount >= watchQuota) break;
    const row = byId.get(id);
    if (row && take(row)) watchCount += 1;
  }

  let volumeCount = 0;
  const volumeSorted = [...input.highVolumeMarkets].sort(
    (a, b) => Number(b.volume ?? 0) - Number(a.volume ?? 0)
  );
  for (const m of volumeSorted) {
    if (volumeCount >= volumeQuota) break;
    if (take(m)) volumeCount += 1;
  }

  const rotateEligible = input.rotatePool
    .filter((m) => m.canonical_id && !seen.has(m.canonical_id) && m.active !== false)
    .sort((a, b) => a.canonical_id.localeCompare(b.canonical_id));

  const eligibleRotateTotal = rotateEligible.length;
  const { offset, nextOffset } = nextRotatedOffset(
    eligibleRotateTotal,
    rotateQuota,
    input.rotateCursor
  );
  const ranges = rotatedPageRanges(eligibleRotateTotal, rotateQuota, offset);

  let rotateCount = 0;
  for (const range of ranges) {
    for (let i = range.from; i <= range.to; i++) {
      if (take(rotateEligible[i])) rotateCount += 1;
    }
  }

  if (selected.length < pageSize) {
    for (const m of volumeSorted) {
      if (selected.length >= pageSize) break;
      if (take(m)) volumeCount += 1;
    }
  }
  if (selected.length < pageSize) {
    for (const m of rotateEligible) {
      if (selected.length >= pageSize) break;
      if (take(m)) rotateCount += 1;
    }
  }

  return {
    markets: selected.slice(0, pageSize),
    watchCount,
    volumeCount,
    rotateCount,
    pageSize,
    rotateOffset: offset,
    nextRotateOffset: nextOffset,
    eligibleRotateTotal,
  };
}

export function formatPriceStreamCoverage(stats: PriceStreamCoverageStats): string {
  return (
    `[Price Stream][${stats.platform}] coverage eligible=${stats.eligibleActive ?? 'n/a'} ` +
    `selected=${stats.selected} subscribed=${stats.subscribedTokensOrTickers} ` +
    `mix(watch=${stats.watchCount} volume=${stats.volumeCount} rotate=${stats.rotateCount}) ` +
    `page=${stats.pageSize} rotateOffset=${stats.rotateOffset} ` +
    `recentTicks=${stats.recentTickMarkets ?? 'n/a'} durationMs=${stats.durationMs}`
  );
}

/** Count keys with last-seen timestamp within windowMs. */
export function countRecentTicks(
  lastTickAt: Map<string, number>,
  nowMs: number,
  windowMs: number
): number {
  let n = 0;
  for (const t of lastTickAt.values()) {
    if (nowMs - t <= windowMs) n += 1;
  }
  return n;
}
