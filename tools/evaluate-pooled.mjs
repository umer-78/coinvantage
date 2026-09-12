// Pooled (multi-coin) training vs per-coin: train on the early 60% of every coin, test on the late 40%.
import fs from 'node:fs';
import { computeAll } from '../js/lib/indicators.js';
import { _internals as M } from '../js/lib/predict.js';
const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const HMAP = { '15m': 8, '1h': 12, '4h': 6, '1d': 7 };
const out = {};
function moveStatsTrain(samples) { // samples: {z, rsi, up}
  const zb = (z) => (z < -2 ? 0 : z < -1 ? 1 : z < -0.3 ? 2 : z < 0.3 ? 3 : z < 1 ? 4 : z < 2 ? 5 : 6);
  const rb = (r) => (r < 30 ? 0 : r < 45 ? 1 : r < 55 ? 2 : r < 70 ? 3 : 4);
  const cell = new Map(), zc = new Map();
  for (const s of samples) {
    const k = zb(s.z) * 5 + rb(s.rsi); const a = cell.get(k) || [0, 0]; a[0] += s.up; a[1]++; cell.set(k, a);
    const b = zc.get(zb(s.z)) || [0, 0]; b[0] += s.up; b[1]++; zc.set(zb(s.z), b);
  }
  const base = samples.reduce((a, s) => a + s.up, 0) / samples.length;
  return (z, rsi) => {
    const a = cell.get(zb(z) * 5 + rb(rsi)); const b = zc.get(zb(z));
    const pz = b ? (b[0] + 10 * base) / (b[1] + 10) : base;
    if (!a) return pz;
    return (a[0] + 20 * pz) / (a[1] + 20);
  };
}
for (const iv of Object.keys(HMAP)) {
  const H = HMAP[iv];
  const series = Object.entries(data).filter(([k]) => k.endsWith(':' + iv)).map(([k, rows]) => {
    const c = rows.map(([t, o, h, l, cc, v]) => ({ t, o, h, l, c: cc, v }));
    const ind = computeAll(c); const feats = M.buildFeatures(c, ind); const cl = c.map((x) => x.c);
    const zAt = (i) => { let s2 = 0; for (let j = i - 99; j <= i; j++) { const r = Math.log(cl[j] / cl[j - 1]); s2 += r * r; } return Math.log(cl[i] / cl[i - H]) / (Math.sqrt(s2 / 100) * Math.sqrt(H)); };
    return { k, c, ind, feats, cl, n: c.length, split: Math.floor(c.length * 0.6), zAt };
  });
  const trX = [], trY = [], ms = [];
  for (const s of series) for (let i = 100; i <= s.split - H - 1; i++) if (s.feats[i]) { trX.push(s.feats[i]); const up = s.cl[i + H] > s.cl[i] ? 1 : 0; trY.push(up); ms.push({ z: s.zAt(i), rsi: s.ind.rsi[i], up }); }
  const scale = M.standardizer(trX); const X = trX.map(scale);
  const t0 = Date.now();
  const lr = M.trainLogistic(X, trY, { iters: 300 });
  const gb = M.trainGbdt(X, trY, { rounds: 150, depth: 3, lr: 0.05, minLeaf: 80 });
  const mlp = [7, 21, 42].map((seed) => M.trainMlp(X, trY, { seed, epochs: 12, hidden: 24 }));
  const msPooled = moveStatsTrain(ms);
  console.error(iv, 'train n', X.length, (Date.now() - t0) / 1000 + 's');
  const acc = {}; const hit = (k, p, y) => { const a = (acc[k] ||= [0, 0]); a[0] += (p >= 0.5 ? 1 : 0) === y ? 1 : 0; a[1]++; };
  const conf = {}; const hitC = (k, p, y, thr) => { if (Math.abs(p - 0.5) < thr) return; const a = (conf[k] ||= [0, 0]); a[0] += (p >= 0.5 ? 1 : 0) === y ? 1 : 0; a[1]++; };
  for (const s of series) {
    const own = []; for (let i = 100; i <= s.split - H - 1; i++) if (s.feats[i]) own.push({ z: s.zAt(i), rsi: s.ind.rsi[i], up: s.cl[i + H] > s.cl[i] ? 1 : 0 });
    const msOwn = moveStatsTrain(own);
    for (let o = s.split; o < s.n - H; o += H) {
      if (!s.feats[o]) continue;
      const y = s.cl[o + H] > s.cl[o] ? 1 : 0; const x = scale(s.feats[o]);
      const p = { pLR: lr.predict(x), pGB: gb.predict(x), pMLP: mlp.reduce((a, m) => a + m.predict(x), 0) / 3, msPooled: msPooled(s.zAt(o), s.ind.rsi[o]), msOwn: msOwn(s.zAt(o), s.ind.rsi[o]) };
      p.ensPooled = (p.pLR + p.pGB + p.pMLP) / 3;
      p.ensPooledMs = (p.pGB + p.pMLP + p.msPooled) / 3;
      p.ensAll = (p.pLR + p.pGB + p.pMLP + p.msPooled + p.msOwn) / 5;
      for (const [k, v] of Object.entries(p)) { hit(k, v, y); hitC(k, v, y, 0.03); }
    }
  }
  out[iv] = { acc, conf };
  console.log(iv, Object.entries(acc).map(([k, [h, n]]) => `${k} ${(100 * h / n).toFixed(1)}`).join(' | '));
  console.log('   conf≥.03', Object.entries(conf).map(([k, [h, n]]) => `${k} ${(100 * h / n).toFixed(1)}(${n})`).join(' | '));
}
