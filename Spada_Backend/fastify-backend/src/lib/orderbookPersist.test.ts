/**
 * Orderbook persistence mapping tests (no live DB / venue calls).
 * Run: npm run test:orderbook
 */
import assert from 'node:assert/strict';

import {
  buildKalshiOrderbookRow,
  buildPolymarketOrderbookRow,
  extractPolymarketTokenIds,
  LatestWinsPersistQueue,
  orderbookLadderFingerprint,
  polyClobBookToYesNoBids,
  resolvePolymarketOrderbookMarketId,
  writeLatestSnapshot,
} from './orderbookPersist.js';

function runResolvePolymarketMarketId() {
  assert.equal(
    resolvePolymarketOrderbookMarketId({
      external_id: '0xabc',
      raw_data: { id: 2589812 },
    }),
    '2589812'
  );
  assert.equal(
    resolvePolymarketOrderbookMarketId({
      external_id: '1142292',
      raw_data: {},
    }),
    '1142292'
  );
  assert.equal(
    resolvePolymarketOrderbookMarketId({
      external_id: '0xcondition',
      raw_data: { clobTokenIds: ['1', '2'] },
    }),
    null
  );
  console.log('✓ resolvePolymarketOrderbookMarketId');
}

function runExtractTokens() {
  assert.deepEqual(
    extractPolymarketTokenIds({
      clobTokenIds: ['yesTok', 'noTok'],
    }),
    { yesTokenId: 'yesTok', noTokenId: 'noTok' }
  );
  assert.deepEqual(
    extractPolymarketTokenIds({
      clob_token_ids: '["a","b"]',
    }),
    { yesTokenId: 'a', noTokenId: 'b' }
  );
  console.log('✓ extractPolymarketTokenIds');
}

function runPolyClobToYesNo() {
  const { yes_bids, no_bids } = polyClobBookToYesNoBids(
    [
      { price: '0.40', size: '10' },
      { price: '0.39', size: '5' },
    ],
    [{ price: '0.42', size: '8' }]
  );
  assert.equal(yes_bids[0].price, 0.4);
  assert.equal(yes_bids[0].qty, 10);
  assert.equal(no_bids[0].price, 0.58); // 1 - 0.42
  assert.equal(no_bids[0].qty, 8);
  console.log('✓ polyClobBookToYesNoBids');
}

function runBuildPolymarketRow() {
  const row = buildPolymarketOrderbookRow({
    marketId: '2589812',
    yesTokenId: 'yesTok',
    noTokenId: 'noTok',
    bids: [{ price: 0.5, size: 1 }],
    asks: [{ price: 0.55, size: 2 }],
    nowIso: '2026-10-16T12:00:00.000Z',
  });
  assert.equal(row.market_id, '2589812');
  assert.equal(row.yes_token_id, 'yesTok');
  assert.equal(row.no_token_id, 'noTok');
  assert.equal(row.last_snapshot, '2026-10-16T12:00:00.000Z');
  assert.equal(row.updated_at, '2026-10-16T12:00:00.000Z');
  assert.equal(row.yes_bids.length, 1);
  assert.equal(row.no_bids[0].price, 0.45);
  console.log('✓ buildPolymarketOrderbookRow');
}

function runBuildKalshiRow() {
  const row = buildKalshiOrderbookRow({
    ticker: 'KXTEST-1',
    orderbook: {
      yes_dollars: [['0.40', '10']],
      no_dollars: [['0.55', '20']],
    },
    nowIso: '2026-10-16T12:00:00.000Z',
  });
  assert.equal(row.ticker, 'KXTEST-1');
  assert.equal(row.yes_bids[0].price, 0.4);
  assert.equal(row.yes_bids[0].qty, 10);
  assert.equal(row.no_bids[0].price, 0.55);
  assert.equal(row.no_bids[0].qty, 20);
  assert.equal(row.updated_at, '2026-10-16T12:00:00.000Z');
  console.log('✓ buildKalshiOrderbookRow');
}

function runFingerprint() {
  const a = orderbookLadderFingerprint([{ price: 0.4, qty: 1 }], []);
  const b = orderbookLadderFingerprint([{ price: 0.4, qty: 1 }], []);
  const c = orderbookLadderFingerprint([{ price: 0.41, qty: 1 }], []);
  assert.equal(a, b);
  assert.notEqual(a, c);
  console.log('✓ orderbookLadderFingerprint');
}

/**
 * Regression: while an older persist is in-flight, newer schedules must not be
 * dropped forever. Intermediate work may be coalesced; the newest must run.
 */
async function runLatestWinsPersistQueue() {
  const q = new LatestWinsPersistQueue();
  const order: number[] = [];
  let releaseA!: () => void;
  const gateA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });

  q.schedule('k', async () => {
    order.push(1);
    await gateA;
  });
  assert.equal(q.hasInFlight('k'), true);

  q.schedule('k', async () => {
    order.push(2);
  });
  q.schedule('k', async () => {
    order.push(3);
  });
  assert.equal(q.hasPending('k'), true);

  releaseA();
  await q.drain();

  assert.deepEqual(order, [1, 3], 'intermediate snapshot 2 must be skipped; newest 3 must run');
  assert.equal(q.hasInFlight('k'), false);
  assert.equal(q.hasPending('k'), false);
  console.log('✓ LatestWinsPersistQueue (in-flight latest-wins)');
}

/** Queue failure handling: rejected work must not stick the queue. */
async function runLatestWinsPersistQueueFailure() {
  const q = new LatestWinsPersistQueue();
  const order: string[] = [];
  const errors: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  q.schedule(
    'k',
    async () => {
      order.push('fail');
      await gate;
      throw new Error('upsert failed');
    },
    (_key, err: any) => {
      errors.push(String(err?.message ?? err));
    }
  );
  q.schedule('k', async () => {
    order.push('next');
  });

  release();
  await q.drain();

  assert.deepEqual(order, ['fail', 'next']);
  assert.deepEqual(errors, ['upsert failed']);
  assert.equal(q.hasInFlight('k'), false);
  assert.equal(q.hasPending('k'), false);
  console.log('✓ LatestWinsPersistQueue (failure clears + pending runs)');
}

/**
 * Late-write regression: older write stays unresolved (simulating a slow
 * upsert that outlives any former Promise.race timeout), newer snapshot is
 * requested and its write finishes, then the older write resolves. Side-effect
 * log must end on the newer snapshot — not `fast-new, slow-old`.
 */
async function runWriteLatestSnapshotLateWrite() {
  const latestByKey = new Map<string, string>();
  const writes: string[] = [];
  let releaseOld!: () => void;
  const oldGate = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });

  const write = async (snapshot: string) => {
    if (snapshot === 'old') await oldGate;
    // Actual persisted side-effect (not merely which promise the caller awaits).
    writes.push(snapshot);
  };

  const oldJob = writeLatestSnapshot({
    key: 'book',
    snapshot: 'old',
    latestByKey,
    write,
  });

  // Let the older write enter its unresolved gate (beyond a would-be timeout).
  await new Promise((r) => setTimeout(r, 20));

  const newJob = writeLatestSnapshot({
    key: 'book',
    snapshot: 'new',
    latestByKey,
    write,
  });

  await newJob;
  assert.ok(writes.includes('new'), 'newer snapshot write must complete first');
  assert.equal(writes.includes('old'), false, 'older write still unresolved');

  releaseOld();
  await oldJob;

  assert.equal(latestByKey.get('book'), 'new');
  assert.equal(
    writes[writes.length - 1],
    'new',
    `final persisted side-effect must be newer; got writes=${writes.join(',')}`
  );
  assert.ok(
    writes.indexOf('old') >= 0 && writes.lastIndexOf('new') > writes.indexOf('old'),
    'older side-effect may land, but must be healed by a later newer write'
  );
  console.log('✓ writeLatestSnapshot (late-write heals to newer)');
}

/** Serial latest-wins via queue + writeLatestSnapshot (normal path). */
async function runQueuePlusWriteLatestWins() {
  const q = new LatestWinsPersistQueue();
  const latestByKey = new Map<string, string>();
  const writes: string[] = [];
  let releaseOld!: () => void;
  const oldGate = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });

  q.schedule('k', () =>
    writeLatestSnapshot({
      key: 'book',
      snapshot: 'old',
      latestByKey,
      write: async (s) => {
        await oldGate;
        writes.push(s);
      },
    })
  );
  q.schedule('k', () =>
    writeLatestSnapshot({
      key: 'book',
      snapshot: 'mid',
      latestByKey,
      write: async (s) => {
        writes.push(s);
      },
    })
  );
  q.schedule('k', () =>
    writeLatestSnapshot({
      key: 'book',
      snapshot: 'new',
      latestByKey,
      write: async (s) => {
        writes.push(s);
      },
    })
  );

  releaseOld();
  await q.drain();

  assert.equal(latestByKey.get('book'), 'new');
  assert.equal(writes[writes.length - 1], 'new');
  // Queue coalesced mid away; old ran then new.
  assert.deepEqual(writes, ['old', 'new']);
  console.log('✓ queue + writeLatestSnapshot (normal latest-wins)');
}

async function run() {
  runResolvePolymarketMarketId();
  runExtractTokens();
  runPolyClobToYesNo();
  runBuildPolymarketRow();
  runBuildKalshiRow();
  runFingerprint();
  await runLatestWinsPersistQueue();
  await runLatestWinsPersistQueueFailure();
  await runWriteLatestSnapshotLateWrite();
  await runQueuePlusWriteLatestWins();
  console.log('\nAll orderbook persist tests passed.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
