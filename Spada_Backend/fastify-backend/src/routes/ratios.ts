import type { FastifyInstance } from 'fastify';
import { supabaseAdmin } from '../lib/supabase.js';
import {
  buildRatioHttpResponse,
  computeMarketRatios,
} from '../services/ratioEngine.js';

const MARKET_SELECT =
  'canonical_id, platform, external_id, title, outcomes, prices, volume, raw_data, active';

export async function ratioRoutes(fastify: FastifyInstance) {
  // GET /api/v1/ratios/:marketId (canonical_id or external_id)
  fastify.get('/api/v1/ratios/:marketId', async (request, reply) => {
    const { marketId } = request.params as { marketId: string };

    let { data: market } = await supabaseAdmin
      .from('markets')
      .select(MARKET_SELECT)
      .eq('canonical_id', marketId)
      .maybeSingle();

    if (!market) {
      const { data: fallback } = await supabaseAdmin
        .from('markets')
        .select(MARKET_SELECT)
        .eq('external_id', marketId)
        .maybeSingle();
      market = fallback;
    }

    if (!market) {
      return reply.status(404).send({ error: 'Market not found' });
    }

    const result = await computeMarketRatios(market);
    return reply.status(200).send(buildRatioHttpResponse(market, result));
  });
}
