/**
 * Forming-candle + OHLCV aggregation tests.
 * Run: npm run test:candles
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import {
  GAP_FILL_CAP,
  INTERVAL_MS,
  SUB_INTERVAL_LADDER,
  aggregateOhlcv,
  applyLivePrice,
  bucketStartMs,
  buildFormingCandle,
  computeGapFills,
  fillCandleGaps,
  maxCandlesForResolution,
  stripFormingBucket,
  type FormingCandleRow,
} from './formingCandle.js';
import {
  CANDLE_RESOLUTIONS,
  candleAggregator,
} from '../services/candleAggregator.js';

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function row(
  tsMs: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 0
): FormingCandleRow {
  return { ts: iso(tsMs), open, high, low, close, volume };
}

function runAggregation() {
  const base = 1_700_000_000_000; // fixed epoch
  const start5 = bucketStartMs(base, INTERVAL_MS['5m']);
  const m1 = row(start5, 0.4, 0.42, 0.39, 0.41, 10);
  const m2 = row(start5 + 60_000, 0.41, 0.45, 0.4, 0.44, 20);
  const m3 = row(start5 + 120_000, 0.44, 0.46, 0.43, 0.45, 5);
  const agg = aggregateOhlcv([m3, m1, m2], '5m');
  assert.equal(agg.length, 1);
  assert.equal(agg[0].open, 0.4);
  assert.equal(agg[0].high, 0.46);
  assert.equal(agg[0].low, 0.39);
  assert.equal(agg[0].close, 0.45);
  assert.equal(agg[0].volume, 35);
  assert.equal(agg[0].ts, iso(start5));
  console.log('✓ OHLCV aggregation from finer candles');
}

function runBucketBoundaries() {
  for (const res of CANDLE_RESOLUTIONS) {
    const ms = INTERVAL_MS[res];
    assert.ok(ms > 0, res);
    const t = Date.parse('2026-10-09T06:17:42.000Z');
    const start = bucketStartMs(t, ms);
    assert.equal(start % ms, 0, `${res} aligned`);
    assert.ok(start <= t && t < start + ms, `${res} contains t`);
  }
  // UTC day / week floors
  const day = bucketStartMs(Date.parse('2026-10-09T15:00:00.000Z'), INTERVAL_MS['1d']);
  assert.equal(iso(day), '2026-10-09T00:00:00.000Z');
  console.log('✓ bucket boundaries for all resolutions');
}

function runFormingFromLive() {
  const now = Date.parse('2026-10-09T06:18:00.000Z');
  const bucketStart = bucketStartMs(now, INTERVAL_MS['5m']);
  assert.equal(iso(bucketStart), '2026-10-09T06:15:00.000Z');

  const { candle, pieces } = buildFormingCandle({
    interval: '5m',
    bucketStartMs: bucketStart,
    nowMs: now,
    finerRowsByInterval: {
      '1m': [
        row(bucketStart, 0.5, 0.52, 0.49, 0.51, 100),
        row(bucketStart + 60_000, 0.51, 0.53, 0.5, 0.52, 50),
      ],
    },
    liveTail: {
      ts: iso(bucketStart + 120_000),
      open: 0.52,
      high: 0.55,
      low: 0.51,
      close: 0.54,
      volume: 0,
    },
  });

  assert.ok(candle);
  assert.equal(candle!.open, 0.5);
  assert.equal(candle!.high, 0.55);
  assert.equal(candle!.low, 0.49);
  assert.equal(candle!.close, 0.54);
  assert.equal(candle!.volume, 150); // DB only; live volume 0
  assert.equal(pieces.filter((p) => p.src.startsWith('db:')).length, 2);
  assert.equal(pieces.filter((p) => p.src === 'live').length, 1);
  console.log('✓ forming candle from finer + live');
}

function runOutOfOrderAndDuplicateLive() {
  const platform = 'polymarket' as const;
  const ticker = `test-token-forming-${Date.now()}`;
  const t0 = bucketStartMs(Date.now(), 60_000);

  candleAggregator.ingestLiveTick(platform, ticker, 0.4, { tsMs: t0 + 10_000 });
  candleAggregator.ingestLiveTick(platform, ticker, 0.45, { tsMs: t0 + 20_000 });
  // duplicate non-trade — OHLC updates, volume stays 0
  candleAggregator.ingestLiveTick(platform, ticker, 0.45, { tsMs: t0 + 25_000 });
  candleAggregator.ingestLiveTick(platform, ticker, 0.42, {
    tsMs: t0 + 30_000,
    isTrade: true,
    volume: 10,
  });
  candleAggregator.ingestLiveTick(platform, ticker, 0.42, {
    tsMs: t0 + 31_000,
    isTrade: true,
    volume: 10,
  });

  // late tick for previous minute — ignored
  candleAggregator.ingestLiveTick(platform, ticker, 0.1, { tsMs: t0 - 30_000 });

  const live = candleAggregator.peekLiveBucket(platform, ticker);
  assert.ok(live);
  assert.equal(live!.open, 0.4);
  assert.equal(live!.high, 0.45);
  assert.equal(live!.low, 0.4);
  assert.equal(live!.close, 0.42);
  assert.equal(live!.volume, 20);
  assert.equal(live!.tradeCount, 2);
  console.log('✓ out-of-order ignored; duplicate trades add volume once each');
}

function runMissingIntervalsNoFabrication() {
  const now = Date.parse('2026-10-09T06:18:30.000Z');
  const bucketStart = bucketStartMs(now, INTERVAL_MS['5m']);
  // Gap at 06:16 — only 06:15 exists; composer stops 1m rung at gap, then live covers tail
  const { candle, pieces } = buildFormingCandle({
    interval: '5m',
    bucketStartMs: bucketStart,
    nowMs: now,
    finerRowsByInterval: {
      '1m': [row(bucketStart, 0.5, 0.5, 0.5, 0.5, 1)],
      // missing bucketStart+60_000 deliberately
    },
    liveTail: {
      ts: iso(bucketStart + 120_000),
      open: 0.6,
      high: 0.61,
      low: 0.59,
      close: 0.6,
      volume: 0,
    },
  });
  assert.ok(candle);
  // First piece is the only DB minute; live fills remainder — no synthetic 06:16 bar
  assert.equal(pieces.length, 2);
  assert.equal(pieces[0].src, 'db:1m');
  assert.equal(pieces[1].src, 'live');
  assert.equal(candle!.open, 0.5);
  assert.equal(candle!.close, 0.6);
  assert.ok(!pieces.some((p) => p.fromMs === bucketStart + 60_000 && p.src.startsWith('db:')));
  console.log('✓ missing source intervals not fabricated');
}

function runVolumeNoDoubleCount() {
  // 06:27 → 15m bucket 06:15; both 06:15 and 06:20 5m blocks are complete
  const now = Date.parse('2026-10-09T06:27:00.000Z');
  const bucketStart = bucketStartMs(now, INTERVAL_MS['15m']);
  assert.equal(iso(bucketStart), '2026-10-09T06:15:00.000Z');
  // 15m ladder: 5m then 1m. Overlapping 1m rows must not also be consumed.
  const { candle, pieces } = buildFormingCandle({
    interval: '15m',
    bucketStartMs: bucketStart,
    nowMs: now,
    finerRowsByInterval: {
      '5m': [
        row(bucketStart, 0.4, 0.5, 0.4, 0.48, 100),
        row(bucketStart + 5 * 60_000, 0.48, 0.5, 0.47, 0.49, 200),
      ],
      '1m': [
        row(bucketStart, 0.4, 0.5, 0.4, 0.48, 999),
        row(bucketStart + 60_000, 0.4, 0.5, 0.4, 0.48, 999),
      ],
    },
    liveTail: {
      ts: iso(bucketStart + 10 * 60_000),
      open: 0.49,
      high: 0.5,
      low: 0.48,
      close: 0.5,
      volume: 7,
    },
  });
  assert.ok(candle);
  assert.equal(candle!.volume, 100 + 200 + 7);
  assert.ok(!pieces.some((p) => p.src === 'db:1m' && p.volume === 999));
  console.log('✓ volume without double-counting overlapping timeframes');
}

function runStripFormingImmutability() {
  const formingStart = Date.parse('2026-10-09T06:15:00.000Z');
  const candles = [
    { bucket: '2026-10-09T06:15:00.000Z', open: 0.9 }, // open bucket — strip
    { bucket: '2026-10-09T06:10:00.000Z', open: 0.5 },
    { bucket: '2026-10-09T06:05:00.000Z', open: 0.4 },
  ];
  const stripped = stripFormingBucket(candles, formingStart);
  assert.equal(stripped.length, 2);
  assert.ok(stripped.every((c) => c.bucket < '2026-10-09T06:15:00.000Z'));
  // Original completed bars unchanged
  assert.equal(candles[1].open, 0.5);
  console.log('✓ strip forming bucket; completed history untouched');
}

function runApiOrderingAndLimits() {
  assert.deepEqual([...CANDLE_RESOLUTIONS], ['5m', '15m', '1h', '4h', '1d', '1w']);
  assert.ok(maxCandlesForResolution('5m') >= 100);
  assert.ok(maxCandlesForResolution('1w') >= 52);
  for (const res of CANDLE_RESOLUTIONS) {
    assert.ok(SUB_INTERVAL_LADDER[res].includes('1m'), `${res} ladder includes 1m`);
  }
  // Empty forming when no pieces
  const empty = buildFormingCandle({
    interval: '5m',
    bucketStartMs: Date.parse('2026-10-09T06:15:00.000Z'),
    nowMs: Date.parse('2026-10-09T06:18:00.000Z'),
    finerRowsByInterval: {},
    liveTail: null,
  });
  assert.equal(empty.candle, null);
  console.log('✓ API resolution set, history limits, empty forming');
}

function runPlatformTickerMapping() {
  // Polymarket: primary YES token from clobTokenIds[0]
  // Kalshi: external_id ticker — exercised via resolve path in aggregator helpers
  // (getPrimaryPolyToken is private; verify ladder + interval mapping contracts)
  assert.deepEqual(SUB_INTERVAL_LADDER['5m'], ['1m']);
  assert.deepEqual(SUB_INTERVAL_LADDER['1h'].slice(0, 2), ['15m', '5m']);
  assert.ok(INTERVAL_MS['1m'] === 60_000);
  console.log('✓ Polymarket/Kalshi resolution ladder mapping');
}

function runApplyLivePriceHelper() {
  const b = { open: 0.5, high: 0.5, low: 0.5, close: 0.5, volume: 0, tradeCount: 0 };
  applyLivePrice(b, 0.55);
  applyLivePrice(b, 0.48, { isTrade: true, volume: 3 });
  assert.equal(b.high, 0.55);
  assert.equal(b.low, 0.48);
  assert.equal(b.close, 0.48);
  assert.equal(b.volume, 3);
  // non-finite ignored
  applyLivePrice(b, Number.NaN);
  assert.equal(b.close, 0.48);
  console.log('✓ applyLivePrice helper');
}

function runGapFills() {
  const step = INTERVAL_MS['5m'];
  const a = Date.parse('2026-10-09T06:30:00.000Z');
  const c = Date.parse('2026-10-09T06:40:00.000Z');
  const { fills, capExceeded } = computeGapFills(a, c, 0.36, step);
  assert.equal(capExceeded, false);
  assert.equal(fills.length, 1);
  assert.equal(fills[0].ts, '2026-10-09T06:35:00.000Z');
  assert.equal(fills[0].open, 0.36);
  assert.equal(fills[0].volume, 0);

  const series = fillCandleGaps(
    [row(a, 0.34, 0.36, 0.34, 0.36, 0), row(c, 0.38, 0.38, 0.36, 0.36, 0)],
    step
  );
  assert.equal(series.length, 3);
  assert.equal(series[1].ts, '2026-10-09T06:35:00.000Z');
  assert.equal(series[1].close, 0.36);

  const wide = computeGapFills(a, a + step * (GAP_FILL_CAP + 5), 0.5, step);
  assert.equal(wide.fills.length, GAP_FILL_CAP);
  assert.equal(wide.capExceeded, true);
  console.log('✓ gap fills for quiet intervals');
}

function runLiveAdvanceGapFill() {
  const platform = 'kalshi' as const;
  const ticker = `gap-fill-ticker-${Date.now()}`;
  const t0 = bucketStartMs(Date.now(), 60_000) - 3 * 60_000;
  candleAggregator.ingestLiveTick(platform, ticker, 0.3, { tsMs: t0 + 5_000 });
  // Jump 3 minutes ahead — should close + fill quiet minutes
  candleAggregator.ingestLiveTick(platform, ticker, 0.35, { tsMs: t0 + 3 * 60_000 + 5_000 });
  const pending = candleAggregator.peekPendingClosed1m(platform, ticker);
  assert.ok(pending.length >= 1);
  const live = candleAggregator.peekLiveBucket(platform, ticker);
  assert.ok(live);
  assert.equal(live!.close, 0.35);
  assert.equal(live!.hadActivity, true);
  console.log('✓ live ingest advances with quiet-minute gap fills');
}

function main() {
  runAggregation();
  runBucketBoundaries();
  runFormingFromLive();
  runOutOfOrderAndDuplicateLive();
  runMissingIntervalsNoFabrication();
  runVolumeNoDoubleCount();
  runStripFormingImmutability();
  runApiOrderingAndLimits();
  runPlatformTickerMapping();
  runApplyLivePriceHelper();
  runGapFills();
  runLiveAdvanceGapFill();
  console.log('\nAll forming-candle tests passed.');
}

main();
