import 'dotenv/config';
import { supabaseAdmin } from '../lib/supabase.js';

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

// 1. Fetch Polymarket (Binary markets and multi-outcome candidate events)
async function fetchPolymarket(): Promise<StandardizedMarket[]> {
  const results: StandardizedMarket[] = [];

  // A. Fetch high-volume binary markets
  try {
    const url = 'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=70&order=volume24hr&ascending=false';
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
    });

    if (res.ok) {
      const markets = await res.json();
      if (Array.isArray(markets)) {
        for (const m of markets) {
          const extId = String(m.conditionId || m.id || m.slug || '').trim();
          if (!extId) continue;

          const outcomes = parseArrayField(m.outcomes);
          const outcomePrices = parseArrayField(m.outcomePrices);
          const clobTokenIds = parseArrayField(m.clobTokenIds);
          const question = m.question || m.title || 'Untitled Market';
          const slug = m.slug || m.event_slug || extId;

          results.push({
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
              ...m,
              clobTokenIds,
              slug,
              market_url: `https://polymarket.com/market/${slug}`,
              description: m.description || null,
              resolution_source: m.resolutionSource || m.resolution_source || null,
              end_date: m.endDate || m.end_date || m.endDateIso || null,
            },
            updated_at: new Date().toISOString(),
          });
        }
      }
    }
  } catch (err: any) {
    console.error('[Sync Worker] Polymarket binary fetch error:', err.message);
  }

  // B. Fetch multi-outcome events (3, 4, 5+ choices)
  try {
    const eventsUrl = 'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=30&order=volume24hr&ascending=false';
    const res = await fetch(eventsUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
    });

    if (res.ok) {
      const events = await res.json();
      if (Array.isArray(events)) {
        for (const e of events) {
          if (!Array.isArray(e.markets) || e.markets.length <= 2) continue;

          const extId = String(e.id || e.slug || '').trim();
          if (!extId) continue;

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

          results.push({
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
              ...e,
              clobTokenIds,
              slug: e.slug || extId,
              market_url: `https://polymarket.com/event/${e.slug || extId}`,
              description: e.description || null,
              end_date: e.endDate || e.end_date || null,
            },
            updated_at: new Date().toISOString(),
          });
        }
      }
    }
  } catch (err: any) {
    console.error('[Sync Worker] Polymarket multi-outcome fetch error:', err.message);
  }

  return results;
}

// 2. Fetch Kalshi (With browser User-Agent & election host fallback)
async function fetchKalshi(): Promise<StandardizedMarket[]> {
  const hosts = [
    'https://external-api.kalshi.com/trade-api/v2',
    'https://api.elections.kalshi.com/trade-api/v2',
  ];

  for (const host of hosts) {
    try {
      const url = `${host}/markets?limit=100&status=open`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Accept': 'application/json',
        },
      });

      if (!res.ok) {
        console.warn(`[Sync Worker] Kalshi host ${host} returned status: ${res.status}`);
        continue;
      }

      const data = await res.json();
      const markets = data.markets || [];

      if (markets.length === 0) continue;

      return markets
        .map((m: any): StandardizedMarket | null => {
          const extId = String(m.ticker || m.ticker_name || m.id || '').trim();
          if (!extId) return null;

          let yesPrice = 0;
          if (typeof m.last_price_dollars === 'number' || typeof m.last_price_dollars === 'string') {
            yesPrice = parseFloat(String(m.last_price_dollars));
          } else if (typeof m.last_price === 'number' && m.last_price > 0) {
            yesPrice = m.last_price / 100;
          } else if (typeof m.yes_bid === 'number' && typeof m.yes_ask === 'number' && (m.yes_bid > 0 || m.yes_ask > 0)) {
            yesPrice = (m.yes_bid + m.yes_ask) / 2 / 100;
          }

          const title = m.title || m.ticker || 'Untitled Market';
          const resolvedCategory =
            m.category && m.category !== 'General' && !m.category.includes('CROSSCATEGORY')
              ? m.category
              : classifyCategory(title);

          const ticker = m.ticker || extId;

          return {
            canonical_id: `kalshi_${extId}`,
            platform: 'kalshi',
            external_id: extId,
            title,
            category: resolvedCategory,
            outcomes: ['YES', 'NO'],
            prices: [yesPrice, parseFloat((1 - yesPrice).toFixed(4))],
            volume: parseFloat(m.volume_24h || m.volume || 0),
            active: m.status === 'open' || m.status === 'active',
            raw_data: {
              ...m,
              ticker,
              market_url: `https://kalshi.com/markets/${m.event_ticker || ticker}`,
              rules_primary: m.rules_primary || null,
              rules_secondary: m.rules_secondary || null,
              settlement_sources: m.settlement_sources || null,
              close_time: m.close_time || m.expiration_time || null,
            },
            updated_at: new Date().toISOString(),
          };
        })
        .filter((item: StandardizedMarket | null): item is StandardizedMarket => item !== null);
    } catch (err: any) {
      console.warn(`[Sync Worker] Kalshi request failed on ${host}:`, err.message);
    }
  }

  return [];
}

// 3. Upsert into Supabase (Preserves existing AI summaries)
async function saveMarkets(markets: StandardizedMarket[]) {
  if (markets.length === 0) return;

  // Retrieve existing AI summaries so upsert does not reset them to null
  const ids = markets.map((m) => m.canonical_id);
  const { data: existing } = await supabaseAdmin
    .from('markets')
    .select('canonical_id, ai_summary, ai_sentiment_label, ai_last_updated')
    .in('canonical_id', ids);

  const existingMap = new Map((existing ?? []).map((e) => [e.canonical_id, e]));

  const mergedMarkets = markets.map((m) => {
    const prev = existingMap.get(m.canonical_id);
    return {
      ...m,
      ai_summary: prev?.ai_summary || null,
      ai_sentiment_label: prev?.ai_sentiment_label || null,
      ai_last_updated: prev?.ai_last_updated || null,
    };
  });

  const { error } = await supabaseAdmin
    .from('markets')
    .upsert(mergedMarkets, { onConflict: 'canonical_id' });

  if (error) {
    console.error('[Sync Worker] Supabase Upsert Error:', error.message);
  } else {
    console.log(`[Sync Worker] Successfully synced ${markets.length} markets into Supabase.`);
  }
}

export async function runMarketSync() {
  console.log('[Sync Worker] Starting market data ingestion...');

  const [polyMarkets, kalshiMarkets] = await Promise.all([
    fetchPolymarket(),
    fetchKalshi(),
  ]);

  const allMarkets = [...polyMarkets, ...kalshiMarkets];
  await saveMarkets(allMarkets);
}

if (process.argv[1]?.endsWith('marketSync.ts')) {
  runMarketSync()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}