/**
 * Map live venue orderbooks onto existing Spada Supabase tables:
 *   - public.polymarket_orderbook (PK: market_id)
 *   - public.kalshi_orderbook     (PK: ticker)
 *
 * Ladder JSON shape matches stored rows: [{ price, qty }, ...]
 */

import {
  extractKalshiYesNoBids,
  normalizeKalshiNoBids,
  parseBookLevels,
  type BookLevel,
} from './orderbookNormalize.js';

export type PersistBookLevel = { price: number; qty: number };

export type PolymarketOrderbookRow = {
  market_id: string;
  yes_token_id: string | null;
  no_token_id: string | null;
  yes_bids: PersistBookLevel[];
  no_bids: PersistBookLevel[];
  last_snapshot: string;
  updated_at: string;
};

export type KalshiOrderbookRow = {
  ticker: string;
  yes_bids: PersistBookLevel[];
  no_bids: PersistBookLevel[];
  last_snapshot: string;
  updated_at: string;
};

function toPersistLevels(levels: BookLevel[]): PersistBookLevel[] {
  return levels.map((l) => ({ price: l.price, qty: l.qty }));
}

/** Stable fingerprint so we can skip no-op upserts. */
export function orderbookLadderFingerprint(
  yesBids: PersistBookLevel[],
  noBids: PersistBookLevel[]
): string {
  return JSON.stringify({ yes: yesBids, no: noBids });
}

/**
 * Resolve polymarket_orderbook.market_id from a markets row.
 * Live table uses Gamma numeric market ids (e.g. "3847118"), not conditionId.
 */
export function resolvePolymarketOrderbookMarketId(market: {
  external_id?: string | null;
  raw_data?: Record<string, unknown> | null;
}): string | null {
  const raw = market.raw_data ?? {};
  const fromRaw = raw.id ?? raw.market_id ?? raw.marketId;
  if (fromRaw != null && String(fromRaw).trim() !== '') {
    const id = String(fromRaw).trim();
    // Prefer numeric Gamma ids to match existing rows; allow other non-empty ids.
    if (/^\d+$/.test(id) || !id.startsWith('0x')) return id;
  }

  const ext = market.external_id != null ? String(market.external_id).trim() : '';
  if (/^\d+$/.test(ext)) return ext;

  return null;
}

export function extractPolymarketTokenIds(raw: Record<string, unknown> | null | undefined): {
  yesTokenId: string | null;
  noTokenId: string | null;
} {
  const value = raw?.clobTokenIds ?? raw?.clob_token_ids;
  let tokens: string[] = [];
  if (Array.isArray(value)) {
    tokens = value.map(String).filter(Boolean);
  } else if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) tokens = parsed.map(String).filter(Boolean);
    } catch {
      tokens = [];
    }
  }
  return {
    yesTokenId: tokens[0] ?? null,
    noTokenId: tokens[1] ?? null,
  };
}

export function polymarketConditionId(
  canonicalId: string,
  raw: Record<string, unknown> | null | undefined
): string | null {
  const fromRaw = raw?.conditionId ?? raw?.condition_id;
  if (typeof fromRaw === 'string' && fromRaw.startsWith('0x')) return fromRaw;
  if (canonicalId.startsWith('polymarket_')) {
    const rest = canonicalId.slice('polymarket_'.length);
    if (rest.startsWith('0x')) return rest;
  }
  return null;
}

/** CLOB 404 body when a listed token no longer has a book. */
export function isPolymarketMissingBook(status: number, body: unknown): boolean {
  if (status !== 404 || !body || typeof body !== 'object') return false;
  const message = String((body as { error?: unknown }).error ?? '').toLowerCase();
  return message.includes('no orderbook exists');
}

/** Closed or explicitly disabled books are an empty ladder, not a substitute book. */
export function polymarketBookDisabled(meta: {
  closed?: unknown;
  enable_order_book?: unknown;
} | null | undefined): boolean {
  if (!meta) return false;
  return meta.closed === true || meta.enable_order_book === false;
}

/**
 * Persist Polymarket CLOB YES-token book as yes/no bid ladders
 * (same storage convention as Kalshi): YES asks ⇒ NO bids via 1−price.
 */
export function polyClobBookToYesNoBids(
  bids: unknown,
  asks: unknown
): { yes_bids: PersistBookLevel[]; no_bids: PersistBookLevel[] } {
  const yes_bids = toPersistLevels(
    [...parseBookLevels(bids)].sort((a, b) => b.price - a.price)
  );
  const no_bids = toPersistLevels(
    parseBookLevels(asks)
      .map((l) => ({
        price: Math.round((1 - l.price) * 1e6) / 1e6,
        qty: l.qty,
      }))
      .filter((l) => l.price > 0 && l.price < 1)
      .sort((a, b) => b.price - a.price)
  );
  return { yes_bids, no_bids };
}

export function buildPolymarketOrderbookRow(input: {
  marketId: string;
  yesTokenId: string | null;
  noTokenId: string | null;
  bids: unknown;
  asks: unknown;
  nowIso?: string;
}): PolymarketOrderbookRow {
  const now = input.nowIso ?? new Date().toISOString();
  const { yes_bids, no_bids } = polyClobBookToYesNoBids(input.bids, input.asks);
  return {
    market_id: input.marketId,
    yes_token_id: input.yesTokenId,
    no_token_id: input.noTokenId,
    yes_bids,
    no_bids,
    last_snapshot: now,
    updated_at: now,
  };
}

export function buildKalshiOrderbookRow(input: {
  ticker: string;
  orderbook: Record<string, unknown>;
  nowIso?: string;
}): KalshiOrderbookRow {
  const now = input.nowIso ?? new Date().toISOString();
  const { yesBids, noBids } = extractKalshiYesNoBids(input.orderbook);
  const { yes_bids, no_bids } = normalizeKalshiNoBids(yesBids, noBids);
  return {
    ticker: input.ticker,
    yes_bids: toPersistLevels(yes_bids),
    no_bids: toPersistLevels(no_bids),
    last_snapshot: now,
    updated_at: now,
  };
}

/**
 * Persist `snapshot` as the desired latest value for `key`, then keep writing
 * until the value that was written still matches the desired latest.
 *
 * Supabase upserts cannot be cancelled. If an older in-flight write finishes
 * after a newer snapshot was requested, this loop re-applies `latestByKey`
 * so the final side-effect is the newest snapshot (not the late older write).
 */
export async function writeLatestSnapshot<T>(args: {
  key: string;
  snapshot: T;
  latestByKey: Map<string, T>;
  write: (snapshot: T) => Promise<void>;
  isSame?: (a: T, b: T) => boolean;
}): Promise<void> {
  const isSame = args.isSame ?? Object.is;
  args.latestByKey.set(args.key, args.snapshot);

  for (;;) {
    const current = args.latestByKey.get(args.key)!;
    await args.write(current);
    const head = args.latestByKey.get(args.key)!;
    if (isSame(head, current)) return;
  }
}

/**
 * Coalesce async persist work by key: at most one in-flight job, and at most
 * one pending successor. Newer schedules while in-flight replace the pending
 * work (latest-wins) so intermediate snapshots are skipped intentionally but
 * the newest is never dropped.
 */
export class LatestWinsPersistQueue {
  private inFlight = new Map<string, Promise<void>>();
  private pending = new Map<string, () => Promise<void>>();

  schedule(
    key: string,
    work: () => Promise<void>,
    onError?: (key: string, err: unknown) => void
  ): void {
    if (this.inFlight.has(key)) {
      this.pending.set(key, work);
      return;
    }

    const job = (async () => {
      try {
        await work();
      } catch (err) {
        onError?.(key, err);
      } finally {
        const next = this.pending.get(key);
        this.pending.delete(key);
        this.inFlight.delete(key);
        if (next) {
          this.schedule(key, next, onError);
        }
      }
    })();

    this.inFlight.set(key, job);
  }

  /** Wait until in-flight and chained pending work drain. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight.values()]);
    }
  }

  /** Test/ops: whether a key currently has an in-flight job. */
  hasInFlight(key: string): boolean {
    return this.inFlight.has(key);
  }

  /** Test/ops: whether a newer job is queued behind an in-flight write. */
  hasPending(key: string): boolean {
    return this.pending.has(key);
  }
}
