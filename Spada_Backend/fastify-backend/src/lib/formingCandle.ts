/**
 * Forming-candle composition plus shared OHLCV aggregation helpers.
 *
 * Two-lane model:
 *   - Historical: completed buckets only (immutable once closed)
 *   - Live: current open bucket composed from finer completed bars + live tail
 *
 * Does not fabricate prices for missing source intervals.
 */

export const FORMING_INTERVALS = ['5m', '15m', '1h', '4h', '1d', '1w'] as const;
export type FormingInterval = (typeof FORMING_INTERVALS)[number];

/** Stored source intervals used when composing a forming candle (includes 1m base). */
export type FormingSourceInterval = '1m' | FormingInterval;

export const INTERVAL_MS: Record<FormingSourceInterval, number> = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
};

/**
 * Coarsest → finest rungs inside the current bucket.
 * Spada stores 1m OHLC as the live base, so every chart resolution includes `1m`.
 */
export const SUB_INTERVAL_LADDER: Record<FormingInterval, FormingSourceInterval[]> = {
  '5m': ['1m'],
  '15m': ['5m', '1m'],
  '1h': ['15m', '5m', '1m'],
  '4h': ['1h', '15m', '5m', '1m'],
  '1d': ['4h', '1h', '15m', '5m', '1m'],
  '1w': ['1d', '4h', '1h', '15m', '5m', '1m'],
};

export type FormingCandleRow = {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type FormingPiece = {
  src: string;
  fromMs: number;
  toMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type LiveTailCandle = {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export type ComposeResult = {
  candle: FormingCandleRow | null;
  pieces: FormingPiece[];
};

export function bucketStartMs(tsMs: number, bucketMs: number): number {
  return Math.floor(tsMs / bucketMs) * bucketMs;
}

export function intervalMs(interval: FormingSourceInterval): number {
  return INTERVAL_MS[interval];
}

/** Aggregate finer candles into a coarser interval (ascending by ts). */
export function aggregateOhlcv(
  source: FormingCandleRow[],
  targetInterval: FormingSourceInterval
): FormingCandleRow[] {
  const bucketMs = INTERVAL_MS[targetInterval];
  const buckets = new Map<number, FormingCandleRow>();
  const ordered = [...source].sort(
    (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()
  );

  for (const c of ordered) {
    const tsMs = new Date(c.ts).getTime();
    if (!Number.isFinite(tsMs)) continue;
    if (
      !Number.isFinite(c.open) ||
      !Number.isFinite(c.high) ||
      !Number.isFinite(c.low) ||
      !Number.isFinite(c.close)
    ) {
      continue;
    }
    const start = bucketStartMs(tsMs, bucketMs);
    const existing = buckets.get(start);
    if (!existing) {
      buckets.set(start, {
        ts: new Date(start).toISOString(),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume || 0,
      });
      continue;
    }
    existing.high = Math.max(existing.high, c.high);
    existing.low = Math.min(existing.low, c.low);
    existing.close = c.close;
    existing.volume += c.volume || 0;
  }

  return [...buckets.values()].sort(
    (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()
  );
}

function indexByBucketStart(
  rows: FormingCandleRow[],
  stepMs: number
): Map<number, FormingCandleRow> {
  const byStart = new Map<number, FormingCandleRow>();
  for (const row of rows) {
    if (
      row.open == null ||
      row.high == null ||
      row.low == null ||
      row.close == null ||
      !Number.isFinite(row.open) ||
      !Number.isFinite(row.high) ||
      !Number.isFinite(row.low) ||
      !Number.isFinite(row.close)
    ) {
      continue;
    }
    const tsMs = Date.parse(row.ts);
    if (Number.isNaN(tsMs)) continue;
    byStart.set(bucketStartMs(tsMs, stepMs), row);
  }
  return byStart;
}

function pieceFromRow(
  src: string,
  fromMs: number,
  stepMs: number,
  row: FormingCandleRow
): FormingPiece {
  return {
    src,
    fromMs,
    toMs: fromMs + stepMs,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume ?? 0),
  };
}

/**
 * Reconstruct the current still-forming candle for `interval` at `nowMs`.
 * Walks SUB_INTERVAL_LADDER (or provided ladder), consuming whole completed
 * finer blocks, then appends `liveTail` for the uncovered span.
 *
 * Missing finer blocks are not filled with synthetic prices — the composer
 * drops to a finer rung or leaves that span to the live tail only.
 */
export function buildFormingCandle(params: {
  interval: FormingInterval;
  bucketStartMs: number;
  nowMs: number;
  ladder?: FormingSourceInterval[];
  finerRowsByInterval: Partial<Record<FormingSourceInterval, FormingCandleRow[]>>;
  liveTail: LiveTailCandle | null;
}): ComposeResult {
  const {
    interval,
    bucketStartMs: bucketStart,
    nowMs,
    finerRowsByInterval,
    liveTail,
  } = params;
  const ladder = params.ladder ?? SUB_INTERVAL_LADDER[interval];
  const pieces: FormingPiece[] = [];
  let cursor = bucketStart;

  for (const rung of ladder) {
    const stepMs = INTERVAL_MS[rung];
    const byStart = indexByBucketStart(finerRowsByInterval[rung] ?? [], stepMs);

    while (cursor + stepMs <= nowMs) {
      const row = byStart.get(cursor);
      if (!row) break;
      pieces.push(pieceFromRow(`db:${rung}`, cursor, stepMs, row));
      cursor += stepMs;
    }
  }

  if (liveTail && liveTail.close != null && Number.isFinite(liveTail.close) && cursor < nowMs) {
    const tailTs = Date.parse(liveTail.ts);
    const tailFrom = Math.max(cursor, Number.isFinite(tailTs) ? tailTs : cursor);
    pieces.push({
      src: 'live',
      fromMs: tailFrom,
      toMs: nowMs,
      open: Number(liveTail.open ?? liveTail.close),
      high: Number(liveTail.high ?? liveTail.close),
      low: Number(liveTail.low ?? liveTail.close),
      close: Number(liveTail.close),
      volume: Number(liveTail.volume ?? 0),
    });
  }

  if (pieces.length === 0) {
    return { candle: null, pieces };
  }

  const first = pieces[0];
  const last = pieces[pieces.length - 1];
  let high = first.high;
  let low = first.low;
  let volume = 0;
  for (const p of pieces) {
    high = Math.max(high, p.high);
    low = Math.min(low, p.low);
    volume += p.volume;
  }

  return {
    candle: {
      ts: new Date(bucketStart).toISOString(),
      open: first.open,
      high,
      low,
      close: last.close,
      volume,
    },
    pieces,
  };
}

/**
 * Strip incomplete same-resolution bars that belong to the open bucket.
 * Completed history must not include the forming bucket.
 */
export function stripFormingBucket<T extends { bucket: string }>(
  candles: T[],
  formingBucketStartMs: number
): T[] {
  return candles.filter((c) => {
    const t = new Date(c.bucket).getTime();
    if (!Number.isFinite(t)) return false;
    return t < formingBucketStartMs;
  });
}

/** Quiet-period fill cap for carry-forward flat bars. */
export const GAP_FILL_CAP = 36;

/**
 * Synthesize flat OHLCV bars for quiet minutes between last written and current
 * bucket (exclusive of current). Prices carry last close, volume 0.
 * Capped at GAP_FILL_CAP (keeps most recent fills if exceeded).
 */
export function computeGapFills(
  lastWrittenBucketTsMs: number,
  currentBucketTsMs: number,
  lastKnownClose: number,
  stepMs: number,
  options: { cap?: number } = {}
): { fills: FormingCandleRow[]; capExceeded: boolean } {
  if (
    !Number.isFinite(lastWrittenBucketTsMs) ||
    !Number.isFinite(currentBucketTsMs) ||
    !Number.isFinite(lastKnownClose) ||
    stepMs <= 0
  ) {
    return { fills: [], capExceeded: false };
  }

  const cap = options.cap ?? GAP_FILL_CAP;
  const lastMs = bucketStartMs(lastWrittenBucketTsMs, stepMs);
  const currentMs = bucketStartMs(currentBucketTsMs, stepMs);
  const close = Number(lastKnownClose);

  const fills: FormingCandleRow[] = [];
  let nextMs = lastMs + stepMs;
  while (nextMs < currentMs) {
    fills.push({
      ts: new Date(nextMs).toISOString(),
      open: close,
      high: close,
      low: close,
      close,
      volume: 0,
    });
    nextMs += stepMs;
  }

  if (fills.length > cap) {
    return { fills: fills.slice(-cap), capExceeded: true };
  }
  return { fills, capExceeded: false };
}

/**
 * Insert carry-forward flat candles into gaps of a completed (ascending or
 * newest-first) series. Does not invent prices beyond last known close; volume
 * stays 0. Used for chart continuity on sparse Kalshi/Polymarket history.
 */
export function fillCandleGaps(
  candles: FormingCandleRow[],
  stepMs: number,
  options: { capPerGap?: number; untilMs?: number } = {}
): FormingCandleRow[] {
  if (!candles.length || stepMs <= 0) return candles;

  const cap = options.capPerGap ?? GAP_FILL_CAP;
  const ordered = [...candles].sort(
    (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()
  );
  const out: FormingCandleRow[] = [];

  for (let i = 0; i < ordered.length; i++) {
    const cur = ordered[i];
    out.push(cur);
    const curMs = new Date(cur.ts).getTime();
    if (!Number.isFinite(curMs)) continue;

    const next = ordered[i + 1];
    const nextMs = next
      ? new Date(next.ts).getTime()
      : options.untilMs != null
        ? bucketStartMs(options.untilMs, stepMs)
        : null;
    if (nextMs == null || !Number.isFinite(nextMs)) continue;

    const { fills } = computeGapFills(curMs, nextMs, cur.close, stepMs, { cap });
    out.push(...fills);
  }

  return out;
}

/** Resolution-aware chart history depth (bars). Override with CANDLE_MAX_BARS. */
export function maxCandlesForResolution(resolution: FormingInterval): number {
  const fromEnv = Number(process.env.CANDLE_MAX_BARS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.min(Math.floor(fromEnv), 2000);
  }
  switch (resolution) {
    case '5m':
      return 288; // ~24h
    case '15m':
      return 288; // ~3d
    case '1h':
      return 336; // ~14d
    case '4h':
      return 360; // ~60d
    case '1d':
      return 365;
    case '1w':
      return 104;
    default:
      return 100;
  }
}

/** Apply a live price observation into an in-memory OHLC bucket (mutates). */
export function applyLivePrice(
  bucket: { open: number; high: number; low: number; close: number; volume: number; tradeCount: number },
  price: number,
  options: { volume?: number; isTrade?: boolean } = {}
): void {
  if (!Number.isFinite(price)) return;
  bucket.high = Math.max(bucket.high, price);
  bucket.low = Math.min(bucket.low, price);
  bucket.close = price;
  if (options.isTrade) {
    const vol =
      options.volume != null && Number(options.volume) > 0 ? Number(options.volume) : 0;
    bucket.volume += vol;
    bucket.tradeCount += 1;
  }
}
