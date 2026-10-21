/**
 * MOCKED contract tests — no network, no Supabase, no venue calls.
 * Validates pure response-shape helpers used by LIVE integration tests.
 *
 * Run: npm run test:integration:mock
 */
import assert from 'node:assert/strict';
import {
  CANDLE_RESOLUTIONS,
  RATIO_KEYS,
  assertCandleSeries,
  assertDashboardMetrics,
  assertMarketVolumeFields,
  assertNoSyntheticCandles,
  assertRatioPayload,
} from './helpers.js';

function run() {
  assert.deepEqual([...CANDLE_RESOLUTIONS], ['5m', '15m', '1h', '4h', '1d', '1w']);
  assert.equal(RATIO_KEYS.length, 7);

  assertNoSyntheticCandles({ candles: [] });
  assertNoSyntheticCandles({
    candles: [
      {
        ticker: 'x',
        bucket: '2026-01-01T00:00:00.000Z',
        open: 0.4,
        high: 0.5,
        low: 0.3,
        close: 0.45,
        volume: 10,
      },
    ],
  });
  assert.throws(() => assertNoSyntheticCandles({ candles: [], _tempStatic: true } as any));
  assertCandleSeries(
    [
      { bucket: '2026-01-01T01:00:00.000Z', open: 0.4, high: 0.5, low: 0.3, close: 0.45, volume: 2 },
      { bucket: '2026-01-01T00:00:00.000Z', open: 0.2, high: 0.4, low: 0.2, close: 0.3, volume: 0 },
    ],
    'mock'
  );
  assert.throws(() =>
    assertCandleSeries(
      [{ bucket: '2026-01-01T00:00:00.000Z', open: 0.9, high: 0.4, low: 0.3, close: 0.45, volume: 1 }],
      'bad-high'
    )
  );
  assertDashboardMetrics({
    total_volume_usd: 10,
    polymarket_active_count: 1,
    kalshi_active_count: 2,
    polymarket_trend: null,
    polymarket_change_24h: null,
    kalshi_trend: 'up',
    kalshi_change_24h: '+1.0%',
    volume_trend: null,
    volume_change_24h: null,
  });

  assertMarketVolumeFields({ volume: 100, event_volume: 250 });
  assertMarketVolumeFields({ volume: 0, event_volume: null });
  assert.throws(() => assertMarketVolumeFields({ volume: 'x' } as any));

  assertRatioPayload({
    matched: false,
    ratios: Object.fromEntries(RATIO_KEYS.map((k) => [k, null])),
  });
  assertRatioPayload({
    matched: true,
    ratios: {
      pressure: 1,
      churn: 0.5,
      support: 2,
      executionCost: 0.01,
      divergence: 0.1,
      probabilityMomentum: 0.02,
      resolutionTension: 0.3,
    },
  });
  assert.throws(() =>
    assertRatioPayload({
      matched: false,
      ratios: { ...Object.fromEntries(RATIO_KEYS.map((k) => [k, null])), divergence: 0.5 },
    })
  );

  console.log('✓ MOCKED candle / volume / ratio contract helpers');
  console.log('\nAll MOCKED contract tests passed.');
}

run();
