import 'dotenv/config';
import { candleAggregator } from '../services/candleAggregator.js';
import {
  DEFAULT_CANDLE_SYNC_MARKET_LIMIT,
  formatCandleSyncStats,
  parseCandleSyncMarketLimit,
} from '../lib/candleSyncPlan.js';

/**
 * Historical OHLCV sync:
 * - Priority: watchlist → high-volume → fair catalogue rotation
 * - Upserts 1m into polymarket_ohlc / kalshi_ohlc
 * - Upserts 5m…1w into polymarket_price_history / kalshi_price_history
 *
 * Env:
 *   CANDLE_SYNC_MARKET_LIMIT   default 40, max 200
 *   CANDLE_SYNC_WATCH_SHARE    default 0.25
 *   CANDLE_SYNC_VOLUME_SHARE   default 0.35
 *
 * Scheduler: boot+20s, then every 15m (see server.ts).
 * Overlapping cycles are skipped. Missing venue history stays empty (not fabricated).
 *
 * Live 1m aggregation is handled by priceStream → candleAggregator.ingestLiveTick.
 */
let workerRunning = false;

export async function runCandleSyncWorker(): Promise<void> {
  if (workerRunning) {
    console.warn(
      formatCandleSyncStats({
        eligibleActive: 0,
        watchlistDistinct: 0,
        processed: 0,
        ok: 0,
        empty: 0,
        failed: 0,
        rows: 0,
        watchCount: 0,
        volumeCount: 0,
        rotateCount: 0,
        skippedOverlap: true,
        pageSize: parseCandleSyncMarketLimit(
          process.env.CANDLE_SYNC_MARKET_LIMIT,
          DEFAULT_CANDLE_SYNC_MARKET_LIMIT
        ),
        durationMs: 0,
      })
    );
    return;
  }

  workerRunning = true;
  const limit = parseCandleSyncMarketLimit(
    process.env.CANDLE_SYNC_MARKET_LIMIT,
    DEFAULT_CANDLE_SYNC_MARKET_LIMIT
  );
  console.log(`[Candle Sync] starting historical OHLCV backfill (limit=${limit})…`);
  try {
    const result = await candleAggregator.syncActiveMarketHistory(limit);
    const stats = result.stats ?? candleAggregator.getLastCandleSyncStats();
    if (stats) {
      console.log(
        `[Candle Sync] done processed=${stats.processed} ok=${stats.ok} empty=${stats.empty} failed=${stats.failed} rows≈${stats.rows}`
      );
    } else {
      console.log(
        `[Candle Sync] done markets=${result.markets} rows_upserted≈${result.rows}`
      );
    }
  } finally {
    workerRunning = false;
  }
}

if (process.argv[1]?.endsWith('candleSync.ts')) {
  runCandleSyncWorker()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[Candle Sync] fatal:', err);
      process.exit(1);
    });
}
