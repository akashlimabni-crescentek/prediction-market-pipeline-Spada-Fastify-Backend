import { supabaseAdmin } from '../lib/supabase.js';

class OrderbookStore {
  async init() {
    console.log('[OrderbookStore] Initialized successfully');
    return true;
  }

  // Fetch live orderbook directly using canonical_id (e.g. polymarket_0x... or kalshi_KX...)
  async getOrderbook(canonicalId: string) {
    const { data: market, error } = await supabaseAdmin
      .from('markets')
      .select('canonical_id, platform, external_id, raw_data')
      .eq('canonical_id', canonicalId)
      .single();

    if (error || !market) {
      throw new Error(`Market not found: ${canonicalId}`);
    }

    if (market.platform === 'polymarket') {
      const raw = market.raw_data ?? {};
      const tokenId =
        raw.clobTokenIds?.[0] ||
        raw.tokens?.[0]?.token_id ||
        raw.tokens?.[0]?.clobTokenId;

      if (!tokenId) {
        throw new Error(`No CLOB token ID found for ${canonicalId}`);
      }

      const res = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
      if (!res.ok) {
        throw new Error(`Polymarket CLOB error: ${res.status}`);
      }

      const book = await res.json();
      return {
        canonical_id: canonicalId,
        platform: 'polymarket',
        bids: book.bids || [],
        asks: book.asks || [],
        timestamp: new Date().toISOString(),
      };
    }

    if (market.platform === 'kalshi') {
      const ticker = market.external_id;
      const res = await fetch(
        `https://external-api.kalshi.com/trade-api/v2/markets/${ticker}/orderbook`
      );
      if (!res.ok) {
        throw new Error(`Kalshi orderbook error: ${res.status}`);
      }

      const data = await res.json();
      return {
        canonical_id: canonicalId,
        platform: 'kalshi',
        orderbook: data.orderbook || {},
        timestamp: new Date().toISOString(),
      };
    }

    throw new Error(`Unsupported platform: ${market.platform}`);
  }
}

export const orderbookStore = new OrderbookStore();