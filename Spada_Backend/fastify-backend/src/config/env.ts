import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('4000').transform(Number),
  HOST: z.string().default('0.0.0.0'),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  CLIENT_ORIGIN: z.string().url(),
  /** Kalshi RSA API key id — required for authenticated Kalshi Trade API calls */
  KALSHI_API_KEY_ID: z.string().min(1).optional(),
  /** Base64-encoded PEM private key for Kalshi request signing */
  KALSHI_PRIVATE_KEY_B64: z.string().min(1).optional(),
});

export const env = envSchema.parse(process.env);
