/**
 * Candle sync selection / coverage planning tests.
 * Run: npm run test:candle-sync-plan
 */
import assert from 'node:assert/strict';
import {
  DEFAULT_CANDLE_SYNC_MARKET_LIMIT,
  formatCandleSyncStats,
  parseShare,
  selectMarketsForCandleSync,
  splitCycleQuotas,
  type SyncMarketRow,
} from './candleSyncPlan.js';
import { parseCandleSyncMarketLimit } from './polyTradesSync.js';

function m(
  id: string,
  volume = 0,
  platform: 'polymarket' | 'kalshi' = 'polymarket'
): SyncMarketRow {
  return {
    canonical_id: id,
    platform,
    external_id: id.replace(/^(polymarket_|kalshi_)/, ''),
    volume,
    active: true,
  };
}

function runQuotasAndLimit() {
  assert.equal(parseCandleSyncMarketLimit(undefined), DEFAULT_CANDLE_SYNC_MARKET_LIMIT);
  assert.equal(parseCandleSyncMarketLimit('0.9'), 40);
  assert.equal(parseCandleSyncMarketLimit('80'), 80);
  assert.equal(parseShare(undefined, 0.25), 0.25);
  assert.equal(parseShare('0.5', 0.25), 0.5);
  assert.equal(parseShare('-1', 0.25), 0.25);
  assert.equal(parseShare('2', 0.25), 1);

  const q = splitCycleQuotas(40, 0.25, 0.35);
  assert.equal(q.watchQuota, 10);
  assert.equal(q.volumeQuota, 14);
  assert.equal(q.rotateQuota, 16);
  assert.equal(q.watchQuota + q.volumeQuota + q.rotateQuota, 40);

  const tiny = splitCycleQuotas(2, 0.5, 0.5);
  assert.ok(tiny.rotateQuota >= 1);
  console.log('✓ quotas + limit parse');
}

function runPriorityAndFairRotation() {
  const watched = ['watch_a', 'watch_b', 'watch_c'];
  const highVol = [
    m('vol_1', 1000),
    m('vol_2', 900),
    m('watch_a', 50), // also watched — deduped into watch bucket
    m('vol_3', 800),
  ];
  const rotatePool = [
    m('rot_a', 1),
    m('rot_b', 1),
    m('rot_c', 1),
    m('rot_d', 1),
    m('vol_1', 1000),
    m('watch_b', 10),
  ];

  const a = selectMarketsForCandleSync({
    pageSize: 6,
    watchedIds: watched,
    highVolumeMarkets: highVol,
    rotatePool,
    rotateCursor: 0,
    watchShare: 0.34,
    volumeShare: 0.34,
  });

  assert.ok(a.markets.length <= 6);
  assert.ok(a.markets.some((x) => x.canonical_id === 'watch_a'));
  assert.ok(a.markets.some((x) => x.canonical_id.startsWith('vol_')));
  const ids = a.markets.map((x) => x.canonical_id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate markets');

  // Second cycle advances rotate cursor
  const b = selectMarketsForCandleSync({
    pageSize: 6,
    watchedIds: watched,
    highVolumeMarkets: highVol,
    rotatePool,
    rotateCursor: a.nextRotateOffset,
    watchShare: 0.34,
    volumeShare: 0.34,
  });
  assert.equal(b.rotateOffset, a.nextRotateOffset);

  // Across several cycles, rotate pool members eventually appear
  let cursor = 0;
  const seenRotate = new Set<string>();
  for (let i = 0; i < 8; i++) {
    const sel = selectMarketsForCandleSync({
      pageSize: 4,
      watchedIds: ['watch_a'],
      highVolumeMarkets: [m('vol_1', 999)],
      rotatePool: [m('rot_a'), m('rot_b'), m('rot_c'), m('rot_d')],
      rotateCursor: cursor,
      watchShare: 0.25,
      volumeShare: 0.25,
    });
    for (const row of sel.markets) {
      if (row.canonical_id.startsWith('rot_')) seenRotate.add(row.canonical_id);
    }
    cursor = sel.nextRotateOffset;
  }
  assert.ok(seenRotate.size >= 3, `expected rotation coverage, got ${[...seenRotate]}`);
  console.log('✓ priority ordering + fair rotation + dedupe');
}

function runEmptyAndInactive() {
  const empty = selectMarketsForCandleSync({
    pageSize: 10,
    watchedIds: [],
    highVolumeMarkets: [],
    rotatePool: [],
    rotateCursor: 0,
  });
  assert.equal(empty.markets.length, 0);

  const inactive = selectMarketsForCandleSync({
    pageSize: 5,
    watchedIds: [],
    highVolumeMarkets: [{ ...m('x', 10), active: false }],
    rotatePool: [{ ...m('y', 1), active: false }],
    rotateCursor: 0,
  });
  assert.equal(inactive.markets.length, 0);
  console.log('✓ empty pools / inactive skipped');
}

function runNoFabricationSemantics() {
  // Selection never invents OHLC — only chooses market ids from inputs.
  const sel = selectMarketsForCandleSync({
    pageSize: 4,
    watchedIds: ['only_watch'],
    highVolumeMarkets: [],
    rotatePool: [],
    rotateCursor: 0,
    watchShare: 0.5,
    volumeShare: 0.25,
  });
  assert.equal(sel.markets.length, 1);
  assert.equal(sel.markets[0].canonical_id, 'only_watch');
  assert.equal(sel.watchCount, 1);
  console.log('✓ empty source history stays a caller concern (no fabricated markets/candles)');
}

function runStatsFormat() {
  const line = formatCandleSyncStats({
    eligibleActive: 100,
    watchlistDistinct: 4,
    processed: 40,
    ok: 30,
    empty: 8,
    failed: 2,
    rows: 1200,
    watchCount: 5,
    volumeCount: 10,
    rotateCount: 25,
    skippedOverlap: false,
    pageSize: 40,
    durationMs: 1234,
  });
  assert.ok(line.includes('eligible=100'));
  assert.ok(line.includes('empty=8'));
  assert.ok(line.includes('failed=2'));
  console.log('✓ ops stats formatting');
}

function main() {
  runQuotasAndLimit();
  runPriorityAndFairRotation();
  runEmptyAndInactive();
  runNoFabricationSemantics();
  runStatsFormat();
  console.log('\nAll candleSyncPlan tests passed.');
}

main();
