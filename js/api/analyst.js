// Analyst layer: provides AI-powered market analysis, sentiment, and predictions
// Runs locally in the visitor's browser using WebLLM — no API key required.

import { CONFIG } from '../config.js';
import { $, icon } from '../ui.js';

const ANALYST_KEY = 'coinvantageAnalystCache';
const CACHE_TTL = 60 * 60 * 1000; // 1 hour cache

export async function startAnalyst() {
  // Initialize the WebLLM analyst if not already running
  if (window.coinvantageAnalyst) {
    return window.coinvantageAnalyst;
  }

  const { createWebLLM } = await import('./webllm-loader.js');
  const modelConfig = CONFIG.WEBLLM_MODELS?.[1] || {}; // Default to recommended

  window.coinvantageAnalyst = createWebLLM({
    model: modelConfig.id,
    onProgress: (progress) => {
      // Update UI with analysis progress
      const progressEl = $('#analystProgress');
      if (progressEl) {
        progressEl.style.width = `${progress * 100}%`;
      }
    },
    onToken: (token) => {
      // Stream analysis tokens to UI
      const textEl = $('#analystText');
      if (textEl) {
        textEl.textContent += token;
      }
    },
  });

  return window.coinvantageAnalyst;
}

export async function getAnalysis(query, context = {}) {
  // Build the context for the analyst
  const marketData = context.marketData || {};
  const portfolio = context.portfolio || {};
  const symbols = context.symbols || [];

  const prompt = `You are a cryptocurrency market analyst for CoinVantage. 
Provide a concise analysis (max 300 words) covering:
1. Current market trend for: ${symbols.join(', ') || 'major pairs'}
2. Recent price action and key levels
3. Sentiment assessment (fear & greed, social signals)
4. Potential near-term catalysts
5. Risk considerations

Market data snapshot:
- Price changes (24h): ${JSON.stringify(marketData.priceChanges || {})}
- Fear & Greed index: ${marketData.fearGreed || 'N/A'}
- Portfolio holdings: ${JSON.stringify(portfolio.holdings || {})}

Keep the analysis factual, never predictive of future prices, and include a disclaimer 
that this is AI-generated analysis for informational purposes only.`;

  try {
    const analyst = await startAnalyst();
    const analysis = await analyst.generate(prompt, {
      maxTokens: 500,
      temperature: 0.3,
      stream: true,
    });

    // Cache the analysis
    setAnalysisCache(query, analysis);

    return analysis;
  } catch (err) {
    console.error('Analyst error:', err);
    return generateFallbackAnalysis(query, marketData);
  }
}

function generateFallbackAnalysis(query, marketData) {
  const fng = marketData.fearGreed !== undefined ?
    (marketData.fearGreed < 25 ? 'Extreme Fear' : marketData.fearGreed > 75 ? 'Extreme Greed' : 'Neutral') :
    'N/A';

  return `<div class="card mt analyst-card">
    <div class="card-h"><h3>${icon('ai', 16)} Market Analysis</h3></div>
    <p class="fine">AI analysis currently unavailable. Market conditions:</p>
    <ul>
      <li>Fear & Greed Index: <b>${fng}</b></li>
      <li>Market status: ${marketData.trend === 'bull' ? 'Bullish' : marketData.trend === 'bear' ? 'Bearish' : 'Sideways'}</li>
      <li>Key observation: ${marketData.observation || 'No specific observation available'}</li>
    </ul>
    <p class="fine mt">This is static fallback analysis. For real-time AI insights, please refresh the page or ensure WebLLM is supported in your browser.</p>
  </div>`;
}

export function setAnalysisCache(query, analysis) {
  try {
    const cache = {
      query,
      analysis,
      timestamp: Date.now(),
    };
    localStorage.setItem(ANALYST_KEY, JSON.stringify(cache));
  } catch (e) {
    // LocalStorage full or disabled - silently ignore
  }
}

export function getAnalysisCache() {
  try {
    const cached = localStorage.getItem(ANALYST_KEY);
    if (!cached) return null;
    const data = JSON.parse(cached);
    // Check cache TTL
    if (Date.now() - data.timestamp > CACHE_TTL) {
      localStorage.removeItem(ANALYST_KEY);
      return null;
    }
    return data.analysis;
  } catch (e) {
    return null;
  }
}