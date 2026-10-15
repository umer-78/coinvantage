// Downloads candles for the accuracy evaluation: node tools/fetch-klines.mjs klines.json
import fs from 'node:fs';
// UNIVERSE=tools/universe.json (each coin with the exchange the app reads it
// from), COINS=BTC,ETH,... (all from Binance) and PLAN='{"1d":2200}' override
// the defaults.
const universe = process.env.UNIVERSE ? JSON.parse(fs.readFileSync(process.env.UNIVERSE, 'utf8')).coins : null;
const coins = universe ? universe.map((c) => c.symbol) : process.env.COINS ? process.env.COINS.split(',') : ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'LTC', 'TRX', 'DOT'];
const venueOf = Object.fromEntries((universe || []).map((c) => [c.symbol, c.venue]));
const STEP_S = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
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
  const step = STEP_S[iv];
  let rows = [], to = Math.floor(Date.now() / 1000);
  while (rows.length < total) {
    const n = Math.min(1000, total - rows.length), from = to - (n - 1) * step;
    const r = await getJson(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${c}_USDT&interval=${iv}&from=${from}&to=${to}`);
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
  const period = { '1m': '1min', '5m': '5min', '15m': '15min', '1h': '60min', '4h': '4hour', '1d': '1day' }[iv];
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
