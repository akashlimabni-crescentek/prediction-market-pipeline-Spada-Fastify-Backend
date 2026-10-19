/**
 * LIVE API integration tests (not mocked).
 *
 * Requires a running Fastify backend with real Supabase credentials.
 * Does not write or delete market/user data — read-only HTTP checks.
 *
 * Run:
 *   SPADA_API_BASE=http://127.0.0.1:4000 npm run test:integration
 *
 * If the API is unreachable, the suite exits 0 after printing SKIP
 * (so local unit-only workflows are not blocked). Set
 * SPADA_INTEGRATION_REQUIRE=1 to fail hard when the API is down.
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import {
  CANDLE_RESOLUTIONS,
  apiBase,
  apiGet,
  apiReachable,
  assertMarketVolumeFields,
  assertNoSyntheticCandles,
  assertRatioPayload,
  pickBinaryMarketId,
} from './helpers.js';

async function run() {
  const base = apiBase();
  const requireLive = process.env.SPADA_INTEGRATION_REQUIRE === '1';

  if (!(await apiReachable(base))) {
    const msg = `[integration:SKIP] API not reachable at ${base}. Start the backend (npm run dev) or set SPADA_API_BASE.`;
    if (requireLive) {
      console.error(msg);
      process.exit(1);
    }
    console.log(msg);
    return;
  }

  console.log(`[integration:LIVE] base=${base}`);

  // --- Missing market ---
  {
    const { status, json } = await apiGet(
      `/api/v1/markets/does_not_exist_${Date.now()}`
    );
    assert.equal(status, 404);
    assert.equal(json?.error, 'Market not found');
    console.log('✓ market details: missing → 404');
  }

  const picked = await pickBinaryMarketId(base);
  assert.ok(picked, 'expected at least one active market from /markets');
  const { id } = picked;

  // --- Market details + volume fields ---
  {
    const { status, json } = await apiGet(`/api/v1/markets/${encodeURIComponent(id)}`);
    assert.equal(status, 200);
    assert.ok(json?.market);
    assert.equal(json.market.canonical_id, id);
    assert.ok(typeof json.market.title === 'string' && json.market.title.length > 0);
    assertMarketVolumeFields(json.market);
    console.log(`✓ market details + volume fields (${id})`);
  }

  // --- Candles: all six resolutions, no synthetic markers ---
  for (const resolution of CANDLE_RESOLUTIONS) {
    const { status, json } = await apiGet(
      `/api/v1/markets/${encodeURIComponent(id)}/candles?resolution=${resolution}`
    );
    assert.equal(status, 200, `candles ${resolution} status`);
    assertNoSyntheticCandles(json);
    // Empty history is allowed (honest []). Non-empty bars must be finite OHLCV.
    for (const c of json.candles.slice(0, 5)) {
      for (const field of ['open', 'high', 'low', 'close'] as const) {
        assert.ok(Number.isFinite(Number(c[field])), `${resolution} ${field}`);
      }
    }
    console.log(`✓ candles ${resolution}: n=${json.candles.length} (no _tempStatic)`);
  }

  // Unknown market candles → 404 (contract)
  {
    const { status, json } = await apiGet(
      `/api/v1/markets/does_not_exist_${Date.now()}/candles?resolution=1h`
    );
    assert.equal(status, 404);
    assert.equal(json?.error, 'Market not found');
    console.log('✓ candles: unknown market → 404');
  }

  // --- Orderbook: live venue shape or honest error (never synthetic levels) ---
  {
    const { status, json } = await apiGet(
      `/api/v1/markets/${encodeURIComponent(id)}/orderbook`
    );
    if (status === 200) {
      assert.equal(json.canonical_id, id);
      assert.ok(typeof json.platform === 'string');
      assert.ok(Array.isArray(json.bids));
      assert.ok(Array.isArray(json.asks));
      console.log(
        `✓ orderbook 200: bids=${json.bids.length} asks=${json.asks.length}`
      );
    } else {
      assert.ok(status === 404 || status >= 500, `unexpected orderbook status ${status}`);
      assert.ok(typeof json?.error === 'string' && json.error.length > 0);
      console.log(`✓ orderbook honest failure status=${status}`);
    }
  }

  // --- Ratios / matching availability ---
  {
    const { status, json } = await apiGet(
      `/api/v1/ratios/${encodeURIComponent(id)}`
    );
    assert.equal(status, 200);
    assertRatioPayload(json);
    console.log(
      `✓ ratios: matched=${json.matched} divergence=${json.ratios?.divergence}`
    );
  }

  console.log('\nAll LIVE API integration tests passed.');
}

run().catch((err) => {
  console.error('[integration:FAIL]', err);
  process.exit(1);
});
