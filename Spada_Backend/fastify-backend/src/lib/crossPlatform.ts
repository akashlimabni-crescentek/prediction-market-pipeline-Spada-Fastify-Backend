/**
 * Cross-platform twin helpers for Divergence — ported from POC
 * (poc-stock-market/frontend/lib/cross-platform.ts).
 *
 * Client formula (unchanged):
 *   divergence = |polyProb − kalshiProb| / ((polyProb + kalshiProb) / 2)
 *
 * Match rule: title Jaccard ≥ 0.88 + close-time alignment + same market kind.
 */

export const CROSS_MATCH_THRESHOLD = 0.88;

/** Venue close_time often differs by days for the same game — keep a wide gate. */
export const CROSS_CLOSE_MAX_MS = 14 * 24 * 60 * 60 * 1000;

const STOP = new Set([
  'will',
  'the',
  'vs',
  'versus',
  'win',
  'wins',
  'winner',
  'winners',
  'and',
  'for',
  'on',
  'at',
  'in',
  'of',
  'a',
  'an',
  'to',
  'be',
  'or',
  'up',
  'down',
  'price',
  'match',
  'game',
  'july',
  'june',
  'august',
  'september',
  'october',
  'november',
  'december',
  'january',
  'february',
  'march',
  'april',
  'may',
  'et',
  'am',
  'pm',
]);

/** Prop / derivative markets — must not twin with moneyline/winner markets. */
const PROP_TITLE_RE =
  /\b(o\s*\/\s*u|over\s*\/\s*under|spread|handicap|innings|nrfi|run scored|extra innings|map\s*\d|totals?)\b/i;

export function isPropMarketTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  return PROP_TITLE_RE.test(title);
}

/** Reject moneyline↔prop pairs that share team tokens after normalization. */
export function sameMarketKind(
  aTitle: string | null | undefined,
  bTitle: string | null | undefined
): boolean {
  return isPropMarketTitle(aTitle) === isPropMarketTitle(bTitle);
}

const TEAM_ALIASES: Record<string, string> = {
  rockies: 'colorado',
  brewers: 'milwaukee',
  yankees: 'newyork',
  mets: 'newyork',
  dodgers: 'losangeles',
  giants: 'sanfrancisco',
  cubs: 'chicago',
  whitesox: 'chicago',
  redsox: 'boston',
  angels: 'losangeles',
  athletics: 'oakland',
  padres: 'sandiego',
  rangers: 'texas',
  astros: 'houston',
  mariners: 'seattle',
  rays: 'tampabay',
  orioles: 'baltimore',
  nationals: 'washington',
  phillies: 'philadelphia',
  braves: 'atlanta',
  marlins: 'miami',
  cardinals: 'stlouis',
  pirates: 'pittsburgh',
  reds: 'cincinnati',
  guardians: 'cleveland',
  tigers: 'detroit',
  twins: 'minnesota',
  royals: 'kansascity',
  diamondbacks: 'arizona',
  dbacks: 'arizona',
  bluejays: 'toronto',
  jays: 'toronto',
};

/** Significant title tokens for Jaccard-style similarity. */
export function titleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .map((t) => t.trim())
    .map((t) => TEAM_ALIASES[t] ?? t)
    .filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t));
}

/**
 * Jaccard similarity of significant title tokens.
 * Mirrors the client's high-threshold similar-market gate (0.88).
 */
export function titleSimilarity(a: string, b: string): number {
  const ta = new Set(titleTokens(a));
  const tb = new Set(titleTokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;

  let inter = 0;
  for (const t of ta) {
    if (tb.has(t)) inter += 1;
  }
  const union = ta.size + tb.size - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Cross-platform title score for matching (threshold still CROSS_MATCH_THRESHOLD).
 *
 * Kalshi often stores short moneyline titles ("BetBoom Team wins") while
 * Polymarket stores long event titles ("Dota 2: BetBoom Team vs OG - Game 2").
 * Pure Jaccard of {betboom,team} vs {dota,betboom,team} is only 0.67 and
 * never reaches 0.88 even for true twins.
 *
 * When the smaller token set has ≥2 significant tokens and is fully contained
 * in the larger set, treat that as a perfect title match (1.0). This does not
 * lower the 0.88 gate — it recognizes asymmetric naming without inventing
 * weak single-token matches.
 */
export function titleMatchScore(a: string, b: string): number {
  const jaccard = titleSimilarity(a, b);
  const ta = new Set(titleTokens(a));
  const tb = new Set(titleTokens(b));
  if (ta.size === 0 || tb.size === 0) return jaccard;

  const smaller = ta.size <= tb.size ? ta : tb;
  const larger = ta.size <= tb.size ? tb : ta;
  if (smaller.size < 2) return jaccard;

  for (const t of smaller) {
    if (!larger.has(t)) return jaccard;
  }
  return Math.max(jaccard, 1);
}

/** Build comparison text: market title + outcome label. */
export function matchText(
  title: string | null | undefined,
  outcomeLabel?: string | null
): string {
  return [title?.trim(), outcomeLabel?.trim()].filter(Boolean).join(' ');
}

function sideTokens(side: string): Set<string> {
  return new Set(titleTokens(side));
}

function sideOverlapCount(a: string, b: string): number {
  const ta = sideTokens(a);
  const tb = sideTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let n = 0;
  for (const t of ta) {
    if (tb.has(t)) n += 1;
  }
  return n;
}

/** Parse "A / B" outcome labels or "A vs B" titles into [primary, secondary]. */
export function parseBinarySides(
  title: string | null | undefined,
  outcomeLabel?: string | null
): [string, string] | null {
  if (outcomeLabel) {
    const parts = outcomeLabel
      .split(/\s*\/\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length >= 2) return [parts[0], parts[1]];
  }
  if (title) {
    const vs = title.split(/\s+vs\.?\s+/i).map((s) => s.trim()).filter(Boolean);
    if (vs.length === 2) {
      const left = vs[0].replace(/\s+winner\??$/i, '').trim();
      const right = vs[1].replace(/\s+winner\??$/i, '').trim();
      if (left && right) return [left, right];
    }
  }
  return null;
}

/**
 * Align twin price to the source outcome.
 * Prefer the orientation (p or 1−p) closest to the source probability when known.
 */
export function alignTwinPrice(
  sourceTitle: string | null | undefined,
  sourceOutcome: string | null | undefined,
  twinTitle: string | null | undefined,
  twinOutcome: string | null | undefined,
  twinPrice: number,
  sourceProb?: number | null
): number {
  if (!Number.isFinite(twinPrice)) return twinPrice;

  if (sourceProb != null && Number.isFinite(sourceProb)) {
    const inv = 1 - twinPrice;
    return Math.abs(sourceProb - twinPrice) <= Math.abs(sourceProb - inv)
      ? twinPrice
      : inv;
  }

  const sourceSide = (sourceOutcome || '').trim();
  if (!sourceSide) return twinPrice;

  const twinSides = parseBinarySides(twinTitle, twinOutcome);
  if (!twinSides) return twinPrice;

  const [primary, secondary] = twinSides;
  const primaryHits = sideOverlapCount(sourceSide, primary);
  const secondaryHits = sideOverlapCount(sourceSide, secondary);

  // Prefer the side with stronger token overlap (handles shared tokens like "team").
  if (secondaryHits > primaryHits) {
    return 1 - twinPrice;
  }
  return twinPrice;
}

export function pickProb(...vals: Array<number | null | undefined>): number | null {
  for (const v of vals) {
    if (v == null) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  }
  return null;
}

/**
 * Prefer a trustworthy top-of-book mid; if the book is a placeholder wide
 * spread (common on quiet CLOB seeds), fall back to last trade.
 * Ported from POC cross-platform.ts — do not alter priority.
 */
export function pickReliableProb(latest: {
  mid?: number | null;
  last_price?: number | null;
  bid?: number | null;
  ask?: number | null;
} | null | undefined): number | null {
  if (!latest) return null;
  const bid = latest.bid != null ? Number(latest.bid) : null;
  const ask = latest.ask != null ? Number(latest.ask) : null;
  const wide =
    bid != null &&
    ask != null &&
    Number.isFinite(bid) &&
    Number.isFinite(ask) &&
    ask - bid > 0.5;
  if (wide) {
    return pickProb(latest.last_price);
  }
  return pickProb(latest.mid, latest.last_price, latest.bid, latest.ask);
}

/** Same resolution window — rejects unrelated markets that share a few words. */
export function closeTimesAligned(
  a: string | null | undefined,
  b: string | null | undefined,
  maxDeltaMs = CROSS_CLOSE_MAX_MS
): boolean {
  if (!a || !b) return true;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return true;
  return Math.abs(ta - tb) <= maxDeltaMs;
}

/**
 * Extract series slot (game/map/match/set N). "game" is a stop-word in titleTokens,
 * so without this gate Game 1 and Game 2 can falsely twin via team names alone.
 */
export function seriesSlotOf(title: string | null | undefined): string | null {
  if (!title) return null;
  const m = title.match(/\b(?:game|map|match|set)\s*#?\s*(\d+)\b/i);
  return m ? m[1]! : null;
}

/** Compatible when both omit a slot, or both name the same slot number. */
export function seriesSlotsCompatible(
  aTitle: string | null | undefined,
  bTitle: string | null | undefined
): boolean {
  const a = seriesSlotOf(aTitle);
  const b = seriesSlotOf(bTitle);
  if (a == null || b == null) return true;
  return a === b;
}

/** Calendar years mentioned in a title (20xx). */
export function significantYears(title: string | null | undefined): number[] {
  if (!title) return [];
  const hits = title.match(/\b(20\d{2})\b/g);
  if (!hits) return [];
  return [...new Set(hits.map((y) => Number(y)))].filter((y) =>
    Number.isFinite(y)
  );
}

/**
 * Reject pairs that both name years with no overlap (e.g. 2024 election vs 2028).
 * If either side has no year, allow (asymmetric naming).
 */
export function yearsCompatible(
  aTitle: string | null | undefined,
  bTitle: string | null | undefined
): boolean {
  const ya = significantYears(aTitle);
  const yb = significantYears(bTitle);
  if (ya.length === 0 || yb.length === 0) return true;
  return ya.some((y) => yb.includes(y));
}

/**
 * Semantic resolution gate beyond Jaccard: same market kind, series slot, and years.
 * Does not invent matches — only rejects incompatible pairs.
 */
export function resolutionCompatible(
  aTitle: string | null | undefined,
  bTitle: string | null | undefined
): boolean {
  if (!sameMarketKind(aTitle, bTitle)) return false;
  if (!seriesSlotsCompatible(aTitle, bTitle)) return false;
  if (!yearsCompatible(aTitle, bTitle)) return false;
  return true;
}

/**
 * When multiple candidates clear the score threshold, reject if a runner-up is
 * within this absolute similarity of the best (ambiguous twin set).
 */
export const AMBIGUOUS_MATCH_MARGIN = 0.02;
