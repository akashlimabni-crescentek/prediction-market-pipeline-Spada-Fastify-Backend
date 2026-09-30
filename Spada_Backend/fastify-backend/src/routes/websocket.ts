import type { FastifyInstance } from 'fastify';
import { supabaseAdmin } from '../lib/supabase.js';

interface ClientSubscription {
  socket: any;
  canonicalIds: Set<string>; // Empty set means subscribed to all markets
}

// Global registry of connected frontend clients
export const connectedClients = new Set<ClientSubscription>();

// Broadcast helper: Called whenever priceStream worker flushes fresh prices
export function broadcastPriceUpdate(canonicalId: string, prices: number[]) {
  const message = JSON.stringify({
    type: 'PRICE_UPDATE',
    canonical_id: canonicalId,
    prices,
    timestamp: new Date().toISOString(),
  });

  for (const client of connectedClients) {
    if (client.socket.readyState === 1 /* OPEN */) {
      if (client.canonicalIds.size === 0 || client.canonicalIds.has(canonicalId)) {
        client.socket.send(message);
      }
    }
  }
}

export async function websocketRoutes(fastify: FastifyInstance) {
  fastify.get('/api/v1/ws', { websocket: true }, (connection, req) => {
    const url = new URL(req.url, 'http://localhost');
    const ticket = url.searchParams.get('ticket');
    const initialCanonicalId = url.searchParams.get('canonical_id') || url.searchParams.get('market_id');

    const clientSub: ClientSubscription = {
      socket: connection.socket,
      canonicalIds: new Set<string>(),
    };

    if (initialCanonicalId) {
      clientSub.canonicalIds.add(initialCanonicalId);
    }

    // Ticket authentication (enforced if provided, bypassable in dev)
    (async () => {
      let userId: string | null = 'anonymous';
      let tier: string | null = 'free';

      if (ticket) {
        const { data, error } = await supabaseAdmin
          .from('ws_tickets')
          .select('user_id, tier, expires_at, used_at')
          .eq('token_hash', ticket)
          .single();

        if (error || !data || (data.expires_at && new Date(data.expires_at) < new Date())) {
          connection.socket.close(4003, 'Invalid or expired ticket');
          return;
        }

        userId = data.user_id;
        tier = data.tier;

        await supabaseAdmin
          .from('ws_tickets')
          .update({ used_at: new Date().toISOString() })
          .eq('token_hash', ticket);
      } else if (process.env.NODE_ENV === 'production') {
        // Enforce ticket strictly in production
        connection.socket.close(4001, 'Ticket token required');
        return;
      }

      connectedClients.add(clientSub);

      connection.socket.send(
        JSON.stringify({
          type: 'CONNECTED',
          userId,
          tier,
          subscribedMarkets: [...clientSub.canonicalIds],
        })
      );
    })();

    // Handle frontend messages (subscribe/unsubscribe to specific markets)
    connection.socket.on('message', (raw) => {
      try {
        const payload = JSON.parse(raw.toString());

        if (payload.action === 'subscribe' && payload.canonical_id) {
          clientSub.canonicalIds.add(payload.canonical_id);
          connection.socket.send(
            JSON.stringify({ type: 'SUBSCRIBED', canonical_id: payload.canonical_id })
          );
          return;
        }

        if (payload.action === 'unsubscribe' && payload.canonical_id) {
          clientSub.canonicalIds.delete(payload.canonical_id);
          connection.socket.send(
            JSON.stringify({ type: 'UNSUBSCRIBED', canonical_id: payload.canonical_id })
          );
          return;
        }

        if (payload.action === 'subscribe_all') {
          clientSub.canonicalIds.clear();
          connection.socket.send(JSON.stringify({ type: 'SUBSCRIBED_ALL' }));
          return;
        }

        // Default heartbeat ACK
        connection.socket.send(
          JSON.stringify({ type: 'ACK', timestamp: new Date().toISOString() })
        );
      } catch {
        connection.socket.send(
          JSON.stringify({ type: 'ACK', timestamp: new Date().toISOString() })
        );
      }
    });

    connection.socket.on('close', () => {
      connectedClients.delete(clientSub);
    });
  });
}