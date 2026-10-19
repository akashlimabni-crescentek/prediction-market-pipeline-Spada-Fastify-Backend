import type { FastifyInstance } from 'fastify';
import { supabaseAdmin } from '../lib/supabase.js';
import { orderbookStore } from '../services/orderbookStore.js';
import {
  candleAggregator,
  CANDLE_RESOLUTIONS,
  isCandleResolution,
  type CandleResolution,
} from '../services/candleAggregator.js';

function parseArrayField(val: any): any[] {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return [];
    }
  }
  return [];
}

function extractMarketRules(platform: string, raw: Record<string, any>): string | null {
  if (platform === 'polymarket') {
    return raw.description || raw.rules || null;
  }
  if (platform === 'kalshi') {
    const rules = [raw.rules_primary, raw.rules_secondary].filter(Boolean);
    return rules.length > 0 ? rules.join('\n\n') : raw.description || null;
  }
  return raw.description || null;
}

function extractResolutionSource(platform: string, raw: Record<string, any>): string | null {
  if (platform === 'polymarket') {
    return raw.resolutionSource || raw.resolution_source || null;
  }
  if (platform === 'kalshi') {
    if (Array.isArray(raw.settlement_sources) && raw.settlement_sources.length > 0) {
      const source = raw.settlement_sources[0];
      return typeof source === 'string' ? source : source.url || source.name || null;
    }
    return raw.resolution_source || null;
  }
  return null;
}

function extractEndingTime(platform: string, raw: Record<string, any>): string | null {
  if (platform === 'polymarket') {
    const date = raw.endDate || raw.end_date || raw.endDateIso || raw.close_time;
    return date ? new Date(date).toISOString() : null;
  }
  if (platform === 'kalshi') {
    const date = raw.close_time || raw.expiration_time || raw.end_date;
    return date ? new Date(date).toISOString() : null;
  }
  return null;
}

function extractMarketUrl(platform: string, externalId: string, raw: Record<string, any>): string {
  if (raw.market_url) return raw.market_url;
  if (platform === 'polymarket') {
    const slug = raw.slug || externalId;
    return `https://polymarket.com/event/${slug}`;
  }
  if (platform === 'kalshi') {
    const ticker = raw.ticker || externalId;
    return `https://kalshi.com/markets/${raw.event_ticker || ticker}`;
  }
  return '';
}

function formatMarket(m: any) {
  const raw = m.raw_data ?? {};

  const rawOutcomes = parseArrayField(m.outcomes).length > 0
    ? parseArrayField(m.outcomes)
    : parseArrayField(raw.outcomes);

  const outcomes: string[] = rawOutcomes.length > 0 ? rawOutcomes.map(String) : ['YES', 'NO'];

  const rawPrices = parseArrayField(m.prices).length > 0
    ? parseArrayField(m.prices)
    : parseArrayField(raw.outcomePrices);

  const prices: number[] = rawPrices.length > 0
    ? rawPrices.map((p: any) => Number(p || 0))
    : [0.5, 0.5];

  const outcomeType: 'binary' | 'multi' = outcomes.length > 2 ? 'multi' : 'binary';

  const outcomePrices = outcomes.map((name, idx) => {
    let price = prices[idx];
    if (price === undefined) {
      price = outcomeType === 'binary' && idx === 1 ? Number((1 - (prices[0] ?? 0.5)).toFixed(4)) : 0;
    }
    return {
      name,
      price: Number(price.toFixed(4)),
      percentage: Math.round(price * 100),
    };
  });

  const yesPrice = prices[0] ?? 0.5;
  const noPrice = prices[1] ?? Number((1 - yesPrice).toFixed(4));
  const endingTime = extractEndingTime(m.platform, raw);
  const marketUrl = extractMarketUrl(m.platform, m.external_id, raw);

  // Market volume (unchanged). Event volume: Kalshi stores sum-by-event_ticker in raw_data;
  // Polymarket binary + polymarket_event_* fall back to markets.volume (event volume for multi rows).
  const marketVolume = Number(m.volume || 0);
  const eventVolumeRaw = Number(raw.event_volume);
  const eventVolume = Number.isFinite(eventVolumeRaw) ? eventVolumeRaw : marketVolume;
  const eventTicker =
    typeof raw.event_ticker === 'string' && raw.event_ticker.trim()
      ? raw.event_ticker.trim()
      : null;

  // Dynamic fallback so the UI never displays an empty AI summary card
  const fallbackSummary = `Market probability currently stands at ${Math.round(yesPrice * 100)}%. Trading volume is at $${Math.round(marketVolume).toLocaleString()}.`;
  const fallbackSentiment = yesPrice > 0.55 ? 'Bullish' : yesPrice < 0.45 ? 'Bearish' : 'Neutral';

  return {
    canonical_id: m.canonical_id,
    platform: m.platform,
    platform_id: m.external_id,
    title: m.title,
    category: m.category || 'General',
    market_url: marketUrl,
    outcome_type: outcomeType,
    outcomes,
    outcome_prices: outcomePrices,
    prices,
    yes_price: yesPrice,
    no_price: noPrice,
    implied_probability: yesPrice,
    volume: marketVolume,
    event_volume: eventVolume,
    event_ticker: eventTicker,
    is_active: m.active,
    end_date: endingTime,
    close_time: endingTime,
    rules: extractMarketRules(m.platform, raw),
    resolution_source: extractResolutionSource(m.platform, raw),
    context: raw.subtitle || raw.groupItemTitle || null,
    ai_summary: m.ai_summary || fallbackSummary,
    ai_sentiment_label: m.ai_sentiment_label || fallbackSentiment,
    ai_last_updated: m.ai_last_updated || m.updated_at,
    updated_at: m.updated_at,
  };
}

function resolvePlatformParam(query: Record<string, any>): string | null {
  const raw = (query.platform || query.market || query.exchange || query.source || '').toString().toLowerCase().trim();
  if (raw.includes('kalsh')) return 'kalshi';
  if (raw.includes('poly')) return 'polymarket';
  return null;
}

/**
 * Resolve Kalshi event_volume at read time:
 * sum of active market volumes sharing raw_data.event_ticker.
 * Prefer row volumes from `rows` when present (fresher than sibling DB rows).
 * Polymarket rows are unchanged (formatMarket falls back to markets.volume).
 */
async function withKalshiEventVolumes(rows: any[]): Promise<any[]> {
  if (!rows.length) return rows;

  const eventTickers = new Set<string>();
  for (const m of rows) {
    if (m.platform !== 'kalshi') continue;
    const et = m.raw_data?.event_ticker;
    if (typeof et === 'string' && et.trim()) eventTickers.add(et.trim());
  }
  if (eventTickers.size === 0) return rows;

  const rowById = new Map(rows.map((m) => [m.canonical_id, m]));
  const totals = new Map<string, number>();
  const tickers = [...eventTickers];

  for (let i = 0; i < tickers.length; i += 30) {
    const chunk = tickers.slice(i, i + 30);
    try {
      const { data, error } = await supabaseAdmin
        .from('markets')
        .select('canonical_id, volume, raw_data')
        .eq('platform', 'kalshi')
        .eq('active', true)
        .filter('raw_data->>event_ticker', 'in', `(${chunk.join(',')})`);

      if (error) {
        console.warn('[markets] Kalshi event volume lookup:', error.message);
        continue;
      }

      for (const row of data ?? []) {
        const et = row.raw_data?.event_ticker;
        if (typeof et !== 'string' || !et) continue;
        const live = rowById.get(row.canonical_id);
        const vol = Number((live ?? row).volume || 0);
        if (!Number.isFinite(vol)) continue;
        totals.set(et, (totals.get(et) ?? 0) + vol);
      }
    } catch (err: any) {
      console.warn('[markets] Kalshi event volume lookup failed:', err?.message ?? err);
    }
  }

  return rows.map((m) => {
    if (m.platform !== 'kalshi') return m;
    const et = m.raw_data?.event_ticker;
    const marketVol = Number(m.volume || 0);
    if (typeof et !== 'string' || !et.trim()) {
      return { ...m, raw_data: { ...(m.raw_data ?? {}), event_volume: marketVol } };
    }
    const fromTotals = totals.get(et.trim());
    const stored = Number(m.raw_data?.event_volume);
    const eventVolume =
      fromTotals != null
        ? fromTotals
        : Number.isFinite(stored)
          ? stored
          : marketVol;
    return {
      ...m,
      raw_data: {
        ...(m.raw_data ?? {}),
        event_volume: eventVolume,
      },
    };
  });
}

export async function marketRoutes(fastify: FastifyInstance) {
  // 1. GET /api/v1/markets/metrics
  fastify.get('/api/v1/markets/metrics', async (_request, reply) => {
    const { data: markets, error } = await supabaseAdmin
      .from('markets')
      .select('platform, volume, active')
      .eq('active', true);

    if (error) return reply.status(500).send({ error: error.message });

    const all = markets ?? [];
    let polymarketCount = 0;
    let kalshiCount = 0;
    let totalVolume = 0;

    for (const m of all) {
      if (m.platform === 'polymarket') polymarketCount++;
      if (m.platform === 'kalshi') kalshiCount++;
      totalVolume += Number(m.volume || 0);
    }

    return reply.status(200).send({
      metrics: {
        total_active_markets: all.length,
        polymarket_active_count: polymarketCount,
        // 24h deltas need historical snapshots — never invent percentages.
        polymarket_trend: null,
        polymarket_change_24h: null,
        kalshi_active_count: kalshiCount,
        kalshi_trend: null,
        kalshi_change_24h: null,
        total_volume_usd: Math.round(totalVolume),
        volume_trend: null,
        volume_change_24h: null,
        last_updated: new Date().toISOString(),
      },
    });
  });

  // 2. GET /api/v1/markets/movers
  fastify.get('/api/v1/markets/movers', async (request, reply) => {
    const query = request.query as Record<string, any>;
    const platform = resolvePlatformParam(query);
    const category = query.category;
    const limit = parseInt(query.limit || '5', 10);

    let dbQuery = supabaseAdmin
      .from('markets')
      .select('canonical_id, platform, external_id, title, category, outcomes, prices, volume, active, raw_data, ai_summary, ai_sentiment_label, ai_last_updated, updated_at')
      .eq('active', true)
      .order('volume', { ascending: false });

    if (platform) dbQuery = dbQuery.eq('platform', platform);
    if (category) dbQuery = dbQuery.ilike('category', `%${category.trim()}%`);

    const { data, error } = await dbQuery.limit(limit);
    if (error) return reply.status(500).send({ error: error.message });

    const enriched = await withKalshiEventVolumes(data ?? []);
    return reply.status(200).send({ movers: enriched.map(formatMarket) });
  });

  // 3. GET /api/v1/markets/ending-soon
  fastify.get('/api/v1/markets/ending-soon', async (request, reply) => {
    const query = request.query as Record<string, any>;
    const platform = resolvePlatformParam(query);
    const category = query.category;
    const limit = parseInt(query.limit || '5', 10);

    let dbQuery = supabaseAdmin
      .from('markets')
      .select('canonical_id, platform, external_id, title, category, outcomes, prices, volume, active, raw_data, ai_summary, ai_sentiment_label, ai_last_updated, updated_at')
      .eq('active', true);

    if (platform) dbQuery = dbQuery.eq('platform', platform);
    if (category) dbQuery = dbQuery.ilike('category', `%${category.trim()}%`);

    const { data, error } = await dbQuery;
    if (error) return reply.status(500).send({ error: error.message });

    const now = Date.now();
    const enriched = await withKalshiEventVolumes(data ?? []);
    const endingSoon = enriched
      .map(formatMarket)
      .filter((m) => m.end_date && new Date(m.end_date).getTime() > now)
      .sort((a, b) => new Date(a.end_date!).getTime() - new Date(b.end_date!).getTime())
      .slice(0, limit);

    return reply.status(200).send({ ending_soon: endingSoon });
  });

  // 4. GET /api/v1/markets/dashboard-overview
  fastify.get('/api/v1/markets/dashboard-overview', async (request, reply) => {
    const query = request.query as Record<string, any>;
    const platform = resolvePlatformParam(query);
    const category = query.category;

    let dbQuery = supabaseAdmin
      .from('markets')
      .select('canonical_id, platform, external_id, title, category, outcomes, prices, volume, active, raw_data, ai_summary, ai_sentiment_label, ai_last_updated, updated_at')
      .eq('active', true);

    if (platform) dbQuery = dbQuery.eq('platform', platform);
    if (category) dbQuery = dbQuery.ilike('category', `%${category.trim()}%`);

    const { data, error } = await dbQuery;
    if (error) return reply.status(500).send({ error: error.message });

    const enriched = await withKalshiEventVolumes(data ?? []);
    const allFormatted = enriched.map(formatMarket);
    const now = Date.now();

    let polymarketCount = 0;
    let kalshiCount = 0;
    let totalVolume = 0;

    for (const m of allFormatted) {
      if (m.platform === 'polymarket') polymarketCount++;
      if (m.platform === 'kalshi') kalshiCount++;
      totalVolume += m.volume;
    }

    return reply.status(200).send({
      metrics: {
        total_active_markets: allFormatted.length,
        polymarket_active_count: polymarketCount,
        // 24h deltas need historical snapshots — never invent percentages.
        polymarket_trend: null,
        polymarket_change_24h: null,
        kalshi_active_count: kalshiCount,
        kalshi_trend: null,
        kalshi_change_24h: null,
        total_volume_usd: Math.round(totalVolume),
        volume_trend: null,
        volume_change_24h: null,
        last_updated: new Date().toISOString(),
      },
      movers: [...allFormatted].sort((a, b) => b.volume - a.volume).slice(0, 5),
      ending_soon: [...allFormatted].filter((m) => m.end_date && new Date(m.end_date).getTime() > now).sort((a, b) => new Date(a.end_date!).getTime() - new Date(b.end_date!).getTime()).slice(0, 5),
    });
  });

  // 5. GET /api/v1/markets
  fastify.get('/api/v1/markets', async (request, reply) => {
    const query = request.query as Record<string, any>;
    const platform = resolvePlatformParam(query);
    const category = query.category;
    const limit = parseInt(query.limit || '20', 10);
    const offset = parseInt(query.offset || '0', 10);

    let dbQuery = supabaseAdmin
      .from('markets')
      .select('canonical_id, platform, external_id, title, category, outcomes, prices, volume, active, raw_data, ai_summary, ai_sentiment_label, ai_last_updated, updated_at')
      .eq('active', true)
      .order('updated_at', { ascending: false });

    if (platform) dbQuery = dbQuery.eq('platform', platform);
    if (category) dbQuery = dbQuery.ilike('category', `%${category.trim()}%`);

    const { data, error } = await dbQuery.range(offset, offset + limit - 1);
    if (error) return reply.status(500).send({ error: error.message });

    const enriched = await withKalshiEventVolumes(data ?? []);
    return reply.status(200).send({ markets: enriched.map(formatMarket) });
  });

  // 6. GET /api/v1/markets/:id
  fastify.get('/api/v1/markets/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const { data, error } = await supabaseAdmin
      .from('markets')
      .select('canonical_id, platform, external_id, title, category, outcomes, prices, volume, active, raw_data, ai_summary, ai_sentiment_label, ai_last_updated, updated_at')
      .eq('canonical_id', id)
      .single();

    if (error || !data) return reply.status(404).send({ error: 'Market not found' });

    const [enriched] = await withKalshiEventVolumes([data]);
    return reply.status(200).send({ market: formatMarket(enriched) });
  });

  // 7. GET /api/v1/markets/:id/orderbook
  fastify.get('/api/v1/markets/:id/orderbook', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const book = await orderbookStore.getOrderbook(id);
      return reply.status(200).send(book);
    } catch (err: any) {
      return reply.status(404).send({ error: err.message });
    }
  });

  // 8. GET /api/v1/markets/:id/candles?resolution=5m|15m|1h|4h|1d|1w
  // Unknown market → 404 (same as GET /markets/:id). Known market with no
  // history → 200 + { candles: [] }.
  fastify.get('/api/v1/markets/:id/candles', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { resolution?: string };
    const resolutionParam = query.resolution ?? '1h';

    if (!isCandleResolution(resolutionParam)) {
      return reply.status(400).send({
        error: `Unsupported resolution "${resolutionParam}". Allowed: ${CANDLE_RESOLUTIONS.join(', ')}`,
      });
    }

    const { data: marketRow, error: marketError } = await supabaseAdmin
      .from('markets')
      .select('canonical_id')
      .eq('canonical_id', id)
      .maybeSingle();

    if (marketError || !marketRow) {
      return reply.status(404).send({ error: 'Market not found' });
    }

    try {
      const candles = await candleAggregator.getCandles(id, resolutionParam as CandleResolution);
      // Honest empty history: known market with no bars → 200 + []. Never invent OHLCV.
      return reply.status(200).send({ candles });
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });
}