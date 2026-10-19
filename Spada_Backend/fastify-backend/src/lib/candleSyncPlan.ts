/**
 * Historical candle sync market selection: watched + high-volume priority,
 * with fair rotation for the remainder. Pure helpers — no DB / no fabricated candles.
 */

import {
  DEFAULT_CANDLE_SYNC_MARKET_LIMIT,
  MAX_CANDLE_SYNC_MARKET_LIMIT,
  nextRotatedOffset,
  parseCandleSyncMarketLimit,
  rotatedPageRanges,
} from './polyTradesSync.js';

export {
  DEFAULT_CANDLE_SYNC_MARKET_LIMIT,
  MAX_CANDLE_SYNC_MARKET_LIMIT,
  parseCandleSyncMarketLimit,
};

/** Fraction of each cycle reserved for watchlist markets (0–1). */
export const DEFAULT_CANDLE_SYNC_WATCH_SHARE = 0.25;
/** Fraction of each cycle reserved for high-volume markets (0–1). */
export const DEFAULT_CANDLE_SYNC_VOLUME_SHARE = 0.35;

export type SyncMarketRow = {
  canonical_id: string;
  platform: string;
  external_id: string | null;
  raw_data?: unknown;
  volume?: number | null;
  active?: boolean | null;
};

export type CandleSyncSelection = {
  markets: SyncMarketRow[];
  watchCount: number;
  volumeCount: number;
  rotateCount: number;
  pageSize: number;
  rotateOffset: number;
  nextRotateOffset: number;
  eligibleRotateTotal: number;
};

export type CandleSyncCycleStats = {
  eligibleActive: number;
  watchlistDistinct: number;
  processed: number;
  ok: number;
  empty: number;
  failed: number;
  rows: number;
  watchCount: number;
  volumeCount: number;
  rotateCount: number;
  skippedOverlap: boolean;
  pageSize: number;
  durationMs: number;
};

export function parseShare(
  raw: string | undefined,
  fallback: number
): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(1, n);
}

export function splitCycleQuotas(
  pageSize: number,
  watchShare: number = DEFAULT_CANDLE_SYNC_WATCH_SHARE,
  volumeShare: number = DEFAULT_CANDLE_SYNC_VOLUME_SHARE
): { watchQuota: number; volumeQuota: number; rotateQuota: number } {
  const size = Math.max(1, Math.floor(pageSize));
  let wShare = Math.min(1, Math.max(0, watchShare));
  let vShare = Math.min(1, Math.max(0, volumeShare));
  // Cap combined priority shares so rotation keeps capacity.
  const combined = wShare + vShare;
  if (combined > 0.9 && combined > 0) {
    const scale = 0.9 / combined;
    wShare *= scale;
    vShare *= scale;
  }
  let watchQuota = Math.floor(size * wShare);
  let volumeQuota = Math.floor(size * vShare);
  // Small pages: floor(share) can be 0 — keep at least one priority slot when share > 0.
  if (wShare > 0 && watchQuota === 0 && size >= 2) watchQuota = 1;
  if (vShare > 0 && volumeQuota === 0 && size >= 3) volumeQuota = 1;
  let rotateQuota = size - watchQuota - volumeQuota;
  if (rotateQuota < 1 && size >= 1) {
    // Steal from volume then watch to keep fair rotation alive.
    if (volumeQuota > 0) {
      volumeQuota -= 1;
      rotateQuota += 1;
    } else if (watchQuota > 0) {
      watchQuota -= 1;
      rotateQuota += 1;
    } else {
      rotateQuota = size;
    }
  }
  return { watchQuota, volumeQuota, rotateQuota };
}

/**
 * Build one cycle's market list: watchlist → high volume → fair rotate remainder.
 * Dedupes by canonical_id. Does not invent markets.
 */
export function selectMarketsForCandleSync(input: {
  pageSize: number;
  watchedIds: string[];
  highVolumeMarkets: SyncMarketRow[];
  rotatePool: SyncMarketRow[];
  rotateCursor: number;
  watchShare?: number;
  volumeShare?: number;
}): CandleSyncSelection {
  const pageSize = parseCandleSyncMarketLimit(
    String(input.pageSize),
    DEFAULT_CANDLE_SYNC_MARKET_LIMIT
  );
  const { watchQuota, volumeQuota, rotateQuota } = splitCycleQuotas(
    pageSize,
    input.watchShare ?? DEFAULT_CANDLE_SYNC_WATCH_SHARE,
    input.volumeShare ?? DEFAULT_CANDLE_SYNC_VOLUME_SHARE
  );

  const selected: SyncMarketRow[] = [];
  const seen = new Set<string>();

  const take = (row: SyncMarketRow | undefined): boolean => {
    if (!row?.canonical_id || seen.has(row.canonical_id)) return false;
    if (row.active === false) return false;
    seen.add(row.canonical_id);
    selected.push(row);
    return true;
  };

  // Index rotate + volume pools for watchlist hydration
  const byId = new Map<string, SyncMarketRow>();
  for (const m of input.highVolumeMarkets) byId.set(m.canonical_id, m);
  for (const m of input.rotatePool) {
    if (!byId.has(m.canonical_id)) byId.set(m.canonical_id, m);
  }

  let watchCount = 0;
  for (const id of input.watchedIds) {
    if (watchCount >= watchQuota) break;
    const row =
      byId.get(id) ??
      ({
        canonical_id: id,
        platform: id.startsWith('kalshi_') ? 'kalshi' : 'polymarket',
        external_id: null,
        active: true,
      } satisfies SyncMarketRow);
    if (take(row)) watchCount += 1;
  }

  let volumeCount = 0;
  const volumeSorted = [...input.highVolumeMarkets].sort(
    (a, b) => Number(b.volume ?? 0) - Number(a.volume ?? 0)
  );
  for (const m of volumeSorted) {
    if (volumeCount >= volumeQuota) break;
    if (take(m)) volumeCount += 1;
  }

  // Fair rotation over markets not already selected
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

  // If priority slots under-filled, top up from rotation pool in volume order
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

export function formatCandleSyncStats(stats: CandleSyncCycleStats): string {
  return (
    `[Candle Sync] cycle eligible=${stats.eligibleActive} watchlist=${stats.watchlistDistinct} ` +
    `processed=${stats.processed} ok=${stats.ok} empty=${stats.empty} failed=${stats.failed} ` +
    `rows≈${stats.rows} mix(watch=${stats.watchCount} volume=${stats.volumeCount} rotate=${stats.rotateCount}) ` +
    `page=${stats.pageSize} durationMs=${stats.durationMs}` +
    (stats.skippedOverlap ? ' skipped=overlap' : '')
  );
}
