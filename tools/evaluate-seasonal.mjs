// usage: node tools/evaluate-seasonal.mjs klines.json
//
// Crypto is busier at some hours of the day than others (European and US
// trading hours against the Asian night — the same pattern Andersen &
// Bollerslev (1997) found in currencies). The ranges use the volatility of the
// last 100 candles, which on 5m is the last 8 hours whatever the hour now, so
// a range drawn at a quiet hour just before a busy one is too narrow, and the
// other way round.
//
// Here each candle's move is first divided by the usual size of moves at that
// hour of the day (UTC, measured over the same 1,500-candle window the forecast
// gets), the 100-candle volatility is taken of those, and the range for the
// next H candles is scaled back up by the usual size of moves in the hours
// they fall in. Past moves are standardised the same way, so the range is
// still the coin's own past moves in units of the volatility at the time.
// "hour" uses each hour's own figure; "hour3" averages each hour with the
// hours either side (each hour has only ~60 candles in a window, so its own
// figure is noisy). 4h candles fall in six slots of the day; they are not
// averaged. 1d is left out: its horizon is a week.
//
// Same tests as tools/evaluate-volatility.mjs: 24 coins, one test per horizon,
// mean interval score (width + 2/α × miss) in units of the coin's usual move.
//
// Decided before the run: each series is cut in half by time. On the older
// half each chart picks whichever of plain, hour and hour3 has the lowest mean
// 80% interval score. A time-of-day version is used only if, on the newer half,
// its mean 80% interval score is at least 2% lower than the plain one's and its
// 80% range holds no more than a point further from 80% than the plain range.
import { readFileSync } from 'node:fs';
import { _internals } from '../js/lib/predict.js';

const { rollingSigma } = _internals;
const raw = JSON.parse(readFileSync(process.argv[2] || 'klines.json', 'utf8'));
const H = { '5m': 12, '15m': 8, '1h': 12, '4h': 6 }; // DEFAULT_HORIZON in js/ai/context.js
const STEP = { '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 144e5 };
const WINDOW = 1500;
const METHODS = ['plain', 'hour', 'hour3'];
const r1 = (v) => +v.toFixed(1), r3 = (v) => +v.toFixed(3);
const quantile = (sorted, p) => { const k = (sorted.length - 1) * p, lo = Math.floor(k); return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (k - lo); };
const hourOf = (t) => Math.floor(t / 36e5) % 24; // UTC hour of a time in ms

/**
 * Usual size of a move at each hour of the day, as a share of the usual move
 * overall (squared: a variance ratio). Hours with under 10 moves count as 1.
 */
function hourProfile(ret, times, last, smooth) {
  const sum = new Float64Array(24), cnt = new Float64Array(24);
  let all = 0;
  for (let i = 1; i <= last; i++) { const b = hourOf(times[i]); sum[b] += Math.abs(ret[i]); cnt[b]++; all += Math.abs(ret[i]); }
  const mean = all / last;
  const avg = Array.from({ length: 24 }, (_, b) => (cnt[b] >= 10 ? sum[b] / cnt[b] : null));
  return Array.from({ length: 24 }, (_, b) => {
    let v = avg[b];
    if (smooth) {
      const near = [(b + 23) % 24, b, (b + 1) % 24].map((x) => avg[x]).filter((x) => x !== null);
      v = near.length ? near.reduce((a, x) => a + x, 0) / near.length : null;
    }
    return v !== null && mean > 0 && v > 0 ? (v / mean) ** 2 : 1;
  });
}

// The range for a window: quantiles of past H-candle moves in units of their
// (time-of-day adjusted) volatility, times the volatility now.
function range(win, times, h, method, step) {
  const last = win.length - 1;
  const ret = new Float64Array(win.length);
  for (let i = 1; i <= last; i++) ret[i] = Math.log(win[i] / win[i - 1]);
  const prof = method === 'plain' ? null : hourProfile(ret, times, last, method === 'hour3');
  const f = (t) => (prof ? prof[hourOf(t)] : 1);
  // 100-candle σ of the adjusted moves (the engine's rollingSigma on the plain ones)
  const S1 = new Float64Array(win.length), S2 = new Float64Array(win.length), Fp = new Float64Array(win.length);
  for (let i = 1; i <= last; i++) {
    const fi = f(times[i]), x = ret[i] / Math.sqrt(fi);
    S1[i] = S1[i - 1] + x; S2[i] = S2[i - 1] + x * x; Fp[i] = Fp[i - 1] + fi;
  }
  const sig = (j) => {
    const a = Math.max(1, j - 99), m = j - a + 1;
    if (m < 2) return 0.02;
    const mu = (S1[j] - S1[a - 1]) / m;
    return Math.sqrt(Math.max((S2[j] - S2[a - 1]) / m - mu * mu, 1e-10));
  };
  // the hours a horizon covers: candles j+1..j+h
  const F = (j) => {
    if (j + h <= last) return Fp[j + h] - Fp[j];
    let s = 0;
    for (let k = 1; k <= h; k++) s += f(j + k <= last ? times[j + k] : times[last] + (j + k - last) * step);
    return s;
  };
  const zl = [];
  for (let j = 101; j <= last - h; j++) { const s = sig(j) * Math.sqrt(F(j)); if (s > 0) zl.push(Math.log(win[j + h] / win[j]) / s); }
  if (zl.length < 60) return null;
  const zs = Float64Array.from(zl).sort();
  const med = quantile(zs, 0.5), sd = sig(last) * Math.sqrt(F(last));
  const b = (p) => (quantile(zs, p) - med) * sd;
  return { l50: b(0.25), u50: b(0.75), l80: b(0.1), u80: b(0.9), l90: b(0.05), u90: b(0.95), sigPlain: method === 'plain' ? sig(last) : null };
}

// the plain range must be the engine's: its σ is rollingSigma
{
  const c = Array.from({ length: 400 }, (_, i) => 100 * Math.exp(Math.sin(i * 0.37) * 0.05 + i * 0.001));
  const t = c.map((_, i) => i * 36e5);
  const got = range(c, t, 6, 'plain', 36e5).sigPlain;
  if (Math.abs(got / rollingSigma(c, 399) - 1) > 1e-6) throw new Error('plain σ differs from the engine');
}

const out = { measuredOn: new Date().toISOString().slice(0, 10), charts: {} };
for (const iv of Object.keys(H)) {
  const keys = Object.keys(raw).filter((k) => k.endsWith(`:${iv}`) && raw[k].length > WINDOW + 200);
  if (!keys.length) continue;
  const h = H[iv];
  const rows = Object.fromEntries(METHODS.map((m) => [m, [[], []]]));
  for (const key of keys) {
    const closes = raw[key].map((r) => r[4]), times = raw[key].map((r) => r[0]);
    const origins = [];
    for (let o = WINDOW - 1; o + h < closes.length; o += h) origins.push(o);
    origins.forEach((o, idx) => {
      const win = closes.slice(o - WINDOW + 1, o + 1), tw = times.slice(o - WINDOW + 1, o + 1);
      const last = win.length - 1;
      const y = Math.log(closes[o + h] / closes[o]);
      if (last - h - 101 + 1 < 60) return;
      const moves = new Float64Array(last - h - 100);
      for (let j = 101; j <= last - h; j++) moves[j - 101] = Math.abs(Math.log(win[j + h] / win[j]));
      moves.sort();
      const scale = quantile(moves, 0.5);
      if (!(scale > 0)) return;
      const got = METHODS.map((m) => range(win, tw, h, m, STEP[iv]));
      if (got.some((g) => !g)) return;
      got.forEach((g, mi) => {
        const score = (l, u, a) => (u - l + (2 / a) * Math.max(0, l - y) + (2 / a) * Math.max(0, y - u)) / scale;
        rows[METHODS[mi]][idx < origins.length / 2 ? 0 : 1].push({
          c50: y >= g.l50 && y <= g.u50, c80: y >= g.l80 && y <= g.u80, c90: y >= g.l90 && y <= g.u90,
          is80: score(g.l80, g.u80, 0.2), is50: score(g.l50, g.u50, 0.5), w80: (g.u80 - g.l80) / scale,
        });
      });
    });
  }
  const stats = (rs) => ({
    band50: r1((rs.filter((r) => r.c50).length / rs.length) * 100), band80: r1((rs.filter((r) => r.c80).length / rs.length) * 100), band90: r1((rs.filter((r) => r.c90).length / rs.length) * 100),
    is80: r3(rs.reduce((a, r) => a + r.is80, 0) / rs.length), is50: r3(rs.reduce((a, r) => a + r.is50, 0) / rs.length), width80: r3(rs.reduce((a, r) => a + r.w80, 0) / rs.length),
  });
  const res = Object.fromEntries(METHODS.map((m) => [m, { older: stats(rows[m][0]), newer: stats(rows[m][1]) }]));
  const pick = [...METHODS].sort((a, b) => res[a].older.is80 - res[b].older.is80 || METHODS.indexOf(a) - METHODS.indexOf(b))[0];
  const cur = res.plain.newer, nw = res[pick].newer;
  const adopt = pick !== 'plain' && nw.is80 <= cur.is80 * 0.98 && Math.abs(nw.band80 - 80) <= Math.abs(cur.band80 - 80) + 1;
  out.charts[iv] = { coins: keys.length, tests: [rows.plain[0].length, rows.plain[1].length], pick, adopt, methods: res };
  console.log(`${iv.padEnd(4)} ${keys.length} coins, ${rows.plain[0].length} + ${rows.plain[1].length} tests · older half picks ${pick} → ${adopt ? `USE ${pick} (newer-half score ${r1((1 - nw.is80 / cur.is80) * 100)}% lower)` : 'KEEP the plain range'}`);
  for (const m of METHODS) console.log(`     ${m.padEnd(6)} older IS ${res[m].older.is80} (80% held ${res[m].older.band80}%) · newer IS ${res[m].newer.is80}, 80% held ${res[m].newer.band80}%, 50% ${res[m].newer.band50}%, 90% ${res[m].newer.band90}%, width ${res[m].newer.width80}`);
}
console.log(`\nJSON ${JSON.stringify(out)}`);
