// Reads a Binance trade-history export and turns it into trades.
//
// Typing every trade by hand is the reason a trade journal goes unused, so the
// Real account takes the file the exchange already gives you. Nothing is sent
// anywhere: the file is parsed in the browser and only the resulting trades are
// stored, in the same shape as a hand-entered one.
//
// Binance has shipped several column layouts over the years, and people also
// hand in files from other exchanges, so the parser matches columns by meaning
// rather than by position and says plainly when it cannot.

const ALIASES = {
  date: ['date(utc)', 'date', 'time', 'utc_time', 'datetime', 'created time', 'trade time'],
  pair: ['pair', 'market', 'symbol', 'instrument'],
  side: ['side', 'type', 'direction', 'operation'],
  price: ['price', 'avg price', 'average price', 'executed price', 'fill price'],
  amount: ['executed', 'amount', 'quantity', 'qty', 'filled', 'executed qty', 'base amount'],
  total: ['total', 'quote amount', 'amount (quote)', 'cost', 'value'],
  fee: ['fee', 'fees', 'commission', 'trading fee'],
  base: ['base asset', 'base', 'base coin'],
  quote: ['quote asset', 'quote', 'quote coin'],
};

const QUOTES = ['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'USD', 'EUR', 'GBP', 'TRY', 'BTC', 'ETH', 'BNB'];

/** Split a CSV line, honouring quoted fields. */
export function splitCsvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',' || ch === '\t' || ch === ';') { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** "0.01234BTC" or "1,234.5 USDT" → { value, asset } */
export function parseAmount(raw) {
  if (raw === null || raw === undefined) return { value: null, asset: null };
  const s = String(raw).replace(/,/g, '').trim();
  const m = /^(-?[\d.]+)\s*([A-Za-z]{2,10})?$/.exec(s);
  if (!m) return { value: null, asset: null };
  const value = parseFloat(m[1]);
  return { value: Number.isFinite(value) ? value : null, asset: m[2] ? m[2].toUpperCase() : null };
}

/** "BTCUSDT" → { base: 'BTC', quote: 'USDT' } */
export function splitPair(pair) {
  const p = String(pair || '').toUpperCase().replace(/[/\-_]/g, '');
  for (const q of QUOTES) {
    if (p.length > q.length && p.endsWith(q)) return { base: p.slice(0, -q.length), quote: q };
  }
  return { base: p, quote: '' };
}

function headerIndex(cells) {
  const lower = cells.map((c) => c.toLowerCase().trim());
  const idx = {};
  for (const [key, names] of Object.entries(ALIASES)) {
    idx[key] = lower.findIndex((c) => names.includes(c));
  }
  return idx;
}

/**
 * Parse a trade-history file into individual fills.
 * @returns {{fills: object[], errors: string[], skipped: number}}
 */
export function parseTradeCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { fills: [], errors: ['That file is empty.'], skipped: 0 };

  // the header is the first row that names a price and an amount
  let headerRow = -1, idx = null;
  for (let i = 0; i < Math.min(8, lines.length); i++) {
    const probe = headerIndex(splitCsvLine(lines[i]));
    if (probe.price >= 0 && (probe.amount >= 0 || probe.total >= 0)) { headerRow = i; idx = probe; break; }
  }
  if (headerRow < 0) {
    return { fills: [], errors: ['This does not look like a trade-history export — no price and amount columns were found. On Binance use Orders → Trade History → Export.'], skipped: 0 };
  }

  const fills = [];
  const errors = [];
  let skipped = 0;
  for (let i = headerRow + 1; i < lines.length; i++) {
    const c = splitCsvLine(lines[i]);
    if (c.length < 3) { skipped++; continue; }
    const get = (k) => (idx[k] >= 0 ? c[idx[k]] : null);

    const pairRaw = get('pair') || `${get('base') || ''}${get('quote') || ''}`;
    const { base, quote } = splitPair(pairRaw);
    const sideRaw = String(get('side') || '').toUpperCase();
    const side = /BUY|LONG/.test(sideRaw) ? 'buy' : /SELL|SHORT/.test(sideRaw) ? 'sell' : null;
    const price = parseAmount(get('price')).value;
    let qty = parseAmount(get('amount')).value;
    const total = parseAmount(get('total')).value;
    if (qty === null && total !== null && price) qty = total / price;
    const fee = parseAmount(get('fee')).value ?? 0;
    const when = Date.parse(String(get('date') || '').replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(get('date'))) ? '' : 'Z'));

    if (!base || !side || !price || !qty) { skipped++; continue; }
    fills.push({ symbol: base, quote, side, price, qty, fee, at: Number.isFinite(when) ? when : Date.now() });
  }

  if (!fills.length && !errors.length) errors.push('No usable rows were found in that file. Check it is the trade history export, not the order history.');
  return { fills, errors, skipped };
}

/**
 * Match buys to sells, oldest first, into closed round trips. Anything left
 * over is still an open position.
 *
 * FIFO is the convention most tax authorities and exchanges use, so the result
 * lines up with the statements people already have.
 */
export function matchFills(fills) {
  const bySymbol = new Map();
  for (const f of [...fills].sort((a, b) => a.at - b.at)) {
    if (!bySymbol.has(f.symbol)) bySymbol.set(f.symbol, []);
    bySymbol.get(f.symbol).push(f);
  }

  const closed = [];
  const open = [];
  for (const [symbol, list] of bySymbol) {
    const lots = []; // unmatched buys, oldest first
    for (const f of list) {
      if (f.side === 'buy') { lots.push({ ...f, left: f.qty }); continue; }
      let toSell = f.qty;
      while (toSell > 1e-12 && lots.length) {
        const lot = lots[0];
        const take = Math.min(lot.left, toSell);
        const feeShare = (lot.fee * (take / lot.qty)) + (f.fee * (take / f.qty));
        closed.push({
          symbol, side: 'long',
          qty: take, entry: lot.price, exit: f.price,
          openedAt: lot.at, closedAt: f.at,
          fee: feeShare,
          pnl: (f.price - lot.price) * take - feeShare,
          pnlPct: ((f.price / lot.price) - 1) * 100,
        });
        lot.left -= take; toSell -= take;
        if (lot.left <= 1e-12) lots.shift();
      }
      // a sell with nothing to match against is a short or a transfer; skipped
      // rather than invented
    }
    for (const lot of lots) if (lot.left > 1e-12) open.push({ symbol, qty: lot.left, entry: lot.price, at: lot.at, fee: lot.fee * (lot.left / lot.qty) });
  }
  closed.sort((a, b) => a.closedAt - b.closedAt);
  return { closed, open };
}
