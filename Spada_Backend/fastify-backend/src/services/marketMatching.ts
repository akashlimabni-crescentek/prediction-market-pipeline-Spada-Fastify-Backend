import { supabaseAdmin } from '../lib/supabase.js';
import {
  AMBIGUOUS_MATCH_MARGIN,
  CROSS_MATCH_THRESHOLD,
  alignTwinPrice,
  closeTimesAligned,
  matchText,
  pickReliableProb,
  resolutionCompatible,
  sameMarketKind,
  titleMatchScore,
} from '../lib/crossPlatform.js';

/**
 * Candidate pool size for online twin scans.
 * Ordered by volume so high-liquidity counterparts are present (POC used 200 unordered).
 */
export const MATCH_CANDIDATE_LIMIT = 500;

/** In-memory source offset for fair match-sync rotation across worker cycles. */
let matchSyncSourceOffset = 0;

/** Test/helper: reset rotation cursor (does not touch DB). */
export function resetMatchSyncSourceOffset(next = 0): void {
  matchSyncSourceOffset = Math.max(0, Math.floor(next));
}

export function getMatchSyncSourceOffset(): number {
  return matchSyncSourceOffset;
}

export type MatchCandidateMarket = {
  canonical_id: string;
  platform: 'polymarket' | 'kalshi' | string;
  external_id: string;
  title: string | null;
  outcomes?: unknown;
  prices?: number[] | null;
  raw_data?: Record<string, any> | null;
  active?: boolean | null;
  volume?: number | null;
};

export type CrossPlatformMatch = {
  twin: MatchCandidateMarket;
  similarity: number;
  /** Twin YES probability aligned to source outcome (POC alignTwinPrice). */
  alignedTwinProb: number;
  pm_platform_id: string;
  kalshi_platform_id: string;
  /** True when loaded from market_matches without a full candidate scan. */
  fromCache?: boolean;
};

/** Per-source rejection reasons for diagnostics (no PII / secrets). */
export type MatchRejectReason =
  | 'short_title'
  | 'unmatchable_market'
  | 'no_candidates'
  | 'platform_mismatch'
  | 'inactive_twin'
  | 'kind_mismatch'
  | 'resolution_conflict'
  | 'close_time'
  | 'score_below_threshold'
  | 'ambiguous_match'
  | 'no_twin_price'
  | 'no_match';

export type MatchDiagnostics = {
  scanned: number;
  matched: number;
  unmatched: number;
  candidatesLoaded: { polymarket: number; kalshi: number };
  candidatesExamined: number;
  sourceOffset: number;
  rejected: Record<MatchRejectReason, number>;
  /** Best similarity seen among rejected score cases (for tuning visibility). */
  bestRejectedScore: number;
  samples: Array<{
    source_platform: string;
    twin_platform: string;
    similarity: number;
    source_title: string;
    twin_title: string;
  }>;
};

export function emptyMatchDiagnostics(): MatchDiagnostics {
  return {
    scanned: 0,
    matched: 0,
    unmatched: 0,
    candidatesLoaded: { polymarket: 0, kalshi: 0 },
    candidatesExamined: 0,
    sourceOffset: 0,
    rejected: {
      short_title: 0,
      unmatchable_market: 0,
      no_candidates: 0,
      platform_mismatch: 0,
      inactive_twin: 0,
      kind_mismatch: 0,
      resolution_conflict: 0,
      close_time: 0,
      score_below_threshold: 0,
      ambiguous_match: 0,
      no_twin_price: 0,
      no_match: 0,
    },
    bestRejectedScore: 0,
    samples: [],
  };
}

/** Drop duplicate candidates (same canonical_id or platform+external_id). */
export function dedupeCandidates(
  candidates: MatchCandidateMarket[]
): MatchCandidateMarket[] {
  const seenId = new Set<string>();
  const seenExt = new Set<string>();
  const out: MatchCandidateMarket[] = [];
  for (const c of candidates) {
    const id = String(c.canonical_id ?? '');
    const ext = `${c.platform}:${c.external_id}`;
    if (id && seenId.has(id)) continue;
    if (seenExt.has(ext)) continue;
    if (id) seenId.add(id);
    seenExt.add(ext);
    out.push(c);
  }
  return out;
}

/** Date / numeric / yes-no labels pollute Jaccard — they are not side names. */
function isNoiseOutcomeLabel(label: string): boolean {
  const t = label.trim();
  if (!t) return true;
  if (/^(yes|no)$/i.test(t)) return true;
  if (/^\d[\d,.\s%+]*$/.test(t)) return true;
  if (/^[↑↓]/.test(t)) return true;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return true;
  if (
    /^(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(
      t
    )
  ) {
    return true;
  }
  return false;
}

export function outcomeLabel(market: MatchCandidateMarket): string | null {
  const raw = market.raw_data ?? {};
  // Prefer venue side labels (POC outcome_label / Kalshi yes_sub_title), not generic YES/NO.
  if (typeof raw.yes_sub_title === 'string' && raw.yes_sub_title.trim()) {
    const label = raw.yes_sub_title.trim();
    if (!isNoiseOutcomeLabel(label)) return label;
  }
  if (typeof raw.groupItemTitle === 'string' && raw.groupItemTitle.trim()) {
    const label = raw.groupItemTitle.trim();
    if (!isNoiseOutcomeLabel(label)) return label;
  }
  const outcomes = market.outcomes;
  if (Array.isArray(outcomes) && outcomes.length > 0) {
    const label = String(outcomes[0]).trim();
    if (label && !isNoiseOutcomeLabel(label)) {
      // Avoid doubling the full market title into matchText.
      if (market.title && label.toLowerCase() === market.title.trim().toLowerCase()) {
        return null;
      }
      return label;
    }
  }
  return null;
}

export function closeTimeOf(market: MatchCandidateMarket): string | null {
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

/**
 * Event-aggregate Polymarket rows (`polymarket_event_*`) bundle many outcomes;
 * twinning them to a single Kalshi binary market is usually semantically wrong.
 */
export function isMatchableMarket(market: MatchCandidateMarket): boolean {
  if (market.active === false) return false;
  const id = String(market.canonical_id ?? '');
  if (id.includes('_event_')) return false;
  const title = market.title?.trim();
  if (!title || title.length < 8) return false;
  return true;
}

/**
 * POC pickReliableProb inputs for a market.
 * With orderbook: mid=(bid+ask)/2, last=stored prices[0], bid, ask.
 * Without orderbook: stored price as mid/last (matching scan / cache gate).
 */
export function marketReliableProb(
  market: MatchCandidateMarket,
  book?: { bid?: number | null; ask?: number | null } | null
): number | null {
  const storedRaw = market.prices?.[0];
  const stored =
    storedRaw == null
      ? null
      : Number.isFinite(Number(storedRaw)) &&
          Number(storedRaw) >= 0 &&
          Number(storedRaw) <= 1
        ? Number(storedRaw)
        : null;

  const bid = book?.bid != null ? Number(book.bid) : null;
  const ask = book?.ask != null ? Number(book.ask) : null;
  const bidOk = bid != null && Number.isFinite(bid) ? bid : null;
  const askOk = ask != null && Number.isFinite(ask) ? ask : null;

  if (bidOk == null && askOk == null) {
    return pickReliableProb({
      mid: stored,
      last_price: stored,
      bid: null,
      ask: null,
    });
  }

  const mid = bidOk != null && askOk != null ? (bidOk + askOk) / 2 : null;
  return pickReliableProb({
    mid,
    last_price: stored,
    bid: bidOk,
    ask: askOk,
  });
}

/** alignTwinPrice after pickReliableProb — used for divergence twin prob. */
export function alignTwinReliableProb(
  source: MatchCandidateMarket,
  twin: MatchCandidateMarket,
  rawTwinProb: number,
  sourceProb?: number | null
): number {
  return alignTwinPrice(
    source.title,
    outcomeLabel(source),
    twin.title,
    outcomeLabel(twin),
    rawTwinProb,
    sourceProb
  );
}

function platformIds(
  source: MatchCandidateMarket,
  twin: MatchCandidateMarket
): { pm_platform_id: string; kalshi_platform_id: string } {
  return {
    pm_platform_id:
      source.platform === 'polymarket'
        ? String(source.external_id)
        : String(twin.external_id),
    kalshi_platform_id:
      source.platform === 'kalshi'
        ? String(source.external_id)
        : String(twin.external_id),
  };
}

/**
 * Re-check a candidate twin against matching rules (for cache validation).
 */
export function scoreTwinAgainstSource(
  source: MatchCandidateMarket,
  twin: MatchCandidateMarket,
  sourceProb?: number | null
): CrossPlatformMatch | null {
  if (!isMatchableMarket(source)) return null;

  const title = source.title!.trim();
  const otherPlatform = source.platform === 'polymarket' ? 'kalshi' : 'polymarket';
  if (twin.platform !== otherPlatform) return null;
  if (twin.active === false) return null;
  if (!isMatchableMarket(twin) && String(twin.canonical_id).includes('_event_')) {
    return null;
  }
  if (!closeTimesAligned(closeTimeOf(source), closeTimeOf(twin))) return null;
  if (!resolutionCompatible(title, twin.title)) return null;

  const score = titleMatchScore(
    matchText(title, outcomeLabel(source)),
    matchText(twin.title, outcomeLabel(twin))
  );
  if (score < CROSS_MATCH_THRESHOLD) return null;

  const rawPrice = marketReliableProb(twin);
  if (rawPrice == null) return null;

  const srcProb = sourceProb ?? marketReliableProb(source);
  const aligned = alignTwinPrice(
    title,
    outcomeLabel(source),
    twin.title,
    outcomeLabel(twin),
    rawPrice,
    srcProb
  );

  return {
    twin,
    similarity: score,
    alignedTwinProb: aligned,
    ...platformIds(source, twin),
  };
}

export type FindBestTwinResult = {
  match: CrossPlatformMatch | null;
  rejectReason: MatchRejectReason | null;
  bestScore: number;
  stageCounts: Partial<Record<MatchRejectReason, number>>;
};

/**
 * Cross-platform twin search among candidate markets.
 * Threshold 0.88 (Jaccard or full containment of ≥2-token shorter title),
 * close-time alignment, same market kind, alignTwinPrice.
 */
export function findBestTwin(
  source: MatchCandidateMarket,
  candidates: MatchCandidateMarket[],
  sourceProb?: number | null
): CrossPlatformMatch | null {
  return findBestTwinDetailed(source, candidates, sourceProb).match;
}

export function findBestTwinDetailed(
  source: MatchCandidateMarket,
  candidates: MatchCandidateMarket[],
  sourceProb?: number | null
): FindBestTwinResult {
  const stageCounts: Partial<Record<MatchRejectReason, number>> = {};
  const bump = (r: MatchRejectReason) => {
    stageCounts[r] = (stageCounts[r] ?? 0) + 1;
  };

  if (!isMatchableMarket(source)) {
    const title = source.title?.trim();
    if (!title || title.length < 8) {
      return { match: null, rejectReason: 'short_title', bestScore: 0, stageCounts };
    }
    return {
      match: null,
      rejectReason: 'unmatchable_market',
      bestScore: 0,
      stageCounts,
    };
  }

  const title = source.title!.trim();
  const otherPlatform = source.platform === 'polymarket' ? 'kalshi' : 'polymarket';
  const sourceText = matchText(title, outcomeLabel(source));
  const sourceClose = closeTimeOf(source);
  const srcProb = sourceProb ?? marketReliableProb(source);
  const pool = dedupeCandidates(candidates);

  type Scored = {
    twin: MatchCandidateMarket;
    similarity: number;
    alignedTwinProb: number;
    rawDist: number;
    priceDist: number;
  };

  const aboveThreshold: Scored[] = [];
  let bestScore = 0;
  let sawCandidate = false;

  for (const cand of pool) {
    if (cand.canonical_id === source.canonical_id) continue;
    if (cand.platform !== otherPlatform) {
      bump('platform_mismatch');
      continue;
    }
    if (cand.active === false) {
      bump('inactive_twin');
      continue;
    }
    // Skip event aggregates as twins too.
    if (String(cand.canonical_id).includes('_event_')) {
      bump('unmatchable_market');
      continue;
    }
    sawCandidate = true;

    if (!closeTimesAligned(sourceClose, closeTimeOf(cand))) {
      bump('close_time');
      continue;
    }
    if (!sameMarketKind(title, cand.title)) {
      bump('kind_mismatch');
      continue;
    }
    if (!resolutionCompatible(title, cand.title)) {
      bump('resolution_conflict');
      continue;
    }

    const score = titleMatchScore(
      sourceText,
      matchText(cand.title, outcomeLabel(cand))
    );
    if (score > bestScore) bestScore = score;
    if (score < CROSS_MATCH_THRESHOLD) {
      bump('score_below_threshold');
      continue;
    }

    const rawPrice = marketReliableProb(cand);
    if (rawPrice == null) {
      bump('no_twin_price');
      continue;
    }

    const aligned = alignTwinPrice(
      title,
      outcomeLabel(source),
      cand.title,
      outcomeLabel(cand),
      rawPrice,
      srcProb
    );

    const rawDist =
      srcProb != null ? Math.abs(srcProb - rawPrice) : Number.POSITIVE_INFINITY;
    const priceDist =
      srcProb != null ? Math.abs(srcProb - aligned) : Number.POSITIVE_INFINITY;

    aboveThreshold.push({
      twin: cand,
      similarity: score,
      alignedTwinProb: aligned,
      rawDist,
      priceDist,
    });
  }

  if (!sawCandidate) {
    return {
      match: null,
      rejectReason: 'no_candidates',
      bestScore: 0,
      stageCounts,
    };
  }

  if (aboveThreshold.length === 0) {
    let rejectReason: MatchRejectReason = 'no_match';
    if ((stageCounts.score_below_threshold ?? 0) > 0) {
      rejectReason = 'score_below_threshold';
    } else if ((stageCounts.close_time ?? 0) > 0) {
      rejectReason = 'close_time';
    } else if ((stageCounts.resolution_conflict ?? 0) > 0) {
      rejectReason = 'resolution_conflict';
    } else if ((stageCounts.kind_mismatch ?? 0) > 0) {
      rejectReason = 'kind_mismatch';
    } else if ((stageCounts.no_twin_price ?? 0) > 0) {
      rejectReason = 'no_twin_price';
    }
    return { match: null, rejectReason, bestScore, stageCounts };
  }

  aboveThreshold.sort((a, b) => {
    if (b.similarity !== a.similarity) return b.similarity - a.similarity;
    if (a.rawDist !== b.rawDist) return a.rawDist - b.rawDist;
    return a.priceDist - b.priceDist;
  });

  const best = aboveThreshold[0]!;
  const runnerUp = aboveThreshold[1];
  if (
    runnerUp &&
    best.similarity - runnerUp.similarity <= AMBIGUOUS_MATCH_MARGIN
  ) {
    bump('ambiguous_match');
    return {
      match: null,
      rejectReason: 'ambiguous_match',
      bestScore: best.similarity,
      stageCounts,
    };
  }

  return {
    match: {
      twin: best.twin,
      similarity: best.similarity,
      alignedTwinProb: best.alignedTwinProb,
      ...platformIds(source, best.twin),
    },
    rejectReason: null,
    bestScore: best.similarity,
    stageCounts,
  };
}

/**
 * Persist match into market_matches without assuming a unique constraint.
 * Select-then-update/insert avoids duplicate rows on repeated requests.
 */
export async function upsertMarketMatch(match: CrossPlatformMatch): Promise<void> {
  // Schema (live): pm_platform_id, kalshi_platform_id, similarity — no updated_at column.
  const row = {
    pm_platform_id: match.pm_platform_id,
    kalshi_platform_id: match.kalshi_platform_id,
    similarity: match.similarity,
  };

  try {
    // No assumed unique constraint — take first row if duplicates exist.
    const { data: byPmRows } = await supabaseAdmin
      .from('market_matches')
      .select('pm_platform_id, kalshi_platform_id')
      .eq('pm_platform_id', row.pm_platform_id)
      .limit(1);
    const byPm = byPmRows?.[0];

    if (byPm) {
      const { error } = await supabaseAdmin
        .from('market_matches')
        .update({
          kalshi_platform_id: row.kalshi_platform_id,
          similarity: row.similarity,
        })
        .eq('pm_platform_id', row.pm_platform_id);
      if (error) {
        console.warn('[marketMatching] update by pm failed:', error.message?.slice(0, 200));
      }
      return;
    }

    const { data: byKalshiRows } = await supabaseAdmin
      .from('market_matches')
      .select('pm_platform_id, kalshi_platform_id')
      .eq('kalshi_platform_id', row.kalshi_platform_id)
      .limit(1);
    const byKalshi = byKalshiRows?.[0];

    if (byKalshi) {
      const { error } = await supabaseAdmin
        .from('market_matches')
        .update({
          pm_platform_id: row.pm_platform_id,
          similarity: row.similarity,
        })
        .eq('kalshi_platform_id', row.kalshi_platform_id);
      if (error) {
        console.warn('[marketMatching] update by kalshi failed:', error.message?.slice(0, 200));
      }
      return;
    }

    const { error: insertError } = await supabaseAdmin.from('market_matches').insert(row);
    if (insertError) {
      // Race / unique conflict — best-effort upsert fallback (constraint unknown in repo).
      const { error: upsertError } = await supabaseAdmin
        .from('market_matches')
        .upsert(row, { onConflict: 'pm_platform_id' });
      if (upsertError) {
        console.warn(
          '[marketMatching] insert/upsert market_matches failed:',
          upsertError.message?.slice(0, 200)
        );
      }
    }
  } catch (err: any) {
    console.warn('[marketMatching] upsertMarketMatch failed:', err?.message ?? err);
  }
}

async function loadPersistedMatch(
  source: MatchCandidateMarket,
  sourceProb?: number | null
): Promise<CrossPlatformMatch | null> {
  const isPoly = source.platform === 'polymarket';
  const col = isPoly ? 'pm_platform_id' : 'kalshi_platform_id';
  const id = String(source.external_id);

  // limit(1): schema may lack a unique constraint (not confirmed in repo).
  const { data: rows, error } = await supabaseAdmin
    .from('market_matches')
    .select('pm_platform_id, kalshi_platform_id, similarity')
    .eq(col, id)
    .limit(1);

  if (error) {
    console.warn('[marketMatching] cache lookup failed:', error.message?.slice(0, 200));
    return null;
  }
  const row = rows?.[0];
  if (!row) return null;

  const twinExt = isPoly ? row.kalshi_platform_id : row.pm_platform_id;
  const twinPlatform = isPoly ? 'kalshi' : 'polymarket';
  if (!twinExt) return null;

  const { data: twin, error: twinError } = await supabaseAdmin
    .from('markets')
    .select('canonical_id, platform, external_id, title, outcomes, prices, raw_data, active')
    .eq('platform', twinPlatform)
    .eq('external_id', twinExt)
    .maybeSingle();

  if (twinError || !twin) return null;

  const validated = scoreTwinAgainstSource(
    source,
    twin as MatchCandidateMarket,
    sourceProb
  );
  if (!validated) return null;

  return { ...validated, fromCache: true };
}

/**
 * Matching only reads a few raw_data keys. Selecting the whole JSON blob
 * made ORDER BY volume on the catalogue get cancelled (ratios sat ~80s).
 */
const CANDIDATE_SELECT = [
  'canonical_id',
  'platform',
  'external_id',
  'title',
  'outcomes',
  'prices',
  'active',
  'volume',
  'yes_sub_title:raw_data->yes_sub_title',
  'group_item_title:raw_data->groupItemTitle',
  'close_time:raw_data->close_time',
  'expiration_time:raw_data->expiration_time',
  'end_date:raw_data->end_date',
  'end_date_camel:raw_data->endDate',
  'end_date_iso:raw_data->endDateIso',
].join(', ');

const CANDIDATE_CACHE_MS = 30_000;
/** Ratios must not sit on a catalogue sort. The query keeps running and fills this cache. */
const RATIO_CANDIDATE_WAIT_MS = 1_500;
const candidateCache = new Map<string, { at: number; rows: MatchCandidateMarket[] }>();
const candidateInflight = new Map<string, Promise<MatchCandidateMarket[]>>();

function candidateFromRow(row: Record<string, unknown>): MatchCandidateMarket {
  return {
    canonical_id: String(row.canonical_id ?? ''),
    platform: String(row.platform ?? ''),
    external_id: String(row.external_id ?? ''),
    title: row.title != null ? String(row.title) : null,
    outcomes: row.outcomes,
    prices: row.prices as number[] | null | undefined,
    active: row.active as boolean | null | undefined,
    volume: row.volume as number | null | undefined,
    raw_data: {
      yes_sub_title: row.yes_sub_title ?? null,
      groupItemTitle: row.group_item_title ?? null,
      close_time: row.close_time ?? null,
      expiration_time: row.expiration_time ?? null,
      end_date: row.end_date ?? null,
      endDate: row.end_date_camel ?? null,
      endDateIso: row.end_date_iso ?? null,
    },
  };
}

async function queryCandidatePool(
  platform: 'polymarket' | 'kalshi',
  safeLimit: number,
  safeOffset: number,
  cacheKey: string
): Promise<MatchCandidateMarket[]> {
  const from = safeOffset;
  const to = safeOffset + safeLimit - 1;
  const { data, error } = await supabaseAdmin
    .from('markets')
    .select(CANDIDATE_SELECT)
    .eq('platform', platform)
    .eq('active', true)
    .order('volume', { ascending: false })
    .range(from, to);

  if (error) {
    console.warn(`[marketMatching] candidate load ${platform}:`, error.message);
    return [];
  }
  const rows = dedupeCandidates(
    (data ?? []).map((row) => candidateFromRow(row as Record<string, unknown>))
  );
  candidateCache.set(cacheKey, { at: Date.now(), rows });
  return rows;
}

async function loadCandidatePool(
  platform: 'polymarket' | 'kalshi',
  limit = MATCH_CANDIDATE_LIMIT,
  offset = 0,
  waitMs?: number
): Promise<MatchCandidateMarket[]> {
  const safeLimit = Math.max(1, Math.floor(limit));
  const safeOffset = Math.max(0, Math.floor(offset));
  const cacheKey = `${platform}:${safeLimit}:${safeOffset}`;
  const cached = candidateCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CANDIDATE_CACHE_MS) return cached.rows;

  let job = candidateInflight.get(cacheKey);
  if (!job) {
    job = queryCandidatePool(platform, safeLimit, safeOffset, cacheKey).finally(() => {
      candidateInflight.delete(cacheKey);
    });
    candidateInflight.set(cacheKey, job);
  }

  if (waitMs == null) return job;
  return Promise.race([
    job,
    new Promise<MatchCandidateMarket[]>((resolve) => {
      setTimeout(() => resolve([]), waitMs);
    }),
  ]);
}

/** Bound DB rows scanned while collecting matchable sync sources. */
export const MATCH_SOURCE_SCAN_CAP = 400;

export type MatchableSourcePage = {
  sources: MatchCandidateMarket[];
  /** Next volume-rank offset into the active catalogue. */
  nextOffset: number;
  examined: number;
  skippedUnmatchable: number;
};

/**
 * Page volume-ordered markets and keep only matchable sources (skip `_event_` /
 * short titles). Spends sync budget on markets that can legally twin.
 * Pure filtering of real rows — never invents counterparts.
 */
export async function collectMatchableSources(
  platform: 'polymarket' | 'kalshi',
  want: number,
  startOffset: number,
  scanCap = MATCH_SOURCE_SCAN_CAP
): Promise<MatchableSourcePage> {
  const need = Math.max(1, Math.floor(want));
  const cap = Math.max(need, Math.floor(scanCap));
  const sources: MatchCandidateMarket[] = [];
  let offset = Math.max(0, Math.floor(startOffset));
  let examined = 0;
  let skippedUnmatchable = 0;
  const batch = Math.min(Math.max(need * 3, need), 100);

  while (sources.length < need && examined < cap) {
    const page = await loadCandidatePool(platform, batch, offset);
    if (!page.length) break;
    offset += page.length;
    for (const m of page) {
      examined += 1;
      if (!isMatchableMarket(m)) {
        skippedUnmatchable += 1;
        continue;
      }
      sources.push(m);
      if (sources.length >= need) break;
    }
    if (page.length < batch) break;
  }

  return { sources, nextOffset: offset, examined, skippedUnmatchable };
}

/** Test helper: filter a preloaded volume page the same way sync does. */
export function filterMatchableSources(
  rows: MatchCandidateMarket[],
  want: number
): { sources: MatchCandidateMarket[]; skippedUnmatchable: number } {
  const sources: MatchCandidateMarket[] = [];
  let skippedUnmatchable = 0;
  for (const m of rows) {
    if (!isMatchableMarket(m)) {
      skippedUnmatchable += 1;
      continue;
    }
    sources.push(m);
    if (sources.length >= want) break;
  }
  return { sources, skippedUnmatchable };
}

async function scanForTwin(
  source: MatchCandidateMarket,
  sourceProb?: number | null
): Promise<CrossPlatformMatch | null> {
  const otherPlatform = source.platform === 'polymarket' ? 'kalshi' : 'polymarket';
  const candidates = await loadCandidatePool(
    otherPlatform,
    MATCH_CANDIDATE_LIMIT,
    0,
    RATIO_CANDIDATE_WAIT_MS
  );
  return findBestTwin(source, candidates, sourceProb);
}

/**
 * Resolve twin: reuse valid market_matches row when possible; otherwise scan
 * volume-ordered candidates and persist.
 */
export async function resolveCrossPlatformMatch(
  source: MatchCandidateMarket,
  sourceProb?: number | null
): Promise<CrossPlatformMatch | null> {
  if (!isMatchableMarket(source)) return null;

  const cached = await loadPersistedMatch(source, sourceProb);
  if (cached) return cached;

  const match = await scanForTwin(source, sourceProb);
  if (match) {
    void upsertMarketMatch(match);
  }
  return match;
}

/**
 * Background pass: balanced poly/kalshi sources vs volume-ordered opposite pools.
 * Sources skip unmatchable rows (event aggregates) so scan budget is not wasted,
 * then rotate by volume-rank offset across cycles.
 * Returns structured counters for ops / audit (no secrets).
 */
export async function runMarketMatchSyncDetailed(
  limit = 100
): Promise<MatchDiagnostics> {
  const stats = emptyMatchDiagnostics();
  const half = Math.max(1, Math.floor(limit / 2));
  const sourceOffset = matchSyncSourceOffset;
  stats.sourceOffset = sourceOffset;

  const [polyPage, kalshiPage, polyPool, kalshiPool] = await Promise.all([
    collectMatchableSources('polymarket', half, sourceOffset),
    collectMatchableSources('kalshi', half, sourceOffset),
    loadCandidatePool('polymarket', MATCH_CANDIDATE_LIMIT, 0),
    loadCandidatePool('kalshi', MATCH_CANDIDATE_LIMIT, 0),
  ]);

  stats.candidatesLoaded = {
    polymarket: polyPool.length,
    kalshi: kalshiPool.length,
  };

  const skippedUnmatchable =
    polyPage.skippedUnmatchable + kalshiPage.skippedUnmatchable;
  if (skippedUnmatchable > 0) {
    stats.rejected.unmatchable_market =
      (stats.rejected.unmatchable_market ?? 0) + skippedUnmatchable;
  }

  const sources = [...polyPage.sources, ...kalshiPage.sources];
  stats.scanned = sources.length;

  for (const source of sources) {
    const pool = source.platform === 'polymarket' ? kalshiPool : polyPool;
    stats.candidatesExamined += pool.length;
    const detailed = findBestTwinDetailed(source, pool);
    if (detailed.match) {
      stats.matched += 1;
      await upsertMarketMatch(detailed.match);
      if (stats.samples.length < 8) {
        stats.samples.push({
          source_platform: String(source.platform),
          twin_platform: String(detailed.match.twin.platform),
          similarity: Number(detailed.match.similarity.toFixed(3)),
          source_title: String(source.title ?? '').slice(0, 80),
          twin_title: String(detailed.match.twin.title ?? '').slice(0, 80),
        });
      }
    } else {
      stats.unmatched += 1;
      const reason = detailed.rejectReason ?? 'no_match';
      stats.rejected[reason] = (stats.rejected[reason] ?? 0) + 1;
      if (detailed.bestScore > stats.bestRejectedScore) {
        stats.bestRejectedScore = Number(detailed.bestScore.toFixed(3));
      }
    }
  }

  // Advance past examined volume ranks; wrap when both sides exhausted the page.
  const nextOffset = Math.max(polyPage.nextOffset, kalshiPage.nextOffset);
  const pageShort =
    polyPage.sources.length < half &&
    kalshiPage.sources.length < half &&
    polyPage.examined + kalshiPage.examined < half;
  matchSyncSourceOffset = pageShort ? 0 : nextOffset;

  console.log(
    `[marketMatchSync] scanned=${stats.scanned} matched=${stats.matched} unmatched=${stats.unmatched} ` +
      `sourceOffset=${sourceOffset} nextOffset=${matchSyncSourceOffset} ` +
      `examined_rows=${polyPage.examined + kalshiPage.examined} skipped_unmatchable=${skippedUnmatchable} ` +
      `candidates_poly=${stats.candidatesLoaded.polymarket} candidates_kalshi=${stats.candidatesLoaded.kalshi} ` +
      `candidatesExamined=${stats.candidatesExamined} ` +
      `rejected=${JSON.stringify(stats.rejected)} bestRejectedScore=${stats.bestRejectedScore}`
  );
  if (stats.samples.length) {
    console.log('[marketMatchSync] sample matches:', JSON.stringify(stats.samples));
  }

  return stats;
}
