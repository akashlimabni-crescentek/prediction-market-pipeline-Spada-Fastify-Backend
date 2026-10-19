/**
 * Fair price-stream selection unit tests.
 * Run: npm run test:price-stream-plan
 */
import assert from 'node:assert/strict';
import {
  DEFAULT_PRICE_STREAM_MARKET_LIMIT,
  MAX_PRICE_STREAM_MARKET_LIMIT,
  countRecentTicks,
  formatPriceStreamCoverage,
  parsePriceStreamMarketLimit,
  selectMarketsForPriceStream,
  type StreamMarketRow,
} from './priceStreamPlan.js';

function row(
  id: string,
  volume: number,
  extra: Partial<StreamMarketRow> = {}
): StreamMarketRow {
  return {
    canonical_id: id,
    platform: id.startsWith('kalshi_') ? 'kalshi' : 'polymarket',
    external_id: id.replace(/^(polymarket_|kalshi_)/, ''),
    volume,
    active: true,
    ...extra,
  };
}

function run() {
  assert.equal(parsePriceStreamMarketLimit(undefined), DEFAULT_PRICE_STREAM_MARKET_LIMIT);
  assert.equal(parsePriceStreamMarketLimit('0'), DEFAULT_PRICE_STREAM_MARKET_LIMIT);
  assert.equal(parsePriceStreamMarketLimit('9999'), MAX_PRICE_STREAM_MARKET_LIMIT);
  assert.equal(parsePriceStreamMarketLimit('80'), 80);

  const watched = ['polymarket_w1', 'polymarket_w2'];
  const highVolume = Array.from({ length: 40 }, (_, i) =>
    row(`polymarket_v${i}`, 1000 - i)
  );
  const rotatePool = [
    ...highVolume,
    ...Array.from({ length: 60 }, (_, i) => row(`polymarket_r${String(i).padStart(3, '0')}`, 10)),
  ];

  const a = selectMarketsForPriceStream({
    pageSize: 20,
    watchedIds: watched,
    highVolumeMarkets: highVolume,
    rotatePool,
    rotateCursor: 0,
  });
  assert.equal(a.markets.length, 20);
  assert.equal(a.watchCount, 0, 'watched ids absent from pools are skipped (no invent)');
  // Watched ids only count when present in pools — inject them
  const withWatch = selectMarketsForPriceStream({
    pageSize: 20,
    watchedIds: watched,
    highVolumeMarkets: [
      row('polymarket_w1', 50),
      row('polymarket_w2', 40),
      ...highVolume,
    ],
    rotatePool,
    rotateCursor: 0,
  });
  assert.equal(withWatch.watchCount, 2);
  assert.ok(withWatch.volumeCount > 0);
  assert.ok(withWatch.rotateCount > 0);
  const ids = withWatch.markets.map((m) => m.canonical_id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate canonical ids');

  // Rotation advances across cycles
  const b = selectMarketsForPriceStream({
    pageSize: 20,
    watchedIds: [],
    highVolumeMarkets: highVolume.slice(0, 5),
    rotatePool,
    rotateCursor: withWatch.nextRotateOffset,
  });
  assert.notEqual(b.rotateOffset, withWatch.rotateOffset);

  // Cap respected
  const capped = selectMarketsForPriceStream({
    pageSize: DEFAULT_PRICE_STREAM_MARKET_LIMIT,
    watchedIds: [],
    highVolumeMarkets: highVolume,
    rotatePool,
    rotateCursor: 0,
  });
  assert.ok(capped.markets.length <= DEFAULT_PRICE_STREAM_MARKET_LIMIT);

  const ticks = new Map<string, number>([
    ['a', Date.now()],
    ['b', Date.now() - 10_000],
    ['c', Date.now() - 10 * 60_000],
  ]);
  assert.equal(countRecentTicks(ticks, Date.now(), 5 * 60_000), 2);

  const line = formatPriceStreamCoverage({
    platform: 'Polymarket',
    eligibleActive: 6000,
    selected: 150,
    subscribedTokensOrTickers: 148,
    watchCount: 10,
    volumeCount: 50,
    rotateCount: 90,
    pageSize: 150,
    rotateOffset: 0,
    recentTickMarkets: 40,
    durationMs: 12,
  });
  assert.ok(line.includes('eligible=6000'));
  assert.ok(line.includes('selected=150'));
  assert.ok(line.includes('recentTicks=40'));

  console.log('✓ limit parse + hard max');
  console.log('✓ watch/volume/rotate mix, dedupe, rotation advance');
  console.log('✓ recent tick window + coverage log format');
  console.log('\nAll priceStreamPlan tests passed.');
}

run();
