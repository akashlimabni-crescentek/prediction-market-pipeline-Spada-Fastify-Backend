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
  LatestWinsPersistQueue,
  orderbookLadderFingerprint,
  resolvePolymarketOrderbookMarketId,
  writeLatestSnapshot,
  type KalshiOrderbookRow,
  type PolymarketOrderbookRow,
} from '../lib/orderbookPersist.js';

/** Short in-memory cache — reduces venue load while FE polls (~5s). */
const ORDERBOOK_CACHE_TTL_MS = 2_500;

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

    const value = await this.fetchLiveOrderbook(canonicalId);
    this.cache.set(canonicalId, {
      expiresAt: Date.now() + ORDERBOOK_CACHE_TTL_MS,
      value,
    });
    return value;
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

      const res = await fetch(
        `https://clob.polymarket.com/book?token_id=${encodeURIComponent(String(tokenId))}`,
        { headers: { Accept: 'application/json' } }
      );
      if (!res.ok) {
        // Venue failure — do not treat as empty book or wipe stored snapshot.
        // 404 is ambiguous: stale token in markets.raw_data, closed/delisted
        // market, CLOB gap, or never-listed token — do not invent replacements.
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
    }

    if (market.platform === 'kalshi') {
      const ticker = market.external_id;
      if (!ticker) {
        throw new Error(`No Kalshi ticker for ${canonicalId}`);
      }

      // Signed GET /markets/{ticker}/orderbook (orderbook_fp shape)
      const data = await kalshiGet(`/markets/${encodeURIComponent(String(ticker))}/orderbook`);
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
    }

    throw new Error(`Unsupported platform: ${market.platform}`);
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
