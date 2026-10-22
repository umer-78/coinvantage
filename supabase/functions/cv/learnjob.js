// The AI's learning pass as the server runs it: on a schedule, with every
// browser closed, into one record every visitor reads. learn.ts reads the
// candles and the database; this file is pure, so the tests run it under Node.
//
// It is the browser's learning pass (js/lib/learnpass.js) with three changes:
// it takes every coin with Binance candles, on every chart, in turn, instead of
// the open page's coins on one chart; it keeps one record per chart; and a call
// whose outcome candle can no longer be read is dropped and counted instead of
// waiting forever. Before this the learning only ran while the AI learning or
// Trading page was open, and was kept in that one browser.
import { computeAll } from './engine/indicators.js';
import { COIN_VENUE } from './coins.js';
import {
  newLearnLedger, recordCalls, resolveCalls, liveScores, measureOnHistory, mergeMeasures,
  learnedWeights, blend, indicatorVotes, diffWeights, decideChampion,
} from './engine/learncenter.js';

/** The forecast horizon on each chart, in candles: js/ai/context.js DEFAULT_HORIZON. */
export const LEARN_HORIZON = { '1m': 15, '5m': 12, '15m': 8, '1h': 12, '4h': 6, '1d': 7 };
export const LEARN_INTERVAL_MS = { '1m': 6e4, '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 144e5, '1d': 864e5 };
export const LEARN_INTERVALS = Object.keys(LEARN_HORIZON);

/** The coins in the evaluation's list (tools/universe.json) whose candles come from Binance. */
export const LEARN_COINS = Object.keys(COIN_VENUE).filter((s) => COIN_VENUE[s] === 'binance');

/** Candles read per coin: the last 500 are measured; 1m reads more so a call made a round ago can still be graded. */
export const candlesToRead = (interval) => (interval === '1m' ? 1000 : 500);

/**
 * The chart and coins a run at `now` takes. The chart changes every run and
 * the coins every round of charts, so with a run every five minutes and six
 * coins a run, each coin is back on each chart about every 6.5 hours.
 */
export function slotFor(now, { coins = LEARN_COINS, perBatch = 6, slotMs = 300e3 } = {}) {
  const slot = Math.floor(now / slotMs);
  const interval = LEARN_INTERVALS[slot % LEARN_INTERVALS.length];
  const batches = Math.max(1, Math.ceil(coins.length / perBatch));
  const batch = Math.floor(slot / LEARN_INTERVALS.length) % batches;
  return { interval, batch, batches, symbols: coins.slice(batch * perBatch, (batch + 1) * perBatch) };
}

const tableOf = (m) => Object.fromEntries(Object.entries(m).map(([k, s]) => [k, [s.hits, s.n]]));
const fromTable = (t) => Object.fromEntries(Object.entries(t).map(([k, [hits, n]]) => [k, { hits, n }]));

/**
 * One run on one chart. `inputs` is [{ symbol, candles }], closed candles only,
 * oldest first. `forecast(candles, opts)` is the engine's forecast. Returns
 * the new ledger, what the pages read (`summary`) and what changed.
 */
export function learnRun(ledger, interval, inputs, { forecast = null, now = Date.now() } = {}) {
  const H = LEARN_HORIZON[interval];
  const step = LEARN_INTERVAL_MS[interval];
  if (!H || !step) throw new Error(`unknown chart ${interval}`);
  let L = ledger?.rows ? ledger : { ...newLearnLedger(), createdAt: now };
  const measures = { ...(L.measures || {}) };
  const before = L.weights?.[interval] || {};
  let scored = 0, expired = 0, logged = 0;
  const fresh = [];
  for (const { symbol, candles } of inputs) {
    if (!candles || candles.length < 260) continue;
    const waiting = L.rows.filter((r) => !r.resolved && r.symbol === symbol).length;
    L = resolveCalls(L, candles, { symbol, interval });
    const still = L.rows.filter((r) => !r.resolved && r.symbol === symbol);
    scored += waiting - still.length;
    // its outcome candle is older than anything read: it can no longer be graded
    const gone = new Set(still.filter((r) => r.horizonAt < candles[0].t).map((r) => r.id));
    if (gone.size) { L = { ...L, rows: L.rows.filter((r) => !gone.has(r.id)) }; expired += gone.size; }
    const recent = candles.slice(-500);
    const m = measureOnHistory(recent, H);
    if (m) measures[symbol] = { at: now, t: tableOf(m) };
    fresh.push({ symbol, candles: recent });
  }
  const history = mergeMeasures(Object.values(measures).map((x) => fromTable(x.t)));
  const weights = learnedWeights(history, liveScores(L, interval));

  for (const { symbol, candles } of fresh) {
    const last = candles[candles.length - 1];
    const votes = indicatorVotes(candles, computeAll(candles), candles.length - 1);
    let fp = null;
    try { const f = forecast?.(candles, { horizon: H, fast: true, intervalMs: step }); fp = f?.ok ? f.probUp : null; } catch { /* the indicators still count */ }
    const had = L.rows.some((r) => r.id === `${symbol}:${interval}:${last.t}`);
    L = recordCalls(L, { symbol, interval, t: last.t, price: last.c, horizonAt: last.t + H * step, votes, forecastProb: fp, blendProb: blend(fp, votes, weights) });
    if (!had) logged++;
  }

  const champ = decideChampion(liveScores(L, interval), L.champion || 'forecast');
  const changes = diffWeights(before, weights).map((text) => ({ at: now, interval, kind: 'weights', text }));
  if (champ.switched) changes.push({ at: now, interval, kind: 'champion', text: `${champ.champion === 'blend' ? 'The learned blend now makes the call.' : 'The forecast makes the call again.'} ${champ.reason}` });
  L = {
    ...L, interval, measures, history, weights: { [interval]: weights }, champion: champ.champion, championReason: champ.reason,
    lastPass: now, changes: [...(L.changes || []), ...changes].slice(-80), expired: (L.expired || 0) + expired,
  };
  return { ledger: L, summary: learnSummary(L, interval), changes, scored, expired, logged };
}

/** What the pages read: the record's size, its scores and weights, who makes the call, what changed. */
export function learnSummary(L, interval) {
  const waiting = (L.rows || []).filter((r) => !r.resolved);
  return {
    interval, lastPass: L.lastPass || null, since: L.createdAt || null,
    calls: (L.rows || []).length, scored: (L.rows || []).length - waiting.length, expired: L.expired || 0,
    waiting: {
      forecast: waiting.filter((r) => Number.isFinite(r.forecastProb)).length,
      blend: waiting.filter((r) => Number.isFinite(r.blendProb)).length,
      nextAt: waiting.length ? Math.min(...waiting.map((r) => r.horizonAt)) : null,
    },
    coins: Object.keys(L.measures || {}).length,
    history: L.history || null, live: liveScores(L, interval), weights: L.weights?.[interval] || {},
    champion: L.champion || 'forecast', reason: L.championReason || null,
    changes: (L.changes || []).slice(-30),
  };
}
