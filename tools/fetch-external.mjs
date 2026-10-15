// Downloads the outside data tools/evaluate-external.mjs tests:
//   - the Crypto Fear & Greed Index, daily since 2018 (api.alternative.me)
//   - perpetual futures funding rates per coin, from Binance's public data
//     archive (data.binance.vision: monthly files, 8-hourly settlements)
// usage: UNIVERSE=tools/universe.json (or COINS=BTC,ETH,...) node tools/fetch-external.mjs external.json
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

// every coin in UNIVERSE (coins with no Binance perpetual simply have no files)
const coins = process.env.UNIVERSE
  ? JSON.parse(fs.readFileSync(process.env.UNIVERSE, 'utf8')).coins.map((c) => c.symbol)
  : (process.env.COINS || 'BTC,ETH').split(',');
const out = { fng: [], funding: {} };
const get = async (url, attempts = 4) => {
  for (let a = 0; a < attempts; a++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (a === attempts - 1) { console.error(`failed ${url}: ${e.message}`); return null; }
      await new Promise((r) => setTimeout(r, 1000 * (a + 1)));
    }
  }
  return null;
};

const f = await get('https://api.alternative.me/fng/?limit=0&format=json');
if (f) out.fng = JSON.parse(f.toString()).data.map((d) => [Number(d.timestamp) * 1000, Number(d.value)]).sort((a, b) => a[0] - b[0]);
console.log('fear & greed days', out.fng.length);

const months = [];
for (let y = 2020; y <= 2026; y++) for (let m = 1; m <= 12; m++) months.push(`${y}-${String(m).padStart(2, '0')}`);
const tmp = fs.mkdtempSync('/tmp/funding-');
for (const c of coins) {
  const rows = [];
  for (const ym of months) {
    const zip = await get(`https://data.binance.vision/data/futures/um/monthly/fundingRate/${encodeURIComponent(c)}USDT/${encodeURIComponent(c)}USDT-fundingRate-${ym}.zip`, 2);
    if (!zip) continue;
    const file = `${tmp}/${c}-${ym}.zip`;
    fs.writeFileSync(file, zip);
    const csv = execFileSync('unzip', ['-p', file]).toString();
    for (const line of csv.split('\n')) {
      const [t, , rate] = line.split(',');
      if (/^\d+$/.test(t) && Number.isFinite(Number(rate))) rows.push([Number(t), Number(rate)]);
    }
  }
  out.funding[c] = rows.sort((a, b) => a[0] - b[0]);
  console.log(c, 'funding settlements', rows.length);
}
fs.writeFileSync(process.argv[2] || 'external.json', JSON.stringify(out));
