/**
 * Market Intelligence ratio formulas — ported from POC
 * (poc-stock-market/frontend/lib/ratios.ts). Formulas and null semantics must stay identical.
 *
 * pressure            = vol24h / liquidity
 * churn               = (vol24h / openInterest) / ln(1 + daysToClose)
 * support             = liquidity / openInterest
 * executionCost       = (bestAsk − bestBid) / midPrice   // mid = (bid + ask) / 2
 * divergence          = |polyProb − kalshiProb| / ((polyProb + kalshiProb) / 2)
 * probabilityMomentum = currentProb − prob_24h_ago
 * resolutionTension   = stddev(7d candle closes) × daysToClose  // population (÷N)
 */

export type MarketRatios = {
  pressure: number | null;
  churn: number | null;
  support: number | null;
  executionCost: number | null;
  divergence: number | null;
  probabilityMomentum: number | null;
  resolutionTension: number | null;
};

export type RatioInputs = {
  vol24h: number | null;
  liquidity: number | null;
  openInterest: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  currentProb: number | null;
  prob24hAgo: number | null;
  polyProb: number | null;
  kalshiProb: number | null;
  daysToClose: number | null;
  closes7d: number[];
};

export function safeDiv(
  a: number | null | undefined,
  b: number | null | undefined
): number | null {
  if (a == null || b == null || b === 0) return null;
  return a / b;
}

/** Days until close_time (fractional). Null if missing/expired. */
export function daysUntilClose(
  closeTime: string | null | undefined,
  nowMs = Date.now()
): number | null {
  if (!closeTime) return null;
  const ms = Date.parse(closeTime);
  if (!Number.isFinite(ms)) return null;
  const days = (ms - nowMs) / (24 * 60 * 60 * 1000);
  return days > 0 ? days : null;
}

/** Population standard deviation (÷ N), not sample (÷ N−1). */
export function populationStddev(values: number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length === 0) return null;
  const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
  const variance = xs.reduce((s, v) => s + (v - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

/**
 * Pick candle close nearest to targetMs (prefer at-or-before).
 * Rejects matches farther than maxDistMs unless the series started after
 * the target (young market) — then uses the earliest close as "since open".
 */
export function closeNearTimestamp(
  candles: { ts: string; close: number | null }[],
  targetMs: number,
  maxDistMs = 3 * 60 * 60 * 1000
): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  let earliest: { t: number; close: number } | null = null;

  for (const c of candles) {
    if (c.close == null || !Number.isFinite(Number(c.close))) continue;
    const t = Date.parse(c.ts);
    if (!Number.isFinite(t)) continue;
    const close = Number(c.close);

    if (!earliest || t < earliest.t) {
      earliest = { t, close };
    }

    const dist = Math.abs(t - targetMs);
    const preferBefore = t <= targetMs ? 0 : 1_000_000_000;
    const score = dist + preferBefore;
    if (score < bestDist) {
      bestDist = score;
      best = close;
    }
  }

  if (best != null && bestDist <= maxDistMs) {
    return best;
  }

  // Market younger than the lookback window — momentum since first candle.
  if (earliest && earliest.t > targetMs) {
    return earliest.close;
  }

  return null;
}

export function closesInWindow(
  candles: { ts: string; close: number | null }[],
  fromMs: number,
  toMs: number
): number[] {
  const out: number[] = [];
  for (const c of candles) {
    if (c.close == null || !Number.isFinite(Number(c.close))) continue;
    const t = Date.parse(c.ts);
    if (!Number.isFinite(t)) continue;
    if (t >= fromMs && t <= toMs) out.push(Number(c.close));
  }
  return out;
}

function finiteOrNull(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  return n;
}

function validProb(n: number | null | undefined): number | null {
  const v = finiteOrNull(n);
  if (v == null || v < 0 || v > 1) return null;
  return v;
}

/** Why a ratio stayed null — for diagnostics only; never fabricates values. */
export type RatioSkipMap = Partial<Record<keyof MarketRatios, string>>;

export function explainRatioSkips(input: RatioInputs): RatioSkipMap {
  const skips: RatioSkipMap = {};
  if (finiteOrNull(input.vol24h) == null) skips.pressure = 'missing_vol24h';
  else if (finiteOrNull(input.liquidity) == null) skips.pressure = 'missing_liquidity';
  else if (input.liquidity === 0) skips.pressure = 'zero_liquidity';

  if (finiteOrNull(input.vol24h) == null) skips.churn = 'missing_vol24h';
  else if (finiteOrNull(input.openInterest) == null) skips.churn = 'missing_open_interest';
  else if (input.openInterest === 0) skips.churn = 'zero_open_interest';
  else if (finiteOrNull(input.daysToClose) == null || (input.daysToClose ?? 0) <= 0) {
    skips.churn = 'missing_or_nonpositive_days_to_close';
  }

  if (finiteOrNull(input.liquidity) == null) skips.support = 'missing_liquidity';
  else if (finiteOrNull(input.openInterest) == null) skips.support = 'missing_open_interest';
  else if (input.openInterest === 0) skips.support = 'zero_open_interest';

  if (finiteOrNull(input.bestBid) == null || finiteOrNull(input.bestAsk) == null) {
    skips.executionCost = 'missing_bid_ask';
  } else {
    const mid = ((input.bestBid as number) + (input.bestAsk as number)) / 2;
    if (!(mid > 0)) skips.executionCost = 'zero_mid';
  }

  const poly = validProb(input.polyProb);
  const kalshi = validProb(input.kalshiProb);
  if (poly == null || kalshi == null) {
    skips.divergence = 'missing_or_invalid_cross_venue_prob';
  } else if ((poly + kalshi) / 2 === 0) {
    skips.divergence = 'zero_mean_prob';
  }

  if (validProb(input.currentProb) == null || validProb(input.prob24hAgo) == null) {
    skips.probabilityMomentum = 'missing_or_invalid_probability';
  }

  const closes = (input.closes7d ?? []).filter((v) => Number.isFinite(v));
  if (closes.length === 0) skips.resolutionTension = 'missing_closes_7d';
  else if (finiteOrNull(input.daysToClose) == null) {
    skips.resolutionTension = 'missing_days_to_close';
  }

  return skips;
}

export function computeRatios(input: RatioInputs): MarketRatios {
  const {
    vol24h,
    liquidity,
    openInterest,
    bestBid,
    bestAsk,
    currentProb,
    prob24hAgo,
    polyProb,
    kalshiProb,
    daysToClose,
    closes7d,
  } = input;

  const vol = finiteOrNull(vol24h);
  const liq = finiteOrNull(liquidity);
  const oi = finiteOrNull(openInterest);
  const bid = finiteOrNull(bestBid);
  const ask = finiteOrNull(bestAsk);
  const cur = validProb(currentProb);
  const ago = validProb(prob24hAgo);
  const poly = validProb(polyProb);
  const kalshi = validProb(kalshiProb);
  const days = finiteOrNull(daysToClose);

  const midPrice = bid != null && ask != null ? (bid + ask) / 2 : null;

  const rawChurn = safeDiv(vol, oi);
  // A.4: any null/invalid input (including daysToClose) → null; never fall back to raw vol/OI.
  const churn =
    rawChurn != null && days != null && days > 0
      ? finiteOrNull(rawChurn / Math.log1p(days))
      : null;

  const stddev7d = populationStddev(closes7d);
  const resolutionTension =
    stddev7d != null && days != null ? finiteOrNull(stddev7d * days) : null;

  const divergence =
    poly != null && kalshi != null
      ? safeDiv(Math.abs(poly - kalshi), (poly + kalshi) / 2)
      : null;

  const probabilityMomentum =
    cur != null && ago != null ? finiteOrNull(cur - ago) : null;

  const executionCost =
    ask != null && bid != null && midPrice != null && midPrice > 0
      ? safeDiv(ask - bid, midPrice)
      : null;

  return {
    pressure: safeDiv(vol, liq),
    churn,
    support: safeDiv(liq, oi),
    executionCost: finiteOrNull(executionCost),
    divergence: finiteOrNull(divergence),
    probabilityMomentum,
    resolutionTension,
  };
}
