/**
 * Run: npx tsx src/lib/dashboardMetrics.test.ts
 */
import assert from 'node:assert/strict';
import {
  formatSignedPercent,
  pickBaseline,
  recordSample,
  trendsFromSamples,
  type MetricSample,
} from './dashboardMetrics.js';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-10-21T12:00:00Z');

function sample(ageMs: number, volume = 1000): MetricSample {
  return {
    at: now - ageMs,
    polymarketActive: 100,
    kalshiActive: 50,
    totalVolumeUsd: volume,
  };
}

assert.deepEqual(formatSignedPercent(110, 100), { trend: 'up', change: '+10.0%' });
assert.deepEqual(formatSignedPercent(90, 100), { trend: 'down', change: '-10.0%' });
assert.deepEqual(formatSignedPercent(100, 100), { trend: null, change: '0.0%' });
assert.equal(formatSignedPercent(10, 0).change, null);

const dayOld = sample(DAY, 200);
assert.equal(pickBaseline([sample(60_000, 1), dayOld, sample(2 * DAY, 1)], now), dayOld);
assert.equal(pickBaseline([sample(2 * 60 * 60 * 1000)], now), null);

const recorded = recordSample([], sample(0, 500), now);
assert.equal(recorded.length, 1);
assert.equal(recordSample(recorded, sample(0, 500), now + 60_000), recorded);

const trends = trendsFromSamples(
  { polymarketActive: 110, kalshiActive: 40, totalVolumeUsd: 250 },
  [dayOld],
  now
);
assert.equal(trends.polymarket_change_24h, '+10.0%');
assert.equal(trends.kalshi_trend, 'down');
assert.equal(trends.volume_change_24h, '+25.0%');

const freshOnly = trendsFromSamples(
  { polymarketActive: 110, kalshiActive: 40, totalVolumeUsd: 250 },
  [sample(5 * 60 * 1000)],
  now
);
assert.equal(freshOnly.volume_change_24h, null);
assert.equal(freshOnly.volume_trend, null);

console.log('✓ dashboard 24h change uses a day-old sample and stays null without one');
