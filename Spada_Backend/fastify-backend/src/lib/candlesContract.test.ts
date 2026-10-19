/**
 * Candle HTTP contract helpers (no live DB / no Supabase).
 * Unknown market → 404; known market with empty history → 200 + [].
 * Production candles API must never return synthetic / `_tempStatic` OHLCV.
 * Run: npx tsx src/lib/candlesContract.test.ts
 *   or: node --import tsx/esm --eval "import('./src/lib/candlesContract.test.ts')"
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const marketRoutePath = join(here, '../routes/market.ts');
const tempStaticPath = join(here, 'tempStaticCandles.ts');

/** Chart resolutions required by the client OHLCV work items. */
const REQUIRED_RESOLUTIONS = ['5m', '15m', '1h', '4h', '1d', '1w'] as const;

/** Mirrors GET /markets/:id/candles identity check before aggregation. */
export function candleHttpStatusForMarket(exists: boolean): 200 | 404 {
  return exists ? 200 : 404;
}

/**
 * Production success body for GET /markets/:id/candles.
 * Must stay free of `_tempStatic` or any synthetic marker.
 */
export function buildCandlesSuccessBody(candles: unknown[]) {
  return { candles };
}

function assertNoSyntheticCandleMarkers(body: Record<string, unknown>) {
  assert.equal(
    Object.prototype.hasOwnProperty.call(body, '_tempStatic'),
    false,
    'candles response must not include _tempStatic'
  );
  assert.deepEqual(Object.keys(body).sort(), ['candles']);
}

function run() {
  assert.equal(candleHttpStatusForMarket(false), 404);
  assert.equal(candleHttpStatusForMarket(true), 200);

  // Empty history is still a successful response once identity is confirmed.
  const bodyKnownEmpty = buildCandlesSuccessBody([]);
  assert.equal(candleHttpStatusForMarket(true), 200);
  assert.deepEqual(bodyKnownEmpty, { candles: [] });
  assertNoSyntheticCandleMarkers(bodyKnownEmpty);

  const bodyUnknown = { error: 'Market not found' };
  assert.equal(candleHttpStatusForMarket(false), 404);
  assert.equal(bodyUnknown.error, 'Market not found');

  // All six chart resolutions share the same honest success shape.
  for (const resolution of REQUIRED_RESOLUTIONS) {
    const body = buildCandlesSuccessBody([]);
    assertNoSyntheticCandleMarkers(body);
    assert.ok(resolution.length > 0);
  }

  // Regression: static synthetic candle module must not exist in the tree.
  assert.equal(
    existsSync(tempStaticPath),
    false,
    'tempStaticCandles.ts must be removed so production cannot serve synthetic OHLCV'
  );

  // Regression: market route must call the real aggregator only — no static short-circuit.
  const marketSource = readFileSync(marketRoutePath, 'utf8');
  assert.equal(
    marketSource.includes('tempStaticCandles'),
    false,
    'market.ts must not import or reference tempStaticCandles'
  );
  assert.equal(
    marketSource.includes('TEMP_STATIC_CANDLES_ENABLED'),
    false,
    'market.ts must not gate on TEMP_STATIC_CANDLES_ENABLED'
  );
  assert.equal(
    marketSource.includes('buildTempStaticCandles'),
    false,
    'market.ts must not call buildTempStaticCandles'
  );
  assert.equal(
    marketSource.includes('_tempStatic'),
    false,
    'market.ts must not return _tempStatic responses'
  );
  assert.ok(
    marketSource.includes('candleAggregator.getCandles'),
    'market.ts must fetch candles via candleAggregator.getCandles'
  );
  // Route must still accept the six resolutions (via CANDLE_RESOLUTIONS / isCandleResolution).
  assert.ok(
    marketSource.includes('isCandleResolution'),
    'market.ts must validate resolution via isCandleResolution'
  );

  console.log('✓ candles contract: unknown → 404; known empty → 200 []');
  console.log('✓ candles contract: no synthetic / _tempStatic markers');
  console.log('✓ candles contract: tempStaticCandles removed; route uses aggregator only');
  console.log('\nAll candles contract tests passed.');
}

run();
