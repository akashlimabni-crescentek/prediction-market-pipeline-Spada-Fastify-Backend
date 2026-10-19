/**
 * Cross-platform market matching unit tests.
 * Run: npm run test:matching
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import {
  AMBIGUOUS_MATCH_MARGIN,
  CROSS_MATCH_THRESHOLD,
  alignTwinPrice,
  resolutionCompatible,
  seriesSlotOf,
  seriesSlotsCompatible,
  titleMatchScore,
  titleSimilarity,
  yearsCompatible,
} from './crossPlatform.js';
import {
  MATCH_CANDIDATE_LIMIT,
  dedupeCandidates,
  filterMatchableSources,
  findBestTwin,
  findBestTwinDetailed,
  getMatchSyncSourceOffset,
  isMatchableMarket,
  outcomeLabel,
  resetMatchSyncSourceOffset,
  type MatchCandidateMarket,
} from '../services/marketMatching.js';

function market(
  partial: Partial<MatchCandidateMarket> &
    Pick<MatchCandidateMarket, 'canonical_id' | 'platform' | 'external_id' | 'title'>
): MatchCandidateMarket {
  return {
    outcomes: ['YES', 'NO'],
    prices: [0.55, 0.45],
    active: true,
    raw_data: {},
    ...partial,
  };
}

function run() {
  resetMatchSyncSourceOffset(0);
  assert.equal(getMatchSyncSourceOffset(), 0);
  assert.ok(MATCH_CANDIDATE_LIMIT >= 100);
  assert.ok(AMBIGUOUS_MATCH_MARGIN > 0 && AMBIGUOUS_MATCH_MARGIN < 0.1);

  // --- Equivalent questions, different wording (Jaccard / containment) ---
  const j = titleSimilarity(
    'Colorado Rockies vs Milwaukee Brewers',
    'Colorado Rockies vs. Milwaukee Brewers Winner?'
  );
  assert.ok(j >= CROSS_MATCH_THRESHOLD, `jaccard ${j}`);
  assert.equal(
    titleMatchScore(
      'Colorado Rockies vs Milwaukee Brewers',
      'Colorado Rockies vs. Milwaukee Brewers Winner?'
    ),
    j
  );

  const containment = titleMatchScore(
    'BetBoom Team wins',
    'Dota 2: BetBoom Team vs OG - Game 2 Winner'
  );
  assert.equal(containment, 1, `expected full containment, got ${containment}`);
  assert.ok(containment >= CROSS_MATCH_THRESHOLD);

  // --- Clearly unrelated with similar wording ---
  const single = titleMatchScore(
    'Trump wins',
    'Will Donald Trump win the Nobel Peace Prize in 2026?'
  );
  assert.ok(single < CROSS_MATCH_THRESHOLD, `single-token must stay below threshold: ${single}`);

  const partial = titleMatchScore('Bitcoin above threshold', 'Bitcoin price on Oct 10, 2026?');
  assert.ok(partial < CROSS_MATCH_THRESHOLD, `partial bitcoin overlap: ${partial}`);

  // --- Valid binary moneyline match via findBestTwin ---
  const poly = market({
    canonical_id: 'polymarket_0xabc',
    platform: 'polymarket',
    external_id: '0xabc',
    title: 'Dota 2: BetBoom Team vs OG - Game 2 Winner',
    prices: [0.62, 0.38],
    raw_data: { end_date: '2026-10-08T14:00:00Z' },
  });
  const kalshiTwin = market({
    canonical_id: 'kalshi_KXBB',
    platform: 'kalshi',
    external_id: 'KXBB',
    title: 'BetBoom Team wins',
    prices: [0.6, 0.4],
    raw_data: {
      close_time: '2026-10-08T14:30:00Z',
      yes_sub_title: 'BetBoom Team',
    },
  });
  const unrelated = market({
    canonical_id: 'kalshi_OTHER',
    platform: 'kalshi',
    external_id: 'OTHER',
    title: 'Completely Unrelated Election Market',
    prices: [0.5, 0.5],
    raw_data: { close_time: '2026-10-08T14:30:00Z' },
  });

  const match = findBestTwin(poly, [kalshiTwin, unrelated], 0.62);
  assert.ok(match, 'expected asymmetric moneyline twin');
  assert.equal(match!.twin.external_id, 'KXBB');
  assert.ok(match!.similarity >= CROSS_MATCH_THRESHOLD);
  assert.ok(Number.isFinite(match!.alignedTwinProb));

  // --- Reversed YES/NO outcomes: invert twin price when sides disagree ---
  const inverted = alignTwinPrice(
    'Colorado Rockies vs Milwaukee Brewers Winner',
    'Milwaukee Brewers',
    'Colorado Rockies vs Milwaukee Brewers',
    'Colorado Rockies / Milwaukee Brewers',
    0.7,
    null
  );
  assert.ok(Math.abs(inverted - 0.3) < 1e-9, `expected inverted 0.3 got ${inverted}`);

  const alignedByProb = alignTwinPrice(
    'Will X happen?',
    null,
    'Will X happen?',
    null,
    0.2,
    0.75
  );
  assert.ok(Math.abs(alignedByProb - 0.8) < 1e-9, `prob-aligned invert ${alignedByProb}`);

  // --- Different resolution criteria (prop vs moneyline) ---
  const prop = market({
    canonical_id: 'kalshi_PROP',
    platform: 'kalshi',
    external_id: 'PROP',
    title: 'Will over 2.5 maps be played in the BetBoom Team vs. 9z CS2 match?',
    prices: [0.4, 0.6],
    raw_data: { close_time: '2026-10-08T14:30:00Z' },
  });
  assert.equal(findBestTwin(poly, [prop], 0.62), null);

  // --- Series slot conflict (Game 1 vs Game 2) ---
  assert.equal(seriesSlotOf('Dota 2 Game 2 Winner'), '2');
  assert.equal(seriesSlotsCompatible('Game 1 Winner', 'Game 2 Winner'), false);
  assert.equal(resolutionCompatible('BetBoom vs OG Game 1', 'BetBoom vs OG Game 2'), false);
  const game1Twin = market({
    ...kalshiTwin,
    canonical_id: 'kalshi_G1',
    external_id: 'G1',
    title: 'BetBoom Team Game 1 wins',
    raw_data: {
      close_time: '2026-10-08T14:30:00Z',
      yes_sub_title: 'BetBoom Team',
    },
  });
  // Source is Game 2; candidate title explicitly Game 1 → reject
  assert.equal(findBestTwin(poly, [game1Twin], 0.62), null);

  // --- Year conflict ---
  assert.equal(
    yearsCompatible('Will Trump win in 2024?', 'Will Trump win the 2028 election?'),
    false
  );
  assert.equal(yearsCompatible('Will Trump win?', 'Will Trump win the 2028 election?'), true);

  // --- Close time outside window ---
  assert.equal(
    findBestTwin(poly, [
      {
        ...kalshiTwin,
        raw_data: { close_time: '2026-11-20T00:00:00Z', yes_sub_title: 'BetBoom Team' },
      },
    ]),
    null
  );

  // --- Ambiguous candidate set (two near-equal high scores) ---
  const ambA = market({
    canonical_id: 'kalshi_AMB_A',
    platform: 'kalshi',
    external_id: 'AMB_A',
    title: 'Colorado Rockies vs Milwaukee Brewers Winner',
    prices: [0.51, 0.49],
    raw_data: { close_time: '2026-07-01T00:00:00Z' },
  });
  const ambB = market({
    canonical_id: 'kalshi_AMB_B',
    platform: 'kalshi',
    external_id: 'AMB_B',
    title: 'Colorado Rockies vs Milwaukee Brewers Winner?',
    prices: [0.52, 0.48],
    raw_data: { close_time: '2026-07-01T00:00:00Z' },
  });
  const polySports = market({
    canonical_id: 'polymarket_sports',
    platform: 'polymarket',
    external_id: 'sports',
    title: 'Colorado Rockies vs Milwaukee Brewers',
    prices: [0.5, 0.5],
    raw_data: { end_date: '2026-07-01T00:00:00Z' },
  });
  const amb = findBestTwinDetailed(polySports, [ambA, ambB], 0.5);
  assert.equal(amb.match, null, 'ambiguous twins must not pick arbitrarily');
  assert.equal(amb.rejectReason, 'ambiguous_match');

  // --- Duplicate candidates do not create unstable picks ---
  const dupPool = dedupeCandidates([kalshiTwin, { ...kalshiTwin }, unrelated]);
  assert.equal(dupPool.length, 2);
  const m1 = findBestTwin(poly, [kalshiTwin, kalshiTwin, unrelated], 0.62);
  const m2 = findBestTwin(poly, [kalshiTwin, unrelated, kalshiTwin], 0.62);
  assert.ok(m1 && m2);
  assert.equal(m1!.twin.canonical_id, m2!.twin.canonical_id);
  assert.equal(m1!.similarity, m2!.similarity);

  // --- Markets without a valid counterpart ---
  assert.equal(findBestTwin(poly, [unrelated], 0.62), null);
  const noCounter = findBestTwinDetailed(poly, [unrelated]);
  assert.equal(noCounter.rejectReason, 'score_below_threshold');

  // --- Multi-outcome event aggregate is not matchable ---
  const eventAgg = market({
    canonical_id: 'polymarket_event_999',
    platform: 'polymarket',
    external_id: '999',
    title: 'Balance of Power: 2026 Midterms',
    outcomes: ['Dem', 'Rep', 'Other'],
    prices: [0.4, 0.4, 0.2],
  });
  assert.equal(isMatchableMarket(eventAgg), false);
  assert.equal(findBestTwin(eventAgg, [kalshiTwin]), null);

  const polyBinary = market({
    canonical_id: 'polymarket_0xfed',
    platform: 'polymarket',
    external_id: '0xfed',
    title: 'BetBoom Team wins the series',
    prices: [0.55, 0.45],
    raw_data: { end_date: '2026-10-08T14:00:00Z' },
  });
  const eventAsTwin = market({
    canonical_id: 'polymarket_event_1',
    platform: 'polymarket',
    external_id: '1',
    title: 'BetBoom Team vs OG',
    outcomes: ['BetBoom Team', 'OG'],
    prices: [0.55, 0.45],
    raw_data: { end_date: '2026-10-08T14:00:00Z' },
  });
  const kalshiSrc = market({
    canonical_id: 'kalshi_KXBB2',
    platform: 'kalshi',
    external_id: 'KXBB2',
    title: 'BetBoom Team wins',
    prices: [0.55, 0.45],
    raw_data: { close_time: '2026-10-08T14:30:00Z' },
  });
  assert.equal(findBestTwin(kalshiSrc, [eventAsTwin]), null);
  assert.ok(findBestTwin(kalshiSrc, [polyBinary]));

  // --- Noise outcome labels ignored ---
  const withNoise = market({
    canonical_id: 'polymarket_noise',
    platform: 'polymarket',
    external_id: 'noise',
    title: 'Bitcoin above ___ on October 15?',
    outcomes: ['72,000', 'Below'],
    prices: [0.3, 0.7],
  });
  assert.equal(outcomeLabel(withNoise), null);

  const withYesSub = market({
    canonical_id: 'kalshi_ys',
    platform: 'kalshi',
    external_id: 'ys',
    title: 'Team A wins',
    raw_data: { yes_sub_title: 'Team A' },
  });
  assert.equal(outcomeLabel(withYesSub), 'Team A');

  // --- Missing twin price → no match ---
  const noPrice = market({
    ...kalshiTwin,
    canonical_id: 'kalshi_noprice',
    external_id: 'noprice',
    prices: [Number.NaN, 0.5],
  });
  assert.equal(findBestTwin(poly, [noPrice], 0.62), null);

  // --- Candidate pool limit constant is bounded ---
  assert.ok(MATCH_CANDIDATE_LIMIT <= 2000, 'candidate pool must stay bounded');

  // --- Sync source preference: skip unmatchable event aggregates ---
  const volumePage = [
    eventAgg,
    poly,
    eventAsTwin,
    polyBinary,
    unrelated,
  ];
  const filtered = filterMatchableSources(volumePage, 3);
  assert.ok(filtered.skippedUnmatchable >= 2);
  assert.ok(filtered.sources.every((s) => isMatchableMarket(s)));
  assert.ok(filtered.sources.length <= 3);
  assert.ok(
    filtered.sources.some((s) => s.canonical_id === poly.canonical_id),
    'matchable binary should be preferred over event aggregates in the same page'
  );

  console.log('✓ equivalent wording + containment; unrelated similar wording rejected');
  console.log('✓ reversed YES/NO alignment; resolution/series/year gates');
  console.log('✓ ambiguous + duplicate candidate handling');
  console.log('✓ unmatched / event aggregates / missing price');
  console.log('✓ matchable source filter prefers binaries over event aggregates');
  console.log('\nAll marketMatching tests passed.');
}

run();
