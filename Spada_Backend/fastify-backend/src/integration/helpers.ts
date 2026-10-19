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
  base = apiBase()
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
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

export function assertMarketVolumeFields(market: Record<string, unknown>) {
  assert.ok(typeof market.volume === 'number' && Number.isFinite(market.volume));
  assert.ok(
    market.event_volume == null ||
      (typeof market.event_volume === 'number' && Number.isFinite(market.event_volume as number)),
    'event_volume must be number or null/undefined'
  );
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
