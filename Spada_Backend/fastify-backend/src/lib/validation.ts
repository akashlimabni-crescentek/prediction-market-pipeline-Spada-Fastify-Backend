import { z } from 'zod';

export const marketPayloadSchema = z.object({
  canonicalId: z.string().min(1, 'canonicalId is required'),
  platform: z.enum(['kalshi', 'polymarket']),
  title: z.string().min(1),
  yesPrice: z.number().min(0).max(1),
  impliedProbability: z.number().min(0).max(1),
  isActive: z.boolean().default(true),
});

export const watchlistAddSchema = z.object({
  canonicalId: z.string().min(1, 'canonicalId is required'),
  platform: z.string().min(1, 'platform is required'),
  outcomeId: z.string().optional(),
  outcomeLabel: z.string().optional(),
});

export const updateProfileSchema = z.object({
  displayName: z.string().min(1).max(50).optional(),
  avatarUrl: z.string().url().optional().or(z.literal('')),
  preferredCurrency: z.enum(['USD', 'EUR', 'GBP']).optional(),
  timezone: z.string().optional(),
});

export const newsQuerySchema = z.object({
  category: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
  marketId: z.string().optional(),
});

export type MarketPayload = z.infer<typeof marketPayloadSchema>;
export type WatchlistAddInput = z.infer<typeof watchlistAddSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type NewsQueryInput = z.infer<typeof newsQuerySchema>;