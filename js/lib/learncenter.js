// AI learning center: one place where the app learns from its own calls.
//
// Three things are scored against what the market actually did:
//   1. every indicator's reading (RSI oversold → expects up, Supertrend down →
//      expects down, …),
//   2. the forecast engine's direction,
//   3. a "learned blend" that combines the forecast with only those indicators
//      that have earned it on this device.
// The blend's weights come from the scores, so the system changes its own
// decisions as evidence arrives — and it is scored itself, so if learning
// does not help, the page says so.
//
// Honesty rules: every rate ships with its sample size and a 95% range; a
// reading only gets a vote when that range sits clearly above (or below) a
// coin flip; nothing here is ever rounded up or invented. "Recent history"
// numbers are measured on past candles right now; "live" numbers are calls
// this device logged BEFORE their outcome was known.

import { computeAll } from './indicators.js';

export const LEARN_VERSION = 1;
const CAP = 2000;          // max rows kept on device (localStorage is small)
const MIN_N = 30;          // calls before a reading may earn a vote

/** Human names and what each vote means, for the page. */
export const INDICATORS = {
  rsi: { name: 'RSI(14) extremes', rule: 'under 30 → up · over 70 → down' },
  macd: { name: 'MACD histogram', rule: 'above zero → up · below → down' },
  ema200: { name: 'Price vs 200 EMA', rule: 'above → up · below → down' },
  emaCross: { name: 'EMA 20 vs 50', rule: '20 above 50 → up · below → down' },
  supertrend: { name: 'Supertrend', rule: 'trend up → up · down → down' },
  stoch: { name: 'Stochastic RSI', rule: 'K under 20 → up · over 80 → down' },
  mfi: { name: 'Money Flow Index', rule: 'under 20 → up · over 80 → down' },
  cci: { name: 'CCI(20)', rule: 'under −100 → up · over 100 → down' },
  willr: { name: 'Williams %R', rule: 'under −80 → up · over −20 → down' },
  bollinger: { name: 'Bollinger bands', rule: 'close under lower → up · over upper → down' },
  donchian: { name: 'Donchian breakout', rule: 'new 20-bar high → up · new low → down' },
  adx: { name: 'ADX + DI (trending only)', rule: 'ADX 25+: +DI leads → up · −DI leads → down' },
};

/** Each indicator's call on bar i: +1 expects up, -1 expects down, 0 no call. */
export function indicatorVotes(candles, ind, i) {
  const c = candles[i]?.c;
  const v = {};
  const n = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : x);
  const r = n(ind.rsi[i]); v.rsi = r === null ? 0 : r < 30 ? 1 : r > 70 ? -1 : 0;
  const h = n(ind.macd.hist[i]); v.macd = h === null ? 0 : Math.sign(h);
  const e200 = n(ind.ema200[i]); v.ema200 = e200 === null ? 0 : c > e200 ? 1 : -1;
  const e20 = n(ind.ema20[i]), e50 = n(ind.ema50[i]); v.emaCross = e20 === null || e50 === null ? 0 : e20 > e50 ? 1 : -1;
  v.supertrend = ind.supertrend?.dir[i] ?? 0;
  const k = n(ind.stoch.k[i]); v.stoch = k === null ? 0 : k < 20 ? 1 : k > 80 ? -1 : 0;
  const m = n(ind.mfi?.[i]); v.mfi = m === null ? 0 : m < 20 ? 1 : m > 80 ? -1 : 0;
  const cc = n(ind.cci?.[i]); v.cci = cc === null ? 0 : cc < -100 ? 1 : cc > 100 ? -1 : 0;
  const w = n(ind.willr?.[i]); v.willr = w === null ? 0 : w < -80 ? 1 : w > -20 ? -1 : 0;
  const bu = n(ind.bb.upper[i]), bl = n(ind.bb.lower[i]); v.bollinger = bu === null ? 0 : c < bl ? 1 : c > bu ? -1 : 0;
  const du = n(ind.donchian?.upper[i - 1]), dl = n(ind.donchian?.lower[i - 1]); v.donchian = du === null ? 0 : c > du ? 1 : c < dl ? -1 : 0;
  const a = n(ind.adx.adx[i]), pd = n(ind.adx.plusDI[i]), md = n(ind.adx.minusDI[i]);
  v.adx = a === null || a < 25 || pd === null ? 0 : pd > md ? 1 : -1;
  return v;
}

/** Wilson 95% interval for a hit rate. */
export function wilson(hits, n) {
  if (!n) return [0, 1];
  const z = 1.96, p = hits / n, d = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / d, half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, mid - half), Math.min(1, mid + half)];
}

function summarise(hits, n) {
  const [lo, hi] = wilson(hits, n);
  const rate = n ? hits / n : null;
  // A reading earns a vote only with enough calls AND a 95% range clear of 50%.
  const verdict = n < MIN_N ? 'too few calls' : lo > 0.5 ? 'right more often than not' : hi < 0.5 ? 'wrong more often than not' : 'no better than a coin flip';
  const weight = n >= MIN_N && (lo > 0.5 || hi < 0.5) ? +(((rate - 0.5) * 4)).toFixed(3) : 0; // wrong-way readings get a negative weight: their call is inverted
  return { n, hits, rate: rate === null ? null : +(rate * 100).toFixed(1), lo: +(lo * 100).toFixed(1), hi: +(hi * 100).toFixed(1), verdict, weight };
}

/**
 * Measure every indicator on past candles right now: for each bar, did the
 * reading's direction match the close `horizon` bars later?
 */
export function measureOnHistory(candles, horizon) {
  if (!candles || candles.length < 260) return null;
  const ind = computeAll(candles);
  const tally = {};
  for (const key of Object.keys(INDICATORS)) tally[key] = { hits: 0, n: 0 };
  // Calls never overlap: with half-overlapping windows one move was counted
  // twice, the 95% range came out too narrow, and pure noise earned votes.
  const step = Math.max(1, horizon);
  for (let i = 210; i < candles.length - horizon; i += step) {
    const up = candles[i + horizon].c > candles[i].c ? 1 : -1;
    const votes = indicatorVotes(candles, ind, i);
    for (const [k, v] of Object.entries(votes)) if (v) { tally[k].n++; if (v === up) tally[k].hits++; }
  }
  return Object.fromEntries(Object.entries(tally).map(([k, t]) => [k, summarise(t.hits, t.n)]));
}

/** Merge several coins' history measurements into one table. */
export function mergeMeasures(list) {
  const t = {};
  for (const m of list.filter(Boolean)) for (const [k, s] of Object.entries(m)) { (t[k] ||= { hits: 0, n: 0 }); t[k].hits += s.hits; t[k].n += s.n; }
  return Object.fromEntries(Object.entries(t).map(([k, x]) => [k, summarise(x.hits, x.n)]));
}

// ---------------------------------------------------------------- live ledger
export function newLearnLedger() { return { v: LEARN_VERSION, rows: [], changes: [], weights: {}, createdAt: Date.now() }; }

/** Log this bar's calls before the outcome is known. One row per coin/timeframe/bar. */
export function recordCalls(ledger, { symbol, interval, t, price, horizonAt, votes, forecastProb = null, blendProb = null }) {
  const L = ledger?.rows ? ledger : newLearnLedger();
  const id = `${symbol}:${interval}:${t}`;
  if (L.rows.some((r) => r.id === id)) return L;
  const rows = [...L.rows, { id, symbol, interval, t, price, horizonAt, votes, forecastProb, blendProb, resolved: false, up: null }];
  while (rows.length > CAP) { const j = rows.findIndex((r) => r.resolved); rows.splice(j < 0 ? 0 : j, 1); }
  return { ...L, rows };
}

/** Score rows whose horizon has passed, using closes the caller has. */
export function resolveCalls(ledger, candles, { symbol, interval }) {
  if (!ledger?.rows?.length || !candles?.length) return ledger;
  const lastT = candles[candles.length - 1].t;
  let changed = false;
  const rows = ledger.rows.map((r) => {
    if (r.resolved || r.symbol !== symbol || r.interval !== interval || r.horizonAt > lastT) return r;
    let close = null;
    for (let i = candles.length - 1; i >= 0; i--) if (candles[i].t <= r.horizonAt) { close = candles[i].c; break; }
    if (!Number.isFinite(close)) return r;
    changed = true;
    return { ...r, resolved: true, up: close > r.price ? 1 : -1, outcome: close };
  });
  return changed ? { ...ledger, rows } : ledger;
}

/** Live scores on this device: every indicator, the forecast, and the learned blend. */
export function liveScores(ledger, interval = null) {
  const tally = { forecast: { hits: 0, n: 0 }, blend: { hits: 0, n: 0 } };
  for (const key of Object.keys(INDICATORS)) tally[key] = { hits: 0, n: 0 };
  for (const r of ledger?.rows || []) {
    if (!r.resolved || (interval && r.interval !== interval)) continue;
    for (const [k, v] of Object.entries(r.votes || {})) if (v && tally[k]) { tally[k].n++; if (v === r.up) tally[k].hits++; }
    if (Number.isFinite(r.forecastProb) && r.forecastProb !== 0.5) { tally.forecast.n++; if ((r.forecastProb > 0.5 ? 1 : -1) === r.up) tally.forecast.hits++; }
    if (Number.isFinite(r.blendProb) && r.blendProb !== 0.5) { tally.blend.n++; if ((r.blendProb > 0.5 ? 1 : -1) === r.up) tally.blend.hits++; }
  }
  return Object.fromEntries(Object.entries(tally).map(([k, t]) => [k, summarise(t.hits, t.n)]));
}

/**
 * The weights the blend uses. Live evidence on this device takes over from
 * the history measurement as it accumulates (each is weighted by its sample
 * size); a reading with no clear record gets 0.
 */
export function learnedWeights(history, live) {
  const w = {};
  for (const k of Object.keys(INDICATORS)) {
    const h = history?.[k], l = live?.[k];
    const hn = h?.weight ? h.n : 0, ln = l?.weight ? l.n : 0;
    w[k] = hn + ln ? +(((h?.weight || 0) * hn + (l?.weight || 0) * ln) / (hn + ln)).toFixed(3) : 0;
  }
  return w;
}

/** Combine the forecast with the indicators that earned a vote. Returns P(up). */
export function blend(forecastProb, votes, weights) {
  let s = Number.isFinite(forecastProb) ? (forecastProb - 0.5) * 2 : 0;
  let wsum = Number.isFinite(forecastProb) ? 1 : 0;
  for (const [k, v] of Object.entries(votes || {})) { const w = weights?.[k] || 0; if (v && w) { s += v * w; wsum += Math.abs(w); } }
  if (!wsum) return 0.5;
  return Math.min(0.95, Math.max(0.05, 0.5 + (s / Math.max(wsum, 1)) / 2));
}

/** Note what changed in the weights, so the page can show the system deciding. */
export function diffWeights(before = {}, after = {}) {
  const out = [];
  for (const k of Object.keys(INDICATORS)) {
    const a = before[k] || 0, b = after[k] || 0;
    if (!a && b) out.push(`${INDICATORS[k].name} earned a vote (weight ${b > 0 ? '+' : ''}${b})${b < 0 ? ' — it has been wrong more often than right, so its call is now read in reverse' : ''}`);
    else if (a && !b) out.push(`${INDICATORS[k].name} lost its vote — its record fell back to coin-flip range`);
    else if (a && b && Math.abs(a - b) >= 0.1) out.push(`${INDICATORS[k].name} weight ${a > 0 ? '+' : ''}${a} → ${b > 0 ? '+' : ''}${b}`);
  }
  return out;
}

// ---------------------------------------------------------------- champion / challenger
/**
 * The blend was tested walk-forward before shipping (tools/evaluate-learning.mjs,
 * 2026-09-26, the same 1,440 forecasts as TESTED_ACCURACY, weights learned only
 * from candles before each forecast). Overall it TIED the plain forecast (53.9%
 * each): better on 1h, 4h and 1d, worse on 1m, 5m and 15m. A tie is not a
 * reason to switch, so the forecast starts as the champion and the blend has to
 * beat it on this device's own live record first.
 */
export const LEARN_TESTED = {
  tests: 1440, forecast: 53.9, blend: 53.9,
  byInterval: { '1m': [59.6, 57.5], '5m': [56.7, 54.2], '15m': [55.0, 53.8], '1h': [52.1, 54.2], '4h': [47.5, 50.4], '1d': [52.5, 53.3] },
  indicatorsAlone: { macd: 48.8, ema200: 51.6, emaCross: 50.1, supertrend: 48.7, stoch: 54.2, cci: 53.6, willr: 56.5, adx: 50.1, rsi: 53.1, mfi: 53.1, donchian: 50.0, bollinger: 49.7 },
  measuredOn: '2026-09-26',
};

export const SWITCH_MIN = 100;   // resolved live calls before a switch is considered
export const SWITCH_GAP = 3;     // points the challenger must lead by

/** Which method should make the call, given the live record. */
export function decideChampion(live, current = 'forecast') {
  const f = live?.forecast, b = live?.blend;
  if (!f || !b || f.n < SWITCH_MIN || b.n < SWITCH_MIN) return { champion: current, reason: `Needs ${SWITCH_MIN} resolved calls from each method before it can switch (forecast ${f?.n || 0}, blend ${b?.n || 0}).` };
  const lead = (x, y) => x.rate - y.rate >= SWITCH_GAP && x.lo > y.rate;
  if (current === 'forecast' && lead(b, f)) return { champion: 'blend', switched: true, reason: `The learned blend was right ${b.rate}% of the time against ${f.rate}% for the forecast over ${b.n} live calls, and its 95% range (${b.lo}–${b.hi}%) sits above the forecast's rate.` };
  if (current === 'blend' && !(b.rate >= f.rate)) return { champion: 'forecast', switched: true, reason: `The learned blend fell back to ${b.rate}% against the forecast's ${f.rate}%, so the forecast makes the call again.` };
  return { champion: current, reason: current === 'forecast' ? `The blend is at ${b.rate}% and the forecast at ${f.rate}% — not a clear enough lead to switch.` : `The blend is still ahead (${b.rate}% vs ${f.rate}%).` };
}
