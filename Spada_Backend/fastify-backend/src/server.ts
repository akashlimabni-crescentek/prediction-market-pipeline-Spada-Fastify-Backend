import './lib/venueDns.js';
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import fastifySwagger from '@fastify/swagger';
import scalarApiReference from '@scalar/fastify-api-reference';

import { env } from './config/env.js';
import authPlugin from './plugins/auth.js';
import { marketRoutes } from './routes/market.js';
import { ratioRoutes } from './routes/ratios.js';
import { watchlistRoutes } from './routes/watchlist.js';
import { websocketRoutes } from './routes/websocket.js';
import { orderbookStore } from './services/orderbookStore.js';
import { userRoutes } from './routes/user.js';
import { newsRoutes } from './routes/news.js';
import { paymentRoutes } from './routes/payments.js';

// Background Workers
import { startPriceStreamWorker } from './workers/priceStream.js';
import { runMarketSync } from './workers/marketSync.js';
import { runNewsSyncWorker } from './workers/newsSync.js';
import { runAISummaryWorker } from './workers/aiSummaryWorker.js';
import { runCandleSyncWorker } from './workers/candleSync.js';
import { runMarketMatchSyncWorker } from './workers/marketMatchSync.js';

const server = Fastify({
  logger: {
    transport: {
      target: 'pino-pretty',
      options: { translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' },
    },
  },
});

function scheduleBackgroundWorkers() {
  server.log.info('[Workers] Initializing background pipeline...');

  // 1. Live price streaming (runs 24/7 continuously)
  try {
    startPriceStreamWorker();
    server.log.info('[Workers] Price stream worker started.');
  } catch (err: any) {
    server.log.error(`[Workers] Failed to start price stream: ${err.message}`);
  }

  // 2. Market catalog sync (runs immediately on boot, then every 1 hour)
  server.log.info('[Workers] Triggering initial market catalog sync on boot...');
  runMarketSync().catch((err) =>
    server.log.error(`[Workers] Market sync error: ${err.message}`)
  );
  setInterval(() => {
    server.log.info('[Workers] 1-hour interval timer fired: executing market catalog sync...');
    runMarketSync().catch((err) =>
      server.log.error(`[Workers] Market sync interval error: ${err.message}`)
    );
  }, 60 * 60 * 1000);

  // 3. News ingestion and sentiment mapping (runs immediately, then every 30 minutes)
  runNewsSyncWorker().catch((err) =>
    server.log.error(`[Workers] News sync error: ${err.message}`)
  );
  setInterval(() => {
    runNewsSyncWorker().catch((err) =>
      server.log.error(`[Workers] News sync interval error: ${err.message}`)
    );
  }, 30 * 60 * 1000);

  // 4. AI market summaries via Claude (runs 10 seconds after boot, then every 2 hours)
  setTimeout(() => {
    runAISummaryWorker().catch((err) =>
      server.log.error(`[Workers] AI summary error: ${err.message}`)
    );
  }, 10000);

  setInterval(() => {
    runAISummaryWorker().catch((err) =>
      server.log.error(`[Workers] AI summary interval error: ${err.message}`)
    );
  }, 2 * 60 * 60 * 1000);

  // 5. Historical OHLCV backfill into *_ohlc / *_price_history (boot + every 15m)
  setTimeout(() => {
    runCandleSyncWorker().catch((err) =>
      server.log.error(`[Workers] Candle sync error: ${err.message}`)
    );
  }, 20_000);
  setInterval(() => {
    runCandleSyncWorker().catch((err) =>
      server.log.error(`[Workers] Candle sync interval error: ${err.message}`)
    );
  }, 15 * 60 * 1000);

  // 6. Cross-platform market matching for ratios (POC Jaccard ≥ 0.88)
  setTimeout(() => {
    runMarketMatchSyncWorker().catch((err) =>
      server.log.error(`[Workers] Market match sync error: ${err.message}`)
    );
  }, 45_000);
  setInterval(() => {
    runMarketMatchSyncWorker().catch((err) =>
      server.log.error(`[Workers] Market match sync interval error: ${err.message}`)
    );
  }, 60 * 60 * 1000);
}

async function main() {
  try {
    await server.register(fastifyCors, { origin: '*' });
    await server.register(fastifyWebsocket);

    // 1. OpenAPI Specification with Global Transformer
    await server.register(fastifySwagger, {
      openapi: {
        info: {
          title: 'Spada Prediction Market Gateway',
          version: '1.0.0',
          description: [
            '## Overview',
            'Spada is a high-throughput prediction market aggregator unifying **Polymarket** and **Kalshi** orderbooks.',
            '',
            '### Capabilities',
            '* **Real-Time CLOB Streaming**: Millisecond-level price odds over WebSockets.',
            '* **Direct Exchange Orderbooks**: Live depth retrieved from primary CLOB engines.',
            '* **Market Intelligence Ratios**: Seven POC ratios (pressure, churn, support, executionCost, divergence, probabilityMomentum, resolutionTension).',
            '* **Claude AI Sentiment**: News aggregation mapped to market titles with sentiment scoring.',
            '',
            '### Authentication',
            'Protected endpoints require a Supabase JWT passed as a Bearer token:',
            '`Authorization: Bearer <supabase_jwt_token>`',
            '',
            'WebSocket connections in production require a ticket obtained from `POST /api/v1/ws/ticket`.',
          ].join('\n'),
          contact: {
            name: 'Spada Developer Support',
            url: 'https://spada.exchange',
          },
        },
        servers: [
          {
            url: `http://localhost:${env.PORT}`,
            description: 'Local Development Gateway',
          },
        ],
        tags: [
          { name: 'Markets', description: 'Market catalogue, live odds, orderbooks, and historical candles' },
          { name: 'News', description: 'Market news ingestion and sentiment analysis' },
          { name: 'Ratios', description: 'Cross-platform arbitrage and price divergence' },
          { name: 'Watchlist', description: 'Saved markets with live odds hydration' },
          { name: 'User', description: 'User profiles and WebSocket ticket issuance' },
          { name: 'Payments', description: 'Crypto invoices (NOWPayments) and card subscriptions (Stripe)' },
          { name: 'WebSocket', description: 'Persistent price tick streaming' },
        ],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: 'http',
              scheme: 'bearer',
              bearerFormat: 'JWT',
              description: 'Enter your Supabase access token (JWT)',
            },
          },
        },
      },

      // Automatically assigns tags, summaries, and schemas to endpoints
      transform: ({ schema, url, route }) => {
        const s = { ...schema } as any;
        const method = Array.isArray(route?.method) ? route.method[0] : (route?.method || '');

        // 1. Markets
        if (url.startsWith('/api/v1/markets')) {
          s.tags = ['Markets'];
          if (url === '/api/v1/markets') {
            s.summary = 'Get Markets Catalogue';
            s.description = 'Fetch active markets with live yes/no prices, volume, and AI summaries';
            s.querystring = {
              type: 'object',
              properties: {
                platform: { type: 'string', enum: ['polymarket', 'kalshi'], description: 'Filter by platform' },
                limit: { type: 'integer', default: 20 },
                offset: { type: 'integer', default: 0 },
              },
            };
          } else if (url.endsWith('/orderbook')) {
            s.summary = 'Get Live Orderbook';
            s.description = 'Fetch live orderbook bids and asks directly from the exchange CLOB';
          } else if (url.endsWith('/candles')) {
            s.summary = 'Get Market Candles';
            s.description =
              'Fetch OHLCV candle bars for price charting. Supports resolutions 5m, 15m, 1h, 4h, 1d, and 1w via the resolution query parameter (default: 1h). Returns newest-first completed bars plus the current forming bucket (composed from finer stored candles and live 1m). History depth is resolution-aware (override with CANDLE_MAX_BARS).';
            s.querystring = {
              type: 'object',
              properties: {
                resolution: {
                  type: 'string',
                  enum: ['5m', '15m', '1h', '4h', '1d', '1w'],
                  default: '1h',
                  description: 'Candle interval / chart resolution',
                },
              },
            };
          } else {
            s.summary = 'Get Single Market';
            s.description = 'Fetch full market details and odds by canonical_id';
          }
        }

        // 2. News
        else if (url.startsWith('/api/workspace/news') || url.startsWith('/api/news')) {
          s.tags = ['News'];
          if (url.includes('related-markets')) {
            s.summary = 'Get Related Market News';
            s.querystring = {
              type: 'object',
              properties: {
                marketId: { type: 'string', description: 'Canonical market ID (e.g. polymarket_0x...)' },
              },
            };
          } else {
            s.summary = 'Get Global News Feed';
            s.description = 'Fetch latest news articles with calculated sentiment scores';
          }
        }

        // 3. Ratios
        else if (url.startsWith('/api/v1/ratios')) {
          s.tags = ['Ratios'];
          s.summary = 'Get Market Intelligence Ratios';
          s.description =
            'Returns the seven POC ratios (pressure, churn, support, executionCost, divergence, probabilityMomentum, resolutionTension) plus legacy metrics for compatibility';
        }

        // 4. Watchlist
        else if (url.startsWith('/api/v1/watchlist')) {
          s.tags = ['Watchlist'];
          s.security = [{ bearerAuth: [] }];
          if (method === 'POST') {
            s.summary = 'Add Market to Watchlist';
            s.body = {
              type: 'object',
              required: ['canonical_id'],
              properties: {
                canonical_id: { type: 'string', example: 'polymarket_0x4567...' },
                platform: { type: 'string', enum: ['polymarket', 'kalshi'], example: 'polymarket' },
                outcome_id: { type: 'string' },
                outcome_label: { type: 'string' },
              },
            };
          } else if (method === 'DELETE') {
            s.summary = 'Remove Market from Watchlist';
          } else {
            s.summary = 'Get User Watchlist';
            s.description = 'Retrieve saved markets enriched with live prices and metadata';
          }
        }

        // 5. User
        else if (url.startsWith('/api/v1/me') || url.startsWith('/api/v1/ws/ticket')) {
          s.tags = ['User'];
          s.security = [{ bearerAuth: [] }];
          if (url.endsWith('/ticket')) {
            s.summary = 'Issue WebSocket Ticket';
            s.description = 'Generates a 60-second single-use ticket for authenticating WebSockets';
          } else if (method === 'PATCH') {
            s.summary = 'Update User Profile';
            s.body = {
              type: 'object',
              properties: {
                displayName: { type: 'string', example: 'CryptoTrader' },
                avatarUrl: { type: 'string', example: 'https://example.com/avatar.png' },
                xHandle: { type: 'string', example: 'cryptotrader' },
              },
            };
          } else {
            s.summary = 'Get User Profile';
            s.description = 'Fetch authenticated user details and subscription tier';
          }
        }

        // 6. Payments
        else if (url.startsWith('/api/nowpayments') || url.startsWith('/api/stripe')) {
          s.tags = ['Payments'];
          if (url.includes('/nowpayments/create-payment')) {
            s.summary = 'Create NOWPayments Crypto Invoice';
            s.security = [{ bearerAuth: [] }];
            s.body = {
              type: 'object',
              required: ['priceAmount'],
              properties: {
                priceAmount: { type: 'number', example: 29.99 },
                priceCurrency: { type: 'string', default: 'usd', example: 'usd' },
                payCurrency: { type: 'string', default: 'usdttrc20', example: 'usdttrc20' },
                tier: { type: 'string', default: 'pro', example: 'pro' },
                purchaseType: { type: 'string', default: 'subscription', example: 'subscription' },
              },
            };
          } else if (url.includes('/stripe/create-checkout-session')) {
            s.summary = 'Create Stripe Checkout Session';
            s.security = [{ bearerAuth: [] }];
            s.body = {
              type: 'object',
              required: ['priceId'],
              properties: {
                priceId: { type: 'string', example: 'price_1N...' },
                tier: { type: 'string', default: 'pro', example: 'pro' },
                billingCycle: { type: 'string', enum: ['monthly', 'yearly'], default: 'monthly', example: 'monthly' },
              },
            };
          } else if (url.includes('webhook')) {
            s.summary = 'Payment Provider Webhook Callback';
          }
        }

        // 7. WebSocket
        else if (url.startsWith('/api/v1/ws')) {
          s.tags = ['WebSocket'];
          s.summary = 'Real-Time Price Stream';
          s.description = 'Persistent WebSocket connection for live price ticks';
          s.querystring = {
            type: 'object',
            properties: {
              canonical_id: { type: 'string', description: 'Auto-subscribe to a market on connect' },
              ticket: { type: 'string', description: 'Single-use authentication ticket from /api/v1/ws/ticket' },
            },
          };
        }

        return { schema: s, url };
      },
    });

    // 2. Enhanced Scalar UI Configuration
    await server.register(scalarApiReference, {
      routePrefix: '/reference',
      configuration: {
        theme: 'deepSpace',
        darkMode: true,
        showSidebar: true,
        searchHotKey: 'k',
        metaData: {
          title: 'Spada API Documentation',
          description: 'Interactive API reference for Spada prediction market gateway',
        },
        defaultHttpClient: {
          targetKey: 'js',
          clientKey: 'axios',
        },
      },
    });

    // Plugins & Route Registration
    await server.register(authPlugin);
    await server.register(marketRoutes);
    await server.register(ratioRoutes);
    await server.register(watchlistRoutes);
    await server.register(userRoutes);
    await server.register(newsRoutes);
    await server.register(websocketRoutes);
    await server.register(paymentRoutes);

    await orderbookStore.init();

    const address = await server.listen({ port: env.PORT, host: '0.0.0.0' });
    server.log.info(`Fastify Gateway operational at: ${address}`);
    server.log.info(`API Reference portal: http://localhost:${env.PORT}/reference`);

    // Start background worker pipeline after port binds
    scheduleBackgroundWorkers();
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

main();