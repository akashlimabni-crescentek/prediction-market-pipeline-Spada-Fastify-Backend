import 'dotenv/config';
import { supabaseAdmin } from '../lib/supabase.js';

interface NewsArticle {
  title: string;
  source: string;
  url: string;
  image_url: string | null;
  published_at: string;
}

interface ProcessedNews {
  canonical_id: string;
  title: string;
  source: string;
  url: string;
  image_url: string | null;
  sentiment_score: number;
  published_at: string;
}

const STOP_WORDS = new Set([
  'will', 'that', 'this', 'with', 'from', 'have', 'more', 'than',
  'down', 'over', 'under', 'game', 'price', 'market', 'about',
  'what', 'when', 'where', 'which', 'their', 'there', 'would',
  'could', 'should', 'total', 'kills', 'first', 'second', 'round',
  'september', 'october', 'november', 'december', 'january', 'february'
]);

function calculateSentiment(title: string): number {
  const lower = title.toLowerCase();
  const positive = ['bullish', 'surge', 'soar', 'win', 'lead', 'gain', 'approve', 'pass', 'up', 'ath', 'rally'];
  const negative = ['bearish', 'drop', 'fall', 'lose', 'ban', 'deny', 'reject', 'crash', 'collapse', 'plunge'];

  let score = 0;
  positive.forEach((word: string) => { if (lower.includes(word)) score += 0.25; });
  negative.forEach((word: string) => { if (lower.includes(word)) score -= 0.25; });

  return Math.max(-1, Math.min(1, parseFloat(score.toFixed(2))));
}

// Extract image URL from raw item or embedded HTML description
function extractImage(item: any): string | null {
  if (item.thumbnail && typeof item.thumbnail === 'string' && item.thumbnail.startsWith('http')) {
    return item.thumbnail;
  }
  if (item.enclosure?.link && typeof item.enclosure.link === 'string') {
    return item.enclosure.link;
  }
  if (typeof item.description === 'string') {
    const match = item.description.match(/<img[^>]+src=["']([^"']+)["']/);
    if (match?.[1]) return match[1];
  }
  return null;
}

async function fetchLatestNews(): Promise<NewsArticle[]> {
  const apiKey = process.env.CRYPTOCOMPARE_API_KEY;

  if (apiKey) {
    try {
      console.log('[News Worker] Fetching news from CryptoCompare API...');
      const res = await fetch(`https://min-api.cryptocompare.com/data/v2/news/?lang=EN&api_key=${apiKey}`);
      if (res.ok) {
        const payload = await res.json();
        const articles = payload.Data || [];
        return articles.map((a: any) => ({
          title: a.title,
          source: a.source || 'CryptoCompare',
          url: a.url,
          image_url: a.imageurl || null,
          published_at: new Date(a.published_on * 1000).toISOString(),
        }));
      }
    } catch (err: any) {
      console.warn('[News Worker] CryptoCompare failed, using RSS:', err.message);
    }
  }

  console.log('[News Worker] Fetching news from open market news feeds...');

  const feeds = [
    { name: 'CoinTelegraph', url: 'https://cointelegraph.com/rss' },
    { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
    { name: 'Decrypt', url: 'https://decrypt.co/feed' },
  ];

  try {
    const results = await Promise.all(
      feeds.map(async (feed) => {
        try {
          const endpoint = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(feed.url)}`;
          const res = await fetch(endpoint);
          if (!res.ok) return [];

          const data = await res.json();
          const items = data.items || [];

          return items.map((item: any) => ({
            title: item.title,
            source: feed.name,
            url: item.link,
            image_url: extractImage(item),
            published_at: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
          }));
        } catch {
          return [];
        }
      })
    );

    const seenUrls = new Set<string>();
    const deduplicatedArticles: NewsArticle[] = [];

    for (const article of results.flat()) {
      if (article.url && !seenUrls.has(article.url)) {
        seenUrls.add(article.url);
        deduplicatedArticles.push(article);
      }
    }

    return deduplicatedArticles;
  } catch (err: any) {
    console.error('[News Worker] Failed to fetch news feeds:', err.message);
    return [];
  }
}

async function processAndSaveNews() {
  console.log('[News Worker] Fetching target markets for keyword mapping...');

  const { data: markets, error } = await supabaseAdmin
    .from('markets')
    .select('canonical_id, title')
    .eq('active', true)
    .limit(200);

  if (error || !markets || markets.length === 0) {
    console.error('[News Worker] Failed to load active markets:', error?.message);
    return;
  }

  const rawNews = await fetchLatestNews();
  console.log(`[News Worker] Fetched ${rawNews.length} articles across all sources. Mapping...`);

  if (rawNews.length === 0) {
    return;
  }

  const mappedNews: ProcessedNews[] = [];
  const seenUrls = new Set<string>();

  for (const article of rawNews) {
    const articleTitleLower = article.title.toLowerCase();

    for (const market of markets) {
      const keywords = market.title
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, '')
        .split(' ')
        .filter((word: string) => word.length > 3 && !STOP_WORDS.has(word));

      const isMatch = keywords.some((kw: string) => articleTitleLower.includes(kw));

      if (isMatch && !seenUrls.has(article.url)) {
        seenUrls.add(article.url);
        mappedNews.push({
          canonical_id: market.canonical_id,
          title: article.title,
          source: article.source,
          url: article.url,
          image_url: article.image_url,
          sentiment_score: calculateSentiment(article.title),
          published_at: article.published_at,
        });
        break;
      }
    }
  }

  if (mappedNews.length === 0) {
    console.log('[News Worker] No news articles matched active market keywords in this cycle.');
    return;
  }

  console.log(`[News Worker] Matched ${mappedNews.length} articles. Saving to Supabase...`);

  const { error: insertError } = await supabaseAdmin
    .from('market_news')
    .upsert(mappedNews, { onConflict: 'url' });

  if (insertError) {
    console.error('[News Worker] Supabase insert error:', insertError.message);
  } else {
    console.log(`[News Worker] Successfully saved ${mappedNews.length} news items with images into Supabase.`);
  }
}

export async function runNewsSyncWorker() {
  console.log('[News Sync Worker] Running news and sentiment aggregation process...');
  await processAndSaveNews();
}

if (process.argv[1]?.endsWith('newsSync.ts')) {
  runNewsSyncWorker()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[News Sync Worker] Fatal execution error:', err);
      process.exit(1);
    });
}