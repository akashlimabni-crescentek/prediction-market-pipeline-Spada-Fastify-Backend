import { runMarketMatchSync } from '../services/ratioEngine.js';

/**
 * Populate market_matches using POC Jaccard/containment ≥ 0.88 matching.
 * Scans a balanced poly/kalshi source set against volume-ordered candidate pools.
 */
export async function runMarketMatchSyncWorker() {
  console.log('[Match Sync] Starting cross-platform market matching...');
  try {
    const result = await runMarketMatchSync(100);
    console.log(
      `[Match Sync] done scanned=${result.scanned} matched=${result.matched} ` +
        `bestRejectedScore=${result.bestRejectedScore}`
    );
  } catch (err: any) {
    console.error('[Match Sync] failed:', err?.message ?? err);
  }
}

if (process.argv[1]?.endsWith('marketMatchSync.ts')) {
  runMarketMatchSyncWorker()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
