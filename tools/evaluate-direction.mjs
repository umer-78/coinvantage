// usage: node tools/evaluate-direction.mjs klines.json
//
// Is there a direction call that beats chance on some chart? The forecast
// engine's own lean does not (TESTED_ACCURACY in js/lib/predict.js), so this
// looks for a simpler rule that does, and keeps one only if it passes a test
// decided before the run.
//
// Candidates, each using only candles up to the call:
//   mom k z    the sign of the last k candles' move, when it is at least z
//              of its usual size (100-candle volatility × √k)
//   rev k z    the opposite of mom
//   trend n z  above or below the n-candle EMA, by at least z volatilities
//   fade n z   the opposite of trend
//   btc k      for every other coin: the sign of BTC's last k candles
// No call when the condition is not met: a rule may stay quiet.
//
// Outcome: up or down over the chart's forecast horizon (DEFAULT_HORIZON in
// js/ai/context.js), one test per horizon (no overlapping outcomes).
//
// Decided before the run. Each chart's test dates are split in half by time,
// the same date for every coin. On the older half the rule with the largest
// lead over the majority direction is picked, among rules that call at least
// 15% of the time, at least 300 times on at least 30 dates. On the newer half
// it is kept only if (1) it is right at least 52% of the time, (2) at least 2
// points more often than always naming that half's commoner direction, which
// uses hindsight, and (3) its edge over 50% has a t-statistic of at least 2
// across dates: coins move together, so each date counts once.
import { readFileSync } from 'node:fs';

const raw = JSON.parse(readFileSync(process.argv[2] || 'klines.json', 'utf8'));
const H = { '1s': 30, '5s': 24, '10s': 18, '1m': 15, '5m': 12, '15m': 8, '1h': 12, '4h': 6, '1d': 7, '1w': 4 };
const WARM = 210;
const r1 = (v) => +v.toFixed(1);

function prep(rows) {
  const c = rows.map((r) => r[4]), t = rows.map((r) => r[0]), n = c.length;
  const lr = c.map((v, i) => (i ? Math.log(v / c[i - 1]) : 0));
  const sig = new Array(n).fill(NaN);
  let s1 = 0, s2 = 0;
  for (let i = 1; i < n; i++) {
    s1 += lr[i]; s2 += lr[i] * lr[i];
    if (i > 100) { s1 -= lr[i - 100]; s2 -= lr[i - 100] * lr[i - 100]; }
    const m = Math.min(i, 100);
    if (i >= 100) sig[i] = Math.sqrt(Math.max(s2 / m - (s1 / m) ** 2, 1e-12));
  }
  const ema = {};
  for (const len of [20, 50, 100, 200]) {
    const a = 2 / (len + 1), e = new Array(n);
    e[0] = c[0];
    for (let i = 1; i < n; i++) e[i] = a * c[i] + (1 - a) * e[i - 1];
    ema[len] = e;
  }
  return { c, t, n, sig, ema, at: new Map(t.map((x, i) => [x, i])) };
}

function rulesFor(h) {
  const ks = [...new Set([h, 2 * h, 4 * h, 12 * h, 24, 72, 168])].filter((k) => k <= 200).sort((a, b) => a - b);
  const out = [];
  for (const k of ks) for (const z of [0, 0.5, 1, 2]) {
    out.push({ name: `mom ${k} ${z}`, f: (s, i) => { const r = Math.log(s.c[i] / s.c[i - k]), u = s.sig[i] * Math.sqrt(k); return Math.abs(r) >= z * u && r !== 0 ? Math.sign(r) : 0; } });
    out.push({ name: `rev ${k} ${z}`, f: (s, i) => { const r = Math.log(s.c[i] / s.c[i - k]), u = s.sig[i] * Math.sqrt(k); return Math.abs(r) >= z * u && r !== 0 ? -Math.sign(r) : 0; } });
  }
  for (const len of [20, 50, 100, 200]) for (const z of [0, 1, 2]) {
    out.push({ name: `trend ${len} ${z}`, f: (s, i) => { const d = Math.log(s.c[i] / s.ema[len][i]) / s.sig[i]; return Math.abs(d) >= z && d !== 0 ? Math.sign(d) : 0; } });
    out.push({ name: `fade ${len} ${z}`, f: (s, i) => { const d = Math.log(s.c[i] / s.ema[len][i]) / s.sig[i]; return Math.abs(d) >= z && d !== 0 ? -Math.sign(d) : 0; } });
  }
  for (const k of [h, 4 * h]) out.push({ name: `btc ${k}`, btc: true, f: (s, i, b, j) => { if (!b || j === undefined || j < k) return 0; const r = Math.log(b.c[j] / b.c[j - k]); return r ? Math.sign(r) : 0; } });
  return out;
}

const report = { measuredOn: new Date().toISOString().slice(0, 10), charts: {} };
for (const iv of Object.keys(H)) {
  const keys = Object.keys(raw).filter((k) => k.endsWith(`:${iv}`) && raw[k].length > WARM + 4 * H[iv] + 50);
  if (keys.length < 5) continue;
  const h = H[iv];
  const series = Object.fromEntries(keys.map((k) => [k.split(':')[0], prep(raw[k])]));
  const btc = series.BTC || null;
  // every test: coin, date, outcome; rules evaluated on the same tests
  const tests = [];
  for (const [coin, s] of Object.entries(series)) {
    for (let i = WARM; i + h < s.n; i += h) {
      if (!(s.sig[i] > 0)) continue;
      const y = Math.sign(Math.log(s.c[i + h] / s.c[i]));
      if (!y) continue;
      tests.push({ coin, s, i, t: s.t[i], y, j: coin === 'BTC' ? undefined : btc?.at.get(s.t[i]) });
    }
  }
  if (tests.length < 600) continue;
  const dates = [...new Set(tests.map((x) => x.t))].sort((a, b) => a - b);
  const cut = dates[Math.floor(dates.length / 2)];
  const halves = [tests.filter((x) => x.t < cut), tests.filter((x) => x.t >= cut)];
  const score = (rule, rows) => {
    let calls = 0, right = 0, ups = 0;
    const perDate = new Map();
    for (const x of rows) {
      if (rule.btc && x.coin === 'BTC') continue;
      const p = rule.f(x.s, x.i, btc, x.j);
      if (!p) continue;
      calls++; if (p === x.y) right++; if (x.y > 0) ups++;
      const d = perDate.get(x.t) || [0, 0]; d[0] += p === x.y ? 1 : 0; d[1]++; perDate.set(x.t, d);
    }
    const eligible = rows.filter((x) => !(rule.btc && x.coin === 'BTC')).length;
    const edges = [...perDate.values()].map(([a, b]) => a / b - 0.5);
    const m = edges.reduce((a, b) => a + b, 0) / (edges.length || 1);
    const sd = Math.sqrt(edges.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(edges.length - 1, 1));
    const tstat = edges.length > 1 && sd > 0 ? m / (sd / Math.sqrt(edges.length)) : 0;
    const hit = calls ? (right / calls) * 100 : 0;
    const majority = calls ? (Math.max(ups, calls - ups) / calls) * 100 : 0;
    return { calls, coverage: eligible ? (calls / eligible) * 100 : 0, dates: perDate.size, hit, majority, lead: hit - majority, tstat };
  };
  const rules = rulesFor(h);
  const older = rules.map((rule) => ({ rule, s: score(rule, halves[0]) }))
    .filter((x) => x.s.coverage >= 15 && x.s.calls >= 300 && x.s.dates >= 30)
    .sort((a, b) => b.s.lead - a.s.lead);
  if (!older.length) { console.log(`${iv.padEnd(4)} no rule called often enough on the older half`); continue; }
  const pick = older[0];
  const newer = score(pick.rule, halves[1]);
  const keep = newer.hit >= 52 && newer.hit - newer.majority >= 2 && newer.tstat >= 2;
  const fmt = (s) => `right ${r1(s.hit)}% of ${s.calls} calls (${r1(s.coverage)}% of moments, ${s.dates} dates), commoner direction ${r1(s.majority)}%, t ${s.tstat.toFixed(2)}`;
  console.log(`${iv.padEnd(4)} ${keys.length} coins, ${halves[0].length} + ${halves[1].length} tests · picked "${pick.rule.name}" · older: ${fmt(pick.s)} · newer: ${fmt(newer)} → ${keep ? 'USE' : 'NO EDGE'}`);
  report.charts[iv] = { coins: keys.length, tests: [halves[0].length, halves[1].length], rule: pick.rule.name, older: { hit: r1(pick.s.hit), calls: pick.s.calls, coverage: r1(pick.s.coverage), majority: r1(pick.s.majority), t: +pick.s.tstat.toFixed(2) }, newer: { hit: r1(newer.hit), calls: newer.calls, coverage: r1(newer.coverage), majority: r1(newer.majority), t: +newer.tstat.toFixed(2) }, keep };
}
console.log(`\nJSON ${JSON.stringify(report)}`);
