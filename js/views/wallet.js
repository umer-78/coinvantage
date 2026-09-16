import { markets, findCoin, getCandles, walletBalance, CHAINS, isStable } from '../api/market.js';
import { generateSignal, adviseHolding } from '../lib/signals.js';
import { donut } from '../charts/small.js';
import { $, $$, coinLogo, icon, toast, skeleton, modal } from '../ui.js';
import { esc, usd, price, pct, amount, changeHtml, compact, money} from '../format.js';
import { load, save } from '../store.js';
import { connectWallet, injectedWallet, walletLabel, onWalletChange } from '../api/connect.js';
import { venuesFor, tradable, TRADE_DISCLAIMER } from '../lib/trade.js';

export const title = 'Wallet';
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const COLORS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-7', '--series-8', '--series-6'];

export async function render(el) {
  let disposed = false;
  const all = await markets().catch(() => []);
  el.innerHTML = `
    <div class="page-head"><div><h1>Wallet</h1><p>Track holdings with live P&amp;L and AI hold/exit hints, and watch public wallet addresses.</p></div></div>
    <div class="grid g4" id="sum"></div>
    <div class="grid mt" style="grid-template-columns:minmax(0,1fr) 320px" id="wgrid">
      <div class="card">
        <div class="card-h"><h3>Holdings</h3><button class="btn sm primary" id="addBtn">${icon('plus', 14)} Add holding</button></div>
        <form id="addForm" class="row" hidden style="margin-bottom:12px;align-items:flex-end">
          <label class="fld">Coin<input class="inp" name="sym" list="wCoins" required placeholder="BTC" style="width:110px"></label>
          <label class="fld">Amount<input class="inp" name="amt" type="number" step="any" min="0" required placeholder="0.5" style="width:120px"></label>
          <label class="fld">Avg buy price (USD)<input class="inp" name="buy" type="number" step="any" min="0" placeholder="optional" style="width:150px"></label>
          <button class="btn primary">Save</button>
        </form>
        <div id="holdings"></div>
      </div>
      <div class="card"><div class="card-h"><h3>Allocation</h3></div><div id="alloc" style="display:grid;place-items:center"></div><div id="allocLegend" class="stack mt" style="gap:6px"></div></div>
    </div>
    <div class="card mt">
      <div class="card-h"><h3>Watch-only wallets</h3>
        <div class="row" style="gap:8px"><span class="fine">Public addresses only — read-only balance lookup</span>
        <button class="btn sm" id="connectBtn">${icon('wallet', 14)} Connect wallet</button></div></div>
      <p class="fine" id="connectMsg" style="margin-bottom:8px"></p>
      <form id="wForm" class="row" style="margin-bottom:12px;align-items:flex-end">
        <label class="fld">Network<select class="inp" name="chain">${Object.entries(CHAINS).map(([k, c]) => `<option value="${k}">${c.name}</option>`).join('')}</select></label>
        <label class="fld" style="flex:1;min-width:220px">Public address<input class="inp" name="addr" required placeholder="bc1… / 0x… / Solana address"></label>
        <label class="fld">Label<input class="inp" name="label" placeholder="Cold wallet" style="width:130px"></label>
        <button class="btn primary">Add</button>
      </form>
      <div id="wallets"></div>
      <p class="fine mt">🔒 Never enter a private key or seed phrase anywhere on this site — it never asks for them. Everything here is stored only in this browser.</p>
    </div>
    <datalist id="wCoins">${all.filter((c) => !isStable(c.symbol)).slice(0, 250).map((c) => `<option value="${esc(c.symbol)}">${esc(c.name)}</option>`).join('')}</datalist>`;
  if (window.innerWidth < 1000) $('#wgrid', el).style.gridTemplateColumns = 'minmax(0,1fr)';

  const advice = new Map();

  const drawHoldings = () => {
    const holdings = load('holdings', []);
    const rows = holdings.map((h) => {
      const c = all.find((m) => m.symbol === h.symbol);
      const p = c?.price ?? null;
      const value = p ? p * h.amount : 0;
      return { ...h, coin: c, price: p, value, pnl: h.avgBuy && p ? (p - h.avgBuy) * h.amount : null, pnlPct: h.avgBuy && p ? (p / h.avgBuy - 1) * 100 : null, ch24: c?.change24h ?? null };
    });
    const wallets = load('wallets', []);
    const walletValue = wallets.reduce((s, w) => { const c = all.find((m) => m.symbol === w.symbol); return s + (w.balance && c ? w.balance * c.price : 0); }, 0);
    const total = rows.reduce((s, r) => s + r.value, 0);
    const cost = rows.reduce((s, r) => s + (r.avgBuy ? r.avgBuy * r.amount : 0), 0);
    const pnl = rows.reduce((s, r) => s + (r.pnl || 0), 0);
    const day = rows.reduce((s, r) => s + (r.ch24 !== null ? r.value - r.value / (1 + r.ch24 / 100) : 0), 0);
    $('#sum', el).innerHTML = `
      <div class="card stat"><span class="k">Portfolio value</span><span class="v">${usd(total)}</span></div>
      <div class="card stat"><span class="k">Total profit / loss</span><span class="v ${pnl >= 0 ? 'up' : 'down'}">${pnl >= 0 ? '+' : '−'}${usd(Math.abs(pnl))}</span><span class="s">${cost ? pct((pnl / cost) * 100) : ''}</span></div>
      <div class="card stat"><span class="k">24h change</span><span class="v ${day >= 0 ? 'up' : 'down'}">${day >= 0 ? '+' : '−'}${usd(Math.abs(day))}</span></div>
      <div class="card stat"><span class="k">Watched wallets</span><span class="v">${usd(walletValue)}</span><span class="s muted">${wallets.length} address${wallets.length === 1 ? '' : 'es'}</span></div>`;
    $('#holdings', el).innerHTML = rows.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th class="l">Coin</th><th>Amount</th><th>Price</th><th>Value</th><th>P&amp;L</th><th class="hide-m">24h</th><th class="l">AI hint (4h)</th><th></th></tr></thead><tbody>
      ${rows.sort((a, b) => b.value - a.value).map((r) => { const a = advice.get(r.symbol); return `<tr data-sym="${esc(r.symbol)}">
        <td class="l"><div class="coin-cell">${coinLogo(r.coin || { symbol: r.symbol }, 24)}<b>${esc(r.symbol)}</b></div></td>
        <td>${amount(r.amount)}</td><td>${money(r.price)}</td><td><b>${usd(r.value)}</b></td>
        <td class="${(r.pnl ?? 0) >= 0 ? 'up' : 'down'}">${r.pnl !== null ? `${r.pnl >= 0 ? '+' : '−'}${usd(Math.abs(r.pnl))}<br><small>${pct(r.pnlPct)}</small>` : '<span class="muted">—</span>'}</td>
        <td class="hide-m">${changeHtml(r.ch24)}</td>
        <td class="l" style="white-space:normal;min-width:170px;max-width:240px">${a ? `<span class="${a.tone === 'warn' ? 'warn' : a.tone}">${esc(a.text)}</span>` : '<span class="spinner" style="width:12px;height:12px"></span>'}</td>
        <td><div class="row" style="gap:4px;flex-wrap:nowrap;justify-content:flex-end">
          ${tradable(r.symbol) ? `<button class="btn sm ghost" data-trade="${esc(r.symbol)}" title="Trade ${esc(r.symbol)} on an exchange">Trade</button>` : ''}
          <button class="icon-btn" style="width:30px;height:30px" data-del="${esc(r.symbol)}" aria-label="Remove">${icon('trash', 14)}</button></div></td></tr>`; }).join('')}
      </tbody></table></div>` : `<div class="empty"><p>No holdings yet.</p><button class="btn primary" id="addFirst">${icon('plus', 14)} Add your first coin</button></div>`;
    // inline onclick is blocked by the page CSP, so the empty-state button is wired here
    $('#addFirst', el)?.addEventListener('click', () => $('#addBtn', el)?.click());
    $$('[data-del]', el).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); save('holdings', load('holdings', []).filter((h) => h.symbol !== b.dataset.del)); drawHoldings(); }));
    $$('#holdings tr[data-sym]', el).forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/coin/${tr.dataset.sym}`; }));
    const items = rows.filter((r) => r.value > 0).map((r, i) => ({ label: r.symbol, value: r.value, color: cssVar(COLORS[i % COLORS.length]) }));
    $('#alloc', el).innerHTML = items.length ? donut(items) : '<p class="muted">Add holdings to see allocation.</p>';
    $('#allocLegend', el).innerHTML = items.map((it) => `<div class="row spread"><span class="row" style="gap:8px"><i style="width:10px;height:10px;border-radius:3px;background:${it.color}"></i>${esc(it.label)}</span><b>${((it.value / total) * 100).toFixed(1)}%</b></div>`).join('');
  };

  const computeAdvice = async () => {
    for (const h of load('holdings', [])) {
      if (disposed) return;
      try {
        const coin = await findCoin(h.symbol);
        const { candles } = await getCandles(coin, '4h', 300);
        const sig = generateSignal(candles, { interval: '4h' });
        advice.set(h.symbol, adviseHolding({ signal: sig, avgBuyPrice: h.avgBuy, price: candles[candles.length - 1].c }));
      } catch { advice.set(h.symbol, { text: 'No chart data', tone: 'flat' }); }
      if (!disposed) drawHoldings();
    }
  };

  $('#addBtn', el).addEventListener('click', () => { const f = $('#addForm', el); f.hidden = !f.hidden; if (!f.hidden) f.sym.focus(); });
  $('#addForm', el).sym.addEventListener('change', (e) => { const c = all.find((m) => m.symbol === e.target.value.toUpperCase()); if (c && !e.target.form.buy.value) e.target.form.buy.placeholder = price(c.price); });
  $('#addForm', el).addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const sym = f.sym.value.trim().toUpperCase();
    const coin = all.find((m) => m.symbol === sym);
    if (!coin) { toast(`${sym} not found in the top 250 coins`, 'down'); return; }
    const amt = parseFloat(f.amt.value), buy = parseFloat(f.buy.value) || coin.price;
    const holdings = load('holdings', []);
    const ex = holdings.find((h) => h.symbol === sym);
    if (ex) { const tot = ex.amount + amt; ex.avgBuy = (ex.avgBuy * ex.amount + buy * amt) / tot; ex.amount = tot; }
    else holdings.push({ symbol: sym, amount: amt, avgBuy: buy });
    save('holdings', holdings);
    f.reset(); f.hidden = true;
    drawHoldings(); computeAdvice();
  });

  const drawWallets = () => {
    const wallets = load('wallets', []);
    $('#wallets', el).innerHTML = wallets.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th class="l">Wallet</th><th class="l">Network</th><th>Balance</th><th>Value</th><th></th></tr></thead><tbody>
      ${wallets.map((w, i) => { const c = all.find((m) => m.symbol === w.symbol); return `<tr style="cursor:default"><td class="l"><b>${esc(w.label || 'Wallet')}</b><br><small class="muted mono">${esc(w.addr.slice(0, 10))}…${esc(w.addr.slice(-6))}</small></td>
        <td class="l">${esc(CHAINS[w.chain].name)}</td><td>${w.error ? `<span class="down">${esc(w.error)}</span>` : w.balance === undefined ? '<span class="spinner" style="width:12px;height:12px"></span>' : `${amount(w.balance)} ${esc(w.symbol)}`}</td>
        <td>${w.balance !== undefined && c ? usd(w.balance * c.price) : '—'}</td>
        <td><button class="icon-btn" style="width:30px;height:30px" data-wdel="${i}" aria-label="Remove">${icon('trash', 14)}</button></td></tr>`; }).join('')}
      </tbody></table></div>` : '<p class="muted">No wallets added. Paste a public BTC, ETH, BNB Chain, Polygon or Solana address to track its balance.</p>';
    $$('[data-wdel]', el).forEach((b) => b.addEventListener('click', () => { const ws = load('wallets', []); ws.splice(+b.dataset.wdel, 1); save('wallets', ws); drawWallets(); drawHoldings(); }));
  };
  const refreshWallets = async () => {
    const ws = load('wallets', []);
    await Promise.all(ws.map(async (w) => {
      try { const r = await walletBalance(w.chain, w.addr); w.balance = r.balance; w.symbol = r.symbol; delete w.error; }
      catch (err) { w.error = err.message.slice(0, 60); }
    }));
    if (disposed) return;
    save('wallets', ws); drawWallets(); drawHoldings();
  };
  $('#wForm', el).addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const chain = f.chain.value, addr = f.addr.value.trim();
    if (!CHAINS[chain].pattern.test(addr)) { toast(`That is not a valid ${CHAINS[chain].name} address`, 'down'); return; }
    const ws = load('wallets', []);
    ws.push({ chain, addr, label: f.label.value.trim(), symbol: CHAINS[chain].symbol });
    save('wallets', ws);
    f.reset(); drawWallets(); refreshWallets();
  });

  // Connecting a wallet asks it for the account address and nothing else — no
  // signature, no transaction, no key. It is the same read-only tracking as
  // pasting the address by hand, just without the copy-paste.
  const addAddresses = (addresses, chain) => {
    const ws = load('wallets', []);
    let added = 0;
    for (const addr of addresses) {
      if (ws.some((w) => w.addr.toLowerCase() === addr.toLowerCase() && w.chain === chain)) continue;
      ws.push({ chain, addr, label: `${walletLabel() || 'Wallet'}`, symbol: CHAINS[chain].symbol });
      added++;
    }
    if (added) { save('wallets', ws); drawWallets(); refreshWallets(); }
    return added;
  };

  $('#connectBtn', el).addEventListener('click', async () => {
    const msg = $('#connectMsg', el);
    if (!injectedWallet()) {
      msg.innerHTML = 'No browser wallet detected. Install MetaMask or any EVM wallet, or just paste your public address below — both are read-only here.';
      return;
    }
    msg.textContent = `Waiting for ${walletLabel()}…`;
    try {
      const r = await connectWallet();
      const added = addAddresses(r.addresses, r.chain);
      msg.innerHTML = added
        ? `<span class="up">Connected ${esc(r.label)} — added ${added} address${added === 1 ? '' : 'es'} as watch-only. No signature was requested and no key was shared.</span>`
        : `<span class="up">Connected ${esc(r.label)} — those addresses were already being tracked.</span>`;
    } catch (e) {
      msg.innerHTML = `<span class="down">${esc(e.message)}</span>`;
    }
  });

  const stopWatch = onWalletChange((ev) => {
    if (disposed || ev.type !== 'accounts') return;
    const added = addAddresses(ev.addresses || [], 'eth');
    if (added) toast(`Added ${added} more address from your wallet`, 'info');
  });

  // Buy/sell hand-off for a holding.
  const openTrade = (symbol) => {
    const venues = venuesFor(symbol);
    modal(`<h3>Trade ${esc(symbol)}</h3>
      <p class="fine">Opens the ${esc(symbol)} market on an exchange you already use.</p>
      <div class="sheet-grid mt">${venues.map((v) => `<a class="sheet-item" href="${esc(v.href)}" target="_blank" rel="noopener noreferrer">${icon('exchanges', 18)}<span>${esc(v.name)}<br><small class="fine">${esc(v.pair)}</small></span></a>`).join('')}</div>
      <p class="fine mt">${esc(TRADE_DISCLAIMER)}</p>`);
  };
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-trade]');
    if (b) { e.stopPropagation(); openTrade(b.dataset.trade); }
  });

  drawHoldings(); drawWallets(); computeAdvice(); refreshWallets();
  return () => { disposed = true; stopWatch(); };
}
