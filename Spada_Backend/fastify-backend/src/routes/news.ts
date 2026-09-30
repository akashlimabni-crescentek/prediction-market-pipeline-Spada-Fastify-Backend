import type { FastifyInstance } from 'fastify';
import { supabaseAdmin } from '../lib/supabase.js';

// Fast category classifier fallback for article headlines
function inferNewsCategory(title: string): string {
  const t = title.toLowerCase();
  if (/bitcoin|btc|ethereum|eth|solana|sol|crypto|binance|coinbase|defi|nft|token/i.test(t)) {
    return 'Crypto';
  }
  if (/trump|biden|harris|election|senate|congress|republican|democrat|white house|vote/i.test(t)) {
    return 'Politics';
  }
  if (/fed|inflation|cpi|interest rate|rate cut|recession|gdp|treasury|yield|dollar/i.test(t)) {
    return 'Macro & Finance';
  }
  if (/nba|nfl|super bowl|champions league|game \d|esports|kills|sports/i.test(t)) {
    return 'Sports';
  }
  if (/ai|openai|chatgpt|nvidia|apple|google|meta|tech/i.test(t)) {
    return 'Technology';
  }
  return 'General';
}

export async function newsRoutes(fastify: FastifyInstance) {
  // Global News Feed (Supports ?category=Crypto, ?category=Politics, etc.)
  fastify.get('/api/workspace/news', async (request, reply) => {
    const { category, limit = '30', offset = '0' } = request.query as {
      category?: string;
      limit?: string;
      offset?: string;
    };

    let query = supabaseAdmin
      .from('market_news')
      .select('canonical_id, title, source, url, image_url, sentiment_score, published_at')
      .order('published_at', { ascending: false });

    // Category filtering
    if (category) {
      const catTrimmed = category.trim();

      // Find canonical_ids belonging to that category in markets
      const { data: catMarkets } = await supabaseAdmin
        .from('markets')
        .select('canonical_id')
        .ilike('category', `%${catTrimmed}%`);

      const matchingIds = (catMarkets ?? []).map((m) => m.canonical_id);

      if (matchingIds.length > 0) {
        // Query articles mapped to those markets OR containing the category name in headline
        query = query.or(`canonical_id.in.(${matchingIds.join(',')}),title.ilike.%${catTrimmed}%`);
      } else {
        query = query.ilike('title', `%${catTrimmed}%`);
      }
    }

    const start = parseInt(offset, 10);
    const end = start + parseInt(limit, 10) - 1;

    const { data, error } = await query.range(start, end);

    if (error) {
      return reply.status(500).send({ error: error.message });
    }

    // Hydrate market categories
    const canonicalIds = (data ?? []).map((item) => item.canonical_id);
    const { data: markets } = await supabaseAdmin
      .from('markets')
      .select('canonical_id, category')
      .in('canonical_id', canonicalIds);

    const marketCategoryMap = new Map((markets ?? []).map((m) => [m.canonical_id, m.category]));

    const formatted = (data ?? []).map((item) => {
      const resolvedCategory =
        marketCategoryMap.get(item.canonical_id) || inferNewsCategory(item.title);

      return {
        id: item.url,
        market_id: item.canonical_id,
        canonical_id: item.canonical_id,
        headline: item.title,
        title: item.title,
        source: item.source,
        category: resolvedCategory,
        article_url: item.url,
        url: item.url,
        image_url: item.image_url || null,
        correlation_score: item.sentiment_score ?? 0,
        sentiment_score: item.sentiment_score ?? 0,
        published_at: item.published_at,
      };
    });

    return reply.status(200).send({ articles: formatted });
  });

  // News Related to a Specific Market
  fastify.get('/api/news/related-markets', async (request, reply) => {
    const queryParams = request.query as {
      marketId?: string;
      market_id?: string;
      canonical_id?: string;
      canonicalId?: string;
    };

    const rawId = (
      queryParams.marketId ||
      queryParams.market_id ||
      queryParams.canonical_id ||
      queryParams.canonicalId ||
      ''
    ).trim();

    let articles: any[] = [];
    let marketCategory = 'General';

    if (rawId) {
      const possibleIds = [
        rawId,
        rawId.startsWith('polymarket_') ? rawId.replace('polymarket_', '') : `polymarket_${rawId}`,
        rawId.startsWith('kalshi_') ? rawId.replace('kalshi_', '') : `kalshi_${rawId}`,
      ];

      // Fetch market category & title
      const { data: market } = await supabaseAdmin
        .from('markets')
        .select('title, category')
        .in('canonical_id', possibleIds)
        .maybeSingle();

      if (market?.category) {
        marketCategory = market.category;
      }

      // 1. Direct search by canonical_id
      const { data: directMatches } = await supabaseAdmin
        .from('market_news')
        .select('canonical_id, title, source, url, image_url, sentiment_score, published_at')
        .in('canonical_id', possibleIds)
        .order('published_at', { ascending: false })
        .limit(10);

      if (directMatches && directMatches.length > 0) {
        articles = directMatches;
      } else {
        // 2. Fallback: Search news by title keywords
        if (market?.title) {
          const keywords = market.title
            .toLowerCase()
            .replace(/[^a-z0-9 ]/g, '')
            .split(' ')
            .filter((w: string) => w.length > 4 && !['about', 'after', 'which', 'their', 'under', 'would'].includes(w));

          if (keywords.length > 0) {
            const filterClause = keywords.map((kw: string) => `title.ilike.%${kw}%`).join(',');
            const { data: keywordMatches } = await supabaseAdmin
              .from('market_news')
              .select('canonical_id, title, source, url, image_url, sentiment_score, published_at')
              .or(filterClause)
              .order('published_at', { ascending: false })
              .limit(5);

            if (keywordMatches && keywordMatches.length > 0) {
              articles = keywordMatches;
            }
          }
        }

        // 3. Fallback: Return latest news so UI never renders an empty section
        if (articles.length === 0) {
          const { data: fallbackNews } = await supabaseAdmin
            .from('market_news')
            .select('canonical_id, title, source, url, image_url, sentiment_score, published_at')
            .order('published_at', { ascending: false })
            .limit(5);

          articles = fallbackNews || [];
        }
      }
    }

    const formatted = articles.map((item) => ({
      market_id: rawId || item.canonical_id,
      canonical_id: rawId || item.canonical_id,
      headline: item.title,
      title: item.title,
      source: item.source,
      category: marketCategory || inferNewsCategory(item.title),
      article_url: item.url,
      url: item.url,
      image_url: item.image_url || null,
      sentiment_score: item.sentiment_score ?? 0,
      correlation_score: item.sentiment_score ?? 0,
      published_at: item.published_at,
    }));

    return reply.status(200).send({ correlations: formatted });
  });
}