import type { FastifyInstance } from 'fastify';
import { supabaseAdmin } from '../lib/supabase.js';

export async function ratioRoutes(fastify: FastifyInstance) {
  // GET /api/v1/ratios/:marketId (where :marketId is canonical_id or external_id)
  fastify.get('/api/v1/ratios/:marketId', async (request, reply) => {
    const { marketId } = request.params as { marketId: string };

    // 1. Fetch primary market details from markets table
    let { data: market } = await supabaseAdmin
      .from('markets')
      .select('canonical_id, platform, external_id, title, prices, volume')
      .eq('canonical_id', marketId)
      .maybeSingle();

    // Fallback search by external_id if canonical_id did not match
    if (!market) {
      const { data: fallback } = await supabaseAdmin
        .from('markets')
        .select('canonical_id, platform, external_id, title, prices, volume')
        .eq('external_id', marketId)
        .maybeSingle();
      market = fallback;
    }

    if (!market) {
      return reply.status(404).send({ error: 'Market not found' });
    }

    const isPoly = market.platform === 'polymarket';
    const primaryPlatformId = market.external_id;

    // 2. Check cross-platform match in market_matches table
    const { data: match } = await supabaseAdmin
      .from('market_matches')
      .select('pm_platform_id, kalshi_platform_id, similarity')
      .eq(isPoly ? 'pm_platform_id' : 'kalshi_platform_id', primaryPlatformId)
      .maybeSingle();

    if (!match) {
      return reply.status(200).send({
        matched: false,
        message: 'No cross-platform counterpart found for this market',
        primaryMarket: {
          canonical_id: market.canonical_id,
          platform: market.platform,
          title: market.title,
          yes_price: market.prices?.[0] ?? 0.5,
        },
        counterMarket: null,
        metrics: null,
      });
    }

    // 3. Fetch the matched counterpart market
    const counterPlatformId = isPoly ? match.kalshi_platform_id : match.pm_platform_id;
    const { data: counterMarket } = await supabaseAdmin
      .from('markets')
      .select('canonical_id, platform, external_id, title, prices, volume')
      .eq('external_id', counterPlatformId)
      .maybeSingle();

    const primaryYesPrice = market.prices?.[0] ?? 0.5;
    const counterYesPrice = counterMarket?.prices?.[0] ?? null;

    // 4. Calculate ratio and arbitrage metrics
    let priceRatio: number | null = null;
    let spread: number | null = null;
    let divergencePct: number | null = null;

    if (counterYesPrice && counterYesPrice > 0) {
      priceRatio = Number((primaryYesPrice / counterYesPrice).toFixed(4));
      spread = Number((primaryYesPrice - counterYesPrice).toFixed(4));
      divergencePct = Number((((primaryYesPrice - counterYesPrice) / counterYesPrice) * 100).toFixed(2));
    }

    return reply.status(200).send({
      matched: true,
      similarity: match.similarity,
      metrics: {
        ratio: priceRatio,
        spread: spread,
        divergence_percent: divergencePct,
      },
      primaryMarket: {
        canonical_id: market.canonical_id,
        platform: market.platform,
        title: market.title,
        yes_price: primaryYesPrice,
      },
      counterMarket: counterMarket
        ? {
            canonical_id: counterMarket.canonical_id,
            platform: counterMarket.platform,
            title: counterMarket.title,
            yes_price: counterYesPrice,
          }
        : null,
    });
  });
}