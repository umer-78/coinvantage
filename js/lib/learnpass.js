// One learning pass: read the latest candles for the trader's coins, score the
// calls whose time has come, measure every indicator on recent history, update
// the weights, log a fresh set of calls, and let the champion rule decide which
// method makes the call. Shared by the AI learning page and the trader page, so
// the system keeps learning whichever of them is open.
import { markets, getCandles, INTERVAL_MS } from '../api/market.js';
import { computeAll } from './indicators.js';
import { runForecast } from './compute.js';
import { DEFAULT_HORIZON } from '../ai/context.js';
import { load, save } from '../store.js';
import { DEFAULT_CONFIG } from './autotrader.js';
import {
  newLearnLedger, recordCalls, resolveCalls, liveScores, measureOnHistory, mergeMeasures,
  learnedWeights, blend, indicatorVotes, diffWeights, decideChampion,
} from './learncenter.js';

export const LEARN_KEY = 'aiLearn';

export function loadLearn() {
  const L = load(LEARN_KEY, null);
  return L?.rows ? L : newLearnLedger();
}

/**
 * @param {string} interval
 * @param {{ symbols?: string[], onStep?: (s: string) => void, candlesBySymbol?: Record<string, object[]> }} opts
 */
export async function learningPass(interval, { symbols, onStep, candlesBySymbol = null } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(load('traderCfg', {}) || {}) };
  const list = symbols || cfg.universe || DEFAULT_CONFIG.universe;
  const H = DEFAULT_HORIZON[interval] || 12;
  const step = INTERVAL_MS[interval] || 36e5;
  let L = loadLearn();
  const all = candlesBySymbol ? [] : await markets().catch(() => []);
  const measures = [];
  const fresh = [];
  for (const sym of list) {
    onStep?.(`Reading ${sym}…`);
    let candles = candlesBySymbol?.[sym];
    if (!candles) {
      const coin = all.find((c) => c.symbol === sym);
      if (!coin) continue;
      try { candles = (await getCandles(coin, interval, 500)).candles.slice(0, -1); } catch { continue; }
    }
    if (!candles || candles.length < 260) continue;
    L = resolveCalls(L, candles, { symbol: sym, interval });
    measures.push(measureOnHistory(candles, H));
    fresh.push({ sym, candles });
  }
  const history = mergeMeasures(measures);
  const live = liveScores(L, interval);
  const before = L.weights?.[interval] || {};
  const weights = learnedWeights(history, live);
  const changes = diffWeights(before, weights).map((text) => ({ at: Date.now(), interval, kind: 'weights', text }));

  for (const { sym, candles } of fresh) {
    onStep?.(`Forecasting ${sym}…`);
    const last = candles[candles.length - 1];
    const ind = computeAll(candles);
    const votes = indicatorVotes(candles, ind, candles.length - 1);
    let fp = null;
    try { const f = await runForecast(candles, { horizon: H, fast: true, intervalMs: step }); fp = f?.ok ? f.probUp : null; } catch { /* the indicators still count */ }
    L = recordCalls(L, { symbol: sym, interval, t: last.t, price: last.c, horizonAt: last.t + H * step, votes, forecastProb: fp, blendProb: blend(fp, votes, weights) });
  }

  const champ = decideChampion(liveScores(L), L.champion || 'forecast');
  if (champ.switched) changes.push({ at: Date.now(), interval, kind: 'champion', text: `${champ.champion === 'blend' ? 'The learned blend now makes the call.' : 'The forecast makes the call again.'} ${champ.reason}` });
  L = { ...L, weights: { ...(L.weights || {}), [interval]: weights }, champion: champ.champion, lastPass: Date.now(), changes: [...(L.changes || []), ...changes].slice(-80), history: { ...(L.history || {}), [interval]: { at: Date.now(), table: history } } };
  save(LEARN_KEY, L);
  return { ledger: L, history, live: liveScores(L), weights, champ, changes };
}

/**
 * Learn from a chart someone is looking at: score this coin's due calls on the
 * candles already loaded, then log the current indicator readings and the
 * forecast before the outcome is known. Every chart opened teaches the system
 * something, not only the trader page. Returns the blend for display.
 */
export function learnFromChart({ symbol, interval, candles, forecastProb = null }) {
  try {
    const closed = candles.slice(0, -1);
    if (closed.length < 260) return null;
    const H = DEFAULT_HORIZON[interval] || 12;
    const step = INTERVAL_MS[interval] || 36e5;
    let L = loadLearn();
    L = resolveCalls(L, closed, { symbol, interval });
    let weights = L.weights?.[interval];
    if (!weights) {
      weights = learnedWeights(measureOnHistory(closed, H), liveScores(L, interval));
      L = { ...L, weights: { ...(L.weights || {}), [interval]: weights } };
    }
    const last = closed[closed.length - 1];
    const votes = indicatorVotes(closed, computeAll(closed), closed.length - 1);
    const blendProb = blend(forecastProb, votes, weights);
    L = recordCalls(L, { symbol, interval, t: last.t, price: last.c, horizonAt: last.t + H * step, votes, forecastProb, blendProb });
    save(LEARN_KEY, L);
    return { blendProb, champion: L.champion || 'forecast', weights, votes };
  } catch { return null; }
}
