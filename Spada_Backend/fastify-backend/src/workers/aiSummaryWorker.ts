import 'dotenv/config';
import { supabaseAdmin } from '../lib/supabase.js';

interface TargetMarket {
  canonical_id: string;
  title: string;
  category: string;
  prices: number[];
}

let resolvedModel: string | null = null;

async function getAvailableModel(): Promise<string> {
  if (resolvedModel) return resolvedModel;
  if (process.env.ANTHROPIC_MODEL) {
    resolvedModel = process.env.ANTHROPIC_MODEL;
    return resolvedModel;
  }

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
      });

      if (res.ok) {
        const json = await res.json();
        const models: { id: string }[] = json.data || [];
        if (models.length > 0) {
          const selected =
            models.find((m) => m.id.includes('haiku')) ||
            models.find((m) => m.id.includes('sonnet')) ||
            models[0];
          resolvedModel = selected.id;
          return resolvedModel;
        }
      }
    } catch {
      // Fallback
    }
  }

  resolvedModel = 'claude-3-haiku-20240307';
  return resolvedModel;
}

async function generateAISummary(
  market: TargetMarket,
  newsTitles: string[],
  modelId: string
): Promise<{ summary: string; sentiment: string }> {
  const currentPrice = market.prices?.[0] ? Math.round(market.prices[0] * 100) : 50;
  const newsContext = newsTitles.length > 0 
    ? `Recent Headlines: ${newsTitles.slice(0, 3).join(' | ')}` 
    : 'No recent breaking news detected.';

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 300,
          system: 'You are a financial analyst specializing in prediction markets. Provide a 2-sentence market summary and assign a sentiment label (Bullish, Bearish, or Neutral). Return strictly valid JSON format with no markdown: {"summary": "...", "sentiment": "..."}',
          messages: [
            {
              role: 'user',
              content: `Market: ${market.title}\nCurrent Probability: ${currentPrice}%\nContext: ${newsContext}`
            }
          ]
        })
      });

      if (response.ok) {
        const json = await response.json();
        const rawText = json.content?.[0]?.text ?? '';
        const cleanedText = rawText.replace(/```json\n?|\n?```/g, '').trim();
        const parsed = JSON.parse(cleanedText);

        return {
          summary: parsed.summary,
          sentiment: parsed.sentiment || 'Neutral'
        };
      }
    } catch {
      // Fallback
    }
  }

  const sentiment = currentPrice > 60 ? 'Bullish' : currentPrice < 40 ? 'Bearish' : 'Neutral';
  const summary = `Market probability currently stands at ${currentPrice}%. ${newsContext}`;
  return { summary, sentiment };
}

export async function runAISummaryWorker(): Promise<void> {
  console.log('[AI Worker] Starting AI summary cycle...');

  // Prioritize markets missing an AI summary first
  let { data: markets } = await supabaseAdmin
    .from('markets')
    .select('canonical_id, title, category, prices')
    .eq('active', true)
    .is('ai_summary', null)
    .limit(50);

  // If all markets have summaries, refresh the oldest 20
  if (!markets || markets.length === 0) {
    const { data: oldest } = await supabaseAdmin
      .from('markets')
      .select('canonical_id, title, category, prices')
      .eq('active', true)
      .order('ai_last_updated', { ascending: true })
      .limit(20);

    markets = oldest || [];
  }

  if (markets.length === 0) return;

  const modelId = await getAvailableModel();
  console.log(`[AI Worker] Generating summaries using ${modelId} for ${markets.length} markets...`);

  for (const market of markets) {
    const { data: news } = await supabaseAdmin
      .from('market_news')
      .select('title')
      .eq('canonical_id', market.canonical_id)
      .limit(5);

    const newsTitles = news?.map((n) => n.title) || [];
    const { summary, sentiment } = await generateAISummary(market, newsTitles, modelId);

    await supabaseAdmin
      .from('markets')
      .update({
        ai_summary: summary,
        ai_sentiment_label: sentiment,
        ai_last_updated: new Date().toISOString(),
      })
      .eq('canonical_id', market.canonical_id);
  }

  console.log('[AI Worker] Summary generation complete.');
}

if (process.argv[1]?.endsWith('aiSummaryWorker.ts')) {
  runAISummaryWorker()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[AI Worker] Execution error:', err);
      process.exit(1);
    });
}