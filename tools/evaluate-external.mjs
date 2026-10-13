// usage: node tools/evaluate-external.mjs klines.json external.json
//
// Does outside data say anything about the next week? Three free sources, on
// 24 coins' daily candles, each value taken only from what was published
// before the candle it is used on:
//   - the Crypto Fear & Greed Index (market-wide mood)
//   - perpetual futures funding (how crowded the longs are), 3-day average,
//     as a percentile of the coin's own previous year
//   - the taker-buy share of volume (how much was bought by market orders),
//     7-day, as a percentile of the coin's own previous year
//
// One test date a week (no overlapping outcomes); the outcome is the 7-day
// return from that close. Coins move together, so a market-wide reading is
// tested on the average of all coins (one number per date), and a per-coin
// reading as a spread between coins on the same date (also one per date).
//
// Decided before the run. A reading counts as telling something only if its
// effect has the same sign in the older and newer half of the dates and, in
// the newer half, a t-statistic of at least 2 — for timing, the mean 7-day
// market return in the extreme group against the middle group; for a spread,
// the mean of (top third − bottom third) across dates.
import { readFileSync } from 'node:fs';

const kl = JSON.parse(readFileSync(process.argv[2] || 'klines.json', 'utf8'));
// 'none' runs the price-only tests (momentum, reversal) without outside data
const ext = process.argv[3] === 'none' ? {} : JSON.parse(readFileSync(process.argv[3] || 'external.json', 'utf8'));
const DAY = 864e5, H = 7, STEP = 7, YEAR = 365;
const coins = Object.keys(kl).filter((k) => k.endsWith(':1d')).map((k) => k.split(':')[0]);
const S = Object.fromEntries(coins.map((c) => [c, kl[`${c}:1d`].map((r) => ({ t: r[0], c: r[4], v: r[5], tb: r[6] }))]));
const at = Object.fromEntries(coins.map((c) => [c, new Map(S[c].map((x, i) => [x.t, i]))]));

// --- outside series, aligned to each daily candle (known by its close)
const fngAt = (() => {
  const f = ext.fng || [];
  return (t) => { let lo = 0, hi = f.length - 1, best = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (f[m][0] <= t) { best = f[m][1]; lo = m + 1; } else hi = m - 1; } return best; };
})();
function fundingDaily(c) {
  const f = ext.funding?.[c] || [];
  const out = new Array(S[c].length).fill(null);
  let j = 0;
  const win = [];
  for (let i = 0; i < S[c].length; i++) {
    const close = S[c][i].t + DAY;
    while (j < f.length && f[j][0] <= close) { win.push(f[j]); j++; }
    while (win.length && win[0][0] <= close - 3 * DAY) win.shift();
    if (win.length >= 3) out[i] = win.reduce((a, x) => a + x[1], 0) / win.length;
  }
  return out;
}
function takerDaily(c) {
  const x = S[c];
  return x.map((_, i) => {
    if (i < 6) return null;
    let tb = 0, v = 0;
    for (let k = i - 6; k <= i; k++) { if (!Number.isFinite(x[k].tb)) return null; tb += x[k].tb; v += x[k].v; }
    return v > 0 ? tb / v : null;
  });
}
// percentile of today's value among the coin's previous year (past only)
const pctile = (arr, i) => {
  if (arr[i] === null || i < YEAR) return null;
  let below = 0, n = 0;
  for (let k = i - YEAR; k < i; k++) if (arr[k] !== null) { n++; if (arr[k] < arr[i]) below++; }
  return n >= 200 ? below / n : null;
};
const fund = Object.fromEntries(coins.map((c) => [c, fundingDaily(c)]));
const taker = Object.fromEntries(coins.map((c) => [c, takerDaily(c)]));

// --- weekly test dates on Bitcoin's clock
const btc = S.BTC;
const dates = [];
for (let i = YEAR + 10; i + H < btc.length; i += STEP) {
  const t = btc[i].t;
  const rows = [];
  for (const c of coins) {
    const k = at[c].get(t);
    if (k === undefined || k + H >= S[c].length) continue;
    rows.push({ c, fwd: S[c][k + H].c / S[c][k].c - 1, fund: pctile(fund[c], k), taker: pctile(taker[c], k),
      // the published crypto factors, settings fixed in advance: momentum is the
      // return over the 3 weeks before the last day, reversal the last week's
      mom: k >= 22 ? S[c][k - 1].c / S[c][k - 22].c - 1 : null, rev: k >= 7 ? S[c][k].c / S[c][k - 7].c - 1 : null });
  }
  if (rows.length >= Math.min(8, coins.length)) dates.push({ t, fng: fngAt(t), rows, market: rows.reduce((a, r) => a + r.fwd, 0) / rows.length });
}
if (dates.length < 20) { console.log(`only ${dates.length} test dates — not enough to test anything`); process.exit(0); }
const half = Math.floor(dates.length / 2);
const halves = [dates.slice(0, half), dates.slice(half)];
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const sd = (xs) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1)); };
const welch = (a, b) => (a.length > 2 && b.length > 2 ? (mean(a) - mean(b)) / Math.sqrt(sd(a) ** 2 / a.length + sd(b) ** 2 / b.length) : 0);
const tOne = (xs) => (xs.length > 2 ? mean(xs) / (sd(xs) / Math.sqrt(xs.length)) : 0);
const p = (v) => +(v * 100).toFixed(2);
const out = { dates: dates.length, from: iso(dates[0]?.t), to: iso(dates.at(-1)?.t), coins: coins.length, tests: {} };

// --- timing: market-wide readings against the average 7-day return of all coins
function timing(name, value, lowCut, highCut) {
  const res = halves.map((ds) => {
    const g = { low: [], mid: [], high: [] };
    for (const d of ds) { const v = value(d); if (v === null || v === undefined) continue; g[v <= lowCut ? 'low' : v >= highCut ? 'high' : 'mid'].push(d.market); }
    return { low: { n: g.low.length, mean: p(mean(g.low)), up: p(g.low.filter((x) => x > 0).length / Math.max(1, g.low.length)) }, mid: { n: g.mid.length, mean: p(mean(g.mid)), up: p(g.mid.filter((x) => x > 0).length / Math.max(1, g.mid.length)) }, high: { n: g.high.length, mean: p(mean(g.high)), up: p(g.high.filter((x) => x > 0).length / Math.max(1, g.high.length)) },
      tLow: +welch(g.low, g.mid).toFixed(2), tHigh: +welch(g.high, g.mid).toFixed(2), dLow: p(mean(g.low) - mean(g.mid)), dHigh: p(mean(g.high) - mean(g.mid)) };
  });
  // and at least 5 dates in the extreme group in each half, or there is nothing to judge
  const verdict = (k, d) => { const g = k === 'tLow' ? 'low' : 'high'; return res[0][g].n >= 5 && res[1][g].n >= 5 && Math.sign(res[0][d]) === Math.sign(res[1][d]) && res[0][d] !== 0 && Math.abs(res[1][k]) >= 2; };
  out.tests[name] = { older: res[0], newer: res[1], lowTells: verdict('tLow', 'dLow'), highTells: verdict('tHigh', 'dHigh') };
  const r = out.tests[name];
  console.log(`${name}: older ${JSON.stringify({ low: r.older.low, mid: r.older.mid, high: r.older.high })}`);
  console.log(`${' '.repeat(name.length)}  newer ${JSON.stringify({ low: r.newer.low, mid: r.newer.mid, high: r.newer.high })}`);
  console.log(`${' '.repeat(name.length)}  low vs middle: ${r.older.dLow} / ${r.newer.dLow} pts (t newer ${r.newer.tLow}) → ${r.lowTells ? 'TELLS' : 'no'} · high vs middle: ${r.older.dHigh} / ${r.newer.dHigh} pts (t newer ${r.newer.tHigh}) → ${r.highTells ? 'TELLS' : 'no'}`);
}
// --- spread: per-coin readings, top third against bottom third on each date
function spread(name, key) {
  const res = halves.map((ds) => {
    const xs = [];
    for (const d of ds) {
      const r = d.rows.filter((x) => x[key] !== null).sort((a, b) => a[key] - b[key]);
      if (r.length < Math.min(9, coins.length)) continue;
      const k = Math.floor(r.length / 3);
      xs.push(mean(r.slice(-k).map((x) => x.fwd)) - mean(r.slice(0, k).map((x) => x.fwd)));
    }
    return { n: xs.length, meanSpread: p(mean(xs)), t: +tOne(xs).toFixed(2), topWins: p(xs.filter((x) => x > 0).length / Math.max(1, xs.length)) };
  });
  const tells = Math.sign(res[0].meanSpread) === Math.sign(res[1].meanSpread) && res[0].meanSpread !== 0 && Math.abs(res[1].t) >= 2;
  out.tests[name] = { older: res[0], newer: res[1], tells };
  console.log(`${name}: top third − bottom third, 7-day return: older ${res[0].meanSpread} pts (t ${res[0].t}, n ${res[0].n}) · newer ${res[1].meanSpread} pts (t ${res[1].t}, n ${res[1].n}) → ${tells ? 'TELLS' : 'no'}`);
}

console.log(`${dates.length} weekly dates, ${out.from} → ${out.to}, ${coins.length} coins; halves split at ${iso(halves[1][0]?.t)}\n`);
timing('fear & greed (≤20 / ≥80)', (d) => d.fng, 20, 80);
timing('market funding (avg percentile ≤0.1 / ≥0.9)', (d) => { const v = d.rows.map((r) => r.fund).filter((x) => x !== null); return v.length >= Math.min(8, coins.length) ? mean(v) : null; }, 0.1, 0.9);
timing('market taker-buy share (avg percentile ≤0.1 / ≥0.9)', (d) => { const v = d.rows.map((r) => r.taker).filter((x) => x !== null); return v.length >= Math.min(8, coins.length) ? mean(v) : null; }, 0.1, 0.9);
spread('funding, coin against coin', 'fund');
spread('taker-buy share, coin against coin', 'taker');
spread('momentum (3 weeks), coin against coin', 'mom');
spread('last week\'s move (reversal), coin against coin', 'rev');
console.log(`\nJSON ${JSON.stringify(out)}`);
