import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase.js';

const watchlistSchema = z
  .object({
    canonicalId: z.string().optional(),
    canonical_id: z.string().optional(),
    platform: z.string().optional(),
    outcome_id: z.string().optional(),
    outcome_label: z.string().optional(),
  })
  .refine((data) => data.canonicalId || data.canonical_id, {
    message: 'Missing canonical_id or canonicalId',
  });

export async function watchlistRoutes(fastify: FastifyInstance) {
  // GET /api/v1/watchlist
  fastify.get('/api/v1/watchlist', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const userId = request.user.id;

    // 1. Fetch user's saved watchlist items
    const { data: items, error } = await supabaseAdmin
      .from('watchlist')
      .select('id, canonical_id, platform, outcome_id, outcome_label, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      return reply.status(500).send({ error: error.message });
    }

    if (!items || items.length === 0) {
      return reply.status(200).send({ watchlist: [] });
    }

    // 2. Hydrate watchlist with live market metadata and current odds
    const canonicalIds = items.map((i) => i.canonical_id);
    const { data: markets } = await supabaseAdmin
      .from('markets')
      .select('canonical_id, title, category, prices, volume, active, ai_summary, ai_sentiment_label, updated_at')
      .in('canonical_id', canonicalIds);

    const marketMap = new Map((markets ?? []).map((m) => [m.canonical_id, m]));

    const enriched = items.map((item) => {
      const market = marketMap.get(item.canonical_id);
      const yesPrice = market?.prices?.[0] ?? 0.5;
      const noPrice = market?.prices?.[1] ?? Number((1 - yesPrice).toFixed(4));

      return {
        id: item.id,
        canonical_id: item.canonical_id,
        platform: item.platform,
        outcome_id: item.outcome_id ?? null,
        outcome_label: item.outcome_label ?? null,
        created_at: item.created_at,
        market: market
          ? {
              title: market.title,
              category: market.category,
              prices: market.prices ?? [yesPrice, noPrice],
              yes_price: yesPrice,
              no_price: noPrice,
              implied_probability: yesPrice,
              volume: market.volume,
              is_active: market.active,
              ai_summary: market.ai_summary ?? null,
              ai_sentiment_label: market.ai_sentiment_label ?? 'Neutral',
              updated_at: market.updated_at,
            }
          : null,
      };
    });

    return reply.status(200).send({ watchlist: enriched });
  });

  // POST /api/v1/watchlist
  fastify.post('/api/v1/watchlist', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const userId = request.user.id;
    const parseResult = watchlistSchema.safeParse(request.body);

    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Missing required parameter: canonical_id' });
    }

    const targetId = (parseResult.data.canonicalId || parseResult.data.canonical_id)!;
    const targetPlatform =
      parseResult.data.platform || (targetId.startsWith('kalshi') ? 'kalshi' : 'polymarket');

    // 1. Check if the item is already on the user's watchlist
    const { data: existing, error: checkError } = await supabaseAdmin
      .from('watchlist')
      .select('id, canonical_id, platform, outcome_id, outcome_label, created_at')
      .eq('user_id', userId)
      .eq('canonical_id', targetId)
      .maybeSingle();

    if (checkError) {
      return reply.status(500).send({ error: checkError.message });
    }

    // If already exists, return the existing item cleanly without throwing constraint error
    if (existing) {
      return reply.status(200).send({ item: existing, message: 'Item is already on watchlist' });
    }

    // 2. Insert new watchlist item
    const { data, error: insertError } = await supabaseAdmin
      .from('watchlist')
      .insert({
        user_id: userId,
        canonical_id: targetId,
        platform: targetPlatform,
        outcome_id: parseResult.data.outcome_id || null,
        outcome_label: parseResult.data.outcome_label || null,
      })
      .select()
      .single();

    if (insertError) {
      return reply.status(500).send({ error: insertError.message });
    }

    return reply.status(201).send({ item: data });
  });

  // DELETE /api/v1/watchlist/:canonicalId
  fastify.delete('/api/v1/watchlist/:canonicalId', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const userId = request.user.id;
    const { canonicalId } = request.params as { canonicalId: string };

    const { error } = await supabaseAdmin
      .from('watchlist')
      .delete()
      .eq('user_id', userId)
      .eq('canonical_id', canonicalId);

    if (error) {
      return reply.status(500).send({ error: error.message });
    }

    return reply.status(200).send({ message: 'Item removed from watchlist' });
  });
}