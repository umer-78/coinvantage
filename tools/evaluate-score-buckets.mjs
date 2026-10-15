// usage: node tools/evaluate-score-buckets.mjs klines.json
//
// What a score reading meant, measured: every candle of every coin gets the
// score the coin page shows (scoreAt, indicators computed from that coin's
// candles up to then), sorted into the five readings (labelFor), and matched
// against whether the price was higher H candles later (H = the coin page's
// horizon for the chart, DEFAULT_HORIZON in js/ai/context.js). The share that
// rose per reading is SCORE_BUCKETS_TESTED in js/lib/signals.js.
//
// Each series is also split in half by time: a pattern that does not show in
// both halves is not one to print. The 95% range is the usual normal
// approximation for a share; neighbouring candles overlap in what follows
// them, so it is narrower than it should be and only a rough guide.
import { readFileSync } from 'node:fs';
import { computeAll } from '../js/lib/indicators.js';
import { scoreAt, labelFor } from '../js/lib/signals.js';
import { DEFAULT_HORIZON } from '../js/ai/context.js';

const raw = JSON.parse(readFileSync(process.argv[2] || 'klines.json', 'utf8'));
const CHARTS = ['5m', '15m', '1h', '4h', '1d'];
const NAMES = { EXTENDED_DOWN: 'extendedDown', LEANING_DOWN: 'leaningDown', NO_TREND: 'noTrend', LEANING_UP: 'leaningUp', EXTENDED_UP: 'extendedUp' };
const ORDER = Object.values(NAMES);
const WARM = 210; // the 200-candle average needs this much before it means anything
const r1 = (v) => +v.toFixed(1);
const ci = (k, n) => { const p = k / n, h = 1.96 * Math.sqrt((p * (1 - p)) / n); return [r1((p - h) * 100), r1((p + h) * 100)]; };

const out = { measuredOn: new Date().toISOString().slice(0, 10), charts: {} };
let bars = 0;
const coins = new Set();
for (const iv of CHARTS) {
  const keys = Object.keys(raw).filter((k) => k.endsWith(`:${iv}`) && raw[k].length > WARM + 100);
  if (!keys.length) continue;
  const H = DEFAULT_HORIZON[iv];
  const tally = [{}, {}];
  for (const key of keys) {
    const c = raw[key].map(([t, o, h, l, cc, v]) => ({ t, o, h, l, c: cc, v }));
    const ind = computeAll(c);
    const last = c.length - 1 - H;
    const mid = WARM + Math.floor((last - WARM) / 2);
    for (let i = WARM; i <= last; i++) {
      if (!(c[i + H].c > 0) || !(c[i].c > 0) || c[i + H].c === c[i].c) continue; // no move, no answer
      const { score } = scoreAt(c, ind, i);
      if (!Number.isFinite(score)) continue;
      const b = NAMES[labelFor(score).action];
      const t = tally[i < mid ? 0 : 1];
      const cell = (t[b] ||= { up: 0, n: 0 });
      cell.n++;
      if (c[i + H].c > c[i].c) cell.up++;
      bars++;
    }
    coins.add(key.split(':')[0]);
  }
  const both = Object.fromEntries(ORDER.map((b) => {
    const a = tally[0][b] || { up: 0, n: 0 }, z = tally[1][b] || { up: 0, n: 0 };
    return [b, { up: a.up + z.up, n: a.n + z.n }];
  }));
  const pct = (x) => (x?.n ? r1((x.up / x.n) * 100) : null);
  const row = Object.fromEntries(ORDER.map((b) => [b, pct(both[b])]));
  const halves = tally.map((t) => Object.fromEntries(ORDER.map((b) => [b, pct(t[b])])));
  // does a higher reading go with a higher share rising, in both halves?
  const rises = (r) => r.extendedUp != null && r.extendedDown != null && r.extendedUp > r.extendedDown;
  out.charts[iv] = {
    coins: keys.length, H, upRate: row, n: Object.fromEntries(ORDER.map((b) => [b, both[b].n])),
    ci: Object.fromEntries(ORDER.map((b) => [b, both[b].n ? ci(both[b].up, both[b].n) : null])),
    older: halves[0], newer: halves[1], higherMeansUp: rises(row) && rises(halves[0]) && rises(halves[1]),
  };
  console.log(`${iv.padEnd(4)} ${keys.length} coins, H ${H}: ${ORDER.map((b) => `${b} ${row[b]}% (${both[b].n})`).join(' · ')}`);
  console.log(`      older half: ${ORDER.map((b) => `${halves[0][b]}`).join(' / ')} · newer half: ${ORDER.map((b) => `${halves[1][b]}`).join(' / ')} · strong rise above strong fall in both halves: ${out.charts[iv].higherMeansUp ? 'yes' : 'no'}`);
}
out.bars = bars;
out.coins = coins.size;
console.log(`\n${bars.toLocaleString('en-US')} candles of ${coins.size} coins`);
console.log(`JSON ${JSON.stringify(out)}`);
