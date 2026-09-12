// Walk-forward evaluation of the forecast models on real Binance data.
// usage: node tools/evaluate.mjs <klines.json> <shard> <shards> <out.json> [variant]
// Each test origin only uses data available at that moment; outcomes never overlap.
import fs from 'node:fs';
import { computeAll } from '../js/lib/indicators.js';
import { _internals as M } from '../js/lib/predict.js';

const [, , file, shardArg = '0', shardsArg = '1', outFile = 'eval-out.json', variant = 'base'] = process.argv;
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const HMAP = { '15m': 8, '1h': 12, '4h': 6, '1d': 7 };
const RETRAIN_EVERY = 12;
const TRAIN_MAX = 3000;
const keys = Object.keys(data).sort().filter((_, i) => i % +shardsArg === +shardArg);

const results = {};
for (const key of keys) {
  const t0 = Date.now();
  const [coin, iv] = key.split(':');
  const H = HMAP[iv];
  const candles = data[key].map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
  const n = candles.length;
  const closes = candles.map((c) => c.c);
  const ind = computeAll(candles);
  const feats = M.buildFeatures(candles, ind);
  const label = (i) => (closes[i + H] > closes[i] ? 1 : 0);
  const fret = (i) => Math.log(closes[i + H] / closes[i]);
  const holt = M.holtSeries(closes);
  const origins = [];
  for (let o = Math.floor(n * 0.6); o < n - H; o += H) if (feats[o]) origins.push(o);
  const probs = {}; const add = (k, p) => (probs[k] ||= []).push(p);
  const ys = [];
  let models = null, scale = null;
  for (let j = 0; j < origins.length; j++) {
    const o = origins[j];
    if (j % RETRAIN_EVERY === 0) {
      const idx = [];
      for (let i = Math.max(0, o - H - TRAIN_MAX); i <= o - H - 1; i++) if (feats[i]) idx.push(i);
      scale = M.standardizer(idx.map((i) => feats[i]));
      const X = idx.map((i) => scale(feats[i]));
      const y = idx.map(label);
      const r = idx.map(fret);
      // noise-filtered training set: skip tiny moves
      const sig = M.rollingSigma(closes, o, 200) * Math.sqrt(H);
      const keep = idx.map((i, k) => Math.abs(r[k]) > 0.25 * sig);
      const Xf = X.filter((_, k) => keep[k]), yf = y.filter((_, k) => keep[k]);
      const upRate = y.reduce((a, b) => a + b, 0) / y.length;
      models = {
        lr: M.trainLogistic(X, y),
        lrF: M.trainLogistic(Xf, yf),
        gbdt: M.trainGbdt(X, y),
        gbdtF: M.trainGbdt(Xf, yf),
        knn: M.knnModel(X, y, r, Math.max(15, Math.round(Math.sqrt(X.length)))),
        upRate,
      };
      if (variant !== 'fast') {
        models.mlp = M.trainMlp(X, y);
        models.mlpF = M.trainMlp(Xf, yf);
        models.mlpBag = [models.mlpF, M.trainMlp(Xf, yf, { seed: 21 }), M.trainMlp(Xf, yf, { seed: 42 })];
      }
    }
    const x = scale(feats[o]);
    ys.push(label(o));
    add('lr', models.lr.predict(x));
    add('lrF', models.lrF.predict(x));
    add('gbdt', models.gbdt.predict(x));
    add('gbdtF', models.gbdtF.predict(x));
    add('knn', models.knn(x).prob);
    if (models.mlp) {
      add('mlp', models.mlp.predict(x));
      add('mlpF', models.mlpF.predict(x));
      add('mlpBag', models.mlpBag.reduce((a, m) => a + m.predict(x), 0) / 3);
    }
    const pat = M.findPatterns(candles, o, { window: 32, horizon: H, topK: 8 });
    add('pattern', pat.matches.length >= 3 ? pat.probUp : 0.5);
    const pat2 = M.findPatterns(candles, o, { window: 48, horizon: H, topK: 12, minCorr: 0.5 });
    add('pattern48', pat2.matches.length >= 3 ? pat2.probUp : 0.5);
    const sig = M.rollingSigma(closes, o);
    add('holt', M.normCdf((holt.trend[o] * H + (holt.level[o] - Math.log(closes[o]))) / (sig * Math.sqrt(H))));
    add('momentum', closes[o] >= closes[o - H] ? 0.6 : 0.4);
    add('reversal', closes[o] >= closes[o - H] ? 0.4 : 0.6);
    add('alwaysUp', 0.51);
    add('trainMajority', models.upRate >= 0.5 ? 0.51 : 0.49);
  }
  results[key] = { coin, iv, H, ys, probs };
  console.error(key, origins.length, 'pts', ((Date.now() - t0) / 1000).toFixed(1) + 's');
}
fs.writeFileSync(outFile, JSON.stringify(results));
