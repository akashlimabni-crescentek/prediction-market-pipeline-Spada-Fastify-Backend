/**
 * Unchanged live prices must not schedule another markets-row write.
 * Run: npx tsx src/lib/pricePersist.test.ts
 */
import assert from 'node:assert/strict';
import { pricesNeedPersist, sameNumericPrices } from './pricePersist.js';

function run() {
  assert.equal(sameNumericPrices(undefined, [0.4, 0.6]), false);
  assert.equal(sameNumericPrices([0.4, 0.6], [0.4, 0.6]), true);
  assert.equal(sameNumericPrices([0.4, 0.6], [0.41, 0.59]), false);
  assert.equal(sameNumericPrices([0.4], [0.4, 0.6]), false);

  assert.equal(pricesNeedPersist(undefined, [0.2, 0.8]), true);
  assert.equal(pricesNeedPersist([0.2, 0.8], [0.2, 0.8]), false);
  assert.equal(pricesNeedPersist([0.2, 0.8], [0.25, 0.75]), true);

  console.log('✓ same prices match');
  console.log('✓ unchanged prices skip persist');
  console.log('✓ a real price change still persists');
  console.log('\nAll pricePersist tests passed.');
}

run();
