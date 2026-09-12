// Downloads Binance candles for the accuracy evaluation: node tools/fetch-klines.mjs klines.json
import fs from 'node:fs';
const coins = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'LTC', 'TRX', 'DOT'];
const plan = { '15m': 4000, '1h': 4000, '4h': 3500, '1d': 2200 };
const out = {};
for (const [iv, total] of Object.entries(plan)) {
  for (const c of coins) {
    let rows = [], end = null;
    while (rows.length < total) {
      const lim = Math.min(1000, total - rows.length);
      let r = null;
      for (let attempt = 0; attempt < 8 && !r; attempt++) {
        try {
          const res = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${c}USDT&interval=${iv}&limit=${lim}${end ? `&endTime=${end}` : ''}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          r = await res.json();
        } catch (e) {
          console.error(`retry ${c} ${iv}: ${e.message}`);
          await new Promise((s2) => setTimeout(s2, 1500 * (attempt + 1)));
        }
      }
      if (!r) break;
      if (!Array.isArray(r) || !r.length) break;
      rows = r.map((k) => [k[0], +k[1], +k[2], +k[3], +k[4], +k[5]]).concat(rows);
      end = r[0][0] - 1;
      if (r.length < lim) break;
    }
    out[`${c}:${iv}`] = rows;
    fs.writeFileSync(process.argv[2] || 'klines.json', JSON.stringify(out));
    console.log(c, iv, rows.length);
  }
}
fs.writeFileSync(process.argv[2] || 'klines.json', JSON.stringify(out));
