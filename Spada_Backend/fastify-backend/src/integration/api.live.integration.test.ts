/**
 * LIVE API integration tests (not mocked).
 *
 * Requires a running Fastify backend with real Supabase credentials.
 * Does not write or delete market/user data — read-only HTTP checks.
 *
 * Run:
 *   SPADA_API_BASE=http://127.0.0.1:4000 npm run test:integration
 *
 * If the API is unreachable this process exits 1. A down backend is not a pass.
 * Set SPADA_INTEGRATION_ALLOW_SKIP=1 only for a local unit-only workflow.
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import {
  CANDLE_RESOLUTIONS,
  apiBase,
  apiGet,
  apiReachable,
  assertCandleSeries,
  assertDashboardMetrics,
  assertMarketVolumeFields,
  assertNoSyntheticCandles,
  assertOrderLevel,
  assertRatioPayload,
  pickBinaryMarketId,
} from './helpers.js';

const RESOLUTION_MS: Record<(typeof CANDLE_RESOLUTIONS)[number], number> = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
};

async function pickMarketWithCandles(base: string): Promise<{ id: string } | null> {
  const candidates: string[] = [];
  if (process.env.SPADA_E2E_MARKET_ID?.trim()) {
    candidates.push(process.env.SPADA_E2E_MARKET_ID.trim());
  }
  // Event rows are the ones with stored multi-outcome history. Probing a
  // random binary market falls through to a slow venue call and often returns [].
  const listed = await apiGet('/api/v1/markets?platform=polymarket&limit=100', base);
  if (listed.status === 200 && Array.isArray(listed.json?.markets)) {
    for (const market of listed.json.markets) {
      const id = market?.canonical_id;
      if (typeof id === 'string' && id.includes('_event_')) candidates.push(id);
    }
  }
  const preferred = await pickBinaryMarketId(base);
  if (preferred) candidates.push(preferred.id);

  const seen = new Set<string>();
  for (const id of candidates.slice(0, 25)) {
    if (seen.has(id)) continue;
    seen.add(id);
    const { status, json } = await apiGet(
      `/api/v1/markets/${encodeURIComponent(id)}/candles?resolution=1h`,
      base
    );
    if (status === 200 && Array.isArray(json?.candles) && json.candles.length > 0) {
      return { id };
    }
  }
  return null;
}

async function assertLiveSocket(base: string, marketId: string) {
  const wsUrl = `${base.replace(/^http/, 'ws')}/api/v1/ws`;
  const seen: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      const connected = seen.includes('CONNECTED');
      reject(
        new Error(
          connected
            ? `VENUE_OR_QUIET: WebSocket connected and subscribed to ${marketId}, but no PRICE_UPDATE arrived in 20s`
            : `WebSocket did not connect at ${wsUrl} (frames: ${seen.join(',') || 'none'})`
        )
      );
    }, 20_000);
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ws.on('open', () => {
      ws.send(JSON.stringify({ action: 'subscribe', canonical_id: marketId }));
    });
    ws.on('message', (raw) => {
      let msg: { type?: string; canonical_id?: string; prices?: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type) seen.push(msg.type);
      if (
        msg.type === 'PRICE_UPDATE' &&
        msg.canonical_id === marketId &&
        Array.isArray(msg.prices) &&
        msg.prices.length > 0
      ) {
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    });
  });
}

async function run() {
  const base = apiBase();
  const allowSkip = process.env.SPADA_INTEGRATION_ALLOW_SKIP === '1';

  if (!(await apiReachable(base))) {
    const msg = `[integration:FAIL] API not reachable at ${base}. Start the backend (npm run dev) or set SPADA_API_BASE.`;
    if (allowSkip) {
      console.error(msg.replace('FAIL', 'SKIP'));
      return;
    }
    console.error(msg);
    process.exit(1);
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

  const picked = await pickMarketWithCandles(base);
    assert.ok(picked, 'expected an active market with stored candles — refusing to pass on empty history');
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
  let resolutionsWithBars = 0;
  for (const resolution of CANDLE_RESOLUTIONS) {
    const { status, json } = await apiGet(
      `/api/v1/markets/${encodeURIComponent(id)}/candles?resolution=${resolution}`
    );
    assert.equal(status, 200, `candles ${resolution} status`);
    assertNoSyntheticCandles(json);
    assertCandleSeries(json.candles, resolution);
    if (json.candles.length > 0) {
      resolutionsWithBars += 1;
      const newest = json.candles[0];
      const bucketMs = new Date(newest.bucket).getTime();
      assert.ok(bucketMs <= Date.now() + 2 * 60 * 1000, `${resolution}: newest bucket is not in the future`);
      const forming = Math.floor(Date.now() / RESOLUTION_MS[resolution]) * RESOLUTION_MS[resolution];
      const isForming = bucketMs >= forming;
      console.log(
        `✓ candles ${resolution}: n=${json.candles.length} newest=${newest.bucket} ${isForming ? '(open bucket)' : '(completed)'}`
      );
    } else {
      console.log(`✓ candles ${resolution}: n=0 (honest empty)`);
    }
  }
  assert.ok(resolutionsWithBars > 0, 'at least one resolution must return real candles');

  {
    const { status, json } = await apiGet(
      `/api/v1/markets/${encodeURIComponent(id)}/candles?resolution=2m`
    );
    assert.equal(status, 400, 'unsupported resolution');
    assert.ok(typeof json?.error === 'string' && json.error.length > 0);
    console.log('✓ candles: unsupported resolution → 400');
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

  // --- Orderbook: schema, or a documented error. A venue failure is not a live-book pass. ---
  {
    const now = Date.now();
    const bookIds: string[] = [];
    // The first page is often settled markets with an honest empty ladder.
    // Open books show up further down; scan a few pages and prefer the latest close.
    for (const offset of [0, 100, 200, 300, 400, 500]) {
      const listed = await apiGet(`/api/v1/markets?platform=kalshi&limit=100&offset=${offset}`);
      if (listed.status !== 200 || !Array.isArray(listed.json?.markets) || listed.json.markets.length === 0) {
        break;
      }
      for (const market of listed.json.markets) {
        const bookId = market?.canonical_id;
        if (typeof bookId !== 'string' || bookId.includes('KXMVE')) continue;
        const closeAt = Date.parse(String(market?.close_time ?? ''));
        if (!Number.isFinite(closeAt) || closeAt <= now) continue;
        bookIds.push(bookId);
      }
    }
    bookIds.sort((a, b) => {
      const rank = (id: string) => (/26(?:NOV|DEC|OCT2[1-9]|OCT3)/.test(id) ? 0 : 1);
      return rank(a) - rank(b);
    });

    let liveBook = false;
    let documentedError = false;
    const probed = bookIds.slice(0, 12);
    for (const bookId of probed) {
      const { status, json } = await apiGet(
        `/api/v1/markets/${encodeURIComponent(bookId)}/orderbook`
      );
      if (status === 200) {
        assert.equal(json.canonical_id, bookId);
        assert.ok(typeof json.platform === 'string');
        assert.ok(Array.isArray(json.bids) && Array.isArray(json.asks));
        for (const level of json.bids) assertOrderLevel(level, 'bid');
        for (const level of json.asks) assertOrderLevel(level, 'ask');
        if (json.bids.length + json.asks.length > 0) {
          liveBook = true;
          console.log(`✓ orderbook 200: ${bookId} bids=${json.bids.length} asks=${json.asks.length}`);
          break;
        }
        console.log(`orderbook 200 empty: ${bookId}`);
      } else {
        assert.ok(status === 404 || status >= 500, `unexpected orderbook status ${status}`);
        assert.ok(typeof json?.error === 'string' && json.error.length > 0);
        documentedError = true;
        console.error(`ORDERBOOK_VENUE: ${bookId} status=${status} error=${json.error}`);
      }
    }
    if (!liveBook) {
      console.error(
        documentedError
          ? 'ORDERBOOK_VENUE: no market returned bid/ask levels (documented errors are not a live book)'
          : `ORDERBOOK_VENUE: every checked book was empty (${probed.length} open Kalshi markets)`
      );
      process.exitCode = 1;
    }

    const missingBook = await apiGet(`/api/v1/markets/does_not_exist_${Date.now()}/orderbook`);
    assert.equal(missingBook.status, 404);
    assert.ok(typeof missingBook.json?.error === 'string' && missingBook.json.error.length > 0);
    console.log('✓ orderbook: unknown market → 404');
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

  {
    const { status, json } = await apiGet('/api/v1/markets/metrics');
    assert.equal(status, 200);
    assertDashboardMetrics(json.metrics);
    const change = json.metrics.volume_change_24h;
    console.log(
      `✓ volume metrics: total=${json.metrics.total_volume_usd} volume_change_24h=${change ?? 'null (no day-old snapshot yet)'}`
    );
  }

  {
    const { status, json } = await apiGet('/api/v1/markets?platform=polymarket&limit=100');
    assert.equal(status, 200);
    // List rows do not always include outcomes.length > 2. Event ids are the
    // multi-outcome markets; stored per-token history returns in about a second.
    const eventIds = (json.markets ?? [])
      .map((market: { canonical_id?: string }) => market.canonical_id)
      .filter((value: unknown): value is string => typeof value === 'string' && value.includes('_event_'));
    const outcomeIds = [...eventIds, id].filter(
      (value, index, all) => all.indexOf(value) === index
    );
    if (!outcomeIds.length) {
      console.error('MULTI_OUTCOME: no polymarket event in the first page — cannot verify outcome candles');
      process.exitCode = 1;
    } else {
      let found = false;
      for (const outcomeId of outcomeIds.slice(0, 8)) {
        let candleStatus = 0;
        let candleJson: { candles?: unknown[] } | null = null;
        try {
          // outcome>0 can fall through to a venue history call. A slow venue
          // must not hang the suite; try the next event instead.
          const result = await apiGet(
            `/api/v1/markets/${encodeURIComponent(outcomeId)}/candles?resolution=1h&outcome=1`,
            base,
            4_000
          );
          candleStatus = result.status;
          candleJson = result.json;
        } catch (err) {
          console.log(`multi-outcome skip ${outcomeId}: ${(err as Error).name || err}`);
          continue;
        }
        if (candleStatus !== 200 || !candleJson) continue;
        assertNoSyntheticCandles(candleJson);
        assertCandleSeries(candleJson.candles, 'outcome=1');
        if (Array.isArray(candleJson.candles) && candleJson.candles.length > 0) {
          found = true;
          console.log(`✓ multi-outcome candles ${outcomeId}: n=${candleJson.candles.length}`);
          break;
        }
      }
      if (!found) {
        console.error('MULTI_OUTCOME: no checked event returned outcome=1 candles');
        process.exitCode = 1;
      }
    }
  }

  await assertLiveSocket(base, id);
  console.log(`✓ websocket PRICE_UPDATE for ${id}`);

  if (process.exitCode && process.exitCode !== 0) {
    throw new Error('LIVE integration reported a venue or data condition (see ORDERBOOK_VENUE / MULTI_OUTCOME above)');
  }

  console.log('\nAll LIVE API integration tests passed.');
}

run().catch((err) => {
  console.error('[integration:FAIL]', err);
  process.exit(1);
});
