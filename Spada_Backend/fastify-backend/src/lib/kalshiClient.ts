import crypto from 'crypto';
import { env } from '../config/env.js';

const API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const SIGN_PATH_PREFIX = '/trade-api/v2';
const WS_SIGN_PATH = '/trade-api/ws/v2';
const FALLBACK_API_BASE = 'https://external-api.kalshi.com/trade-api/v2';

/** POC + Kalshi docs: elections host (external-api-ws also supported) */
export const KALSHI_WS_URL = 'wss://api.elections.kalshi.com/trade-api/ws/v2';

function loadKalshiCredentials() {
  const apiKeyId = env.KALSHI_API_KEY_ID?.trim();
  const b64 = env.KALSHI_PRIVATE_KEY_B64?.trim();

  if (!apiKeyId) {
    throw new Error('[kalshiClient] KALSHI_API_KEY_ID is required');
  }
  if (!b64) {
    throw new Error('[kalshiClient] KALSHI_PRIVATE_KEY_B64 is required');
  }

  const privateKeyPem = Buffer.from(b64, 'base64').toString('utf8');
  if (!privateKeyPem.includes('BEGIN')) {
    throw new Error('[kalshiClient] KALSHI_PRIVATE_KEY_B64 does not decode to PEM');
  }

  return { apiKeyId, privateKeyPem };
}

/**
 * Build Kalshi signed request headers (RSA-PSS SHA256).
 * @param method HTTP method
 * @param signPath Path from API root, e.g. /trade-api/v2/markets (no query string)
 */
export function buildKalshiAuthHeaders(method: string, signPath: string): Record<string, string> {
  const { apiKeyId, privateKeyPem } = loadKalshiCredentials();
  const timestamp = String(Date.now());
  const pathWithoutQuery = signPath.split('?')[0];
  const message = `${timestamp}${method.toUpperCase()}${pathWithoutQuery}`;

  const signature = crypto.sign('sha256', Buffer.from(message), {
    key: privateKeyPem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });

  return {
    'KALSHI-ACCESS-KEY': apiKeyId,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'KALSHI-ACCESS-SIGNATURE': signature.toString('base64'),
    Accept: 'application/json',
  };
}

/**
 * Authenticated GET to Kalshi trade API v2.
 * @param endpoint e.g. '/markets' or '/markets/{ticker}/orderbook'
 */
export async function kalshiGet(
  endpoint: string,
  queryParams: Record<string, string | number | boolean | undefined | null> = {}
): Promise<any> {
  const params = Object.fromEntries(
    Object.entries(queryParams).filter(([, value]) => value != null && value !== '')
  );
  const queryString = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  ).toString();

  const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const signPath = `${SIGN_PATH_PREFIX}${path}`;
  const headers = {
    ...buildKalshiAuthHeaders('GET', signPath),
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  };

  const hosts = [API_BASE, FALLBACK_API_BASE];
  let lastError: Error | null = null;

  for (const host of hosts) {
    const url = `${host}${path}${queryString ? `?${queryString}` : ''}`;
    try {
      const response = await fetch(url, { headers });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        lastError = new Error(
          `[kalshiClient] GET ${path} ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`
        );
        continue;
      }
      return response.json();
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError ?? new Error(`[kalshiClient] GET ${path} failed`);
}

export interface KalshiMarketsPageOptions {
  /** Page size (Kalshi max 1000). Default 200. */
  limit?: number;
  /** Max pages per call — prevents unbounded single-cycle downloads. */
  maxPages?: number;
  status?: string;
  /** Prefer non-multivariate markets when set to `exclude`. */
  mve_filter?: 'only' | 'exclude';
  /** Resume pagination from a previous response cursor. */
  cursor?: string | null;
  event_ticker?: string;
  series_ticker?: string;
  min_updated_ts?: number;
}

export interface KalshiMarketsPageResult {
  markets: any[];
  /** Cursor for the next page, or null when exhausted. */
  nextCursor: string | null;
  pagesFetched: number;
}

/**
 * Paginated GET /markets using Kalshi's cursor (same auth as kalshiGet).
 * Fetches up to `maxPages` pages of `limit` each — never one unbounded request.
 */
export async function kalshiGetMarketsPaginated(
  options: KalshiMarketsPageOptions = {}
): Promise<KalshiMarketsPageResult> {
  const pageLimit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
  const maxPages = Math.max(options.maxPages ?? 25, 1);

  const markets: any[] = [];
  let cursor: string | null = options.cursor ?? null;
  let pagesFetched = 0;

  do {
    const pageParams: Record<string, string | number | boolean | undefined | null> = {
      limit: pageLimit,
      status: options.status,
      mve_filter: options.mve_filter,
      event_ticker: options.event_ticker,
      series_ticker: options.series_ticker,
      min_updated_ts: options.min_updated_ts,
    };
    if (cursor) pageParams.cursor = cursor;

    const data = await kalshiGet('/markets', pageParams);
    const page = Array.isArray(data?.markets) ? data.markets : [];
    markets.push(...page);
    pagesFetched += 1;

    const next = data?.cursor != null && data.cursor !== '' ? String(data.cursor) : null;
    // Only the API cursor decides exhaustion (not page size heuristics)
    cursor = next;
    if (!cursor || page.length === 0) break;
  } while (pagesFetched < maxPages);

  return { markets, nextCursor: cursor, pagesFetched };
}

/** Signed headers for Kalshi WebSocket handshake (GET /trade-api/ws/v2). */
export function buildKalshiWsAuthHeaders(): Record<string, string> {
  return buildKalshiAuthHeaders('GET', WS_SIGN_PATH);
}
