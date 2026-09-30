import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { supabasePublic } from '../lib/supabase.js';

// Extend Fastify types so request.user is recognized by TypeScript
declare module 'fastify' {
  interface FastifyRequest {
    user: {
      id: string;
      email?: string;
      role?: string;
    };
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

async function authPlugin(fastify: FastifyInstance) {
  fastify.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.status(401).send({ error: 'Missing or malformed Authorization header' });
      }

      const token = authHeader.replace('Bearer ', '').trim();

      // Validate the token directly with Supabase Auth
      const { data: { user }, error } = await supabasePublic.auth.getUser(token);

      if (error || !user) {
        return reply.status(401).send({ error: 'Unauthorized token' });
      }

      // Attach authenticated user payload to the request context
      request.user = {
        id: user.id,
        email: user.email,
        role: user.role,
      };
    } catch (err) {
      return reply.status(401).send({ error: 'Unauthorized token' });
    }
  });
}

// Export default wrapped with fastify-plugin so decorators persist globally
export default fp(authPlugin);