import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase.js';

const profileUpdateSchema = z.object({
  displayName: z.string().optional(),
  display_name: z.string().optional(),
  avatarUrl: z.string().optional(),
  avatar_url: z.string().optional(),
  xHandle: z.string().optional(),
  x_handle: z.string().optional(),
});

export async function userRoutes(fastify: FastifyInstance) {
  // GET /api/v1/me (Auto-creates profile if missing)
  fastify.get('/api/v1/me', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const userId = request.user.id;
    const userEmail = request.user.email;

    let { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .select(
        'id, display_name, email, subscription_tier, role, mass_credits, avatar_url, subscription_status, badges, x_handle, billing_cycle, created_at'
      )
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      return reply.status(500).send({ error: error.message });
    }

    // Auto-provision profile on first login
    if (!profile) {
      const { data: newProfile, error: createError } = await supabaseAdmin
        .from('profiles')
        .insert({
          id: userId,
          email: userEmail,
          subscription_tier: 'free',
          subscription_status: 'active',
          mass_credits: 0,
        })
        .select()
        .single();

      if (createError) {
        return reply.status(500).send({ error: createError.message });
      }
      profile = newProfile;
    }

    return reply.status(200).send({ profile });
  });

  // PATCH /api/v1/me
  fastify.patch('/api/v1/me', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const userId = request.user.id;
    const parseResult = profileUpdateSchema.safeParse(request.body);

    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Invalid profile payload' });
    }

    const displayName = parseResult.data.displayName || parseResult.data.display_name;
    const avatarUrl = parseResult.data.avatarUrl || parseResult.data.avatar_url;
    let xHandle = parseResult.data.xHandle || parseResult.data.x_handle;

    if (xHandle) {
      xHandle = xHandle.replace(/^@/, '').trim();
    }

    const updates: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };

    if (displayName !== undefined) updates.display_name = displayName;
    if (avatarUrl !== undefined) updates.avatar_url = avatarUrl;
    if (xHandle !== undefined) updates.x_handle = xHandle;

    const { data, error } = await supabaseAdmin
      .from('profiles')
      .update(updates)
      .eq('id', userId)
      .select()
      .single();

    if (error) {
      return reply.status(500).send({ error: error.message });
    }

    return reply.status(200).send({ profile: data });
  });

  // POST /api/v1/ws/ticket - Issues a 60-second ticket for authenticating WebSockets
  fastify.post('/api/v1/ws/ticket', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const userId = request.user.id;

    // Fetch user's subscription tier
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('subscription_tier')
      .eq('id', userId)
      .single();

    const tier = profile?.subscription_tier || 'free';
    const tokenHash = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 1000).toISOString(); // Valid for 60 seconds

    const { error } = await supabaseAdmin.from('ws_tickets').insert({
      token_hash: tokenHash,
      user_id: userId,
      tier: tier,
      expires_at: expiresAt,
    });

    if (error) {
      return reply.status(500).send({ error: error.message });
    }

    return reply.status(200).send({
      ticket: tokenHash,
      expires_at: expiresAt,
    });
  });
}