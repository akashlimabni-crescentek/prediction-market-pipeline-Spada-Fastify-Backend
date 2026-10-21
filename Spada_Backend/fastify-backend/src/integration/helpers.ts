/**
 * Shared helpers for LIVE API integration tests.
 * These hit a running Fastify server — they do not mock Supabase or venues.
 */
import assert from 'node:assert/strict';

export const CANDLE_RESOLUTIONS = ['5m', '15m', '1h', '4h', '1d', '1w'] as const;

export const RATIO_KEYS = [
  'pressure',
  'churn',
  'support',
  'executionCost',
  'divergence',
  'probabilityMomentum',
  'resolutionTension',
] as const;

export function apiBase(): string {
  const raw = (process.env.SPADA_API_BASE ?? 'http://127.0.0.1:4000').trim();
  return raw.replace(/\/$/, '');
}

export async function apiReachable(base = apiBase()): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/v1/markets/metrics`, {
      signal: AbortSignal.timeout(4_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function apiGet(
  path: string,
  base = apiBase(),
  timeoutMs = 30_000
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/** Prefer a binary (non-event) active market for chart/orderbook contracts. */
export async function pickBinaryMarketId(
  base = apiBase()
): Promise<{ id: string; market: any } | null> {
  for (const platform of ['polymarket', 'kalshi'] as const) {
    const { status, json } = await apiGet(`/api/v1/markets?platform=${platform}&limit=20`, base);
    if (status !== 200 || !Array.isArray(json?.markets)) continue;
    const binary = json.markets.find(
      (m: any) =>
        typeof m?.canonical_id === 'string' &&
        !String(m.canonical_id).includes('_event_') &&
        (m.outcome_type === 'binary' || (Array.isArray(m.outcomes) && m.outcomes.length <= 2))
    );
    if (binary) return { id: binary.canonical_id, market: binary };
    if (json.markets[0]?.canonical_id) {
      return { id: json.markets[0].canonical_id, market: json.markets[0] };
    }
  }
  return null;
}

export function assertNoSyntheticCandles(body: Record<string, unknown>) {
  assert.equal(
    Object.prototype.hasOwnProperty.call(body, '_tempStatic'),
    false,
    'LIVE candles must not include _tempStatic synthetic marker'
  );
  assert.ok(Array.isArray(body.candles), 'candles must be an array');
}

/** Newest-first OHLCV contract used by GET /candles (limitCandles). */
export function assertCandleSeries(candles: unknown[], label: string) {
  assert.ok(Array.isArray(candles), `${label}: candles must be an array`);
  let prevMs: number | null = null;
  for (const raw of candles) {
    assert.ok(raw && typeof raw === 'object', `${label}: candle must be an object`);
    const candle = raw as Record<string, unknown>;
    const open = Number(candle.open);
    const high = Number(candle.high);
    const low = Number(candle.low);
    const close = Number(candle.close);
    const volume = Number(candle.volume ?? 0);
    const bucketMs = new Date(String(candle.bucket)).getTime();
    assert.ok(Number.isFinite(bucketMs), `${label}: bucket timestamp`);
    assert.ok(Number.isFinite(open) && Number.isFinite(high) && Number.isFinite(low) && Number.isFinite(close), `${label}: OHLC`);
    assert.ok(Number.isFinite(volume) && volume >= 0, `${label}: volume`);
    assert.ok(high >= open && high >= close, `${label}: high >= open and close`);
    assert.ok(low <= open && low <= close, `${label}: low <= open and close`);
    assert.ok(high >= low, `${label}: high >= low`);
    if (prevMs != null) {
      assert.ok(prevMs >= bucketMs, `${label}: candles must be newest-first`);
    }
    prevMs = bucketMs;
  }
}

export function assertMarketVolumeFields(market: Record<string, unknown>) {
  assert.ok(typeof market.volume === 'number' && Number.isFinite(market.volume));
  assert.ok(
    market.event_volume == null ||
      (typeof market.event_volume === 'number' && Number.isFinite(market.event_volume as number)),
    'event_volume must be number or null/undefined'
  );
  if (Array.isArray(market.outcome_prices)) {
    for (const outcome of market.outcome_prices as Array<Record<string, unknown>>) {
      assert.ok(typeof outcome.name === 'string' && outcome.name.length > 0);
      assert.ok(typeof outcome.price === 'number' && Number.isFinite(outcome.price));
      assert.ok(typeof outcome.percentage === 'number' && Number.isFinite(outcome.percentage));
    }
  }
}

export function assertOrderLevel(level: unknown, label: string) {
  assert.ok(level && typeof level === 'object', `${label}: level`);
  const row = level as Record<string, unknown>;
  const price = Number(row.price);
  const size = Number(row.size);
  assert.ok(Number.isFinite(price) && price >= 0, `${label}: price`);
  assert.ok(Number.isFinite(size) && size >= 0, `${label}: size`);
}

const TREND = new Set(['up', 'down', null]);

/** Dashboard change fields stay null until a real ~24h snapshot exists. */
export function assertDashboardMetrics(metrics: Record<string, unknown>) {
  assert.ok(typeof metrics.total_volume_usd === 'number' && Number.isFinite(metrics.total_volume_usd));
  assert.ok(typeof metrics.polymarket_active_count === 'number');
  assert.ok(typeof metrics.kalshi_active_count === 'number');
  for (const key of ['polymarket_trend', 'kalshi_trend', 'volume_trend'] as const) {
    assert.ok(TREND.has(metrics[key] as 'up' | 'down' | null), `${key} must be up|down|null`);
  }
  for (const key of ['polymarket_change_24h', 'kalshi_change_24h', 'volume_change_24h'] as const) {
    const value = metrics[key];
    assert.ok(value == null || typeof value === 'string', `${key} must be string|null`);
    if (typeof value === 'string') {
      assert.match(value, /^[+-]?\d+(\.\d+)?%$/);
    }
  }
}

export function assertRatioPayload(body: Record<string, unknown>) {
  assert.equal(typeof body.matched, 'boolean');
  assert.ok(body.ratios && typeof body.ratios === 'object');
  for (const key of RATIO_KEYS) {
    assert.ok(key in (body.ratios as object), `missing ratio ${key}`);
    const v = (body.ratios as Record<string, unknown>)[key];
    assert.ok(
      v == null || (typeof v === 'number' && Number.isFinite(v)),
      `${key} must be number|null`
    );
  }
  // Divergence only when matched + both probs available — otherwise null is honest.
  if (body.matched === false) {
    assert.equal(
      (body.ratios as Record<string, unknown>).divergence,
      null,
      'unmatched market must not invent divergence'
    );
  }
}
