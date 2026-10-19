/**
 * Orderbook helpers for ratio executionCost / Kalshi liquidity —
 * POC-aligned (poc-stock-market/frontend/lib/orderbook.ts + RatioPanel).
 */

export type BookLevel = {
  price: number;
  qty: number;
};

export type NormalizedBook = {
  bids: BookLevel[];
  asks: BookLevel[];
};

export function parseBookLevels(raw: unknown): BookLevel[] {
  if (!Array.isArray(raw)) return [];

  const levels: BookLevel[] = [];
  for (const item of raw) {
    if (Array.isArray(item)) {
      const price = parseFloat(String(item[0] ?? ''));
      const qty = parseFloat(String(item[1] ?? ''));
      if (Number.isFinite(price) && Number.isFinite(qty) && qty > 0) {
        levels.push({ price, qty });
      }
      continue;
    }
    if (item && typeof item === 'object') {
      const row = item as Record<string, unknown>;
      const price = parseFloat(String(row.price ?? ''));
      const qty = parseFloat(String(row.size ?? row.qty ?? row.quantity ?? ''));
      if (Number.isFinite(price) && Number.isFinite(qty) && qty > 0) {
        levels.push({ price, qty });
      }
    }
  }
  return levels;
}

/**
 * Kalshi REST orderbook_fp / orderbook → yes/no bid arrays.
 * Supports nested yes/no, yes_dollars/no_dollars, and fp string prices.
 */
export function extractKalshiYesNoBids(orderbook: Record<string, unknown> | null | undefined): {
  yesBids: BookLevel[];
  noBids: BookLevel[];
} {
  if (!orderbook || typeof orderbook !== 'object') {
    return { yesBids: [], noBids: [] };
  }

  const yesRaw =
    orderbook.yes_dollars ??
    orderbook.yes ??
    orderbook.yes_bids ??
    (orderbook as any).yesBids;
  const noRaw =
    orderbook.no_dollars ??
    orderbook.no ??
    orderbook.no_bids ??
    (orderbook as any).noBids;

  return {
    yesBids: parseBookLevels(yesRaw),
    noBids: parseBookLevels(noRaw),
  };
}

export function normalizeKalshiNoBids(
  yesBids: BookLevel[],
  noBids: BookLevel[]
): { yes_bids: BookLevel[]; no_bids: BookLevel[] } {
  const yes_bids = [...yesBids].sort((a, b) => b.price - a.price);
  const rawNo = [...noBids].sort((a, b) => b.price - a.price);
  const bestYes = yes_bids[0]?.price ?? null;
  const bestNo = rawNo[0]?.price ?? null;
  const crossed =
    bestYes != null && bestNo != null && bestYes + bestNo > 1.0001;

  if (!crossed) {
    return { yes_bids, no_bids: rawNo };
  }

  const no_bids = rawNo
    .map((l) => ({
      price: Math.round((1 - l.price) * 1e6) / 1e6,
      qty: l.qty,
    }))
    .filter((l) => l.price > 0 && l.price < 1)
    .sort((a, b) => b.price - a.price);

  return { yes_bids, no_bids };
}

/** Kalshi: NO bid at p implies YES ask at 1−p. */
export function kalshiToYesBook(yesBids: BookLevel[], noBids: BookLevel[]): NormalizedBook {
  const { yes_bids, no_bids } = normalizeKalshiNoBids(yesBids, noBids);
  const bids = yes_bids;
  const asks = no_bids
    .map((l) => ({ price: 1 - l.price, qty: l.qty }))
    .sort((a, b) => a.price - b.price);
  return { bids, asks };
}

export function polyToBook(bids: BookLevel[], asks: BookLevel[]): NormalizedBook {
  return {
    bids: [...bids].sort((a, b) => b.price - a.price),
    asks: [...asks].sort((a, b) => a.price - b.price),
  };
}

/**
 * Kalshi API liquidity_dollars is deprecated (often "0.0000").
 * Dollar resting notional from yes/no bids — same as POC RatioPanel.
 */
export function estimateKalshiLiquidityFromOrderbook(
  orderbook: Record<string, unknown> | null | undefined
): number | null {
  const { yesBids, noBids } = extractKalshiYesNoBids(orderbook);
  const { yes_bids, no_bids } = normalizeKalshiNoBids(yesBids, noBids);
  const levels = [...yes_bids, ...no_bids];
  if (levels.length === 0) return null;
  const notional = levels.reduce((sum, l) => sum + l.price * l.qty, 0);
  return notional > 0 ? notional : null;
}

export function bestBidAskFromNormalized(book: NormalizedBook): {
  bid: number | null;
  ask: number | null;
} {
  return {
    bid: book.bids[0]?.price ?? null,
    ask: book.asks[0]?.price ?? null,
  };
}
