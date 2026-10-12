// Every reading on coins shaped like the awkward ones on a real exchange:
// micro-prices, six- and eight-figure prices, stablecoins, a flat line, pumps,
// crashes, no volume and brand-new listings. Nothing may throw, no number may
// be NaN or infinite, no sentence may print "undefined", and every trade plan
// must have its stop and targets on the right sides of the price.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeAll } from '../js/lib/indicators.js';
import { generateSignal, backtest } from '../js/lib/signals.js';
import { forecast, summarizeForecast } from '../js/lib/predict.js';
import { timingOutlook, condenseTiming, summarizeTiming } from '../js/lib/timing.js';
import { analyzeHistory } from '../js/lib/history.js';
import { threeModelEnsemble, anomalyFlags, directionTrustFor } from '../js/lib/selfimprove.js';
import { adviseCoin } from '../js/lib/advice.js';
import { tradeSummary } from '../js/lib/summary.js';
import { historyMatch, analogVerdict } from '../js/lib/analog.js';
import { replayAll, newState, DEFAULT_CONFIG, stats } from '../js/lib/autotrader.js';

const STEP = { '1h': 36e5, '1d': 864e5 };
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function walk(n, iv, { p0, vol, seed, shape = () => 0, flat = false, noVolume = false }) {
  const r = rng(seed), out = [];
  let p = p0;
  for (let i = 0; i < n; i++) {
    const o = p, c = flat ? p0 : o * Math.exp(shape(i, n) + (r() - 0.5) * 2 * vol);
    out.push({ t: Date.UTC(2026, 0, 1) + i * STEP[iv], o, h: flat ? p0 : Math.max(o, c) * (1 + r() * vol / 2), l: flat ? p0 : Math.min(o, c) * (1 - r() * vol / 2), c, v: noVolume ? 0 : 1000 + r() * 500 });
    p = c;
  }
  return out;
}
const COINS = {
  BTC: { p0: 100000, vol: 0.012, seed: 3 },
  PEPE: { p0: 0.00000123, vol: 0.04, seed: 5 },
  USDT: { p0: 1, vol: 0.0001, seed: 7 },
  FLAT: { p0: 2.5, vol: 0, seed: 9, flat: true },
  PUMP: { p0: 0.5, vol: 0.02, seed: 11, shape: (i, n) => (i > n - 25 ? 0.06 : 0) },
  DUMP: { p0: 50, vol: 0.02, seed: 13, shape: (i, n) => (i > n - 25 ? -0.08 : 0) },
  CRASH: { p0: 80, vol: 0.03, seed: 15, shape: (i, n) => (i > n * 0.6 ? -0.12 : 0) },
  NOVOL: { p0: 3, vol: 0.01, seed: 17, noVolume: true },
  HUGE: { p0: 2.4e7, vol: 0.01, seed: 19 },
};
const LENGTHS = { full: (iv) => (iv === '1d' ? 1000 : 600), new60: () => 60, new25: () => 25, one: () => 1, none: () => 0 };

function check(where, v, path = '', seen = new Set()) {
  if (typeof v === 'number') return assert.ok(Number.isFinite(v), `${where} ${path} = ${v}`);
  if (typeof v === 'string') return assert.doesNotMatch(v, /\bNaN\b|undefined|Infinity|\[object Object\]/, `${where} ${path}: ${v.slice(0, 140)}`);
  if (!v || typeof v !== 'object' || seen.has(v)) return;
  seen.add(v);
  // long numeric series (indicators) may hold null for warm-up bars, never NaN
  if (Array.isArray(v) && v.length > 50 && typeof v.find((x) => x !== null) === 'number') {
    const bad = v.findIndex((x) => x !== null && !Number.isFinite(x));
    return assert.equal(bad, -1, `${where} ${path}[${bad}] = ${v[bad]}`);
  }
  for (const [k, x] of Object.entries(v)) check(where, x, `${path}.${k}`, seen);
}
function sides(where, plan, price) {
  if (!plan) return;
  const [t1, t2, t3] = plan.takeProfits;
  const ok = plan.side === 'long'
    ? plan.stopLoss < price && price < t1 && t1 <= t2 && t2 <= t3
    : plan.stopLoss > price && price > t1 && t1 >= t2 && t2 >= t3 && t3 > 0;
  assert.ok(ok, `${where} ${plan.side}: price ${price}, stop ${plan.stopLoss}, targets ${plan.takeProfits}`);
  assert.ok(plan.entryZone[0] <= plan.entryZone[1], `${where} entry zone ${plan.entryZone}`);
}

for (const iv of ['1h', '1d']) {
  test(`every reading on awkward coins, ${iv} chart`, () => {
    for (const [sym, spec] of Object.entries(COINS)) {
      for (const [len, n] of Object.entries(LENGTHS)) {
        const where = `${sym}/${iv}/${len}`;
        const candles = walk(n(iv), iv, spec);
        if (candles.length) check(`${where} indicators`, computeAll(candles));
        const signal = generateSignal(candles, { interval: iv });
        check(`${where} signal`, signal);
        if (signal.ok) sides(where, signal.plan, candles.at(-1).c);
        check(`${where} backtest`, backtest(candles, { interval: iv }));
        const fc = forecast(candles, { horizon: 12, interval: iv, intervalMs: STEP[iv], fast: true });
        check(`${where} forecast`, fc);
        const fcs = fc.ok ? summarizeForecast(fc, iv, directionTrustFor(iv).trust) : null;
        const timing = fc.ok ? timingOutlook(fc, { intervalMs: STEP[iv] }) : null;
        check(`${where} timing`, [timing, summarizeTiming(timing), condenseTiming(timing)]);
        const history = iv === '1d' ? analyzeHistory(candles) : null;
        check(`${where} history`, history);
        check(`${where} ensemble`, threeModelEnsemble(candles, { ledger: null }));
        check(`${where} anomalies`, anomalyFlags(candles));
        check(`${where} advice`, adviseCoin({ signal, forecast: fc, timing, history, interval: iv }));
        // exactly what the coin page hands its plain-English summary
        const sum = tradeSummary({ signal: signal.ok ? { ...signal, coinSymbol: sym } : signal, forecast: fcs, timing: condenseTiming(timing), interval: iv, horizonText: '12 hours', fmt: (v) => (Number.isFinite(v) ? `$${v}` : `${v}`), dur: (b) => `${b} candles` });
        check(`${where} summary`, sum);
        const match = historyMatch(candles, { interval: iv });
        check(`${where} analog`, [match, analogVerdict(match, signal.score ?? 0, { symbol: sym, interval: iv })]);
      }
    }
  });
}

test('the AI trader on all of them together', () => {
  for (const iv of ['1h', '1d']) {
    const by = Object.fromEntries(Object.entries(COINS).map(([s, spec]) => [s, walk(LENGTHS.full(iv), iv, spec)]));
    const st = newState(DEFAULT_CONFIG);
    replayAll(st, DEFAULT_CONFIG, by);
    check(`trader ${iv}`, [st, stats(st)]);
    assert.ok(st.closed.length > 0, 'it trades');
    for (const t of st.closed) assert.ok(t.entry > 0 && t.exit > 0, `${t.symbol} ${t.entry} → ${t.exit}`);
  }
});

test('the summary times the move from the timing model, and says nothing without one', () => {
  const candles = walk(600, '1h', COINS.BTC);
  const fc = forecast(candles, { horizon: 12, interval: '1h', intervalMs: STEP['1h'], fast: true });
  const t = condenseTiming(timingOutlook(fc, { intervalMs: STEP['1h'] }));
  assert.ok(t, 'this chart has a timing reading');
  const signal = { ...generateSignal(candles, { interval: '1h' }), coinSymbol: 'BTC' };
  const how = (timing) => tradeSummary({ signal, forecast: null, timing, interval: '1h', horizonText: '12 hours', fmt: (v) => `$${v}`, dur: (b) => `${b}h` }).steps.find((s) => s.label === 'How long');
  assert.match(how(t).text, new RegExp(`about ${t.bars}h .* near \\$${String(t.targetPrice).replace('.', '\\.')}, then turning down about ${t.turnBars}h`));
  assert.equal(how(null), undefined);
  assert.equal(how(condenseTiming({ ok: false, reason: 'Only 2 similar past charts' })), undefined, 'no reading, no claim');
});
