// Downloads candles for the accuracy evaluation: node tools/fetch-klines.mjs klines.json
import fs from 'node:fs';
// UNIVERSE=tools/universe.json (each coin with the exchange the app reads it
// from), COINS=BTC,ETH,... (all from Binance) and PLAN='{"1d":2200}' override
// the defaults.
const universe = process.env.UNIVERSE ? JSON.parse(fs.readFileSync(process.env.UNIVERSE, 'utf8')).coins : null;
const coins = universe ? universe.map((c) => c.symbol) : process.env.COINS ? process.env.COINS.split(',') : ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'LTC', 'TRX', 'DOT'];
const venueOf = Object.fromEntries((universe || []).map((c) => [c.symbol, c.venue]));
const STEP_S = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '12h': 43200, '1d': 86400, '1w': 604800 };
// Gate.io and HTX publish no 2h, 6h or 12h candles: they are built from 1h ones on
// Binance's UTC boundaries, as the app builds them (js/api/market.js EX_AGG).
const AGG = { '2h': 2, '6h': 6, '12h': 12 };
function aggregate(rows, iv) {
  const step = STEP_S[iv] * 1000, out = [];
  for (const r of rows) {
    const t = Math.floor(r[0] / step) * step, last = out[out.length - 1];
    if (last && last[0] === t) { last[2] = Math.max(last[2], r[2]); last[3] = Math.min(last[3], r[3]); last[4] = r[4]; last[5] += r[5]; }
    else out.push([t, r[1], r[2], r[3], r[4], r[5], null, r[0]]);
  }
  return out.filter((b) => b[7] === b[0]).map((b) => b.slice(0, 7));
}
async function getJson(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 400 || res.status === 404) return { error: res.status, body: await res.text() };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      console.error(`retry ${url.slice(0, 90)}: ${e.message}`);
      await new Promise((s2) => setTimeout(s2, 1500 * (attempt + 1)));
    }
  }
  return null;
}
// Gate.io: 1,000 candles a request, walked back with from/to; it keeps a
// limited history for short charts and says so with a 400, which ends the walk.
async function gateRows(c, iv, total) {
  if (AGG[iv]) return aggregate(await gateRows(c, '1h', total * AGG[iv] + AGG[iv]), iv);
  const step = STEP_S[iv];
  let rows = [], to = Math.floor(Date.now() / 1000);
  while (rows.length < total) {
    const n = Math.min(1000, total - rows.length), from = to - (n - 1) * step;
    const r = await getJson(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${c}_USDT&interval=${iv === '1w' ? '7d' : iv}&from=${from}&to=${to}`);
    if (!Array.isArray(r) || !r.length) break;
    const first = rows.length ? rows[0][0] : Infinity;
    rows = r.map((k) => [+k[0] * 1000, +k[5], +k[3], +k[4], +k[2], +k[6], null]).filter((k) => k[0] < first).concat(rows);
    to = from - step;
    if (r.length < n) break;
  }
  return rows;
}
// HTX: the latest 2,000 candles, no paging
async function htxRows(c, iv, total) {
  if (AGG[iv]) return aggregate(await htxRows(c, '1h', total * AGG[iv] + AGG[iv]), iv);
  const period = { '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '60min', '4h': '4hour', '1d': '1day', '1w': '1week' }[iv];
  const r = await getJson(`https://api.huobi.pro/market/history/kline?symbol=${c.toLowerCase()}usdt&period=${period}&size=${Math.min(2000, total)}`);
  if (r?.status !== 'ok' || !Array.isArray(r.data)) return [];
  return r.data.map((k) => [k.id * 1000, +k.open, +k.high, +k.low, +k.close, +k.amount, null]).reverse();
}
const plan = process.env.PLAN ? JSON.parse(process.env.PLAN) : { '15m': 4000, '1h': 4000, '4h': 3500, '1d': 2200 };
const out = {};
for (const [iv, total] of Object.entries(plan)) {
  for (const c of coins) {
    if (venueOf[c] === 'gate' || venueOf[c] === 'htx') {
      const rows = (venueOf[c] === 'gate' ? await gateRows(c, iv, total) : await htxRows(c, iv, total))
        .filter((k) => k.slice(1, 5).every((x) => Number.isFinite(x) && x > 0));
      if (rows.length) out[`${c}:${iv}`] = rows;
      fs.writeFileSync(process.argv[2] || 'klines.json', JSON.stringify(out));
      console.log(c, iv, rows.length, venueOf[c]);
      continue;
    }
    let rows = [], end = null;
    while (rows.length < total) {
      const lim = Math.min(1000, total - rows.length);
      let r = null;
      for (let attempt = 0; attempt < 8 && !r; attempt++) {
        try {
          const res = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(c)}USDT&interval=${iv}&limit=${lim}${end ? `&endTime=${end}` : ''}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          r = await res.json();
        } catch (e) {
          console.error(`retry ${c} ${iv}: ${e.message}`);
          await new Promise((s2) => setTimeout(s2, 1500 * (attempt + 1)));
        }
      }
      if (!r) break;
      if (!Array.isArray(r) || !r.length) break;
      // [time, open, high, low, close, volume, taker-buy volume]: the last is the
      // part of the volume bought by market orders (tools/evaluate-external.mjs)
      rows = r.map((k) => [k[0], +k[1], +k[2], +k[3], +k[4], +k[5], +k[9]]).concat(rows);
      end = r[0][0] - 1;
      if (r.length < lim) break;
    }
    out[`${c}:${iv}`] = rows;
    fs.writeFileSync(process.argv[2] || 'klines.json', JSON.stringify(out));
    console.log(c, iv, rows.length);
  }
}
fs.writeFileSync(process.argv[2] || 'klines.json', JSON.stringify(out));
