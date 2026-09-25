// CSV and printable reports.
//
// Everything the app knows about a person's trading lives in their browser, so
// the export has to work without a server: rows are built here and handed to the
// browser as a download. A client-facing report is the same data with the
// caveats attached, because a performance summary without its sample size and
// its disclaimers is a sales document, not a report.

const esc = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Rows (array of objects) → CSV text, with the header taken from `columns`. */
export function toCsv(rows, columns) {
  const cols = columns || (rows.length ? Object.keys(rows[0]).map((k) => ({ key: k, label: k })) : []);
  const head = cols.map((c) => esc(c.label)).join(',');
  const body = rows.map((r) => cols.map((c) => esc(typeof c.get === 'function' ? c.get(r) : r[c.key])).join(','));
  return [head, ...body].join('\n');
}

const iso = (t) => (t ? new Date(t).toISOString() : '');

export const TRADE_COLUMNS = [
  { key: 'symbol', label: 'Coin' },
  { key: 'side', label: 'Side' },
  { label: 'Opened', get: (t) => iso(t.openedAt) },
  { label: 'Closed', get: (t) => iso(t.exitAt) },
  { key: 'qty', label: 'Amount' },
  { key: 'entry', label: 'Price in' },
  { key: 'exit', label: 'Price out' },
  { key: 'feePaid', label: 'Fee' },
  { key: 'pnl', label: 'Profit/loss' },
  { key: 'pnlPct', label: 'Profit/loss %' },
  { key: 'reason', label: 'Why it closed' },
];

export function tradesCsv(closed) {
  return toCsv(closed || [], TRADE_COLUMNS);
}

/** Hand the browser a file. Nothing leaves the device. */
export function downloadText(filename, text, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * A printable summary for handing to someone else.
 *
 * `stats` is whatever autotrader.stats() returned. The caveats are not optional
 * decoration: a report that shows a win rate without the number of trades behind
 * it invites a conclusion the data cannot support.
 */
export function reportHtml({ title, accountName, stats: s, closed = [], fmtMoney = (v) => String(v), generatedAt = Date.now(), notes = [] }) {
  // Coin symbols can come from a typed-in or imported trade, so text is escaped;
  // `notes` are the app's own fixed strings and may carry <b>.
  const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const row = (k, v) => `<tr><th>${k}</th><td>${v}</td></tr>`;
  const small = s && s.trades < 30;
  return `<!doctype html><meta charset="utf-8"><title>${escHtml(title)}</title>
<style>
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; color: #111; margin: 32px auto; max-width: 760px; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 24px 0 8px; }
  .muted { color: #666; font-size: 12px; }
  table { border-collapse: collapse; width: 100%; margin-top: 6px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e5e5e5; font-size: 13px; }
  th { color: #555; font-weight: 600; width: 40%; }
  .grid td { width: auto; } .pos { color: #0a8259; } .neg { color: #d12a49; }
  .warn { background: #fff8e6; border: 1px solid #f0d48a; padding: 10px 12px; border-radius: 8px; margin-top: 14px; font-size: 13px; }
  @media print { body { margin: 0; } }
</style>
<h1>${escHtml(title)}</h1>
<p class="muted">${escHtml(accountName)} · generated ${new Date(generatedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC</p>
${s ? `<h2>Result</h2><table>
  ${row('Starting balance', fmtMoney(s.startingBalance))}
  ${row('Balance now', fmtMoney(s.equity))}
  ${row('Return', `<span class="${s.returnPct >= 0 ? 'pos' : 'neg'}">${s.returnPct >= 0 ? '+' : ''}${s.returnPct}%</span>`)}
  ${row('Closed trades', s.trades)}
  ${row('Win rate', s.winRate === null ? 'not enough trades' : `${s.winRate}% (${s.wins}W / ${s.losses}L)`)}
  ${row('Profit factor', s.profitFactor ?? '—')}
  ${row('Largest drawdown', `<span class="neg">-${s.maxDrawdownPct}%</span>`)}
  ${row('Fees paid', fmtMoney(s.feesPaid))}
</table>` : ''}
${small ? `<div class="warn"><b>Small sample.</b> ${s.trades} closed trade${s.trades === 1 ? '' : 's'} is too few to judge a strategy on. A win rate from this many trades can swing by twenty points on luck alone.</div>` : ''}
${notes.map((n) => `<div class="warn">${n}</div>`).join('')}
${closed.length ? `<h2>Trades</h2><table class="grid"><tr><th>Coin</th><th>Closed</th><th>In</th><th>Out</th><th>Result</th></tr>
${closed.slice(0, 200).map((t) => `<tr><td>${escHtml(t.symbol)}</td><td>${iso(t.exitAt).slice(0, 10)}</td><td>${fmtMoney(t.entry)}</td><td>${fmtMoney(t.exit)}</td><td class="${t.pnl >= 0 ? 'pos' : 'neg'}">${t.pnl >= 0 ? '+' : ''}${fmtMoney(t.pnl)} (${t.pnlPct}%)</td></tr>`).join('')}
</table>` : ''}
<div class="warn">Past results do not predict future ones. Signals and forecasts in this app are estimates from public market data, not financial advice, and the app never places trades.</div>`;
}
