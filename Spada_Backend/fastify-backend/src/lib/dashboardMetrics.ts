/**
 * Dashboard 24h change from stored samples of the real counts and volume.
 * No sample about a day old → null. Never invent a percent.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type MetricSample = {
  at: number;
  polymarketActive: number;
  kalshiActive: number;
  totalVolumeUsd: number;
};

export type TrendFields = {
  polymarket_trend: 'up' | 'down' | null;
  polymarket_change_24h: string | null;
  kalshi_trend: 'up' | 'down' | null;
  kalshi_change_24h: string | null;
  volume_trend: 'up' | 'down' | null;
  volume_change_24h: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** Accept a sample that is close to a day old, not a few minutes of noise. */
const MIN_BASELINE_AGE_MS = 20 * 60 * 60 * 1000;
const MAX_BASELINE_AGE_MS = 36 * 60 * 60 * 1000;
const SAMPLE_GAP_MS = 15 * 60 * 1000;
const KEEP_MS = 48 * 60 * 60 * 1000;

const SNAPSHOT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../data/dashboard-metric-snapshots.json'
);

export const EMPTY_TRENDS: TrendFields = {
  polymarket_trend: null,
  polymarket_change_24h: null,
  kalshi_trend: null,
  kalshi_change_24h: null,
  volume_trend: null,
  volume_change_24h: null,
};

export function formatSignedPercent(
  current: number,
  previous: number
): { trend: 'up' | 'down' | null; change: string | null } {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) {
    return { trend: null, change: null };
  }
  const pct = ((current - previous) / previous) * 100;
  if (!Number.isFinite(pct)) return { trend: null, change: null };
  const rounded = Math.round(pct * 10) / 10;
  const trend = rounded > 0 ? 'up' : rounded < 0 ? 'down' : null;
  const sign = rounded > 0 ? '+' : '';
  return { trend, change: `${sign}${rounded.toFixed(1)}%` };
}

/** Sample closest to 24h ago, only if it is actually about a day old. */
export function pickBaseline(samples: MetricSample[], now: number): MetricSample | null {
  const target = now - DAY_MS;
  let best: MetricSample | null = null;
  let bestDist = Infinity;
  for (const sample of samples) {
    if (!Number.isFinite(sample.at)) continue;
    const age = now - sample.at;
    if (age < MIN_BASELINE_AGE_MS || age > MAX_BASELINE_AGE_MS) continue;
    const dist = Math.abs(sample.at - target);
    if (dist < bestDist) {
      best = sample;
      bestDist = dist;
    }
  }
  return best;
}

export function recordSample(
  samples: MetricSample[],
  next: MetricSample,
  now: number
): MetricSample[] {
  const pruned = samples.filter((sample) => now - sample.at <= KEEP_MS && Number.isFinite(sample.at));
  const last = pruned[pruned.length - 1];
  const appended = !last || now - last.at >= SAMPLE_GAP_MS ? [...pruned, next] : pruned;
  if (
    appended.length === samples.length &&
    appended.every((sample, index) => sample.at === samples[index]?.at)
  ) {
    return samples;
  }
  return appended;
}

export function trendsFromSamples(
  current: Omit<MetricSample, 'at'>,
  samples: MetricSample[],
  now: number
): TrendFields {
  const baseline = pickBaseline(samples, now);
  if (!baseline) return { ...EMPTY_TRENDS };
  const polymarket = formatSignedPercent(current.polymarketActive, baseline.polymarketActive);
  const kalshi = formatSignedPercent(current.kalshiActive, baseline.kalshiActive);
  const volume = formatSignedPercent(current.totalVolumeUsd, baseline.totalVolumeUsd);
  return {
    polymarket_trend: polymarket.trend,
    polymarket_change_24h: polymarket.change,
    kalshi_trend: kalshi.trend,
    kalshi_change_24h: kalshi.change,
    volume_trend: volume.trend,
    volume_change_24h: volume.change,
  };
}

function isSample(value: unknown): value is MetricSample {
  if (!value || typeof value !== 'object') return false;
  const row = value as MetricSample;
  return (
    Number.isFinite(row.at) &&
    Number.isFinite(row.polymarketActive) &&
    Number.isFinite(row.kalshiActive) &&
    Number.isFinite(row.totalVolumeUsd)
  );
}

export async function loadAndUpdateDashboardTrends(
  current: Omit<MetricSample, 'at'>,
  now = Date.now()
): Promise<TrendFields> {
  let samples: MetricSample[] = [];
  try {
    const raw = await readFile(SNAPSHOT_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) samples = parsed.filter(isSample);
  } catch {
    samples = [];
  }

  const next = recordSample(samples, { at: now, ...current }, now);
  const trends = trendsFromSamples(current, next, now);
  if (next !== samples) {
    try {
      await mkdir(dirname(SNAPSHOT_PATH), { recursive: true });
      await writeFile(SNAPSHOT_PATH, JSON.stringify(next));
    } catch (err: any) {
      console.warn('[metrics] could not store 24h snapshot:', err?.message ?? err);
    }
  }
  return trends;
}
