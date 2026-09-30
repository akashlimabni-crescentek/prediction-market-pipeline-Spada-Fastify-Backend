import { supabaseAdmin } from '../lib/supabase.js';

export interface Candle {
  ticker: string;
  bucket: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

class CandleAggregator {
  // Main method: Retrieves 1-hour OHLCV candles for any market
  async getCandles(canonicalId: string): Promise<Candle[]> {
    // 1. Check if database view already has candles stored
    const { data: dbCandles } = await supabaseAdmin
      .from('ohlcv_1h_view')
      .select('ticker, bucket, open, high, low, close, volume')
      .eq('ticker', canonicalId)
      .order('bucket', { ascending: false })
      .limit(100);

    if (dbCandles && dbCandles.length > 0) {
      return dbCandles.map((c) => ({
        ticker: c.ticker,
        bucket: c.bucket,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume || 0),
      }));
    }

    // 2. Fallback: Fetch historical time-series directly from exchange APIs
    const { data: market } = await supabaseAdmin
      .from('markets')
      .select('canonical_id, platform, external_id, raw_data, prices')
      .eq('canonical_id', canonicalId)
      .maybeSingle();

    if (!market) {
      return [];
    }

    // Handle Polymarket Historical Price Aggregation
    if (market.platform === 'polymarket') {
      const raw = market.raw_data ?? {};
      const tokenId =
        raw.clobTokenIds?.[0] ||
        raw.tokens?.[0]?.token_id ||
        raw.tokens?.[0]?.clobTokenId;

      if (!tokenId) {
        return [];
      }

      try {
        // Fetch 1-week history at 60-minute fidelity
        const res = await fetch(
          `https://clob.polymarket.com/prices-history?market=${tokenId}&interval=1w&fidelity=60`
        );

        if (!res.ok) {
          return [];
        }

        const data = await res.json();
        const history: { t: number; p: number }[] = data.history || [];

        if (history.length === 0) {
          return [];
        }

        // Group raw points into 1-hour OHLCV buckets (3600 seconds)
        const buckets = new Map<number, { prices: number[]; count: number }>();

        for (const point of history) {
          const hourBucket = Math.floor(point.t / 3600) * 3600;
          if (!buckets.has(hourBucket)) {
            buckets.set(hourBucket, { prices: [], count: 0 });
          }
          buckets.get(hourBucket)!.prices.push(point.p);
          buckets.get(hourBucket)!.count++;
        }

        const candles: Candle[] = [];

        for (const [bucketTs, data] of buckets.entries()) {
          const p = data.prices;
          const open = p[0];
          const close = p[p.length - 1];
          const high = Math.max(...p);
          const low = Math.min(...p);

          candles.push({
            ticker: canonicalId,
            bucket: new Date(bucketTs * 1000).toISOString(),
            open: Number(open.toFixed(4)),
            high: Number(high.toFixed(4)),
            low: Number(low.toFixed(4)),
            close: Number(close.toFixed(4)),
            volume: data.count * 50, // Estimated volume
          });
        }

        // Sort latest first
        return candles.sort(
          (a, b) => new Date(b.bucket).getTime() - new Date(a.bucket).getTime()
        );
      } catch (err: any) {
        console.error('[CandleAggregator] Polymarket history error:', err.message);
        return [];
      }
    }

    return [];
  }
}

export const candleAggregator = new CandleAggregator();