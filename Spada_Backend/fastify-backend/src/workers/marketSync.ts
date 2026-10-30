import 'dotenv/config';
import { supabaseAdmin } from '../lib/supabase.js';
import { kalshiGetMarketsPaginated } from '../lib/kalshiClient.js';

/** Kalshi page size — API allows up to 1000; keep modest to avoid heavy payloads. */
const KALSHI_PAGE_LIMIT = 200;
/** Safety cap per sync cycle (200 × 25 = 5,000 markets). Cursor advances across cycles. */
const KALSHI_MAX_PAGES_PER_CYCLE = 25;

/** In-process cursor so hourly sync walks the full open Kalshi catalog over time. */
let kalshiMarketsCursor: string | null = null;

/** Polymarket page size (Gamma API keyset allows up to 100) */
const POLY_PAGE_LIMIT = 100;
/** Safety cap per sync cycle for binary markets (100 × 20 = up to 2,000 markets per cycle). */
const POLY_MAX_BINARY_PAGES_PER_CYCLE = 20;
/** Safety cap per sync cycle for multi-choice events (50 × 10 = up to 500 events per cycle). */
const POLY_MAX_EVENT_PAGES_PER_CYCLE = 10;

/** In-process cursors so hourly sync walks the full open Polymarket catalog over time. */
let polyMarketsCursor: string | null = null;
let polyEventsCursor: string | null = null;

interface StandardizedMarket {
  canonical_id: string;
  platform: 'polymarket' | 'kalshi';
  external_id: string;
  title: string;
  category: string;
  outcomes: string[];
  prices: number[];
  volume: number;
  active: boolean;
  raw_data: Record<string, any>;
  updated_at: string;
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

// Category Classifier: Prioritizes sports markers and college tech teams before technology
function classifyCategory(title: string): string {
  const t = title.toLowerCase();

  // 1. Sports: Prioritize sports markers, match halves, and college tech teams
  if (
    /\b(1st half|2nd half|wins 1st half|wins 2nd half|half-time|halftime|full-time|parlay|moneyline|over\/under|spread)\b/i.test(t) ||
    /\b(nfl|nba|mlb|nhl|fifa|ufc|f1|formula 1|premier league|champions league|super bowl|superbowl|touchdown|quarterback|ncaa|college football|college basketball|world cup|olympics|stanley cup|world series|pga tour|tennis|wimbledon|esports|league of legends|dota|csgo)\b/i.test(t) ||
    /(georgia|texas|virginia|louisiana)\s+tech/i.test(t)
  ) {
    return 'Sports';
  }

  // 2. Crypto
  if (/\b(bitcoin|btc|ethereum|eth|solana|sol|crypto|token|airdrop|binance|coinbase|defi|nft|memecoin|altcoin|blockchain)\b/i.test(t)) {
    return 'Crypto';
  }

  // 3. Politics
  if (/\b(trump|biden|harris|election|president|senate|congress|republican|democrat|white house|vote|governor|supreme court|gop|dnc|rnc|parliament|prime minister)\b/i.test(t)) {
    return 'Politics';
  }

  // 4. Technology: Specific tech companies & terms (avoids loose 'tech' capturing college sports)
  if (
    /\b(apple|openai|chatgpt|google|meta|nvidia|tesla|microsoft|software|hardware|robotics|spacex|semiconductor|artificial intelligence|deepseek|anthropic|claude|gemini|gpu|microchip|tech sector|big tech|technology)\b/i.test(t) ||
    /\bai\b/i.test(t)
  ) {
    return 'Technology';
  }

  // 5. Macro & Finance
  if (/\b(fed|rate cut|interest rate|inflation|cpi|recession|gdp|treasury|yield|nasdaq|sp500|dow|s&p|unemployment|central bank|jobs report)\b/i.test(t)) {
    return 'Macro & Finance';
  }

  return 'General';
}

function mapPolymarketBinaryMarket(m: any): StandardizedMarket | null {
  const extId = String(m.conditionId || m.id || m.slug || '').trim();
  if (!extId) return null;

  const outcomes = parseArrayField(m.outcomes);
  const outcomePrices = parseArrayField(m.outcomePrices);
  const clobTokenIds = parseArrayField(m.clobTokenIds);
  const question = m.question || m.title || 'Untitled Market';
  const slug = m.slug || m.event_slug || extId;

  return {
    canonical_id: `polymarket_${extId}`,
    platform: 'polymarket',
    external_id: extId,
    title: question,
    category: m.category || classifyCategory(question),
    outcomes: outcomes.length > 0 ? outcomes.map(String) : ['YES', 'NO'],
    prices: outcomePrices.length > 0 ? outcomePrices.map(Number) : [0.5, 0.5],
    volume: parseFloat(m.volume24hr || m.volume || 0),
    active: m.active ?? true,
    raw_data: {
      // Gamma numeric market id — keys public.polymarket_orderbook.market_id
      id: m.id != null ? m.id : null,
      clobTokenIds,
      slug,
      market_url: `https://polymarket.com/market/${slug}`,
      description: m.description || null,
      resolution_source: m.resolutionSource || m.resolution_source || null,
      end_date: m.endDate || m.end_date || m.endDateIso || null,
      conditionId: m.conditionId || null,
    },
    updated_at: new Date().toISOString(),
  };
}

function mapPolymarketEvent(e: any): StandardizedMarket | null {
  if (!Array.isArray(e.markets) || e.markets.length <= 2) return null;

  const extId = String(e.id || e.slug || '').trim();
  if (!extId) return null;

  const outcomes: string[] = [];
  const prices: number[] = [];
  const clobTokenIds: string[] = [];

  for (const subMarket of e.markets) {
    const label = subMarket.groupItemTitle || subMarket.question || 'Option';
    const priceArray = parseArrayField(subMarket.outcomePrices);
    const tokenArray = parseArrayField(subMarket.clobTokenIds);

    outcomes.push(label);
    prices.push(priceArray[0] ? Number(priceArray[0]) : 0);
    if (tokenArray[0]) clobTokenIds.push(tokenArray[0]);
  }

  return {
    canonical_id: `polymarket_event_${extId}`,
    platform: 'polymarket',
    external_id: extId,
    title: e.title || 'Multi-Choice Market',
    category: e.category || classifyCategory(e.title || ''),
    outcomes,
    prices,
    volume: parseFloat(e.volume24hr || e.volume || 0),
    active: e.active ?? true,
    raw_data: {
      clobTokenIds,
      slug: e.slug || extId,
      market_url: `https://polymarket.com/event/${e.slug || extId}`,
      description: e.description || null,
      end_date: e.endDate || e.end_date || null,
    },
    updated_at: new Date().toISOString(),
  };
}

/**
 * Fetch Polymarket binary markets using Gamma keyset cursor pagination.
 * Walks through pages of POLY_PAGE_LIMIT markets with safe delays between calls.
 */
async function fetchPolymarketBinary(): Promise<{ markets: StandardizedMarket[]; pagesFetched: number }> {
  const list: StandardizedMarket[] = [];
  let cursor: string | null = polyMarketsCursor;
  let pages = 0;

  while (pages < POLY_MAX_BINARY_PAGES_PER_CYCLE) {
    try {
      let url = `https://gamma-api.polymarket.com/markets/keyset?active=true&closed=false&limit=${POLY_PAGE_LIMIT}&order=volume24hr&ascending=false`;
      if (cursor) {
        url += `&after_cursor=${encodeURIComponent(cursor)}`;
      }

      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Accept': 'application/json',
        },
      });

      if (!res.ok) {
        console.warn(`[Sync Worker] Polymarket binary page ${pages + 1} response status ${res.status}`);
        break;
      }

      const body = await res.json();
      const rawMarkets = Array.isArray(body) ? body : (body?.markets ?? []);
      if (!Array.isArray(rawMarkets) || rawMarkets.length === 0) {
        cursor = null;
        break;
      }

      for (const m of rawMarkets) {
        const mapped = mapPolymarketBinaryMarket(m);
        if (mapped) list.push(mapped);
      }

      pages++;
      const nextCursor = body?.next_cursor;
      if (!nextCursor || nextCursor === 'LTE=' || nextCursor === cursor) {
        cursor = null;
        break;
      }
      cursor = nextCursor;

      await sleep(150); // Safe delay between pages to prevent rate limits
    } catch (err: any) {
      console.error(`[Sync Worker] Polymarket binary fetch error on page ${pages + 1}:`, err.message);
      break;
    }
  }

  polyMarketsCursor = cursor;
  return { markets: list, pagesFetched: pages };
}

/**
 * Fetch Polymarket multi-outcome events using Gamma keyset cursor pagination.
 */
async function fetchPolymarketEvents(): Promise<{ events: StandardizedMarket[]; pagesFetched: number }> {
  const list: StandardizedMarket[] = [];
  let cursor: string | null = polyEventsCursor;
  let pages = 0;

  while (pages < POLY_MAX_EVENT_PAGES_PER_CYCLE) {
    try {
      let url = `https://gamma-api.polymarket.com/events/keyset?active=true&closed=false&limit=50&order=volume24hr&ascending=false`;
      if (cursor) {
        url += `&after_cursor=${encodeURIComponent(cursor)}`;
      }

      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Accept': 'application/json',
        },
      });

      if (!res.ok) {
        console.warn(`[Sync Worker] Polymarket events page ${pages + 1} response status ${res.status}`);
        break;
      }

      const body = await res.json();
      const rawEvents = Array.isArray(body) ? body : (body?.events ?? []);
      if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
        cursor = null;
        break;
      }

      for (const e of rawEvents) {
        const mapped = mapPolymarketEvent(e);
        if (mapped) list.push(mapped);
      }

      pages++;
      const nextCursor = body?.next_cursor;
      if (!nextCursor || nextCursor === 'LTE=' || nextCursor === cursor) {
        cursor = null;
        break;
      }
      cursor = nextCursor;

      await sleep(150);
    } catch (err: any) {
      console.error(`[Sync Worker] Polymarket events fetch error on page ${pages + 1}:`, err.message);
      break;
    }
  }

  polyEventsCursor = cursor;
  return { events: list, pagesFetched: pages };
}

// 1. Fetch Polymarket (Binary markets and multi-outcome candidate events via cursor pagination)
async function fetchPolymarket(): Promise<{ markets: StandardizedMarket[]; binaryPages: number; eventPages: number }> {
  const [binaryRes, eventRes] = await Promise.all([
    fetchPolymarketBinary(),
    fetchPolymarketEvents(),
  ]);

  const combined = [...binaryRes.markets, ...eventRes.events];
  const byId = new Map<string, StandardizedMarket>();
  for (const m of combined) {
    byId.set(m.canonical_id, m);
  }

  return {
    markets: [...byId.values()],
    binaryPages: binaryRes.pagesFetched,
    eventPages: eventRes.pagesFetched,
  };
}

function parseKalshiMarketVolume(m: any): number {
  const volume = parseFloat(
    String(m.volume_24h_fp ?? m.volume_24h ?? m.volume_fp ?? m.volume ?? 0)
  );
  return Number.isFinite(volume) ? volume : 0;
}

function mapKalshiMarket(m: any): StandardizedMarket | null {
  const extId = String(m.ticker || m.ticker_name || m.id || '').trim();
  if (!extId) return null;

  // Prefer dollar fields (0–1). Legacy cent fields need /100.
  let yesPrice = 0;
  if (typeof m.last_price_dollars === 'number' || typeof m.last_price_dollars === 'string') {
    yesPrice = parseFloat(String(m.last_price_dollars));
  } else if (typeof m.yes_bid_dollars === 'number' || typeof m.yes_ask_dollars === 'number') {
    const bid = parseFloat(String(m.yes_bid_dollars ?? NaN));
    const ask = parseFloat(String(m.yes_ask_dollars ?? NaN));
    if (Number.isFinite(bid) && Number.isFinite(ask)) yesPrice = (bid + ask) / 2;
    else if (Number.isFinite(bid)) yesPrice = bid;
    else if (Number.isFinite(ask)) yesPrice = ask;
  } else if (typeof m.last_price === 'number' && m.last_price > 0) {
    yesPrice = m.last_price > 1 ? m.last_price / 100 : m.last_price;
  } else if (typeof m.yes_bid === 'number' && typeof m.yes_ask === 'number' && (m.yes_bid > 0 || m.yes_ask > 0)) {
    yesPrice = (m.yes_bid + m.yes_ask) / 2 / 100;
  }

  if (!Number.isFinite(yesPrice) || yesPrice < 0) yesPrice = 0;
  if (yesPrice > 1) yesPrice = yesPrice / 100;

  const title = m.title || m.ticker || 'Untitled Market';
  const resolvedCategory =
    m.category && m.category !== 'General' && !m.category.includes('CROSSCATEGORY')
      ? m.category
      : classifyCategory(title);

  const ticker = m.ticker || extId;
  const volume = parseKalshiMarketVolume(m);
  const eventTicker =
    typeof m.event_ticker === 'string' && m.event_ticker.trim()
      ? m.event_ticker.trim()
      : null;

  return {
    canonical_id: `kalshi_${extId}`,
    platform: 'kalshi',
    external_id: extId,
    title,
    category: resolvedCategory,
    outcomes: ['YES', 'NO'],
    prices: [yesPrice, parseFloat((1 - yesPrice).toFixed(4))],
    volume,
    active: m.status === 'open' || m.status === 'active',
    raw_data: {
      ticker,
      event_ticker: eventTicker,
      series_ticker: m.series_ticker || null,
      market_url: `https://kalshi.com/markets/${eventTicker || ticker}`,
      rules_primary: m.rules_primary || null,
      rules_secondary: m.rules_secondary || null,
      close_time: m.close_time || m.expiration_time || null,
      // Outcome / side labels — required for cross-platform matchText (divergence).
      yes_sub_title: typeof m.yes_sub_title === 'string' ? m.yes_sub_title : null,
      no_sub_title: typeof m.no_sub_title === 'string' ? m.no_sub_title : null,
      subtitle: typeof m.subtitle === 'string' ? m.subtitle : null,
    },
    updated_at: new Date().toISOString(),
  };
}

/**
 * Kalshi has no event-level volume field — only per-market volume_24h_fp / volume_24h.
 * Event volume = sum of independent market volumes sharing the same event_ticker.
 * Batch totals are merged with sibling markets already in DB (pagination-safe).
 */
async function attachKalshiEventVolumes(
  markets: StandardizedMarket[]
): Promise<StandardizedMarket[]> {
  if (markets.length === 0) return markets;

  const batchIdsByEvent = new Map<string, Set<string>>();
  const batchTotals = new Map<string, number>();

  for (const m of markets) {
    const et = m.raw_data?.event_ticker;
    if (typeof et !== 'string' || !et) continue;
    if (!batchIdsByEvent.has(et)) batchIdsByEvent.set(et, new Set());
    batchIdsByEvent.get(et)!.add(m.canonical_id);
    batchTotals.set(et, (batchTotals.get(et) ?? 0) + (Number.isFinite(m.volume) ? m.volume : 0));
  }

  const eventTotals = new Map(batchTotals);
  const eventTickers = [...batchTotals.keys()];

  try {
    for (const tickerChunk of chunkArray(eventTickers, 30)) {
      const { data, error } = await supabaseAdmin
        .from('markets')
        .select('canonical_id, volume, event_ticker:raw_data->>event_ticker')
        .eq('platform', 'kalshi')
        .eq('active', true)
        .filter('raw_data->>event_ticker', 'in', `(${tickerChunk.join(',')})`);

      if (error) {
        console.warn(
          '[Sync Worker] Kalshi event volume DB merge warning:',
          formatSupabaseError(error)
        );
        continue;
      }

      for (const row of data ?? []) {
        const et = row.event_ticker;
        if (typeof et !== 'string' || !et) continue;
        if (batchIdsByEvent.get(et)?.has(row.canonical_id)) continue;
        const siblingVol = Number(row.volume || 0);
        if (!Number.isFinite(siblingVol) || siblingVol <= 0) continue;
        eventTotals.set(et, (eventTotals.get(et) ?? 0) + siblingVol);
      }
    }
  } catch (err: any) {
    console.warn(
      '[Sync Worker] Kalshi event volume DB merge failed (using batch sums):',
      err?.message ?? err
    );
  }

  return markets.map((m) => {
    const et = m.raw_data?.event_ticker;
    const marketVol = Number.isFinite(m.volume) ? m.volume : 0;
    const eventVolume =
      typeof et === 'string' && et ? (eventTotals.get(et) ?? marketVol) : marketVol;

    return {
      ...m,
      raw_data: {
        ...m.raw_data,
        event_volume: eventVolume,
      },
    };
  });
}

/**
 * Fetch Kalshi open markets via cursor pagination (not a single limit=100 page).
 * Uses mve_filter=exclude so combinatorial MVE markets don't crowd out tradable markets.
 * Advances an in-process cursor each cycle so the full catalog is covered over time.
 */
async function fetchKalshi(): Promise<{ markets: StandardizedMarket[]; pagesFetched: number }> {
  try {
    const { markets, nextCursor, pagesFetched } = await kalshiGetMarketsPaginated({
      status: 'open',
      limit: KALSHI_PAGE_LIMIT,
      maxPages: KALSHI_MAX_PAGES_PER_CYCLE,
      mve_filter: 'exclude',
      cursor: kalshiMarketsCursor,
    });

    kalshiMarketsCursor = nextCursor;
    if (!nextCursor) {
      console.log(
        `[Sync Worker] Kalshi catalog pass complete (pages=${pagesFetched}, markets=${markets.length}). Cursor reset.`
      );
    } else {
      console.log(
        `[Sync Worker] Kalshi page batch fetched (pages=${pagesFetched}, markets=${markets.length}, cursor_pending=true)`
      );
    }

    if (markets.length === 0) return { markets: [], pagesFetched };

    // Dedupe by ticker within the batch (upsert on canonical_id also prevents DB duplicates)
    const byTicker = new Map<string, StandardizedMarket>();
    for (const m of markets) {
      const mapped = mapKalshiMarket(m);
      if (!mapped) continue;
      byTicker.set(mapped.external_id, mapped);
    }

    // Attach event-level volume (sum of market volumes sharing event_ticker)
    const withVolumes = await attachKalshiEventVolumes([...byTicker.values()]);
    return { markets: withVolumes, pagesFetched };
  } catch (err: any) {
    console.warn('[Sync Worker] Kalshi authenticated request failed:', err.message);
    return { markets: [], pagesFetched: 0 };
  }
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function formatSupabaseError(error: any): string {
  const raw = String(error?.message ?? error ?? 'unknown');
  if (raw.includes('<!DOCTYPE html') || raw.includes('Error code 520')) {
    return 'Supabase host temporarily unavailable (Cloudflare 520). Will retry next cycle.';
  }
  if (raw.includes('Error code 5')) {
    return `Supabase upstream error: ${raw.slice(0, 120)}`;
  }
  return raw.slice(0, 300);
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function upsertMarketsBatch(rows: StandardizedMarket[], attempt = 1): Promise<void> {
  const { error } = await supabaseAdmin
    .from('markets')
    .upsert(rows, { onConflict: 'canonical_id' });

  if (!error) return;

  const message = formatSupabaseError(error);
  const transient =
    message.includes('520') ||
    message.includes('temporarily unavailable') ||
    message.includes('upstream error') ||
    /5\d\d/.test(String(error?.code ?? ''));

  if (transient && attempt < 3) {
    const delay = attempt * 1500;
    console.warn(`[Sync Worker] upsert batch retry ${attempt}/3 after ${delay}ms: ${message}`);
    await sleep(delay);
    return upsertMarketsBatch(rows, attempt + 1);
  }

  throw new Error(message);
}

// 3. Upsert into Supabase (Preserves existing AI summaries)
async function saveMarkets(markets: StandardizedMarket[]): Promise<number> {
  if (markets.length === 0) return 0;

  const existingMap = new Map<
    string,
    { ai_summary: string | null; ai_sentiment_label: string | null; ai_last_updated: string | null }
  >();

  // Chunk .in() lookups — large ID lists + fat payloads trigger Cloudflare 520s
  for (const idChunk of chunkArray(
    markets.map((m) => m.canonical_id),
    50
  )) {
    const { data: existing, error } = await supabaseAdmin
      .from('markets')
      .select('canonical_id, ai_summary, ai_sentiment_label, ai_last_updated')
      .in('canonical_id', idChunk);

    if (error) {
      console.warn('[Sync Worker] AI summary lookup warning:', formatSupabaseError(error));
      continue;
    }
    for (const row of existing ?? []) {
      existingMap.set(row.canonical_id, row);
    }
  }

  const mergedMarkets = markets.map((m) => {
    const prev = existingMap.get(m.canonical_id);
    return {
      ...m,
      ai_summary: prev?.ai_summary || null,
      ai_sentiment_label: prev?.ai_sentiment_label || null,
      ai_last_updated: prev?.ai_last_updated || null,
    };
  });

  let written = 0;
  for (const batch of chunkArray(mergedMarkets, 25)) {
    try {
      await upsertMarketsBatch(batch);
      written += batch.length;
    } catch (err: any) {
      console.error('[Sync Worker] Supabase Upsert Error:', formatSupabaseError(err));
    }
    await sleep(100);
  }

  return written;
}

let isSyncRunning = false;

export async function runMarketSync(): Promise<void> {
  if (isSyncRunning) {
    console.warn('[Sync Worker] A market sync cycle is already in progress. Skipping duplicate execution.');
    return;
  }
  isSyncRunning = true;

  const startTime = Date.now();
  const startTimeIso = new Date().toISOString();
  console.log(`\n================================================================================`);
  console.log(`[Sync Worker] [${startTimeIso}] Starting hourly market sync worker...`);
  console.log(`================================================================================`);

  try {
    const [polyRes, kalshiRes] = await Promise.all([
      fetchPolymarket(),
      fetchKalshi(),
    ]);

    const polyMarkets = polyRes.markets;
    const kalshiMarkets = kalshiRes.markets;
    const allMarkets = [...polyMarkets, ...kalshiMarkets];

    console.log(
      `[Sync Worker] Polymarket fetched: ${polyMarkets.length} markets ` +
      `(Binary pages: ${polyRes.binaryPages}, Event pages: ${polyRes.eventPages}, ` +
      `Cursor: ${polyMarketsCursor ? 'pending next cycle' : 'pass complete'})`
    );
    console.log(
      `[Sync Worker] Kalshi fetched: ${kalshiMarkets.length} markets ` +
      `(Pages: ${kalshiRes.pagesFetched}, Cursor: ${kalshiMarketsCursor ? 'pending next cycle' : 'pass complete'})`
    );
    console.log(`[Sync Worker] Total markets collected this cycle: ${allMarkets.length}. Saving to Supabase...`);

    const written = await saveMarkets(allMarkets);

    const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
    const nextRun = new Date(Date.now() + 60 * 60 * 1000);
    const nextRunTimeStr = nextRun.toLocaleTimeString('en-US', { hour12: true });

    console.log(`================================================================================`);
    console.log(`[Sync Worker] [${new Date().toISOString()}] Hourly sync completed successfully in ${durationSec}s:`);
    console.log(`  ✓ Total markets processed: ${allMarkets.length}`);
    console.log(`  ✓ Polymarket markets: ${polyMarkets.length}`);
    console.log(`  ✓ Kalshi markets: ${kalshiMarkets.length}`);
    console.log(`  ✓ Stored into Supabase: ${written}/${allMarkets.length}`);
    console.log(`  ✓ Next scheduled run: in 1 hour (around ${nextRunTimeStr})`);
    console.log(`================================================================================\n`);
  } catch (err: any) {
    console.error(`[Sync Worker] Fatal error in market sync worker:`, err?.message ?? err);
  } finally {
    isSyncRunning = false;
  }
}

if (process.argv[1]?.endsWith('marketSync.ts')) {
  runMarketSync()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}