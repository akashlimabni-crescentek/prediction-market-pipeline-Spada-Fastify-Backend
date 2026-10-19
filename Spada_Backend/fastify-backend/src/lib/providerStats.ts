/**
 * Provider volume / liquidity / open-interest extraction — POC-aligned
 * (poc-stock-market/frontend/lib/market-stats.ts).
 */

export type ProviderMarketStats = {
  volume_24h: number | null;
  liquidity: number | null;
  open_interest: number | null;
  updated_at: string;
};

function parsePositiveNumber(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n === 0 ? null : n;
}

function firstPositive(...candidates: unknown[]): number | null {
  for (const c of candidates) {
    const n = parsePositiveNumber(c);
    if (n != null) return n;
  }
  return null;
}

/** Kalshi REST market → stats. */
export function extractKalshiStats(market: Record<string, unknown>): ProviderMarketStats {
  const now = new Date().toISOString();
  return {
    volume_24h: firstPositive(
      market.volume_24h_fp,
      market.volume_24h,
      market.volume24h,
      market.volume_fp,
      market.volume
    ),
    liquidity: firstPositive(
      market.liquidity_dollars,
      market.liquidity_fp,
      market.liquidity
    ),
    open_interest: firstPositive(
      market.open_interest_fp,
      market.open_interest,
      market.openInterest
    ),
    updated_at: now,
  };
}

/** Polymarket Gamma market (+ optional parent event) → stats. */
export function extractPolymarketStats(
  market: Record<string, unknown>,
  event: Record<string, unknown> | null = null
): ProviderMarketStats {
  const now = new Date().toISOString();
  return {
    volume_24h: firstPositive(
      market.volume24hrClob,
      market.volume_24hr_clob,
      market.volume24hr,
      market.volume_24hr,
      market.volumeClob,
      event?.volume24hr,
      event?.volume_24hr
    ),
    liquidity: firstPositive(
      market.liquidityClob,
      market.liquidity_clob,
      market.liquidity,
      market.liquidityNum,
      event?.liquidityClob,
      event?.liquidity
    ),
    open_interest: firstPositive(
      market.openInterest,
      market.open_interest,
      event?.openInterest,
      event?.open_interest
    ),
    updated_at: now,
  };
}
