/**
 * POC parity tests for seven ratio formulas, input assembly, matching, and HTTP shape.
 * Run: npm run test:ratios
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import {
  closeNearTimestamp,
  closesInWindow,
  computeRatios,
  daysUntilClose,
  explainRatioSkips,
  populationStddev,
  safeDiv,
} from './ratios.js';
import {
  CROSS_MATCH_THRESHOLD,
  alignTwinPrice,
  closeTimesAligned,
  pickReliableProb,
  sameMarketKind,
  titleMatchScore,
  titleSimilarity,
} from './crossPlatform.js';
import {
  MATCH_CANDIDATE_LIMIT,
  findBestTwin,
  marketReliableProb,
  scoreTwinAgainstSource,
  type MatchCandidateMarket,
} from '../services/marketMatching.js';
import {
  assembleAlignedTwinProb,
  assembleCurrentProb,
  assembleVol24h,
  buildRatioHttpResponse,
  computeMarketRatios,
  type RatioMarketRow,
} from '../services/ratioEngine.js';

function runFormulas() {
  assert.equal(safeDiv(10, 2), 5);
  assert.equal(safeDiv(10, 0), null);
  assert.equal(safeDiv(null, 2), null);
  assert.equal(safeDiv(10, null), null);

  const closes = [0.4, 0.42, 0.45, 0.44, 0.5, 0.55, 0.58, 0.6];
  const sd = populationStddev(closes);
  assert.ok(sd != null && sd > 0);

  const r = computeRatios({
    vol24h: 50_000,
    liquidity: 20_000,
    openInterest: 40_000,
    bestBid: 0.59,
    bestAsk: 0.61,
    currentProb: 0.6,
    prob24hAgo: 0.58,
    polyProb: 0.6,
    kalshiProb: 0.57,
    daysToClose: 30,
    closes7d: closes,
  });

  assert.ok(Math.abs((r.pressure as number) - 2.5) < 1e-9, `pressure ${r.pressure}`);
  assert.ok(Math.abs((r.support as number) - 0.5) < 1e-9, `support ${r.support}`);
  assert.ok(Math.abs((r.churn as number) - 0.3642) < 0.01, `churn ${r.churn}`);
  assert.ok(Math.abs((r.executionCost as number) - 0.033333) < 1e-4, `exec ${r.executionCost}`);
  assert.ok(
    Math.abs((r.probabilityMomentum as number) - 0.02) < 1e-9,
    `mom ${r.probabilityMomentum}`
  );
  assert.ok(Math.abs((r.divergence as number) - 0.051282) < 1e-4, `div ${r.divergence}`);
  assert.ok(
    Math.abs((r.resolutionTension as number) - 2.145) < 0.05,
    `tension ${r.resolutionTension}`
  );

  assert.equal(
    computeRatios({
      vol24h: 50_000,
      liquidity: 20_000,
      openInterest: 40_000,
      bestBid: 0.59,
      bestAsk: 0.61,
      currentProb: 0.6,
      prob24hAgo: 0.58,
      polyProb: 0.6,
      kalshiProb: 0.57,
      daysToClose: null,
      closes7d: closes,
    }).churn,
    null
  );

  assert.equal(
    computeRatios({
      vol24h: 50_000,
      liquidity: 20_000,
      openInterest: 0,
      bestBid: 0.59,
      bestAsk: 0.61,
      currentProb: 0.6,
      prob24hAgo: 0.58,
      polyProb: 0.6,
      kalshiProb: 0.57,
      daysToClose: 30,
      closes7d: closes,
    }).churn,
    null
  );

  assert.equal(
    computeRatios({
      vol24h: 1,
      liquidity: 1,
      openInterest: 1,
      bestBid: null,
      bestAsk: 0.6,
      currentProb: 0.6,
      prob24hAgo: 0.5,
      polyProb: null,
      kalshiProb: null,
      daysToClose: 1,
      closes7d: [0.5],
    }).executionCost,
    null
  );

  assert.equal(
    computeRatios({
      vol24h: 1,
      liquidity: 1,
      openInterest: 1,
      bestBid: 0,
      bestAsk: 0,
      currentProb: 0.5,
      prob24hAgo: 0.5,
      polyProb: null,
      kalshiProb: null,
      daysToClose: 1,
      closes7d: [0.5],
    }).executionCost,
    null
  );

  assert.equal(
    computeRatios({
      vol24h: 1,
      liquidity: 1,
      openInterest: 1,
      bestBid: 0.5,
      bestAsk: 0.51,
      currentProb: 0.5,
      prob24hAgo: 0.5,
      polyProb: 0.5,
      kalshiProb: null,
      daysToClose: 1,
      closes7d: [0.5],
    }).divergence,
    null
  );

  const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  const dte = daysUntilClose(future);
  assert.ok(dte != null && dte > 1.9 && dte < 2.1);
  assert.equal(daysUntilClose(null), null);
  assert.equal(daysUntilClose(new Date(Date.now() - 1000).toISOString()), null);

  const young = [
    { ts: new Date(Date.now() - 60 * 60 * 1000).toISOString(), close: 0.42 },
    { ts: new Date(Date.now() - 30 * 60 * 1000).toISOString(), close: 0.44 },
  ];
  assert.equal(closeNearTimestamp(young, Date.now() - 24 * 60 * 60 * 1000), 0.42);

  assert.equal(
    computeRatios({
      vol24h: 1,
      liquidity: 1,
      openInterest: 1,
      bestBid: 0.5,
      bestAsk: 0.51,
      currentProb: 0.5,
      prob24hAgo: null,
      polyProb: null,
      kalshiProb: null,
      daysToClose: 1,
      closes7d: [],
    }).probabilityMomentum,
    null
  );

  assert.equal(
    computeRatios({
      vol24h: 1,
      liquidity: 1,
      openInterest: 1,
      bestBid: 0.5,
      bestAsk: 0.51,
      currentProb: 0.5,
      prob24hAgo: 0.5,
      polyProb: null,
      kalshiProb: null,
      daysToClose: 2,
      closes7d: [],
    }).resolutionTension,
    null
  );

  const win = closesInWindow(
    [
      { ts: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), close: 0.1 },
      { ts: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(), close: 0.2 },
    ],
    Date.now() - 7 * 24 * 60 * 60 * 1000,
    Date.now()
  );
  assert.deepEqual(win, [0.2]);

  return r;
}

function runInputAssembly() {
  const now = Date.now();
  const candles24h = [
    { ts: new Date(now - 2 * 60 * 60 * 1000).toISOString(), volume: 100 },
    { ts: new Date(now - 1 * 60 * 60 * 1000).toISOString(), volume: 250 },
    { ts: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(), volume: 9999 }, // outside 24h
  ];

  // provider volume available
  assert.equal(assembleVol24h(12_345, candles24h, now), 12_345);

  // provider volume missing → candle volume sum (100+250, not 9999)
  assert.equal(assembleVol24h(null, candles24h, now), 350);
  assert.equal(assembleVol24h(0, candles24h, now), 350);
  assert.equal(assembleVol24h(undefined, candles24h, now), 350);

  // no provider + no candle volume → null
  assert.equal(assembleVol24h(null, [], now), null);
  assert.equal(
    assembleVol24h(null, [{ ts: new Date(now - 1000).toISOString(), volume: 0 }], now),
    null
  );

  // markets.volume must NOT be used by assembleVol24h (caller responsibility)
  // — if only DB volume exists, result stays null without candles/provider
  assert.equal(assembleVol24h(null, [], now), null);

  // reliable current probability: mid preferred
  assert.equal(assembleCurrentProb(0.4, 0.55, 0.57), 0.56);

  // wide spread → last_price (stored)
  assert.equal(assembleCurrentProb(0.42, 0.1, 0.9), 0.42);

  // no book → stored last
  assert.equal(assembleCurrentProb(0.61, null, null), 0.61);

  // pickReliableProb priority
  assert.equal(pickReliableProb({ mid: 0.5, last_price: 0.4, bid: 0.49, ask: 0.51 }), 0.5);
  assert.equal(pickReliableProb({ mid: null, last_price: 0.4, bid: 0.39, ask: 0.41 }), 0.4);
  assert.equal(pickReliableProb({ mid: null, last_price: null, bid: 0.39, ask: null }), 0.39);
  assert.equal(pickReliableProb(null), null);

  // Twin probability: mid / last / bid+ask / wide book / missing book
  const twinMkt: MatchCandidateMarket = {
    canonical_id: 'kalshi_twin',
    platform: 'kalshi',
    external_id: 'TWIN1',
    title: 'Colorado Rockies vs. Milwaukee Brewers Winner?',
    prices: [0.42],
    raw_data: { yes_sub_title: 'Rockies' },
  };
  assert.equal(marketReliableProb(twinMkt, { bid: 0.55, ask: 0.57 }), 0.56); // mid
  assert.equal(marketReliableProb(twinMkt, { bid: null, ask: null }), 0.42); // last fallback
  assert.equal(marketReliableProb(twinMkt, { bid: 0.1, ask: 0.9 }), 0.42); // wide → last
  assert.equal(marketReliableProb(twinMkt), 0.42); // no book args

  const sourceMkt: MatchCandidateMarket = {
    canonical_id: 'polymarket_src',
    platform: 'polymarket',
    external_id: 'SRC1',
    title: 'Colorado Rockies vs Milwaukee Brewers',
    outcomes: ['Rockies', 'Brewers'],
    prices: [0.6],
    raw_data: {},
  };
  // raw twin mid 0.3 + sourceProb 0.7 → alignTwinPrice flips to 0.7
  assert.equal(assembleAlignedTwinProb(sourceMkt, twinMkt, 0.28, 0.32, 0.7), 0.7);
  // missing bid/ask → last 0.42; alignTwinPrice toward 0.6 prefers 1−0.42 = 0.58
  const alignedNoBook = assembleAlignedTwinProb(sourceMkt, twinMkt, null, null, 0.6);
  assert.ok(
    alignedNoBook != null && Math.abs(alignedNoBook - 0.58) < 1e-9,
    `alignedNoBook ${alignedNoBook}`
  );
}

async function runEngineWithMocks() {
  const closeIso = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
  const market: RatioMarketRow = {
    canonical_id: 'polymarket_test1',
    platform: 'polymarket',
    external_id: 'cond_test1',
    title: 'Colorado Rockies vs Milwaukee Brewers',
    outcomes: ['Rockies', 'Brewers'],
    prices: [0.55, 0.45],
    volume: 999_999, // must NOT be used as vol24h fallback
    raw_data: { end_date: closeIso },
    active: true,
  };

  const now = Date.now();
  const candleRows = Array.from({ length: 20 }, (_, i) => ({
    bucket: new Date(now - (i + 1) * 60 * 60 * 1000).toISOString(),
    close: 0.5 + i * 0.001,
    volume: 10,
  }));

  // Full happy path with twin — twin book mid used for divergence (not prices[0] alone)
  const matched = await computeMarketRatios(market, {
    fetchProviderStats: async () => ({
      volume_24h: 50_000,
      liquidity: 20_000,
      open_interest: 40_000,
      updated_at: new Date().toISOString(),
    }),
    fetchBestBidAsk: async (m) => {
      if (m.canonical_id === 'kalshi_KX1') {
        return { bid: 0.53, ask: 0.55, kalshiOrderbook: null }; // twin mid 0.54
      }
      return { bid: 0.59, ask: 0.61, kalshiOrderbook: null };
    },
    getCandlesSince: async () => candleRows,
    resolveCrossPlatformMatch: async () => ({
      twin: {
        canonical_id: 'kalshi_KX1',
        platform: 'kalshi',
        external_id: 'KX1',
        title: 'Colorado Rockies vs. Milwaukee Brewers Winner?',
        prices: [0.5], // last — mid from book preferred
        raw_data: {},
      },
      similarity: 0.92,
      alignedTwinProb: 0.5, // overwritten by orderbook enrich
      pm_platform_id: 'cond_test1',
      kalshi_platform_id: 'KX1',
      fromCache: true,
    }),
  });

  assert.equal(matched.inputs.vol24h, 50_000);
  assert.equal(matched.inputs.liquidity, 20_000);
  assert.equal(matched.inputs.openInterest, 40_000);
  assert.equal(matched.inputs.bestBid, 0.59);
  assert.equal(matched.inputs.bestAsk, 0.61);
  assert.equal(matched.inputs.currentProb, 0.6); // mid of 0.59/0.61
  assert.equal(matched.inputs.kalshiProb, 0.54); // twin mid after enrich + align
  assert.equal(matched.matched, true);
  assert.equal(matched.inputs.matchFromCache, true);
  assert.ok(matched.ratios.divergence != null);
  assert.ok(matched.ratios.pressure != null);
  assert.ok(matched.legacy.ratio != null); // legacy separate
  assert.notEqual(matched.legacy.ratio, matched.ratios.divergence);

  // provider volume missing → candle sum; DB volume ignored
  const candleVolOnly = await computeMarketRatios(market, {
    fetchProviderStats: async () => ({
      volume_24h: null,
      liquidity: 20_000,
      open_interest: 40_000,
      updated_at: new Date().toISOString(),
    }),
    fetchBestBidAsk: async () => ({ bid: 0.5, ask: 0.52, kalshiOrderbook: null }),
    getCandlesSince: async () => candleRows,
    resolveCrossPlatformMatch: async () => null,
  });
  assert.equal(candleVolOnly.inputs.vol24h, 200); // 20 * 10
  assert.equal(candleVolOnly.matched, false);
  assert.equal(candleVolOnly.ratios.divergence, null);

  // no provider + no candle volume → null pressure/churn
  const noVol = await computeMarketRatios(market, {
    fetchProviderStats: async () => ({
      volume_24h: null,
      liquidity: 20_000,
      open_interest: 40_000,
      updated_at: new Date().toISOString(),
    }),
    fetchBestBidAsk: async () => ({ bid: 0.5, ask: 0.52, kalshiOrderbook: null }),
    getCandlesSince: async () => [],
    resolveCrossPlatformMatch: async () => null,
  });
  assert.equal(noVol.inputs.vol24h, null);
  assert.equal(noVol.ratios.pressure, null);
  assert.equal(noVol.ratios.churn, null);

  // missing orderbook → executionCost null; currentProb from stored price
  const noBook = await computeMarketRatios(market, {
    fetchProviderStats: async () => ({
      volume_24h: 1000,
      liquidity: 500,
      open_interest: 2000,
      updated_at: new Date().toISOString(),
    }),
    fetchBestBidAsk: async () => ({ bid: null, ask: null, kalshiOrderbook: null }),
    getCandlesSince: async () => candleRows,
    resolveCrossPlatformMatch: async () => null,
  });
  assert.equal(noBook.ratios.executionCost, null);
  assert.equal(noBook.inputs.currentProb, 0.55);

  // missing OI
  const noOi = await computeMarketRatios(market, {
    fetchProviderStats: async () => ({
      volume_24h: 1000,
      liquidity: 500,
      open_interest: null,
      updated_at: new Date().toISOString(),
    }),
    fetchBestBidAsk: async () => ({ bid: 0.5, ask: 0.52, kalshiOrderbook: null }),
    getCandlesSince: async () => candleRows,
    resolveCrossPlatformMatch: async () => null,
  });
  assert.equal(noOi.ratios.churn, null);
  assert.equal(noOi.ratios.support, null);

  // missing liquidity
  const noLiq = await computeMarketRatios(market, {
    fetchProviderStats: async () => ({
      volume_24h: 1000,
      liquidity: null,
      open_interest: 2000,
      updated_at: new Date().toISOString(),
    }),
    fetchBestBidAsk: async () => ({ bid: 0.5, ask: 0.52, kalshiOrderbook: null }),
    getCandlesSince: async () => candleRows,
    resolveCrossPlatformMatch: async () => null,
  });
  assert.equal(noLiq.ratios.pressure, null);
  assert.equal(noLiq.ratios.support, null);

  // missing close time → churn/resolutionTension null
  const noClose: RatioMarketRow = {
    ...market,
    raw_data: {},
  };
  const noCloseResult = await computeMarketRatios(noClose, {
    fetchProviderStats: async () => ({
      volume_24h: 1000,
      liquidity: 500,
      open_interest: 2000,
      updated_at: new Date().toISOString(),
    }),
    fetchBestBidAsk: async () => ({ bid: 0.5, ask: 0.52, kalshiOrderbook: null }),
    getCandlesSince: async () => candleRows,
    resolveCrossPlatformMatch: async () => null,
  });
  assert.equal(noCloseResult.inputs.daysToClose, null);
  assert.equal(noCloseResult.ratios.churn, null);
  assert.equal(noCloseResult.ratios.resolutionTension, null);

  // twin: stored last 0.3, book mid 0.7 → pickReliableProb mid, alignTwinPrice keeps 0.7 vs source 0.6
  const twinAligned = await computeMarketRatios(market, {
    fetchProviderStats: async () => ({
      volume_24h: 1000,
      liquidity: 500,
      open_interest: 2000,
      updated_at: new Date().toISOString(),
    }),
    fetchBestBidAsk: async (m) => {
      if (m.canonical_id === 'kalshi_t') {
        return { bid: 0.69, ask: 0.71, kalshiOrderbook: null };
      }
      return { bid: 0.6, ask: 0.6, kalshiOrderbook: null };
    },
    getCandlesSince: async () => candleRows,
    resolveCrossPlatformMatch: async () => ({
      twin: {
        canonical_id: 'kalshi_t',
        platform: 'kalshi',
        external_id: 'KT',
        title: 'Colorado Rockies vs. Milwaukee Brewers Winner?',
        prices: [0.3],
        raw_data: {},
      },
      similarity: 0.9,
      alignedTwinProb: 0.3,
      pm_platform_id: 'cond_test1',
      kalshi_platform_id: 'KT',
      fromCache: false,
    }),
  });
  assert.equal(twinAligned.inputs.kalshiProb, 0.7);
  assert.equal(twinAligned.inputs.polyProb, 0.6);
  assert.ok(twinAligned.ratios.divergence != null);

  // twin wide book → last_price; then alignTwinPrice (0.3 → 0.7 toward source 0.6)
  const twinWide = await computeMarketRatios(market, {
    fetchProviderStats: async () => ({
      volume_24h: 1000,
      liquidity: 500,
      open_interest: 2000,
      updated_at: new Date().toISOString(),
    }),
    fetchBestBidAsk: async (m) => {
      if (m.canonical_id === 'kalshi_wide') {
        return { bid: 0.1, ask: 0.9, kalshiOrderbook: null };
      }
      return { bid: 0.6, ask: 0.6, kalshiOrderbook: null };
    },
    getCandlesSince: async () => candleRows,
    resolveCrossPlatformMatch: async () => ({
      twin: {
        canonical_id: 'kalshi_wide',
        platform: 'kalshi',
        external_id: 'KW',
        title: 'Colorado Rockies vs. Milwaukee Brewers Winner?',
        prices: [0.3],
        raw_data: {},
      },
      similarity: 0.9,
      alignedTwinProb: 0.3,
      pm_platform_id: 'cond_test1',
      kalshi_platform_id: 'KW',
      fromCache: false,
    }),
  });
  assert.equal(twinWide.inputs.kalshiProb, 0.7); // alignTwinPrice(0.3, source 0.6) → 0.7
  assert.ok(twinWide.ratios.divergence != null);

  // twin missing bid/ask → stored last only
  const twinNoBook = await computeMarketRatios(market, {
    fetchProviderStats: async () => ({
      volume_24h: 1000,
      liquidity: 500,
      open_interest: 2000,
      updated_at: new Date().toISOString(),
    }),
    fetchBestBidAsk: async (m) => {
      if (m.canonical_id === 'kalshi_nobook') {
        return { bid: null, ask: null, kalshiOrderbook: null };
      }
      return { bid: 0.6, ask: 0.6, kalshiOrderbook: null };
    },
    getCandlesSince: async () => candleRows,
    resolveCrossPlatformMatch: async () => ({
      twin: {
        canonical_id: 'kalshi_nobook',
        platform: 'kalshi',
        external_id: 'KN',
        title: 'Colorado Rockies vs. Milwaukee Brewers Winner?',
        prices: [0.58],
        raw_data: {},
      },
      similarity: 0.9,
      alignedTwinProb: 0.99,
      pm_platform_id: 'cond_test1',
      kalshi_platform_id: 'KN',
      fromCache: false,
    }),
  });
  assert.equal(twinNoBook.inputs.kalshiProb, 0.58);
  assert.ok(twinNoBook.ratios.divergence != null);
}

function runMatching() {
  assert.equal(CROSS_MATCH_THRESHOLD, 0.88);
  assert.equal(MATCH_CANDIDATE_LIMIT, 500);
  assert.equal(sameMarketKind('Team A vs Team B Winner?', 'Team A vs Team B'), true);
  assert.equal(sameMarketKind('Team A vs Team B Winner?', 'Team A vs Team B O/U 8.5'), false);

  const sim = titleSimilarity(
    'Colorado Rockies vs Milwaukee Brewers',
    'Colorado Rockies vs. Milwaukee Brewers Winner?'
  );
  assert.ok(sim >= 0.88, `similarity ${sim}`);
  assert.ok(
    titleMatchScore('BetBoom Team wins', 'Dota 2: BetBoom Team vs OG - Game 2 Winner') >=
      CROSS_MATCH_THRESHOLD
  );

  assert.equal(closeTimesAligned(null, null), true);
  assert.equal(closeTimesAligned('2026-10-01T00:00:00Z', '2026-10-20T00:00:00Z'), false);

  assert.equal(alignTwinPrice('A vs B', 'A', 'A vs B', 'A / B', 0.3, 0.7), 0.7);

  const source: MatchCandidateMarket = {
    canonical_id: 'polymarket_1',
    platform: 'polymarket',
    external_id: 'cond1',
    title: 'Colorado Rockies vs Milwaukee Brewers',
    outcomes: ['Rockies', 'Brewers'],
    prices: [0.55, 0.45],
    raw_data: { end_date: '2026-10-15T00:00:00Z' },
    active: true,
  };

  const goodTwin: MatchCandidateMarket = {
    canonical_id: 'kalshi_KX1',
    platform: 'kalshi',
    external_id: 'KX1',
    title: 'Colorado Rockies vs. Milwaukee Brewers Winner?',
    outcomes: ['YES', 'NO'],
    prices: [0.54, 0.46],
    raw_data: {
      close_time: '2026-10-15T12:00:00Z',
      yes_sub_title: 'Rockies',
    },
    active: true,
  };

  const match = findBestTwin(source, [goodTwin, {
    canonical_id: 'kalshi_OTHER',
    platform: 'kalshi',
    external_id: 'OTHER',
    title: 'Completely Unrelated Election Market',
    outcomes: ['YES', 'NO'],
    prices: [0.5, 0.5],
    raw_data: { close_time: '2026-10-15T12:00:00Z' },
    active: true,
  }], 0.55);
  assert.ok(match, 'expected twin match');
  assert.equal(match!.twin.external_id, 'KX1');
  assert.ok(match!.similarity >= 0.88);

  // similarity below 0.88
  const lowSim = findBestTwin(source, [{
    ...goodTwin,
    title: 'Totally Different Sports Event Winner?',
    external_id: 'LOW',
  }]);
  assert.equal(lowSim, null);

  // close time outside 14 days
  const farClose = findBestTwin(source, [{
    ...goodTwin,
    raw_data: { close_time: '2026-11-20T00:00:00Z' },
  }]);
  assert.equal(farClose, null);

  // prop vs moneyline
  const noMatch = findBestTwin(
    {
      canonical_id: 'polymarket_prop',
      platform: 'polymarket',
      external_id: 'prop1',
      title: 'Rockies vs Brewers Over/Under 8.5',
      prices: [0.5, 0.5],
      raw_data: {},
    },
    [{
      canonical_id: 'kalshi_ml',
      platform: 'kalshi',
      external_id: 'ML1',
      title: 'Colorado Rockies vs Milwaukee Brewers Winner?',
      prices: [0.5, 0.5],
      raw_data: {},
    }]
  );
  assert.equal(noMatch, null);

  // scoreTwinAgainstSource validates cache candidates (persisted reuse gate)
  const scored = scoreTwinAgainstSource(source, goodTwin, 0.55);
  assert.ok(scored);
  assert.equal(scored!.twin.external_id, 'KX1');

  const stale = scoreTwinAgainstSource(source, {
    ...goodTwin,
    title: 'Unrelated Market Title Here Forever',
  }, 0.55);
  assert.equal(stale, null);

  // inactive twin rejected
  assert.equal(
    scoreTwinAgainstSource(source, { ...goodTwin, active: false }, 0.55),
    null
  );
}

function runHttpShape() {
  const market: RatioMarketRow = {
    canonical_id: 'polymarket_http',
    platform: 'polymarket',
    external_id: 'http1',
    title: 'Test Market Title Long Enough',
    prices: [0.6],
    raw_data: {},
  };

  const closes = [0.4, 0.42, 0.45, 0.44, 0.5, 0.55, 0.58, 0.6];
  const ratios = computeRatios({
    vol24h: 50_000,
    liquidity: 20_000,
    openInterest: 40_000,
    bestBid: 0.59,
    bestAsk: 0.61,
    currentProb: 0.6,
    prob24hAgo: 0.58,
    polyProb: 0.6,
    kalshiProb: 0.57,
    daysToClose: 30,
    closes7d: closes,
  });

  // matched market with valid seven ratios
  const matchedBody = buildRatioHttpResponse(market, {
    ratios,
    matched: true,
    similarity: 0.91,
    counterMarket: {
      canonical_id: 'kalshi_x',
      platform: 'kalshi',
      title: 'Twin',
      yes_price: 0.57,
    },
    legacy: { ratio: 1.0526, spread: 0.03, divergence_percent: 5.26 },
    inputs: {
      vol24h: 50_000,
      liquidity: 20_000,
      openInterest: 40_000,
      bestBid: 0.59,
      bestAsk: 0.61,
      currentProb: 0.6,
      prob24hAgo: 0.58,
      polyProb: 0.6,
      kalshiProb: 0.57,
      daysToClose: 30,
      closes7dCount: 8,
      matchFromCache: true,
    },
  });

  assert.equal(matchedBody.matched, true);
  assert.ok(matchedBody.ratios.pressure != null);
  assert.ok(matchedBody.ratios.churn != null);
  assert.ok(matchedBody.ratios.support != null);
  assert.ok(matchedBody.ratios.executionCost != null);
  assert.ok(matchedBody.ratios.divergence != null);
  assert.ok(matchedBody.ratios.probabilityMomentum != null);
  assert.ok(matchedBody.ratios.resolutionTension != null);
  assert.ok(matchedBody.metrics.ratio != null);
  assert.notEqual(matchedBody.metrics.ratio, matchedBody.ratios.divergence);
  assert.notEqual(matchedBody.metrics.divergence_percent, matchedBody.ratios.divergence);

  // unmatched → divergence null; legacy metrics null
  const nullRatios = computeRatios({
    vol24h: null,
    liquidity: null,
    openInterest: null,
    bestBid: null,
    bestAsk: null,
    currentProb: 0.55,
    prob24hAgo: null,
    polyProb: 0.55,
    kalshiProb: null,
    daysToClose: null,
    closes7d: [],
  });
  const unmatchedBody = buildRatioHttpResponse(market, {
    ratios: nullRatios,
    matched: false,
    similarity: null,
    counterMarket: null,
    legacy: { ratio: null, spread: null, divergence_percent: null },
    inputs: {
      vol24h: null,
      liquidity: null,
      openInterest: null,
      bestBid: null,
      bestAsk: null,
      currentProb: 0.55,
      prob24hAgo: null,
      polyProb: 0.55,
      kalshiProb: null,
      daysToClose: null,
      closes7dCount: 0,
      matchFromCache: false,
    },
  });

  assert.equal(unmatchedBody.matched, false);
  assert.equal(unmatchedBody.ratios.divergence, null);
  assert.equal(unmatchedBody.ratios.pressure, null);
  assert.equal(unmatchedBody.metrics.ratio, null);
  // Message is the HTTP unmatched notice; Jaccard threshold 0.88 is matching-only.
  assert.equal(
    unmatchedBody.message,
    'No cross-platform counterpart found for this market'
  );
  assert.deepEqual(Object.keys(unmatchedBody.ratios).sort(), [
    'churn',
    'divergence',
    'executionCost',
    'pressure',
    'probabilityMomentum',
    'resolutionTension',
    'support',
  ]);
}

function runMissingAndInvalidInputs() {
  const empty = computeRatios({
    vol24h: null,
    liquidity: null,
    openInterest: null,
    bestBid: null,
    bestAsk: null,
    currentProb: null,
    prob24hAgo: null,
    polyProb: null,
    kalshiProb: null,
    daysToClose: null,
    closes7d: [],
  });
  for (const key of Object.keys(empty) as Array<keyof typeof empty>) {
    assert.equal(empty[key], null, `${key} must stay null with missing inputs`);
  }

  const invalid = computeRatios({
    vol24h: Number.NaN,
    liquidity: Number.POSITIVE_INFINITY,
    openInterest: -1,
    bestBid: 0.5,
    bestAsk: 0.6,
    currentProb: 1.5,
    prob24hAgo: -0.1,
    polyProb: Number.NaN,
    kalshiProb: 0.5,
    daysToClose: 10,
    closes7d: [Number.NaN, Number.POSITIVE_INFINITY],
  });
  assert.equal(invalid.pressure, null);
  assert.equal(invalid.support, null);
  assert.equal(invalid.divergence, null);
  assert.equal(invalid.probabilityMomentum, null);
  assert.equal(invalid.resolutionTension, null);

  const zeroDiv = computeRatios({
    vol24h: 100,
    liquidity: 0,
    openInterest: 0,
    bestBid: 0,
    bestAsk: 0,
    currentProb: 0.5,
    prob24hAgo: 0.4,
    polyProb: 0,
    kalshiProb: 0,
    daysToClose: 5,
    closes7d: [0.4, 0.5],
  });
  assert.equal(zeroDiv.pressure, null);
  assert.equal(zeroDiv.churn, null);
  assert.equal(zeroDiv.support, null);
  assert.equal(zeroDiv.executionCost, null);
  assert.equal(zeroDiv.divergence, null);

  const skips = explainRatioSkips({
    vol24h: null,
    liquidity: 1,
    openInterest: 1,
    bestBid: null,
    bestAsk: null,
    currentProb: 0.5,
    prob24hAgo: null,
    polyProb: 0.5,
    kalshiProb: null,
    daysToClose: null,
    closes7d: [],
  });
  assert.equal(skips.pressure, 'missing_vol24h');
  assert.equal(skips.divergence, 'missing_or_invalid_cross_venue_prob');
  assert.equal(skips.probabilityMomentum, 'missing_or_invalid_probability');
  assert.equal(skips.resolutionTension, 'missing_closes_7d');

  console.log('✓ missing/invalid/zero-division ratio inputs stay null');
}

async function run() {
  const r = runFormulas();
  runMissingAndInvalidInputs();
  runInputAssembly();
  await runEngineWithMocks();
  runMatching();
  runHttpShape();

  console.log('ratios.test.ts OK', {
    pressure: r.pressure,
    churn: Number((r.churn as number).toFixed(4)),
    support: r.support,
    executionCost: Number(((r.executionCost as number) * 100).toFixed(2)) + '%',
    divergence: Number(((r.divergence as number) * 100).toFixed(2)) + '%',
    probabilityMomentum: Number(((r.probabilityMomentum as number) * 100).toFixed(1)) + 'pp',
    resolutionTension: Number((r.resolutionTension as number).toFixed(2)),
    candidateLimit: MATCH_CANDIDATE_LIMIT,
  });
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
