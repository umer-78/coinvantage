// Self-improving forecast layer: a local prediction ledger, rolling accuracy
// windows, adaptive ensemble weights, a session state machine, a three-family
// ensemble, an indicator-strength meter, and risk/anomaly checks.
//
// Everything here is a pure function — no localStorage, no window. The views
// persist the ledger with store.js and feed it back in. Honesty rules from the
// rest of the app still apply: numbers shown are measured on THIS device's own
// resolved forecasts (or clearly marked as the published walk-forward record),
// never invented, and a small sample is always labelled as one.

import { computeAll } from './indicators.js';
import { findPatterns, shownProbUp, TESTED_ACCURACY } from './predict.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Bump when the way outcomes are scored changes, so old rows are not mixed in. */
export const MODEL_VERSION = 1;

/** Rolling windows the UI publishes (last N resolved forecasts). */
export const ACC_WINDOWS = [20, 50, 100];

/** Max forecast rows kept on device. Oldest resolved rows are dropped first. */
const LEDGER_CAP = 400;

// ---------------------------------------------------------------- ledger
export function newLedger() {
  return { modelVersion: MODEL_VERSION, entries: [], createdAt: Date.now(), updatedAt: Date.now() };
}

/**
 * Record a forecast BEFORE its outcome is known (the honest way to measure hit rate).
 * `horizonAt` is the candle time when the horizon completes.
 */
export function recordForecast(ledger, { symbol, interval, price, probUp, horizonBars, horizonAt, modelKey = 'ensemble' }) {
  const base = ledger?.entries ? ledger : newLedger();
  if (!Number.isFinite(price) || !Number.isFinite(probUp) || !horizonAt) return base;
  const id = `${symbol}:${interval}:${horizonAt}:${modelKey}`;
  if (base.entries.some((e) => e.id === id)) return base;
  const entry = {
    id,
    t: Date.now(),
    symbol, interval, modelKey,
    price,
    probUp,
    direction: probUp >= 0.5 ? 'UP' : 'DOWN',
    horizonBars,
    horizonAt,
    resolved: false,
    actualUp: null,
    correct: null,
    outcomePrice: null,
  };
  const entries = [...base.entries, entry];
  while (entries.length > LEDGER_CAP) {
    const firstResolved = entries.findIndex((e) => e.resolved);
    if (firstResolved === -1) { entries.shift(); break; }
    entries.splice(firstResolved, 1);
  }
  return { ...base, modelVersion: MODEL_VERSION, entries, updatedAt: Date.now() };
}

/**
 * Resolve forecasts whose horizon has passed, using only closes the caller
 * already has on screen. Filters by symbol+interval so one coin's path never
 * scores another coin's forecast.
 */
export function resolveDueLedger(ledger, candles, { symbol = null, interval = null } = {}) {
  if (!ledger?.entries?.length || !candles?.length) return ledger ?? newLedger();
  const lastT = candles[candles.length - 1].t;
  let changed = false;
  const entries = ledger.entries.map((e) => {
    if (e.resolved || e.horizonAt > lastT) return e;
    if (symbol && e.symbol !== symbol) return e;
    if (interval && e.interval !== interval) return e;
    let close = null;
    for (let i = candles.length - 1; i >= 0; i--) {
      if (candles[i].t <= e.horizonAt) { close = candles[i].c; break; }
    }
    if (!Number.isFinite(close)) return e;
    const actualUp = close > e.price;
    changed = true;
    return {
      ...e,
      resolved: true,
      actualUp,
      correct: actualUp === (e.direction === 'UP'),
      outcomePrice: close,
    };
  });
  return changed ? { ...ledger, entries, updatedAt: Date.now() } : ledger;
}

// ---------------------------------------------------------------- direction trust
const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/** Graded forecasts needed before this device's record moves the trust at all. */
export const MIN_GRADED_FOR_TRUST = 30;

/**
 * How far the direction lean on a timeframe can be trusted, re-measured on this
 * device's own graded forecasts. The local value is the shrink s (0 to 1) that
 * best explains the outcomes seen, sigmoid(s * logit p), found by maximum
 * likelihood on a grid; ties go to the smaller s. It is blended with the
 * release test, which counts as its 240 forecasts, so a handful of lucky calls
 * cannot move it far. A timeframe the release test found no direction on stays
 * at 0: one device's sample does not overrule 240 forecasts on 12 coins.
 */
export function learnedTrust(ledger, interval) {
  const prior = TESTED_ACCURACY.directionTrust[interval] ?? 0;
  const priorN = TESTED_ACCURACY.testsPerInterval;
  const graded = (ledger?.entries ?? []).filter((e) => e.resolved && e.interval === interval
    && Number.isFinite(e.probUp) && typeof e.actualUp === 'boolean');
  if (graded.length < MIN_GRADED_FOR_TRUST) return { trust: prior, prior, local: null, graded: graded.length };
  const local = fitShrink(graded.map((e) => ({ p: e.probUp, up: e.actualUp }))).s;
  const trust = prior > 0 ? (prior * priorN + local * graded.length) / (priorN + graded.length) : 0;
  return { trust, prior, local, graded: graded.length };
}

/**
 * The trust s on a 0..1 grid that best predicts graded outcomes {p, up}, and
 * how much better it fits than s = 0, i.e. than no direction at all (log
 * likelihood, in nats).
 */
export function fitShrink(graded) {
  let s = 0, best = -Infinity, none = 0;
  for (let i = 0; i <= 20; i++) {
    const k = i / 20;
    let ll = 0;
    for (const g of graded) {
      const q = clamp(sigmoid(k * logit(clamp(g.p, 1e-6, 1 - 1e-6))), 1e-9, 1 - 1e-9);
      ll += Math.log(g.up ? q : 1 - q);
    }
    if (i === 0) none = ll;
    if (ll > best + 1e-9) { best = ll; s = k; }
  }
  return { s, gain: best - none };
}

// Coins move together, so the forecasts made on one candle are closer to one
// observation than to twelve. The live check counts candles, not rows, and a
// direction would need to fit this much better than none on that count (about
// a 1-in-100 chance of luck) before it could be called proven.
export const LIVE_PROOF_NATS = 3.3;

/**
 * What the server's graded track record (signal_log rows) says about one
 * timeframe's direction: the trust that fits it best, the evidence for it per
 * independent candle, and the hit rate against always calling the more common
 * outcome.
 */
export function liveDirectionCheck(rows, interval) {
  const graded = (rows || []).filter((r) => r.interval === interval && r.resolved && r.prob_up !== null
    && [r.prob_up, r.price, r.outcome_price].every((x) => Number.isFinite(+x)))
    .map((r) => ({ p: +r.prob_up, up: +r.outcome_price > +r.price, t: r.candle_time }));
  const n = graded.length;
  if (!n) return { interval, n: 0 };
  const candles = new Set(graded.map((g) => g.t)).size;
  const { s, gain } = fitShrink(graded);
  const hit = graded.filter((g) => (g.p >= 0.5) === g.up).length / n;
  const rose = graded.filter((g) => g.up).length / n;
  const baseline = Math.max(rose, 1 - rose);
  const evidence = (gain * candles) / n;
  return { interval, n, candles, s, gain, evidence, hit, baseline, proven: s > 0 && evidence >= LIVE_PROOF_NATS && hit > baseline };
}

/** The trust every page uses for a timeframe: the release test, adjusted by this device's record. */
export function directionTrustFor(interval, ledger = loadLedger()) {
  return learnedTrust(ledger, interval);
}

// ---------------------------------------------------------------- accuracy
/** Hit rate over the last `window` resolved forecasts on this device. */
export function rollingAccuracy(ledger, window) {
  const done = (ledger?.entries ?? []).filter((e) => e.resolved && e.correct !== null).slice(-window);
  if (!done.length) return { window, total: 0, hits: 0, pct: null };
  const hits = done.filter((e) => e.correct).length;
  return { window, total: done.length, hits, pct: +((hits / done.length) * 100).toFixed(1) };
}

/** Trailing-window accuracy after each resolved row — the sparkline series. */
export function accuracySparkline(ledger, window = 20) {
  const done = (ledger?.entries ?? []).filter((e) => e.resolved && e.correct !== null);
  const pts = [];
  const q = [];
  let hits = 0;
  for (const e of done) {
    const v = e.correct ? 1 : 0;
    q.push(v); hits += v;
    if (q.length > window) hits -= q.shift();
    pts.push(+((hits / q.length) * 100).toFixed(1));
  }
  return pts;
}

/** Rolling 20/50/100 windows + trend, totals and model version. */
export function learningStatus(ledger) {
  const entries = ledger?.entries ?? [];
  const resolved = entries.filter((e) => e.resolved);
  const windows = {};
  for (const w of ACC_WINDOWS) windows[w] = rollingAccuracy(ledger, w);
  const a20 = windows[20].pct;
  const a50 = windows[50].pct;
  let trend = 'unknown';
  if (resolved.length < 10) trend = 'warming-up';
  else if (a20 !== null && a50 !== null) {
    if (a20 > a50 + 3) trend = 'improving';
    else if (a20 < a50 - 3) trend = 'declining';
    else trend = 'stable';
  }
  return {
    modelVersion: ledger?.modelVersion ?? MODEL_VERSION,
    total: entries.length,
    resolved: resolved.length,
    pending: entries.length - resolved.length,
    windows,
    trend,
    updatedAt: ledger?.updatedAt ?? null,
  };
}

/**
 * Shrink an overconfident probability toward 0.5 when this device's own recent
 * record says confidence has not been earned. Leaves the number alone when the
 * sample is too small or the record is fine.
 */
export function dampenConfidence(probUp, ledger) {
  const st = learningStatus(ledger);
  const acc = st.windows[50].pct ?? st.windows[20].pct;
  if (acc === null || st.resolved < 15) return probUp;
  if (acc >= 55) return probUp;
  const shrink = acc < 40 ? 0.5 : 0.75;
  return 0.5 + (probUp - 0.5) * shrink;
}

/**
 * Family weights for the three-model ensemble, steered by rolling accuracy:
 * below 40% → more mean-reversion, less momentum; above 60% → more momentum.
 */
export function adaptiveWeights(ledger) {
  const st = learningStatus(ledger);
  const acc = st.windows[50].pct ?? st.windows[20].pct;
  const w = { momentum: 1, reversion: 1, pattern: 1 };
  if (acc === null || st.resolved < 10) return { ...w, source: 'default', accuracy: null };
  if (acc < 40) { w.momentum = 0.5; w.reversion = 1.5; }
  else if (acc > 60) { w.momentum = 1.5; w.reversion = 0.75; }
  return { ...w, source: 'adaptive', accuracy: acc };
}

// ---------------------------------------------------------------- 3-model ensemble
/**
 * Three independent families, blended with ledger-adaptive weights:
 *   momentum   — EMA stack + MACD (continuation)
 *   reversion  — RSI + Bollinger extremes (contrarian)
 *   pattern    — historical chart analogs
 *
 * Shown as an experimental cross-check beside the full 7-model engine. It is
 * NOT part of the published walk-forward accuracy — say so in the UI.
 */
export function threeModelEnsemble(candles, { ledger = null, horizon = 12, window = 40 } = {}) {
  if (!candles || candles.length < 100) return { ok: false, reason: 'Need at least 100 candles for the three-family ensemble.' };
  const ind = computeAll(candles);
  const n = candles.length - 1;
  const close = candles[n].c;

  // momentum
  let momentum = 0.5;
  const e20 = ind.ema20[n], e50 = ind.ema50[n], e200 = ind.ema200[n];
  const hist = ind.macd.hist[n];
  if (e20 !== null && e50 !== null) momentum += e20 > e50 ? 0.12 : -0.12;
  if (e200 !== null) momentum += close > e200 ? 0.08 : -0.08;
  if (hist !== null && ind.atr[n]) momentum += clamp(hist / (ind.atr[n] * 4), -0.15, 0.15);
  momentum = clamp(momentum, 0.05, 0.95);

  // mean reversion
  let reversion = 0.5;
  const r = ind.rsi[n];
  if (r !== null) reversion = clamp(0.5 + (50 - r) / 100, 0.05, 0.95);
  if (ind.bb.upper[n] !== null && ind.bb.lower[n] !== null) {
    if (close < ind.bb.lower[n]) reversion = clamp(reversion + 0.12, 0.05, 0.95);
    else if (close > ind.bb.upper[n]) reversion = clamp(reversion - 0.12, 0.05, 0.95);
  }

  // pattern analogs
  const pat = findPatterns(candles, n, { window, horizon, topK: 8, minCorr: 0.5 });
  const pattern = pat.matches?.length >= 3 ? clamp(pat.probUp, 0.05, 0.95) : 0.5;

  const w = adaptiveWeights(ledger);
  const probs = { momentum, reversion, pattern };
  const keys = ['momentum', 'reversion', 'pattern'];
  let sum = 0, wsum = 0;
  for (const k of keys) { sum += probs[k] * w[k]; wsum += w[k]; }
  const raw = wsum ? sum / wsum : 0.5;
  const probUp = dampenConfidence(raw, ledger);

  return {
    ok: true,
    probUp,
    direction: probUp >= 0.54 ? 'UP' : probUp <= 0.46 ? 'DOWN' : 'SIDEWAYS',
    weights: w,
    models: keys.map((k) => ({
      key: k,
      name: k === 'momentum' ? 'Momentum (EMA/MACD)' : k === 'reversion' ? 'Mean reversion (RSI/BB)' : 'Pattern analogs',
      probUp: probs[k],
      weight: w[k],
      weightPct: Math.round((w[k] / wsum) * 100),
    })),
    patternMatches: pat.matches?.length ?? 0,
    dampened: Math.abs(probUp - raw) > 1e-9,
    rawProbUp: raw,
    experimental: true,
  };
}

// ---------------------------------------------------------------- signal meter
/**
 * UI-only strength meter for the indicator-agreement score: the conventional
 * strong buy → strong sell scale readers expect. This is deliberately separate
 * from labelFor()/tradeSummary(), which describe what was MEASURED (higher
 * scores were less likely to rise) and must never instruct. Pair the meter with
 * upRateFor() wherever both are shown.
 */
export function signalMeter(score) {
  const s = clamp(Number.isFinite(score) ? score : 0, -100, 100);
  const pos = (s + 100) / 2; // percent along the track, 0 = strong sell, 100 = strong buy
  let label, tone;
  // Momentum words, not orders: measured, the highest scores were the LEAST
  // likely to keep rising (see SCORE_BUCKETS_TESTED), so "Strong buy" said the
  // opposite of the data.
  if (s >= 45) { label = 'Strong rise'; tone = 'up'; }
  else if (s >= 18) { label = 'Rising'; tone = 'up'; }
  else if (s <= -45) { label = 'Strong fall'; tone = 'down'; }
  else if (s <= -18) { label = 'Falling'; tone = 'down'; }
  else { label = 'Flat'; tone = 'flat'; }
  return { score: s, pos, label, tone };
}

// ---------------------------------------------------------------- risk & anomalies
/** Unusual bars on the chart currently on screen: volume, range, RSI extremes. */
export function anomalyFlags(candles) {
  const out = [];
  if (!candles || candles.length < 40) return out;
  const ind = computeAll(candles);
  const n = candles.length - 1;
  const vs = ind.volSma[n];
  if (vs && candles[n].v > vs * 3) {
    out.push({ key: 'volume', level: 'warn', text: `Volume is ${(candles[n].v / vs).toFixed(1)}× its average — an unusual burst on this chart.` });
  }
  const a = ind.atr[n];
  if (a && n > 0) {
    const move = Math.abs(candles[n].c - candles[n - 1].c);
    if (move > 3 * a) out.push({ key: 'move', level: 'down', text: `Price moved ${(move / a).toFixed(1)} ATR in a single bar — an anomalous jump. Treat any signal here with extra caution.` });
  }
  const r = ind.rsi[n];
  if (r !== null && (r >= 80 || r <= 20)) {
    out.push({ key: 'rsi', level: 'warn', text: `RSI ${r.toFixed(0)} is in an extreme zone — mean-reversion risk is elevated.` });
  }
  return out;
}

/**
 * Plain-language risk warnings assembled from what is already on the page.
 * Every line is tied to a number the reader can see; nothing is invented.
 */
export function riskWarnings({ signal = null, forecast = null, backtest = null, anomalies = [], interval = null, noEdgeTimeframe = false, noEdgeText = null, trust = undefined } = {}) {
  const out = [];
  for (const a of anomalies) out.push({ key: `anomaly:${a.key}`, level: a.level || 'warn', text: a.text });

  if (signal?.plan && signal.plan.expectancyR !== null && signal.plan.expectancyR !== undefined && signal.plan.expectancyR <= 0) {
    out.push({
      key: 'geometry',
      level: 'warn',
      text: `Stop/target geometry on ${interval || 'this'} timeframe tested at ${signal.plan.expectancyR}R per trade — slightly negative before fees. Read the plan as structure, not as an edge.`,
    });
  }
  if (noEdgeTimeframe) {
    out.push({
      key: 'no-edge',
      level: 'down',
      text: noEdgeText || `The forecast engine has no measured edge on the ${interval} chart (at or below its baseline). A probability shown here is background, not a reason to act.`,
    });
  }
  if (backtest?.ok && backtest.totalReturnPct < 0 && backtest.buyHoldPct > 0 && backtest.tradeCount >= 10) {
    out.push({
      key: 'backtest',
      level: 'down',
      text: `Backtest over ${backtest.tradeCount} trades lost ${Math.abs(backtest.totalReturnPct).toFixed(1)}% while simply holding gained ${backtest.buyHoldPct.toFixed(1)}%.`,
    });
  }
  if (forecast?.ok && forecast.confidence === 'Low') {
    out.push({ key: 'low-conf', level: 'warn', text: 'Forecast confidence is low — models barely agree or recent accuracy is weak. Size down or wait.' });
  }
  if (signal?.ok && Math.abs(signal.score) >= 45 && forecast?.ok) {
    const leanUp = signal.score > 0;
    const shown = shownProbUp(forecast.probUp, interval, trust);
    const fcLeanUp = shown >= 0.54;
    const fcLeanDown = shown <= 0.46;
    if ((leanUp && fcLeanDown) || (!leanUp && fcLeanUp)) {
      out.push({ key: 'conflict', level: 'warn', text: 'The chart reading and the forecast lean opposite ways — a conflict is a reason to wait, not to pick a side.' });
    }
  }
  return out;
}

// ---------------------------------------------------------------- session machine
export const SESSION_STATES = ['idle', 'running', 'stopped'];

export function initialSession(status = 'idle') {
  return { status: SESSION_STATES.includes(status) ? status : 'idle', since: Date.now(), resets: 0 };
}

/**
 * idle → running → stopped → running, and RESET from any state back to idle.
 * Returns the same object when the event is a no-op so callers can skip saves.
 */
export function sessionReducer(sess, event) {
  const cur = sess?.status ?? 'idle';
  if (event === 'RESET') {
    return { status: 'idle', since: Date.now(), resets: (sess?.resets ?? 0) + 1 };
  }
  if (event === 'START') {
    if (cur === 'running') return sess;
    return { ...(sess ?? initialSession()), status: 'running', since: Date.now() };
  }
  if (event === 'STOP') {
    if (cur !== 'running') return sess;
    return { ...(sess ?? initialSession()), status: 'stopped', since: Date.now() };
  }
  return sess ?? initialSession();
}

export function sessionLabel(status) {
  if (status === 'running') return 'AI running';
  if (status === 'stopped') return 'AI stopped';
  return 'Idle';
}

// ---------------------------------------------------------------- persistence helpers
// The ledger itself is pure; these thin wrappers keep localStorage access in
// the views' layer so the module stays Node-safe for tests.
const LEDGER_KEY = 'aiLedger';

export const LEARN_KEY = LEDGER_KEY;

export function loadLedger(fallback = null) {
  try {
    if (typeof localStorage === 'undefined') return fallback ?? newLedger();
    const raw = localStorage.getItem(`cv:${LEDGER_KEY}`);
    if (raw === null) return fallback ?? newLedger();
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.entries)) return fallback ?? newLedger();
    return { ...newLedger(), ...parsed };
  } catch {
    return fallback ?? newLedger();
  }
}

export function saveLedger(ledger) {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(`cv:${LEDGER_KEY}`, JSON.stringify(ledger));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- sparkline
/** Tiny inline SVG for the accuracy trend. Empty string when there is no data. */
export function sparklineSvg(values, { width = 120, height = 28, color = 'currentColor' } = {}) {
  if (!values?.length) return '';
  const min = Math.min(...values, 50);
  const max = Math.max(...values, 50);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = values.length === 1 ? width : (i / (values.length - 1)) * width;
    const y = height - ((v - min) / span) * (height - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true"><polyline fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" points="${pts}"/></svg>`;
}
