import { kalshiGet } from '../lib/kalshiClient.js';
import { pickReliableProb } from '../lib/crossPlatform.js';
import {
  closeNearTimestamp,
  closesInWindow,
  computeRatios,
  daysUntilClose,
  explainRatioSkips,
  type MarketRatios,
  type RatioSkipMap,
} from '../lib/ratios.js';
import {
  bestBidAskFromNormalized,
  estimateKalshiLiquidityFromOrderbook,
  extractKalshiYesNoBids,
  kalshiToYesBook,
  parseBookLevels,
  polyToBook,
} from '../lib/orderbookNormalize.js';
import {
  extractKalshiStats,
  extractPolymarketStats,
  type ProviderMarketStats,
} from '../lib/providerStats.js';
import { readLiveQuote } from '../lib/liveQuotes.js';
import { orderbookStore } from './orderbookStore.js';
import { candleAggregator } from './candleAggregator.js';
import {
  alignTwinReliableProb,
  marketReliableProb,
  resolveCrossPlatformMatch,
  runMarketMatchSyncDetailed,
  type CrossPlatformMatch,
  type MatchCandidateMarket,
  type MatchDiagnostics,
} from './marketMatching.js';

export type RatioMarketRow = MatchCandidateMarket & {
  volume?: number | null;
};

export type RatioComputationResult = {
  ratios: MarketRatios;
  matched: boolean;
  similarity: number | null;
  counterMarket: {
    canonical_id: string;
    platform: string;
    title: string | null;
    yes_price: number | null;
  } | null;
  /** Legacy Spada fields (not POC ratios) — kept for backward compatibility. */
  legacy: {
    ratio: number | null;
    spread: number | null;
    divergence_percent: number | null;
  };
  inputs: {
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
    closes7dCount: number;
    matchFromCache: boolean;
  };
  /** Ratios left null due to missing/invalid inputs (diagnostics only). */
  ratioSkips: RatioSkipMap;
};

export type CandleVolRow = { ts: string; volume?: number | null };

/**
 * POC vol24h assembly: provider/API volume, else sum of 5m candle volumes over 24h.
 * No markets.volume DB fallback.
 */
export function assembleVol24h(
  providerVol: number | null | undefined,
  candleRows: CandleVolRow[],
  nowMs = Date.now()
): number | null {
  let vol24h =
    providerVol != null && Number.isFinite(Number(providerVol))
      ? Number(providerVol)
      : null;
  if (vol24h === 0) vol24h = null;

  if (vol24h == null) {
    const from24h = nowMs - 24 * 60 * 60 * 1000;
    const sum = candleRows
      .filter((c) => {
        const t = Date.parse(c.ts);
        return Number.isFinite(t) && t >= from24h;
      })
      .reduce((s, c) => s + (Number(c.volume) || 0), 0);
    if (sum > 0) vol24h = sum;
  }

  return vol24h;
}

function validLiveYes(price: number | null | undefined): number | null {
  if (price == null || !Number.isFinite(price) || price < 0 || price > 1) return null;
  return price;
}

/**
 * Current probability for momentum and divergence.
 * A live socket YES price wins: it is the venue midpoint the chart is showing.
 * With no live quote, pickReliableProb rejects a placeholder wide book
 * (spread > 0.5, mid 0.50) and uses the stored last trade.
 */
export function assembleCurrentProb(
  storedYesPrice: number | null | undefined,
  bestBid: number | null,
  bestAsk: number | null,
  liveYes?: number | null
): number | null {
  const live = validLiveYes(liveYes);
  if (live != null) return live;

  const mid =
    bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
  return pickReliableProb({
    mid,
    last_price: storedYesPrice,
    bid: bestBid,
    ask: bestAsk,
  });
}

/**
 * Twin divergence input: orderbook mid/bid/ask + stored last → pickReliableProb → alignTwinPrice.
 */
export function assembleAlignedTwinProb(
  source: MatchCandidateMarket,
  twin: MatchCandidateMarket,
  twinBid: number | null,
  twinAsk: number | null,
  sourceProb?: number | null,
  liveYes?: number | null
): number | null {
  const live = validLiveYes(liveYes);
  const raw = live ?? marketReliableProb(twin, { bid: twinBid, ask: twinAsk });
  if (raw == null) return null;
  return alignTwinReliableProb(source, twin, raw, sourceProb);
}

function closeTimeOf(market: RatioMarketRow): string | null {
  const raw = market.raw_data ?? {};
  const date =
    raw.close_time ||
    raw.expiration_time ||
    raw.end_date ||
    raw.endDate ||
    raw.endDateIso ||
    null;
  return date ? String(date) : null;
}

function storedYesPrice(market: RatioMarketRow): number | null {
  const p = market.prices?.[0];
  if (p == null) return null;
  const n = Number(p);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

export async function fetchProviderStats(
  market: RatioMarketRow
): Promise<ProviderMarketStats | null> {
  try {
    if (market.platform === 'kalshi') {
      const data = await kalshiGet(`/markets/${encodeURIComponent(String(market.external_id))}`);
      const row = (data?.market ?? data) as Record<string, unknown>;
      return extractKalshiStats(row);
    }

    if (market.platform === 'polymarket') {
      const extId = String(market.external_id);
      const slug = market.raw_data?.slug ? String(market.raw_data.slug) : null;
      const urls = [
        `https://gamma-api.polymarket.com/markets?condition_ids=${encodeURIComponent(extId)}`,
        `https://gamma-api.polymarket.com/markets?id=${encodeURIComponent(extId)}`,
        slug
          ? `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`
          : null,
      ].filter(Boolean) as string[];

      for (const url of urls) {
        const res = await fetch(url, {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) continue;
        const body = await res.json();
        const row = Array.isArray(body) ? body[0] : body?.markets?.[0] ?? body;
        if (row && typeof row === 'object') {
          let event: Record<string, unknown> | null = null;
          if (Array.isArray(row.events) && row.events[0]) {
            event = row.events[0] as Record<string, unknown>;
          }
          return extractPolymarketStats(row as Record<string, unknown>, event);
        }
      }
    }
  } catch (err: any) {
    console.warn('[ratioEngine] provider stats failed:', err?.message ?? err);
  }
  return null;
}

export async function fetchBestBidAsk(market: RatioMarketRow): Promise<{
  bid: number | null;
  ask: number | null;
  kalshiOrderbook: Record<string, unknown> | null;
}> {
  try {
    const book = await orderbookStore.getOrderbook(market.canonical_id);
    if (market.platform === 'polymarket') {
      const normalized = polyToBook(
        parseBookLevels((book as any).bids),
        parseBookLevels((book as any).asks)
      );
      const ba = bestBidAskFromNormalized(normalized);
      return { ...ba, kalshiOrderbook: null };
    }
    if (market.platform === 'kalshi') {
      const ob = ((book as any).orderbook ?? {}) as Record<string, unknown>;
      const { yesBids, noBids } = extractKalshiYesNoBids(ob);
      const normalized = kalshiToYesBook(yesBids, noBids);
      const ba = bestBidAskFromNormalized(normalized);
      return { ...ba, kalshiOrderbook: ob };
    }
  } catch (err: any) {
    console.warn('[ratioEngine] orderbook failed:', err?.message ?? err);
  }
  return { bid: null, ask: null, kalshiOrderbook: null };
}

const RATIO_HEAVY_TTL_MS = 5_000;

type RatioBook = {
  bid: number | null;
  ask: number | null;
  kalshiOrderbook: Record<string, unknown> | null;
};

type RatioCandleRow = { ts: string; close: number; volume: number };

type RatioHeavySnapshot = {
  at: number;
  stats: ProviderMarketStats | null;
  book: RatioBook;
  candleRows: RatioCandleRow[];
  twin: {
    match: CrossPlatformMatch;
    bid: number | null;
    ask: number | null;
  } | null;
};

const ratioHeavyCache = new Map<string, RatioHeavySnapshot>();

export type RatioEngineDeps = {
  fetchProviderStats?: (m: RatioMarketRow) => Promise<ProviderMarketStats | null>;
  fetchBestBidAsk?: (m: RatioMarketRow) => Promise<{
    bid: number | null;
    ask: number | null;
    kalshiOrderbook: Record<string, unknown> | null;
  }>;
  getCandlesSince?: (
    canonicalId: string,
    resolution: '5m',
    fromMs: number,
    toMs: number
  ) => Promise<Array<{ bucket: string; close: number; volume: number }>>;
  resolveCrossPlatformMatch?: typeof resolveCrossPlatformMatch;
};

/**
 * Compute the seven POC ratios for a Spada market row.
 * Formulas live in lib/ratios.ts (do not change). This assembles POC-compatible inputs.
 */
export async function computeMarketRatios(
  market: RatioMarketRow,
  deps: RatioEngineDeps = {}
): Promise<RatioComputationResult> {
  const fetchStats = deps.fetchProviderStats ?? fetchProviderStats;
  const fetchBook = deps.fetchBestBidAsk ?? fetchBestBidAsk;
  const getCandles = deps.getCandlesSince ?? ((id, res, from, to) =>
    candleAggregator.getCandlesSince(id, res, from, to)
  );
  const resolveMatch = deps.resolveCrossPlatformMatch ?? resolveCrossPlatformMatch;

  const now = Date.now();
  const from7d = now - 7 * 24 * 60 * 60 * 1000;
  const daysToClose = daysUntilClose(closeTimeOf(market), now);
  const usingDefaultDeps =
    deps.fetchProviderStats == null &&
    deps.fetchBestBidAsk == null &&
    deps.getCandlesSince == null &&
    deps.resolveCrossPlatformMatch == null;

  let stats: ProviderMarketStats | null;
  let book: RatioBook;
  let candleRows: RatioCandleRow[];
  let twinSnap: RatioHeavySnapshot['twin'] = null;

  const cached = usingDefaultDeps
    ? ratioHeavyCache.get(market.canonical_id)
    : undefined;
  if (cached && now - cached.at < RATIO_HEAVY_TTL_MS) {
    stats = cached.stats;
    book = cached.book;
    candleRows = cached.candleRows;
    twinSnap = cached.twin;
  } else {
    // Stats + book + candles first; match after currentProb is known (and can hit cache).
    const [fetchedStats, fetchedBook, candles5m] = await Promise.all([
      fetchStats(market),
      fetchBook(market),
      getCandles(market.canonical_id, '5m', from7d, now),
    ]);
    stats = fetchedStats;
    book = fetchedBook;
    candleRows = candles5m.map((c) => ({
      ts: c.bucket,
      close: c.close,
      volume: c.volume,
    }));

    const seedProb = assembleCurrentProb(
      storedYesPrice(market),
      book.bid,
      book.ask,
      readLiveQuote(market.canonical_id)?.[0]
    );
    const crossMatch = await resolveMatch(market, seedProb);
    if (crossMatch) {
      const twinBook = await fetchBook(crossMatch.twin as RatioMarketRow);
      twinSnap = {
        match: crossMatch,
        bid: twinBook.bid,
        ask: twinBook.ask,
      };
    }

    if (usingDefaultDeps) {
      ratioHeavyCache.set(market.canonical_id, {
        at: now,
        stats,
        book,
        candleRows,
        twin: twinSnap,
      });
    }
  }

  const bestBid = book.bid;
  const bestAsk = book.ask;
  const resolvedCurrentProb = assembleCurrentProb(
    storedYesPrice(market),
    bestBid,
    bestAsk,
    readLiveQuote(market.canonical_id)?.[0]
  );

  let crossMatch: CrossPlatformMatch | null = twinSnap
    ? { ...twinSnap.match }
    : null;

  // Twin divergence prob: live quote when present, else pickReliableProb, then alignTwinPrice.
  if (crossMatch && twinSnap) {
    const aligned = assembleAlignedTwinProb(
      market,
      crossMatch.twin,
      twinSnap.bid,
      twinSnap.ask,
      resolvedCurrentProb,
      readLiveQuote(crossMatch.twin.canonical_id)?.[0]
    );
    if (aligned != null) {
      crossMatch = { ...crossMatch, alignedTwinProb: aligned };
    }
  }

  // POC: provider/API volume → 5m candle sum (no markets.volume DB fallback)
  const vol24h = assembleVol24h(stats?.volume_24h, candleRows, now);

  // Liquidity: Kalshi from orderbook notional (POC); Polymarket from API stats
  const liquidity =
    market.platform === 'kalshi'
      ? estimateKalshiLiquidityFromOrderbook(book.kalshiOrderbook)
      : stats?.liquidity != null
        ? Number(stats.liquidity)
        : null;

  const openInterest =
    stats?.open_interest != null ? Number(stats.open_interest) : null;

  const prob24hAgo = closeNearTimestamp(candleRows, now - 24 * 60 * 60 * 1000);
  const closes7d = closesInWindow(candleRows, from7d, now);

  let polyProb: number | null = null;
  let kalshiProb: number | null = null;
  if (market.platform === 'polymarket') {
    polyProb = resolvedCurrentProb;
    kalshiProb = crossMatch?.alignedTwinProb ?? null;
  } else if (market.platform === 'kalshi') {
    kalshiProb = resolvedCurrentProb;
    polyProb = crossMatch?.alignedTwinProb ?? null;
  }

  const ratioInput = {
    vol24h,
    liquidity,
    openInterest,
    bestBid,
    bestAsk,
    currentProb: resolvedCurrentProb,
    prob24hAgo,
    polyProb,
    kalshiProb,
    daysToClose,
    closes7d,
  };
  const ratios = computeRatios(ratioInput);
  const ratioSkips = explainRatioSkips(ratioInput);
  const skipKeys = Object.keys(ratioSkips);
  if (skipKeys.length > 0) {
    console.log(
      `[ratioEngine] skipped ratios for ${market.canonical_id}: ${JSON.stringify(ratioSkips)}`
    );
  }

  // Legacy Spada fields (not POC) — preserved for existing consumers
  const primaryYes = resolvedCurrentProb;
  const counterYes = crossMatch?.alignedTwinProb ?? null;
  let legacyRatio: number | null = null;
  let legacySpread: number | null = null;
  let legacyDivergencePct: number | null = null;
  if (primaryYes != null && counterYes != null && counterYes > 0) {
    legacyRatio = Number((primaryYes / counterYes).toFixed(4));
    legacySpread = Number((primaryYes - counterYes).toFixed(4));
    legacyDivergencePct = Number(
      (((primaryYes - counterYes) / counterYes) * 100).toFixed(2)
    );
  }

  return {
    ratios,
    matched: Boolean(crossMatch),
    similarity: crossMatch?.similarity ?? null,
    counterMarket: crossMatch
      ? {
          canonical_id: crossMatch.twin.canonical_id,
          platform: crossMatch.twin.platform,
          title: crossMatch.twin.title,
          yes_price: crossMatch.alignedTwinProb,
        }
      : null,
    legacy: {
      ratio: legacyRatio,
      spread: legacySpread,
      divergence_percent: legacyDivergencePct,
    },
    inputs: {
      vol24h,
      liquidity,
      openInterest,
      bestBid,
      bestAsk,
      currentProb: resolvedCurrentProb,
      prob24hAgo,
      polyProb,
      kalshiProb,
      daysToClose,
      closes7dCount: closes7d.length,
      matchFromCache: Boolean(crossMatch?.fromCache),
    },
    ratioSkips,
  };
}

/** Shape returned by GET /api/v1/ratios/:marketId (for route tests). */
export function buildRatioHttpResponse(
  market: RatioMarketRow,
  result: RatioComputationResult
) {
  return {
    matched: result.matched,
    similarity: result.similarity,
    message: result.matched
      ? null
      : 'No cross-platform counterpart found for this market',
    ratios: {
      pressure: result.ratios.pressure,
      churn: result.ratios.churn,
      support: result.ratios.support,
      executionCost: result.ratios.executionCost,
      divergence: result.ratios.divergence,
      probabilityMomentum: result.ratios.probabilityMomentum,
      resolutionTension: result.ratios.resolutionTension,
    },
    metrics: {
      ratio: result.legacy.ratio,
      spread: result.legacy.spread,
      divergence_percent: result.legacy.divergence_percent,
    },
    inputs: result.inputs,
    primaryMarket: {
      canonical_id: market.canonical_id,
      platform: market.platform,
      title: market.title,
      yes_price: result.inputs.currentProb ?? market.prices?.[0] ?? null,
    },
    counterMarket: result.counterMarket,
  };
}

/**
 * Background pass: populate market_matches.
 * Uses balanced poly/kalshi sources and volume-ordered candidate pools
 * (see runMarketMatchSyncDetailed). Divergence stays null until a valid twin exists.
 */
export async function runMarketMatchSync(
  limit = 100
): Promise<{ scanned: number; matched: number } & MatchDiagnostics> {
  const stats = await runMarketMatchSyncDetailed(limit);
  return stats;
}
