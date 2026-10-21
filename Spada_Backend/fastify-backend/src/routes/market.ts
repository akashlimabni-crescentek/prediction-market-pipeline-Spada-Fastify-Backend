import type { FastifyInstance } from 'fastify';
import { supabaseAdmin } from '../lib/supabase.js';
import { loadAndUpdateDashboardTrends } from '../lib/dashboardMetrics.js';
import { orderbookStore } from '../services/orderbookStore.js';
import {
  candleAggregator,
  CANDLE_RESOLUTIONS,
  isCandleResolution,
  type CandleResolution,
} from '../services/candleAggregator.js';

/** Chart outcome index. Missing means the primary series (unchanged). */
function parseOutcomeIndex(raw: string | undefined): number | null {
  if (raw == null || raw === '') return 0;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  // Events can list well over 64 outcomes (a college game book had 215).
  if (!Number.isInteger(n) || n < 0 || n > 1024) return null;
  return n;
}

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

const MARKET_CARD_COLUMNS = [
  'canonical_id',
  'platform',
  'external_id',
  'title',
  'category',
  'outcomes',
  'prices',
  'volume',
  'active',
  'ai_summary',
  'ai_sentiment_label',
  'ai_last_updated',
  'updated_at',
  'raw_end_date:raw_data->end_date',
  'raw_endDate:raw_data->endDate',
  'raw_endDateIso:raw_data->endDateIso',
  'raw_close_time:raw_data->close_time',
  'raw_expiration_time:raw_data->expiration_time',
  'raw_slug:raw_data->slug',
  'raw_market_url:raw_data->market_url',
  'raw_event_ticker:raw_data->event_ticker',
  'raw_event_volume:raw_data->event_volume',
  'raw_ticker:raw_data->ticker',
].join(', ');

function formatCardRow(row: any) {
  return formatMarket({
    ...row,
    raw_data: {
      end_date: row.raw_end_date ?? null,
      endDate: row.raw_endDate ?? null,
      endDateIso: row.raw_endDateIso ?? null,
      close_time: row.raw_close_time ?? null,
      expiration_time: row.raw_expiration_time ?? null,
      slug: row.raw_slug ?? null,
      market_url: row.raw_market_url ?? null,
      event_ticker: row.raw_event_ticker ?? null,
      event_volume: row.raw_event_volume ?? null,
      ticker: row.raw_ticker ?? null,
    },
  });
}

/** Date keys only. Ending-soon does not need AI text or the rest of raw_data. */
const ENDING_SOON_COLUMNS = [
  'canonical_id',
  'platform',
  'external_id',
  'title',
  'category',
  'outcomes',
  'prices',
  'volume',
  'active',
  'updated_at',
  'raw_end_date:raw_data->end_date',
  'raw_endDate:raw_data->endDate',
  'raw_endDateIso:raw_data->endDateIso',
  'raw_close_time:raw_data->close_time',
  'raw_expiration_time:raw_data->expiration_time',
].join(', ');

const DASHBOARD_CACHE_MS = 60_000;
const dashboardCache = new Map<string, { at: number; value: unknown }>();

function readDashboardCache<T>(key: string): T | null {
  const hit = dashboardCache.get(key);
  if (!hit || Date.now() - hit.at >= DASHBOARD_CACHE_MS) return null;
  return hit.value as T;
}

function writeDashboardCache(key: string, value: unknown) {
  dashboardCache.set(key, { at: Date.now(), value });
}

async function loadMetrics() {
  const cached = readDashboardCache<Record<string, unknown>>('metrics');
  if (cached) return cached;

  const { data: markets, error } = await supabaseAdmin
    .from('markets')
    .select('platform, volume')
    .eq('active', true);
  if (error) throw new Error(error.message);

  const all = markets ?? [];
  let polymarketCount = 0;
  let kalshiCount = 0;
  let totalVolume = 0;
  for (const m of all) {
    if (m.platform === 'polymarket') polymarketCount++;
    if (m.platform === 'kalshi') kalshiCount++;
    totalVolume += Number(m.volume || 0);
  }

  const totalVolumeUsd = Math.round(totalVolume);
  const trends = await loadAndUpdateDashboardTrends({
    polymarketActive: polymarketCount,
    kalshiActive: kalshiCount,
    totalVolumeUsd,
  });
  const metrics = {
    total_active_markets: all.length,
    polymarket_active_count: polymarketCount,
    polymarket_trend: trends.polymarket_trend,
    polymarket_change_24h: trends.polymarket_change_24h,
    kalshi_active_count: kalshiCount,
    kalshi_trend: trends.kalshi_trend,
    kalshi_change_24h: trends.kalshi_change_24h,
    total_volume_usd: totalVolumeUsd,
    volume_trend: trends.volume_trend,
    volume_change_24h: trends.volume_change_24h,
    last_updated: new Date().toISOString(),
  };
  writeDashboardCache('metrics', metrics);
  return metrics;
}

async function loadMovers(platform: string | null, category: string, limit: number) {
  const safeLimit = Math.min(Math.max(limit || 5, 1), 20);
  const cacheKey = `movers:${platform ?? ''}:${category}:${safeLimit}`;
  const cached = readDashboardCache<any[]>(cacheKey);
  if (cached) return cached;

  // Rank on the volume column only. Pulling card JSON into this sort reads
  // the large raw_data payload for the whole catalogue.
  let idQuery = supabaseAdmin
    .from('markets')
    .select('canonical_id')
    .eq('active', true)
    .order('volume', { ascending: false });
  if (platform) idQuery = idQuery.eq('platform', platform);
  if (category) idQuery = idQuery.ilike('category', `%${category}%`);

  const { data: idRows, error } = await idQuery.limit(safeLimit);
  if (error) throw new Error(error.message);

  const ids = (idRows ?? []).map((row) => String(row.canonical_id)).filter(Boolean);
  if (!ids.length) {
    writeDashboardCache(cacheKey, []);
    return [];
  }

  const { data, error: cardError } = await supabaseAdmin
    .from('markets')
    .select(MARKET_CARD_COLUMNS)
    .in('canonical_id', ids);
  if (cardError) throw new Error(cardError.message);

  const byId = new Map((data ?? []).map((row) => [String(row.canonical_id), formatCardRow(row)]));
  const movers = ids.map((id) => byId.get(id)).filter(Boolean);
  writeDashboardCache(cacheKey, movers);
  return movers;
}

async function loadEndingSoon(platform: string | null, category: string, limit: number) {
  const safeLimit = Math.min(Math.max(limit || 5, 1), 20);
  const cacheKey = `ending:${platform ?? ''}:${category}:${safeLimit}`;
  const cached = readDashboardCache<any[]>(cacheKey);
  if (cached) return cached;

  let dbQuery = supabaseAdmin.from('markets').select(ENDING_SOON_COLUMNS).eq('active', true);
  if (platform) dbQuery = dbQuery.eq('platform', platform);
  if (category) dbQuery = dbQuery.ilike('category', `%${category}%`);

  const { data, error } = await dbQuery;
  if (error) throw new Error(error.message);

  const now = Date.now();
  const endingSoon = (data ?? [])
    .map(formatCardRow)
    .filter((m) => m.end_date && new Date(m.end_date).getTime() > now)
    .sort((a, b) => new Date(a.end_date!).getTime() - new Date(b.end_date!).getTime())
    .slice(0, safeLimit);
  writeDashboardCache(cacheKey, endingSoon);
  return endingSoon;
}

export async function marketRoutes(fastify: FastifyInstance) {
  // 1. GET /api/v1/markets/metrics
  fastify.get('/api/v1/markets/metrics', async (_request, reply) => {
    try {
      const metrics = await loadMetrics();
      return reply.status(200).send({ metrics });
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // 2. GET /api/v1/markets/movers
  fastify.get('/api/v1/markets/movers', async (request, reply) => {
    const query = request.query as Record<string, any>;
    const platform = resolvePlatformParam(query);
    const category = typeof query.category === 'string' ? query.category.trim() : '';
    const limit = parseInt(query.limit || '5', 10);
    try {
      const movers = await loadMovers(platform, category, limit);
      return reply.status(200).send({ movers });
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // 3. GET /api/v1/markets/ending-soon
  fastify.get('/api/v1/markets/ending-soon', async (request, reply) => {
    const query = request.query as Record<string, any>;
    const platform = resolvePlatformParam(query);
    const category = typeof query.category === 'string' ? query.category.trim() : '';
    const limit = parseInt(query.limit || '5', 10);
    try {
      const endingSoon = await loadEndingSoon(platform, category, limit);
      return reply.status(200).send({ ending_soon: endingSoon });
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // 4. GET /api/v1/markets/dashboard-overview
  fastify.get('/api/v1/markets/dashboard-overview', async (request, reply) => {
    const query = request.query as Record<string, any>;
    const platform = resolvePlatformParam(query);
    const category = typeof query.category === 'string' ? query.category.trim() : '';
    try {
      const [metrics, movers, endingSoon] = await Promise.all([
        loadMetrics(),
        loadMovers(platform, category, 5),
        loadEndingSoon(platform, category, 5),
      ]);
      return reply.status(200).send({
        metrics,
        movers,
        ending_soon: endingSoon,
      });
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // 5. GET /api/v1/markets
  // Card fields only. Selecting raw_data and sorting it makes the database
  // cancel the statement, which returned 500 for this list.
  fastify.get('/api/v1/markets', async (request, reply) => {
    const query = request.query as Record<string, any>;
    const platform = resolvePlatformParam(query);
    const category = typeof query.category === 'string' ? query.category.trim() : '';
    const limit = Math.min(Math.max(parseInt(query.limit || '20', 10) || 20, 1), 100);
    const offset = Math.max(parseInt(query.offset || '0', 10) || 0, 0);
    const filtered = () => {
      let dbQuery = supabaseAdmin.from('markets').select(MARKET_CARD_COLUMNS).eq('active', true);
      if (platform) dbQuery = dbQuery.eq('platform', platform);
      if (category) dbQuery = dbQuery.ilike('category', `%${category}%`);
      return dbQuery;
    };

    // A full-table volume sort takes long enough that this request 500s.
    // Take the page, then sort that page.
    const { data, error } = await filtered().range(offset, offset + limit - 1);
    if (error) return reply.status(500).send({ error: error.message });

    const markets = (data ?? []).map(formatCardRow);
    markets.sort((a, b) => (b.volume || 0) - (a.volume || 0));
    return reply.status(200).send({ markets });
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

    // Event volume is already on the row from sync. A live sibling scan
    // selects raw_data and the database cancels it, which left this page
    // on "Loading..." until the statement timed out.
    return reply.status(200).send({ market: formatMarket(data) });
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
  // from+to → stored bars in that window only (no forming candle, no newest-N trim).
  // The chart uses that for finer blocks inside the open bucket.
  fastify.get('/api/v1/markets/:id/candles', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as {
      resolution?: string;
      from?: string;
      to?: string;
      outcome?: string;
    };
    const resolutionParam = query.resolution ?? '1h';
    const outcomeIndex = parseOutcomeIndex(query.outcome);
    if (outcomeIndex == null) {
      return reply.status(400).send({ error: 'outcome must be a whole number from 0 to 1024' });
    }

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

    const hasFrom = query.from != null && query.from !== '';
    const hasTo = query.to != null && query.to !== '';
    if (hasFrom !== hasTo) {
      return reply.status(400).send({ error: 'from and to must be sent together' });
    }

    try {
      if (hasFrom && hasTo) {
        const fromMs = Date.parse(String(query.from));
        const toMs = Date.parse(String(query.to));
        if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
          return reply.status(400).send({ error: 'from and to must be valid timestamps' });
        }
        const maxWindowMs = 14 * 24 * 60 * 60 * 1000;
        if (toMs - fromMs > maxWindowMs) {
          return reply.status(400).send({ error: 'from/to window cannot exceed 14 days' });
        }
        const candles = await candleAggregator.getCandlesSince(
          id,
          resolutionParam as CandleResolution,
          fromMs,
          toMs,
          outcomeIndex
        );
        return reply.status(200).send({ candles });
      }

      const candles = await candleAggregator.getCandles(
        id,
        resolutionParam as CandleResolution,
        outcomeIndex
      );
      // Honest empty history: known market with no bars → 200 + []. Never invent OHLCV.
      return reply.status(200).send({ candles });
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });
}