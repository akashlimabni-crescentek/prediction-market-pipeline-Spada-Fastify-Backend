import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase.js';

const nowPaymentSchema = z.object({
  priceAmount: z.number().positive(),
  priceCurrency: z.string().default('usd'),
  payCurrency: z.string().default('usdttrc20'),
  tier: z.string().optional(),
  purchaseType: z.string().default('subscription'),
});

const stripeCheckoutSchema = z.object({
  priceId: z.string().min(1),
  tier: z.string().default('pro'),
  billingCycle: z.enum(['monthly', 'yearly']).default('monthly'),
});

export async function paymentRoutes(fastify: FastifyInstance) {
  // ==========================================
  // NOWPAYMENTS (CRYPTO)
  // ==========================================

  // POST /api/nowpayments/create-payment
  fastify.post('/api/nowpayments/create-payment', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const parseResult = nowPaymentSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Invalid payment payload' });
    }

    const { priceAmount, priceCurrency, payCurrency, tier, purchaseType } = parseResult.data;
    const userId = request.user.id;
    const orderId = `ORDER-${Date.now()}-${userId.slice(0, 8)}`;

    let invoiceUrl: string | null = null;
    let paymentId = `pending_${orderId}`;

    // Call actual NOWPayments API if API key is configured
    if (process.env.NOWPAYMENTS_API_KEY) {
      try {
        const res = await fetch('https://api.nowpayments.io/v1/invoice', {
          method: 'POST',
          headers: {
            'x-api-key': process.env.NOWPAYMENTS_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            price_amount: priceAmount,
            price_currency: priceCurrency,
            pay_currency: payCurrency,
            order_id: orderId,
            order_description: `Subscription ${tier || 'pro'}`,
            ipn_callback_url: `${process.env.BACKEND_URL || ''}/api/nowpayments/webhook`,
            success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment/success`,
            cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment/cancel`,
          }),
        });

        if (res.ok) {
          const apiData = await res.json();
          invoiceUrl = apiData.invoice_url;
          paymentId = String(apiData.id || paymentId);
        } else {
          const errText = await res.text();
          console.warn('[Payments] NOWPayments API warning:', errText);
        }
      } catch (err: any) {
        console.error('[Payments] NOWPayments API request error:', err.message);
      }
    }

    const { data, error } = await supabaseAdmin
      .from('nowpayments_transactions')
      .insert({
        user_id: userId,
        order_id: orderId,
        payment_id: paymentId,
        purchase_type: purchaseType,
        tier: tier || 'pro',
        price_amount: priceAmount,
        price_currency: priceCurrency,
        pay_currency: payCurrency,
        status: 'waiting',
        raw_payload: invoiceUrl ? { invoice_url: invoiceUrl } : null,
      })
      .select()
      .single();

    if (error) {
      return reply.status(500).send({ error: error.message });
    }

    return reply.status(201).send({
      transaction: data,
      invoice_url: invoiceUrl,
    });
  });

  // POST /api/nowpayments/webhook
  fastify.post('/api/nowpayments/webhook', async (request, reply) => {
    const body = request.body as Record<string, any>;
    const { payment_id, payment_status, order_id } = body;

    if (!payment_id || !order_id) {
      return reply.status(400).send({ error: 'Missing webhook payload identifiers' });
    }

    // Prevent duplicate webhook processing
    const { data: existing } = await supabaseAdmin
      .from('processed_webhook_events')
      .select('event_id')
      .eq('event_id', String(payment_id))
      .maybeSingle();

    if (existing) {
      return reply.status(200).send({ status: 'already_processed' });
    }

    if (payment_status === 'finished') {
      const { data: tx } = await supabaseAdmin
        .from('nowpayments_transactions')
        .update({
          status: 'finished',
          payment_id: String(payment_id),
          raw_payload: body,
          updated_at: new Date().toISOString(),
        })
        .eq('order_id', order_id)
        .select('user_id, tier, purchase_type')
        .single();

      if (tx) {
        // Upgrade user tier in profiles
        await supabaseAdmin
          .from('profiles')
          .update({
            subscription_tier: tx.tier,
            subscription_status: 'active',
            updated_at: new Date().toISOString(),
          })
          .eq('id', tx.user_id);

        // Record idempotency
        await supabaseAdmin
          .from('processed_webhook_events')
          .insert({ provider: 'nowpayments', event_id: String(payment_id) });
      }
    }

    return reply.status(200).send({ status: 'success' });
  });

  // ==========================================
  // STRIPE (CREDIT CARD)
  // ==========================================

  // POST /api/stripe/create-checkout-session
  fastify.post('/api/stripe/create-checkout-session', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const parseResult = stripeCheckoutSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Invalid checkout payload' });
    }

    const { priceId, tier, billingCycle } = parseResult.data;
    const userId = request.user.id;
    const userEmail = request.user.email;

    if (!process.env.STRIPE_SECRET_KEY) {
      return reply.status(503).send({ error: 'Stripe payments are not configured' });
    }

    try {
      // Use URLSearchParams with append() to ensure strict string typing
      const params = new URLSearchParams();
      params.append('mode', 'subscription');
      params.append(
        'success_url',
        `${process.env.FRONTEND_URL || 'http://localhost:3000'}/dashboard?session_id={CHECKOUT_SESSION_ID}`
      );
      params.append(
        'cancel_url',
        `${process.env.FRONTEND_URL || 'http://localhost:3000'}/pricing`
      );
      params.append('line_items[0][price]', priceId);
      params.append('line_items[0][quantity]', '1');
      if (userEmail) {
        params.append('customer_email', userEmail);
      }
      params.append('client_reference_id', userId);
      params.append('metadata[userId]', userId);
      params.append('metadata[tier]', tier);
      params.append('metadata[billingCycle]', billingCycle);

      const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      if (!stripeRes.ok) {
        const err = await stripeRes.text();
        return reply.status(500).send({ error: `Stripe API error: ${err}` });
      }

      const session = await stripeRes.json();
      return reply.status(200).send({ checkoutUrl: session.url, sessionId: session.id });
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // POST /api/stripe/webhook
  fastify.post('/api/stripe/webhook', async (request, reply) => {
    const event = request.body as Record<string, any>;
    const eventId = event?.id;

    if (!eventId) {
      return reply.status(400).send({ error: 'Missing event ID' });
    }

    // Check duplicate event processing
    const { data: existing } = await supabaseAdmin
      .from('processed_webhook_events')
      .select('event_id')
      .eq('event_id', eventId)
      .maybeSingle();

    if (existing) {
      return reply.status(200).send({ received: true });
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data?.object;
      const userId = session?.client_reference_id || session?.metadata?.userId;
      const tier = session?.metadata?.tier || 'pro';
      const billingCycle = session?.metadata?.billingCycle || 'monthly';

      if (userId) {
        await supabaseAdmin
          .from('profiles')
          .update({
            subscription_tier: tier,
            subscription_status: 'active',
            stripe_customer_id: session.customer || null,
            stripe_subscription_id: session.subscription || null,
            billing_cycle: billingCycle,
            updated_at: new Date().toISOString(),
          })
          .eq('id', userId);

        await supabaseAdmin
          .from('processed_webhook_events')
          .insert({ provider: 'stripe', event_id: eventId });
      }
    }

    return reply.status(200).send({ received: true });
  });
}