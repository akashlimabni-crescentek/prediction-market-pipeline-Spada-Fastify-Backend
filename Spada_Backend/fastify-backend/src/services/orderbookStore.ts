import { supabaseAdmin } from '../lib/supabase.js';
import { kalshiGet } from '../lib/kalshiClient.js';
import {
  extractKalshiYesNoBids,
  kalshiToYesBook,
} from '../lib/orderbookNormalize.js';
import {
  buildKalshiOrderbookRow,
  buildPolymarketOrderbookRow,
  extractPolymarketTokenIds,
  isPolymarketMissingBook,
  LatestWinsPersistQueue,
  orderbookLadderFingerprint,
  polymarketBookDisabled,
  polymarketConditionId,
  resolvePolymarketOrderbookMarketId,
  writeLatestSnapshot,
  type KalshiOrderbookRow,
  type PolymarketOrderbookRow,
} from '../lib/orderbookPersist.js';

/** Short in-memory cache — reduces venue load while FE polls (~5s). */
const ORDERBOOK_CACHE_TTL_MS = 2_500;
/** A closed market has no live book. Keep the empty result so polls do not re-hit CLOB. */
const CLOSED_BOOK_CACHE_MS = 60_000;
/** After a live miss, keep the stored ladder so the next poll does not wait on the venue again. */
const STALE_BOOK_CACHE_MS = 10_000;
/** CLOB book + closed-market check. A dead proxy must not hold the request for 15s. */
const POLY_CLOB_TIMEOUT_MS = 4_000;

type CachedOrderbook = {
  expiresAt: number;
  value: Record<string, unknown>;
};

function sameOrderbookRow(
  a: { yes_bids: { price: number; qty: number }[]; no_bids: { price: number; qty: number }[] },
  b: { yes_bids: { price: number; qty: number }[]; no_bids: { price: number; qty: number }[] }
): boolean {
  return (
    orderbookLadderFingerprint(a.yes_bids, a.no_bids) ===
    orderbookLadderFingerprint(b.yes_bids, b.no_bids)
  );
}

class OrderbookStore {
  private cache = new Map<string, CachedOrderbook>();
  /** One venue read per market while a request is already in flight (FE polls overlap). */
  private inflight = new Map<string, Promise<Record<string, unknown>>>();
  /** Last real ladder, used only when the live read fails and the DB row is missing. */
  private lastGood = new Map<string, Record<string, unknown>>();
  /** Last successfully persisted ladder fingerprint per table key. */
  private lastPersistedFingerprint = new Map<string, string>();
  /** Desired latest row per table key — used to heal late older upserts. */
  private latestPolymarketRows = new Map<string, PolymarketOrderbookRow>();
  private latestKalshiRows = new Map<string, KalshiOrderbookRow>();
  /** Latest-wins coalesce so a slow upsert cannot drop a newer snapshot. */
  private persistQueue = new LatestWinsPersistQueue();

  async init() {
    console.log('[OrderbookStore] Initialized successfully');
    return true;
  }

  /** Wait for in-flight + pending persist jobs (tests / ops). */
  async flushPersists(): Promise<void> {
    await this.persistQueue.drain();
  }

  /**
   * Live orderbook by canonical_id (e.g. polymarket_0x... or kalshi_KX...).
   * Cached briefly in-process; latest snapshot also upserted to Supabase.
   */
  async getOrderbook(canonicalId: string) {
    const hit = this.cache.get(canonicalId);
    if (hit && hit.expiresAt > Date.now()) {
      return hit.value;
    }

    const pending = this.inflight.get(canonicalId);
    if (pending) return pending;

    const job = this.fetchLiveOrderbook(canonicalId)
      .then((value) => {
        const closed = (value as { closed?: boolean }).closed === true;
        const stale = (value as { cached?: boolean }).cached === true;
        const ttlMs = closed
          ? CLOSED_BOOK_CACHE_MS
          : stale
            ? STALE_BOOK_CACHE_MS
            : ORDERBOOK_CACHE_TTL_MS;
        this.cache.set(canonicalId, { expiresAt: Date.now() + ttlMs, value });
        this.lastGood.set(canonicalId, value);
        return value;
      })
      .finally(() => {
        this.inflight.delete(canonicalId);
      });

    this.inflight.set(canonicalId, job);
    return job;
  }

  /**
   * Polymarket removes the book after a market closes. That 404 is an empty
   * ladder. A 404 on a market that still has its book enabled stays an error,
   * so a stale token is not replaced with made-up prices.
   */
  private async emptyBookIfPolymarketClosed(
    canonicalId: string,
    raw: Record<string, unknown>,
    bookResponse: Response
  ): Promise<Record<string, unknown> | null> {
    let body: unknown = null;
    try {
      body = await bookResponse.json();
    } catch {
      return null;
    }
    if (!isPolymarketMissingBook(bookResponse.status, body)) return null;

    const conditionId = polymarketConditionId(canonicalId, raw);
    if (!conditionId) return null;

    try {
      const metaRes = await fetch(
        `https://clob.polymarket.com/markets/${encodeURIComponent(conditionId)}`,
        {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(POLY_CLOB_TIMEOUT_MS),
        }
      );
      if (!metaRes.ok) return null;
      const meta = (await metaRes.json()) as {
        closed?: unknown;
        enable_order_book?: unknown;
      };
      if (!polymarketBookDisabled(meta)) return null;
    } catch {
      return null;
    }

    return {
      canonical_id: canonicalId,
      platform: 'polymarket',
      bids: [],
      asks: [],
      timestamp: new Date().toISOString(),
      cached: false,
      closed: true,
    };
  }

  private async fetchLiveOrderbook(canonicalId: string) {
    const { data: market, error } = await supabaseAdmin
      .from('markets')
      .select('canonical_id, platform, external_id, raw_data')
      .eq('canonical_id', canonicalId)
      .single();

    if (error || !market) {
      throw new Error(`Market not found: ${canonicalId}`);
    }

    if (market.platform === 'polymarket') {
      const raw = (market.raw_data ?? {}) as Record<string, unknown>;
      const { yesTokenId, noTokenId } = extractPolymarketTokenIds(raw);
      const tokenId =
        yesTokenId ||
        (raw.tokens as any)?.[0]?.token_id ||
        (raw.tokens as any)?.[0]?.clobTokenId;

      if (!tokenId) {
        throw new Error(`No CLOB token ID found for ${canonicalId}`);
      }

      const stalePromise = this.loadPolymarketDbSnapshot(canonicalId, market);
      try {
        const res = await fetch(
          `https://clob.polymarket.com/book?token_id=${encodeURIComponent(String(tokenId))}`,
          {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(POLY_CLOB_TIMEOUT_MS),
          }
        );
        if (!res.ok) {
          const closedBook = await this.emptyBookIfPolymarketClosed(canonicalId, raw, res);
          if (closedBook) return closedBook;
          throw new Error(`Polymarket CLOB error: ${res.status}`);
        }

        const book = await res.json();
        const bids = book.bids || [];
        const asks = book.asks || [];
        const timestamp = new Date().toISOString();

        const response = {
          canonical_id: canonicalId,
          platform: 'polymarket',
          bids,
          asks,
          timestamp,
          cached: false,
        };

        this.schedulePersist(`poly:${canonicalId}`, () =>
          this.persistPolymarketSnapshot({
            market,
            raw,
            yesTokenId: String(tokenId),
            noTokenId,
            bids,
            asks,
            timestamp,
          })
        );

        return response;
      } catch (err) {
        const stale = await stalePromise;
        if (stale) return stale;
        const last = this.lastGood.get(canonicalId);
        if (last) return { ...last, cached: true };
        throw err;
      }
    }

    if (market.platform === 'kalshi') {
      const ticker = market.external_id;
      if (!ticker) {
        throw new Error(`No Kalshi ticker for ${canonicalId}`);
      }

      const stalePromise = this.loadKalshiDbSnapshot(canonicalId, String(ticker));
      try {
        // Signed GET /markets/{ticker}/orderbook (orderbook_fp shape)
        const data = await kalshiGet(
          `/markets/${encodeURIComponent(String(ticker))}/orderbook`
        );
        const orderbook = (data.orderbook_fp ?? data.orderbook ?? {}) as Record<
          string,
          unknown
        >;

        // Also expose YES-side bids/asks so FE/consumers share one shape with Polymarket.
        const { yesBids, noBids } = extractKalshiYesNoBids(orderbook);
        const yesBook = kalshiToYesBook(yesBids, noBids);
        const timestamp = new Date().toISOString();

        const response = {
          canonical_id: canonicalId,
          platform: 'kalshi',
          orderbook,
          bids: yesBook.bids.map((l) => ({ price: l.price, size: l.qty })),
          asks: yesBook.asks.map((l) => ({ price: l.price, size: l.qty })),
          timestamp,
          cached: false,
        };

        this.schedulePersist(`kalshi:${String(ticker)}`, () =>
          this.persistKalshiSnapshot({
            ticker: String(ticker),
            orderbook,
            timestamp,
          })
        );

        return response;
      } catch (err) {
        // Same ladder shape from the last stored book — do not fail the page on a venue timeout.
        const stale = await stalePromise;
        if (stale) return stale;
        const last = this.lastGood.get(canonicalId);
        if (last) return { ...last, cached: true };
        throw err;
      }
    }

    throw new Error(`Unsupported platform: ${market.platform}`);
  }

  /** Rebuild the API orderbook from public.kalshi_orderbook (yes/no bid ladders). */
  private async loadKalshiDbSnapshot(
    canonicalId: string,
    ticker: string
  ): Promise<Record<string, unknown> | null> {
    const { data, error } = await supabaseAdmin
      .from('kalshi_orderbook')
      .select('ticker, yes_bids, no_bids, last_snapshot, updated_at')
      .eq('ticker', ticker)
      .maybeSingle();
    if (error || !data) return null;

    const orderbook = {
      yes_bids: data.yes_bids ?? [],
      no_bids: data.no_bids ?? [],
    };
    const { yesBids, noBids } = extractKalshiYesNoBids(orderbook);
    const yesBook = kalshiToYesBook(yesBids, noBids);
    const timestamp = String(data.last_snapshot || data.updated_at || new Date().toISOString());

    return {
      canonical_id: canonicalId,
      platform: 'kalshi',
      orderbook,
      bids: yesBook.bids.map((l) => ({ price: l.price, size: l.qty })),
      asks: yesBook.asks.map((l) => ({ price: l.price, size: l.qty })),
      timestamp,
      cached: true,
    };
  }

  /** Rebuild CLOB-shaped bids/asks from public.polymarket_orderbook when live CLOB fails. */
  private async loadPolymarketDbSnapshot(
    canonicalId: string,
    market: { external_id?: string | null; raw_data?: Record<string, unknown> | null }
  ): Promise<Record<string, unknown> | null> {
    const marketId = resolvePolymarketOrderbookMarketId(market);
    if (!marketId) return null;

    const { data, error } = await supabaseAdmin
      .from('polymarket_orderbook')
      .select('yes_bids, no_bids, last_snapshot, updated_at')
      .eq('market_id', marketId)
      .maybeSingle();
    if (error || !data) return null;

    const yesBids = Array.isArray(data.yes_bids) ? data.yes_bids : [];
    const noBids = Array.isArray(data.no_bids) ? data.no_bids : [];
    const bids = yesBids.map((l: { price: number; qty: number }) => ({
      price: String(l.price),
      size: String(l.qty),
    }));
    const asks = noBids.map((l: { price: number; qty: number }) => ({
      price: String(1 - Number(l.price)),
      size: String(l.qty),
    }));
    const timestamp = String(data.last_snapshot || data.updated_at || new Date().toISOString());

    return {
      canonical_id: canonicalId,
      platform: 'polymarket',
      bids,
      asks,
      timestamp,
      cached: true,
    };
  }

  /**
   * Explicit async persist lifecycle: coalesce by key (latest-wins while
   * in-flight), always log failures, never mutate the in-memory API cache
   * on persist error.
   */
  private schedulePersist(key: string, work: () => Promise<void>): void {
    this.persistQueue.schedule(key, work, (k, err: any) => {
      console.error(
        `[OrderbookStore] persist failed key=${k}:`,
        err?.message ?? err
      );
    });
  }

  private async persistPolymarketSnapshot(input: {
    market: { external_id?: string | null; raw_data?: Record<string, unknown> | null };
    raw: Record<string, unknown>;
    yesTokenId: string;
    noTokenId: string | null;
    bids: unknown;
    asks: unknown;
    timestamp: string;
  }): Promise<void> {
    const marketId = resolvePolymarketOrderbookMarketId(input.market);
    if (!marketId) {
      console.warn(
        '[OrderbookStore] skip polymarket persist: no Gamma market id in raw_data.id / numeric external_id'
      );
      return;
    }

    const tokens = extractPolymarketTokenIds(input.raw);
    const row = buildPolymarketOrderbookRow({
      marketId,
      yesTokenId: input.yesTokenId || tokens.yesTokenId,
      noTokenId: input.noTokenId ?? tokens.noTokenId,
      bids: input.bids,
      asks: input.asks,
      nowIso: input.timestamp,
    });

    const fpKey = `polymarket_orderbook:${marketId}`;
    const fp = orderbookLadderFingerprint(row.yes_bids, row.no_bids);
    if (this.lastPersistedFingerprint.get(fpKey) === fp) {
      return;
    }

    // Await the real upsert (no Promise.race timeout). A non-cancelling timeout
    // previously let the queue start a newer write while an older upsert was
    // still running, allowing slow-old to overwrite fast-new.
    await writeLatestSnapshot({
      key: fpKey,
      snapshot: row,
      latestByKey: this.latestPolymarketRows,
      isSame: sameOrderbookRow,
      write: async (snapshot) => {
        const { error } = await supabaseAdmin.from('polymarket_orderbook').upsert(snapshot, {
          onConflict: 'market_id',
        });
        if (error) throw new Error(error.message);
      },
    });

    const finalRow = this.latestPolymarketRows.get(fpKey)!;
    this.lastPersistedFingerprint.set(
      fpKey,
      orderbookLadderFingerprint(finalRow.yes_bids, finalRow.no_bids)
    );
  }

  private async persistKalshiSnapshot(input: {
    ticker: string;
    orderbook: Record<string, unknown>;
    timestamp: string;
  }): Promise<void> {
    const row = buildKalshiOrderbookRow({
      ticker: input.ticker,
      orderbook: input.orderbook,
      nowIso: input.timestamp,
    });

    const fpKey = `kalshi_orderbook:${input.ticker}`;
    const fp = orderbookLadderFingerprint(row.yes_bids, row.no_bids);
    if (this.lastPersistedFingerprint.get(fpKey) === fp) {
      return;
    }

    await writeLatestSnapshot({
      key: fpKey,
      snapshot: row,
      latestByKey: this.latestKalshiRows,
      isSame: sameOrderbookRow,
      write: async (snapshot) => {
        const { error } = await supabaseAdmin.from('kalshi_orderbook').upsert(snapshot, {
          onConflict: 'ticker',
        });
        if (error) throw new Error(error.message);
      },
    });

    const finalRow = this.latestKalshiRows.get(fpKey)!;
    this.lastPersistedFingerprint.set(
      fpKey,
      orderbookLadderFingerprint(finalRow.yes_bids, finalRow.no_bids)
    );
  }
}

export const orderbookStore = new OrderbookStore();
