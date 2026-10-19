/**
 * Polymarket trade pagination / sync planning tests.
 * Run: npm run test:poly-trades
 */
import assert from 'node:assert/strict';
import {
  POLY_TRADES_MAX_OFFSET,
  POLY_TRADES_MIN_WINDOW_SEC,
  POLY_TRADES_PAGE_LIMIT,
  POLY_TRADES_WINDOW_SEC,
  accumulateTradeVolume,
  bisectTimeWindow,
  canBisectWindow,
  nextRotatedOffset,
  parseCandleSyncMarketLimit,
  planTradeWindows,
  resolveOffsetCapAction,
  retryDelayMs,
  rotatedPageRanges,
  shouldRetryHttpStatus,
  tradeDedupeKey,
} from './polyTradesSync.js';

function runWindowPlanning() {
  const windows = planTradeWindows(1000, 1000 + POLY_TRADES_WINDOW_SEC * 2 + 100, POLY_TRADES_WINDOW_SEC);
  assert.equal(windows.length, 3);
  assert.equal(windows[0].startSec, 1000);
  assert.equal(windows[0].endSec, 1000 + POLY_TRADES_WINDOW_SEC);
  assert.equal(windows[2].endSec, 1000 + POLY_TRADES_WINDOW_SEC * 2 + 100);
  assert.deepEqual(planTradeWindows(50, 50), []);
  assert.deepEqual(planTradeWindows(80, 40), []);
  console.log('✓ trade window planning');
}

function runBisectOnOffsetCap() {
  const wide = { startSec: 0, endSec: POLY_TRADES_WINDOW_SEC };
  const halves = bisectTimeWindow(wide);
  assert.ok(halves);
  assert.equal(halves!.length, 2);
  assert.equal(halves![0].startSec, 0);
  assert.equal(halves![0].endSec, halves![1].startSec);
  assert.equal(halves![1].endSec, POLY_TRADES_WINDOW_SEC);

  const tiny = { startSec: 0, endSec: POLY_TRADES_MIN_WINDOW_SEC };
  assert.equal(bisectTimeWindow(tiny), null);
  assert.equal(canBisectWindow(tiny, 0), false);
  assert.equal(canBisectWindow(wide, 99), false);

  assert.equal(
    resolveOffsetCapAction(wide, 0, POLY_TRADES_PAGE_LIMIT),
    'bisect'
  );
  assert.equal(
    resolveOffsetCapAction(tiny, 0, POLY_TRADES_PAGE_LIMIT),
    'incomplete'
  );
  assert.equal(resolveOffsetCapAction(wide, 0, 10), 'incomplete');
  assert.ok(POLY_TRADES_MAX_OFFSET === 10_000);
  console.log('✓ offset-cap window bisection');
}

function runMarketRotation() {
  const a = nextRotatedOffset(100, 40, 0);
  assert.equal(a.offset, 0);
  assert.equal(a.nextOffset, 40);
  assert.equal(a.wrap, false);

  const b = nextRotatedOffset(100, 40, 80);
  assert.equal(b.offset, 80);
  assert.equal(b.nextOffset, 20);
  assert.equal(b.wrap, true);

  const ranges = rotatedPageRanges(100, 40, 80);
  assert.deepEqual(ranges, [
    { from: 80, to: 99 },
    { from: 0, to: 19 },
  ]);
  assert.deepEqual(rotatedPageRanges(10, 40, 0), [{ from: 0, to: 9 }]);
  assert.deepEqual(rotatedPageRanges(0, 40, 0), []);
  assert.deepEqual(nextRotatedOffset(0, 40, 0), {
    offset: 0,
    nextOffset: 0,
    wrap: false,
  });

  // Repeated cycles cover every index exactly once before repeating.
  let cursor = 0;
  const covered = new Set<number>();
  for (let cycle = 0; cycle < 3; cycle++) {
    const { offset, nextOffset } = nextRotatedOffset(100, 40, cursor);
    for (const r of rotatedPageRanges(100, 40, offset)) {
      for (let i = r.from; i <= r.to; i++) covered.add(i);
    }
    cursor = nextOffset;
  }
  assert.equal(covered.size, 100);
  assert.equal(cursor, 20);

  // Growing catalogue: cursor modulo new total stays in range.
  const grown = nextRotatedOffset(120, 40, 100);
  assert.equal(grown.offset, 100);
  assert.ok(grown.offset < 120);

  assert.equal(parseCandleSyncMarketLimit(undefined), 40);
  assert.equal(parseCandleSyncMarketLimit('75'), 75);
  assert.equal(parseCandleSyncMarketLimit('9999'), 200);
  assert.equal(parseCandleSyncMarketLimit('nope'), 40);
  assert.equal(parseCandleSyncMarketLimit('0'), 40);
  assert.equal(parseCandleSyncMarketLimit('-5'), 40);
  assert.equal(parseCandleSyncMarketLimit(''), 40);
  // Regression: fractional values must not floor to 0.
  assert.equal(parseCandleSyncMarketLimit('0.9'), 40);
  assert.equal(parseCandleSyncMarketLimit('1.8'), 1);
  console.log('✓ market sync rotation + limit parse');
}

function runTradeDedupeAndPartial() {
  const volumes = new Map();
  const seen = new Set<string>();
  const window = { startSec: 1000, endSec: 2000 };
  const token = 'tok-a';

  const t1 = {
    asset: token,
    transactionHash: '0xabc',
    timestamp: 1500,
    size: 10,
    price: 0.4,
    side: 'BUY',
  };
  assert.equal(accumulateTradeVolume(volumes, seen, t1, token, window), true);
  // duplicate hash+asset
  assert.equal(accumulateTradeVolume(volumes, seen, t1, token, window), false);
  // wrong token
  assert.equal(
    accumulateTradeVolume(volumes, seen, { ...t1, asset: 'other', transactionHash: '0xdef' }, token, window),
    false
  );
  // zero size — never invent volume
  assert.equal(
    accumulateTradeVolume(
      volumes,
      seen,
      { asset: token, transactionHash: '0x0', timestamp: 1600, size: 0 },
      token,
      window
    ),
    false
  );
  // outside window
  assert.equal(
    accumulateTradeVolume(
      volumes,
      seen,
      { asset: token, transactionHash: '0x1', timestamp: 50, size: 5 },
      token,
      window
    ),
    false
  );
  // second distinct trade same minute
  assert.equal(
    accumulateTradeVolume(
      volumes,
      seen,
      { asset: token, transactionHash: '0x2', timestamp: 1510, size: 3 },
      token,
      window
    ),
    true
  );

  const bucket = Math.floor(1500 / 60) * 60;
  assert.equal(volumes.get(bucket)?.volume, 13);
  assert.equal(volumes.get(bucket)?.tradeCount, 2);

  assert.equal(tradeDedupeKey({ asset: 'a', transactionHash: 'h' }), 'h:a');
  assert.equal(
    tradeDedupeKey({ token_id: 'a', transaction_hash: 'h2' }),
    'h2:a'
  );

  // Bisect halves share the mid timestamp; shared `seen` must count once.
  const halves = bisectTimeWindow({ startSec: 0, endSec: 3600 });
  assert.ok(halves);
  const mid = halves![0].endSec;
  assert.equal(halves![1].startSec, mid);
  const boundaryVolumes = new Map();
  const boundarySeen = new Set<string>();
  const boundaryTrade = {
    asset: token,
    transactionHash: '0xmid',
    timestamp: mid,
    size: 7,
  };
  assert.equal(
    accumulateTradeVolume(boundaryVolumes, boundarySeen, boundaryTrade, token, halves![0]),
    true
  );
  assert.equal(
    accumulateTradeVolume(boundaryVolumes, boundarySeen, boundaryTrade, token, halves![1]),
    false
  );
  assert.equal([...boundaryVolumes.values()].reduce((s, v) => s + v.volume, 0), 7);
  console.log('✓ trade dedupe + partial/missing size stays missing');
}

function runRetryHelpers() {
  assert.equal(shouldRetryHttpStatus(429), true);
  assert.equal(shouldRetryHttpStatus(503), true);
  assert.equal(shouldRetryHttpStatus(500), true);
  assert.equal(shouldRetryHttpStatus(400), false);
  assert.equal(shouldRetryHttpStatus(404), false);
  assert.equal(shouldRetryHttpStatus(401), false);
  assert.ok(retryDelayMs(0, 429) >= 2000);
  assert.ok(retryDelayMs(1, 500) >= 1000);
  // 429 backoff is longer than generic 5xx for the same attempt.
  assert.ok(retryDelayMs(0, 429) > retryDelayMs(0, 503));
  console.log('✓ retry status / backoff helpers');
}

function main() {
  runWindowPlanning();
  runBisectOnOffsetCap();
  runMarketRotation();
  runTradeDedupeAndPartial();
  runRetryHelpers();
  console.log('\nAll poly-trades sync tests passed.');
}

main();
