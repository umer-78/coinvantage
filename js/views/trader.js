// The automatic AI trader, running on simulated money.
import { markets, getCandles, isStable, findCoin } from '../api/market.js';
import { newState, replaySymbol, stats, equity, closeManual, recordRealTrade, DEFAULT_CONFIG, PAPER_NOTICE, REAL_NOTICE } from '../lib/autotrader.js';
import { parseTradeCsv, matchFills } from '../lib/importer.js';
import { tradesCsv, downloadText, reportHtml } from '../lib/export.js';
import { LineChart } from '../charts/line.js';
import { $, $$, icon, toast, skeleton, coinLogo, modal, bindSeg } from '../ui.js';
import { esc, pct, money, compact, dateTime, ago, amount } from '../format.js';
import { load, save } from '../store.js';

export const title = 'Trading';

const CFG_KEY = 'traderCfg';
const STATE_KEY = 'traderState';

export async function render(el) {
  const st = { disposed: false, charts: [], prices: {}, running: false };
  const cfg = { ...DEFAULT_CONFIG, ...load(CFG_KEY, {}) };
  let state = load(STATE_KEY, null);

  const all = await markets().catch(() => []);
  const tradable = all.filter((c) => c.binance && !isStable(c.symbol)).slice(0, 60);

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Trading</h1>
        <p>Three accounts, side by side: the practice trades you place yourself, the trades you really made, and the AI running the strategy on its own. Only the real account involves real money — CoinVantage never places an order and holds no keys.</p></div>
      <div class="row">
        <button class="btn" id="cfgBtn">${icon('chip', 16)} Settings</button>
        ${state ? '<button class="btn ghost" id="resetBtn">Reset</button>' : ''}
        <button class="btn primary" id="startBtn">${state ? icon('refresh', 16) + ' Catch up now' : icon('bolt', 16) + ' Start the trader'}</button>
      </div>
    </div>
    <div id="body">${state ? skeleton(6, 26) : startCard()}</div>`;

  function startCard() {
    return `<div class="card empty">
      <h3>Let the AI trade for you — with play money</h3>
      <p style="max-width:620px">It watches ${cfg.universe.length} coins on the ${esc(cfg.interval)} chart. When the signal turns bullish it buys, sizes the position so a stop-out costs ${cfg.riskPct}% of the balance, moves the stop to break-even at +1R, and sells at the target, the stop, or when the signal turns against it. Every trade is logged with fees.</p>
      <p class="fine" style="max-width:620px">Starting balance ${money(cfg.startingBalance)}. It also catches up on the candles that closed while this page was shut, so the record stays continuous.</p>
    </div>`;
  }

  // ---------------------------------------------------------------- engine
  async function catchUp() {
    if (st.running) return;
    st.running = true;
    const btn = $('#startBtn', el);
    const old = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Working…';
    if (!state) state = newState(cfg);

    let processed = 0, failed = [];
    for (const sym of cfg.universe) {
      if (st.disposed) return;
      const coin = all.find((c) => c.symbol === sym);
      if (!coin) { failed.push(sym); continue; }
      try {
        const r = await getCandles(coin, cfg.interval, 500);
        // only fully closed candles drive decisions
        const candles = r.candles.slice(0, -1);
        processed += replaySymbol(state, cfg, sym, candles).processed;
      } catch { failed.push(sym); }
    }
    save(STATE_KEY, state);
    st.running = false;
    if (st.disposed) return;
    btn.disabled = false;
    btn.innerHTML = old;
    if (failed.length) toast(`No data for ${failed.join(', ')} — skipped.`, 'info');
    draw();
    if (processed) toast(`Processed ${processed} new candles.`, 'up');
  }

  // ---------------------------------------------------------------- view
  // --- the real account -------------------------------------------------
  // Trades actually placed on an exchange, typed in here. CoinVantage records
  // them; it never places one. Same statistics as the simulated accounts so the
  // three can be compared honestly.
  const REAL_KEY = 'realTradeState';
  const realState = () => load(REAL_KEY, null);

  function realCard() {
    const rs = realState();
    const has = rs && (Object.keys(rs.open).length || rs.closed.length);
    const s3 = has ? stats(rs, st.prices) : null;
    const open = has ? Object.entries(rs.open) : [];
    const closed = has ? [...rs.closed].reverse().slice(0, 25) : [];
    return `<div class="card mt">
      <div class="card-h"><h3>Real account</h3><div class="row" style="gap:8px"><span class="chip up">Your own money</span>${has ? '<button class="btn sm ghost" id="realReset">Reset</button>' : ''}</div></div>
      <p class="fine">Record the trades you actually placed on an exchange and they are measured the same way as the accounts above. ${esc(REAL_NOTICE)}</p>

      <div class="row mt" style="gap:10px;align-items:center;flex-wrap:wrap">
        <label class="btn sm" style="cursor:pointer">${icon('exchanges', 14)} Import from Binance
          <input type="file" id="csvIn" accept=".csv,.tsv,.txt" hidden>
        </label>
        <span class="fine">Binance → Orders → Trade History → Export. The file is read in your browser; nothing is uploaded.</span>
      </div>
      ${has ? `<div class="row mt" style="gap:8px;flex-wrap:wrap">
        <button class="btn sm ghost" data-export="real-csv">Download trades (CSV)</button>
        <button class="btn sm ghost" data-report="real">Printable report</button>
      </div>` : ''}
      <p class="fine" id="csvMsg" hidden></p>

      <form id="rf" class="row mt" style="gap:8px;align-items:flex-end;flex-wrap:wrap">
        <label class="fld">Coin<select class="inp" name="sym">${tradable.slice(0, 60).map((c) => `<option value="${esc(c.symbol)}">${esc(c.symbol)}</option>`).join('')}</select></label>
        <label class="fld">Side<select class="inp" name="side"><option value="long">Bought</option><option value="short">Sold short</option></select></label>
        <label class="fld">Amount<input class="inp" name="qty" type="number" step="any" min="0" placeholder="0.05" style="width:100px" required></label>
        <label class="fld">Price in<input class="inp" name="entry" type="number" step="any" min="0" placeholder="60000" style="width:110px" required></label>
        <label class="fld">Price out<input class="inp" name="exit" type="number" step="any" min="0" placeholder="still open" style="width:110px"></label>
        <label class="fld">Fee<input class="inp" name="fee" type="number" step="any" min="0" placeholder="0" style="width:80px"></label>
        <button class="btn primary">Record trade</button>
      </form>
      <p class="fine down" id="rfErr" hidden></p>

      ${s3 ? `<div class="grid g4 mt">
        <div class="stat"><span class="k">Realised result</span><span class="v ${s3.returnPct >= 0 ? 'up' : 'down'}">${pct(s3.returnPct)}</span><span class="s fine">${money(s3.equity - s3.startingBalance)} on a ${money(s3.startingBalance)} basis</span></div>
        <div class="stat"><span class="k">Win rate</span><span class="v">${s3.winRate === null ? '—' : `${s3.winRate}%`}</span><span class="s fine">${s3.wins}W / ${s3.losses}L${s3.profitFactor ? ` · PF ${s3.profitFactor}` : ''}</span></div>
        <div class="stat"><span class="k">Max drawdown</span><span class="v down">${pct(-s3.maxDrawdownPct, 1)}</span></div>
        <div class="stat"><span class="k">Trades</span><span class="v">${s3.trades}</span><span class="s fine">${s3.openCount} open</span></div>
      </div>` : ''}

      ${open.length ? `<div class="tbl-wrap mt"><table class="tbl"><thead><tr><th class="l">Coin</th><th>Side</th><th>In at</th><th>Now</th><th>Size</th><th>Open P&amp;L</th><th></th></tr></thead><tbody>
        ${open.map(([sym, p]) => {
          const px = st.prices[sym] ?? p.entry;
          const pnl = (p.side === 'short' ? (p.entry - px) : (px - p.entry)) * p.qty;
          return `<tr><td class="l"><b>${esc(sym)}</b></td><td>${p.side === 'short' ? 'Short' : 'Long'}</td><td>${money(p.entry)}</td><td>${money(px)}</td><td>${money(p.notional)}</td>
            <td class="${pnl >= 0 ? 'up' : 'down'}"><b>${pnl >= 0 ? '+' : '−'}${money(Math.abs(pnl))}</b></td>
            <td><button class="btn sm" data-realclose="${esc(sym)}">Close at live price</button></td></tr>`;
        }).join('')}</tbody></table></div>` : ''}

      ${closed.length ? `<div class="tbl-wrap mt"><table class="tbl"><thead><tr><th class="l">Coin</th><th class="l">Closed</th><th>In</th><th>Out</th><th>Result</th></tr></thead><tbody>
        ${closed.map((t) => `<tr><td class="l"><b>${esc(t.symbol)}</b>${t.side === 'short' ? ' <small class="muted">short</small>' : ''}</td><td class="l fine">${dateTime(t.exitAt, false)}</td><td>${money(t.entry)}</td><td>${money(t.exit)}</td>
          <td class="${t.pnl >= 0 ? 'up' : 'down'}"><b>${t.pnl >= 0 ? '+' : '−'}${money(Math.abs(t.pnl))}</b> <small>${pct(t.pnlPct)}</small></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="fine mt">No real trades recorded yet.</p>'}
      ${has && rs.equityCurve.length > 2 ? `<div class="mt"><div class="card-h" style="margin-bottom:6px"><h3 style="font-size:14px">Your money over time</h3><span class="fine">against simply holding Bitcoin</span></div><div id="realChart"></div><p class="fine" id="realChartNote"></p></div>` : ''}
    </div>`;
  }

  // The chart that answers "was any of this worth it?": the real account's
  // balance against the same money left in Bitcoin over the same period. A
  // trading record without that comparison flatters itself — a 20% gain in a
  // year Bitcoin doubled is a loss in every sense that matters.
  async function drawRealChart() {
    const host = $('#realChart', el);
    if (!host) return;
    const rs = realState();
    if (!rs || rs.equityCurve.length < 3) return;
    const curve = rs.equityCurve;
    const from = curve[0].t, to = curve[curve.length - 1].t;
    const note = $('#realChartNote', el);

    let holdSeries = null;
    try {
      const btc = await findCoin('BTC');
      const span = to - from;
      const iv = span > 120 * 864e5 ? '1d' : span > 10 * 864e5 ? '4h' : '1h';
      const { candles } = await getCandles(btc, iv, 1000);
      const inRange = candles.filter((c) => c.t >= from - 864e5 && c.t <= to + 864e5);
      if (inRange.length > 2) {
        const base = inRange[0].c;
        holdSeries = inRange.map((c) => ({ x: c.t, y: (c.c / base) * rs.startingBalance }));
      }
    } catch { /* the comparison is a bonus, not a requirement */ }

    if (st.disposed) return;
    const lc = new LineChart(host, { height: 240, yFormat: (v) => money(v), legend: true });
    st.charts.push(lc);
    const series = [{ name: 'Your account', color: 'var(--accent)', width: 2.4, data: curve.map((p) => ({ x: p.t, y: p.equity })) }];
    if (holdSeries) series.push({ name: 'Holding BTC', color: 'var(--text-muted)', width: 1.6, dash: true, data: holdSeries });
    lc.set(series);

    if (note && holdSeries) {
      const mine = ((curve[curve.length - 1].equity / rs.startingBalance) - 1) * 100;
      const hold = ((holdSeries[holdSeries.length - 1].y / rs.startingBalance) - 1) * 100;
      const diff = mine - hold;
      note.textContent = diff >= 0
        ? `You are ${pct(diff, 1)} ahead of simply holding Bitcoin over this period.`
        : `Holding Bitcoin would have done ${pct(Math.abs(diff), 1, false)} better over this period. Worth knowing before trading more.`;
      note.className = `fine ${diff >= 0 ? 'up' : 'down'}`;
    }
  }

  // Downloads happen entirely in the browser — the data never left it, and the
  // export should not be the moment it starts to.
  function wireExports() {
    const stamp = new Date().toISOString().slice(0, 10);
    $$('[data-export]', el).forEach((b) => b.addEventListener('click', () => {
      const which = b.dataset.export;
      const src = which === 'ai-csv' ? state : realState();
      if (!src?.closed?.length) { toast('No closed trades to export yet.', 'info'); return; }
      downloadText(`coinvantage-${which === 'ai-csv' ? 'ai-trader' : 'my-trades'}-${stamp}.csv`, tradesCsv(src.closed));
      toast(`${src.closed.length} trades exported.`, 'up');
    }));
    $$('[data-report]', el).forEach((b) => b.addEventListener('click', () => {
      const isAi = b.dataset.report === 'ai';
      const src = isAi ? state : realState();
      if (!src) { toast('Nothing to report on yet.', 'info'); return; }
      const s2 = stats(src, st.prices);
      const notes = isAi
        ? ['<b>Simulated money.</b> These trades were never placed on an exchange. Fees are modelled, slippage is not.']
        : ['<b>Recorded by hand or imported.</b> These are trades placed on an exchange; this app did not place them.'];
      const html = reportHtml({
        title: isAi ? 'AI trader — performance report' : 'Trading performance report',
        accountName: isAi ? 'Simulated account' : 'Real account',
        stats: s2, closed: [...src.closed].reverse(),
        fmtMoney: (v) => money(v), notes,
      });
      const w = window.open('', '_blank');
      if (!w) { downloadText(`coinvantage-report-${stamp}.html`, html, 'text/html;charset=utf-8'); toast('Report downloaded.', 'up'); return; }
      w.document.write(html);
      w.document.close();
    }));
  }

  function wireReal() {
    // Import: parse in the browser, match buys to sells FIFO, and show what
    // happened before writing anything.
    $('#csvIn', el)?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const msg = $('#csvMsg', el);
      msg.hidden = false;
      msg.className = 'fine';
      msg.textContent = `Reading ${file.name}…`;
      try {
        const text = await file.text();
        const { fills, errors, skipped } = parseTradeCsv(text);
        if (errors.length) { msg.className = 'fine down'; msg.textContent = errors[0]; return; }
        const { closed, open } = matchFills(fills);
        if (!closed.length && !open.length) { msg.className = 'fine down'; msg.textContent = 'No trades could be matched from that file.'; return; }

        const rs = realState() || newState(cfg);
        let added = 0;
        for (const t of closed) {
          const r = recordRealTrade(rs, cfg, {
            symbol: t.symbol, side: 'long', qty: t.qty, entry: t.entry, exit: t.exit,
            fee: t.fee, openedAt: t.openedAt, closedAt: t.closedAt, note: 'imported',
          });
          if (r.ok) added++;
        }
        for (const o of open) {
          const r = recordRealTrade(rs, cfg, { symbol: o.symbol, side: 'long', qty: o.qty, entry: o.entry, fee: o.fee, openedAt: o.at, note: 'imported' });
          if (r.ok) added++;
        }
        save(REAL_KEY, rs);
        msg.className = 'fine up';
        msg.textContent = `Imported ${added} trade${added === 1 ? '' : 's'} from ${fills.length} fills — ${closed.length} closed, ${open.length} still open${skipped ? `, ${skipped} row${skipped === 1 ? '' : 's'} skipped` : ''}.`;
        toast(`${added} trades imported.`, 'up');
        draw();
      } catch (err) {
        msg.className = 'fine down';
        msg.textContent = `Could not read that file: ${err.message}`;
      } finally {
        e.target.value = '';
      }
    });

    const f3 = $('#rf', el);
    f3?.addEventListener('submit', (e) => {
      e.preventDefault();
      const err = $('#rfErr', el);
      err.hidden = true;
      const rs = realState() || newState(cfg);
      const r = recordRealTrade(rs, cfg, {
        symbol: f3.sym.value, side: f3.side.value,
        qty: f3.qty.value, entry: f3.entry.value,
        exit: f3.exit.value === '' ? null : f3.exit.value,
        fee: f3.fee.value || 0,
      });
      if (!r.ok) { err.textContent = r.error; err.hidden = false; return; }
      save(REAL_KEY, rs);
      toast(r.trade ? `Recorded — ${r.trade.pnl >= 0 ? 'profit' : 'loss'} ${r.trade.pnlPct}%.` : `Open ${f3.sym.value} trade recorded.`, r.trade && r.trade.pnl < 0 ? 'down' : 'up');
      draw();
    });
    $$('[data-realclose]', el).forEach((b) => b.addEventListener('click', () => {
      const sym = b.dataset.realclose;
      const rs = realState();
      const px = st.prices[sym] ?? rs.open[sym]?.entry;
      const r = closeManual(rs, cfg, sym, px);
      if (!r.ok) { toast(r.error, 'down'); return; }
      save(REAL_KEY, rs);
      toast(`${sym} closed at ${money(px)}.`, r.trade.pnl >= 0 ? 'up' : 'down');
      draw();
    }));
    $('#realReset', el)?.addEventListener('click', () => {
      save(REAL_KEY, newState(cfg));
      toast('Real account cleared.', 'info');
      draw();
    });
  }

  // Trades you placed yourself, from a coin page. Kept in their own account so
  // the AI's record stays a record of the AI.
  const MY_KEY = 'myDemoState';
  const myState = () => load(MY_KEY, null);

  function myDemoCard() {
    const ms = myState();
    if (!ms || (!Object.keys(ms.open).length && !ms.closed.length)) {
      return `<div class="card"><div class="card-h"><h3>Your own demo trades</h3><span class="chip">Separate account</span></div>
        <p class="fine">Nothing here yet. Open any coin, press <b>Trade</b>, and use <b>Buy (demo)</b> to place a practice trade yourself at the live price. It is kept apart from the AI's account below, so your experiments never distort the strategy's record.</p></div>`;
    }
    const s2 = stats(ms, st.prices);
    const open = Object.entries(ms.open);
    const closed = [...ms.closed].reverse().slice(0, 20);
    return `<div class="card">
      <div class="card-h"><h3>Your own demo trades</h3><div class="row" style="gap:8px"><span class="chip">Separate account</span><button class="btn sm ghost" id="myReset">Reset</button></div></div>
      <div class="grid g4">
        <div class="stat"><span class="k">Balance</span><span class="v ${s2.returnPct >= 0 ? 'up' : 'down'}">${money(s2.equity)}</span><span class="s fine">started at ${money(s2.startingBalance)}</span></div>
        <div class="stat"><span class="k">Return</span><span class="v ${s2.returnPct >= 0 ? 'up' : 'down'}">${pct(s2.returnPct)}</span></div>
        <div class="stat"><span class="k">Win rate</span><span class="v">${s2.winRate === null ? '—' : `${s2.winRate}%`}</span><span class="s fine">${s2.wins}W / ${s2.losses}L</span></div>
        <div class="stat"><span class="k">Trades</span><span class="v">${s2.trades}</span><span class="s fine">${s2.openCount} still open</span></div>
      </div>
      ${open.length ? `<div class="tbl-wrap mt"><table class="tbl"><thead><tr><th class="l">Coin</th><th>Bought at</th><th>Now</th><th>Size</th><th>Open P&amp;L</th><th></th></tr></thead><tbody>
        ${open.map(([sym, p]) => {
          const px = st.prices[sym] ?? p.entry;
          const pnl = (px - p.entry) * p.qty;
          return `<tr><td class="l"><b>${esc(sym)}</b></td><td>${money(p.entry)}</td><td>${money(px)}</td><td>${money(p.notional)}</td>
            <td class="${pnl >= 0 ? 'up' : 'down'}"><b>${pnl >= 0 ? '+' : '−'}${money(Math.abs(pnl))}</b> <small>${pct((px / p.entry - 1) * 100)}</small></td>
            <td><button class="btn sm" data-mysell="${esc(sym)}">Sell</button></td></tr>`;
        }).join('')}
      </tbody></table></div>` : ''}
      ${closed.length ? `<div class="tbl-wrap mt"><table class="tbl"><thead><tr><th class="l">Coin</th><th class="l">Closed</th><th>Bought</th><th>Sold</th><th>Result</th></tr></thead><tbody>
        ${closed.map((t) => `<tr><td class="l"><b>${esc(t.symbol)}</b></td><td class="l fine">${dateTime(t.exitAt, false)}</td><td>${money(t.entry)}</td><td>${money(t.exit)}</td>
          <td class="${t.pnl >= 0 ? 'up' : 'down'}"><b>${t.pnl >= 0 ? '+' : '−'}${money(Math.abs(t.pnl))}</b> <small>${pct(t.pnlPct)}</small></td></tr>`).join('')}
      </tbody></table></div>` : ''}
      <p class="fine mt">${esc(PAPER_NOTICE)}</p>
    </div>`;
  }

  function wireMyDemo() {
    $('#myReset', el)?.addEventListener('click', () => {
      save(MY_KEY, newState(cfg));
      toast('Your demo account is back to its starting balance.', 'info');
      draw();
    });
    $$('[data-mysell]', el).forEach((b) => b.addEventListener('click', () => {
      const sym = b.dataset.mysell;
      const ms = myState();
      const px = st.prices[sym] ?? ms.open[sym]?.entry;
      const r = closeManual(ms, cfg, sym, px);
      if (!r.ok) { toast(r.error, 'down'); return; }
      save(MY_KEY, ms);
      toast(`Sold ${sym} — ${r.trade.pnl >= 0 ? 'profit' : 'loss'} ${r.trade.pnlPct}%.`, r.trade.pnl >= 0 ? 'up' : 'down');
      draw();
    }));
  }

  function draw() {
    if (!state) { $('#body', el).innerHTML = `${myDemoCard()}${realCard()}<div class="mt">${startCard()}</div>`; wireMyDemo(); wireReal(); wireExports(); drawRealChart(); return; }
    const s = stats(state, st.prices);
    const open = Object.entries(state.open);
    const closed = [...state.closed].reverse();

    $('#body', el).innerHTML = `
      ${myDemoCard()}
      ${realCard()}
      <h3 class="mt" style="margin-bottom:8px">The AI's own account</h3>
      <div class="grid g4">
        <div class="card"><div class="stat"><span class="k">Balance now</span><span class="v ${s.returnPct >= 0 ? 'up' : 'down'}">${money(s.equity)}</span><span class="s fine">started at ${money(s.startingBalance)}</span></div></div>
        <div class="card"><div class="stat"><span class="k">Return</span><span class="v ${s.returnPct >= 0 ? 'up' : 'down'}">${pct(s.returnPct)}</span><span class="s fine">since ${dateTime(s.since, false)}</span></div></div>
        <div class="card"><div class="stat"><span class="k">Win rate</span><span class="v">${s.winRate === null ? '—' : `${s.winRate}%`}</span><span class="s fine">${s.wins}W / ${s.losses}L${s.profitFactor ? ` · PF ${s.profitFactor}` : ''}</span></div></div>
        <div class="card"><div class="stat"><span class="k">Max drawdown</span><span class="v down">${pct(-s.maxDrawdownPct, 1)}</span><span class="s fine">${s.openCount} open · ${s.trades} closed</span></div></div>
      </div>

      <div class="card mt">
        <div class="card-h"><h3>Open positions</h3><span class="fine">marked against the live price</span></div>
        ${open.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th class="l">Coin</th><th>Entry</th><th>Now</th><th>Stop</th><th>Target</th><th>Size</th><th>Open P&amp;L</th><th class="l">Opened</th></tr></thead><tbody>
          ${open.map(([sym, p]) => {
            const px = st.prices[sym] ?? p.entry;
            const pnl = (px - p.entry) * p.qty;
            const coin = all.find((c) => c.symbol === sym);
            return `<tr data-sym="${esc(sym)}">
              <td class="l"><div class="coin-cell">${coinLogo(coin || { symbol: sym }, 22)}<b>${esc(sym)}</b></div></td>
              <td>${money(p.entry)}</td><td>${money(px)}</td>
              <td class="down">${money(p.stop)}${p.movedToBreakEven ? ' <span class="fine">(BE)</span>' : ''}</td>
              <td class="up">${money(p.tp)}</td>
              <td>${money(p.notional)}</td>
              <td class="${pnl >= 0 ? 'up' : 'down'}"><b>${pnl >= 0 ? '+' : '−'}${money(Math.abs(pnl))}</b><br><small>${pct((px / p.entry - 1) * 100)}</small></td>
              <td class="l fine">${ago(p.openedAt)}</td></tr>`;
          }).join('')}
        </tbody></table></div>` : '<p class="muted">No position open right now — the AI is waiting for a setup that meets its rules.</p>'}
      </div>

      ${state.equityCurve.length > 2 ? `<div class="card mt"><div class="card-h"><h3>Balance over time</h3><span class="fine">simulated</span></div><div id="eqChart"></div></div>` : ''}

      <div class="card mt">
        <div class="card-h"><h3>Trade log</h3><div class="row" style="gap:8px"><span class="fine">${s.trades} closed · ${money(s.feesPaid)} paid in fees</span><button class="btn sm ghost" data-export="ai-csv">CSV</button><button class="btn sm ghost" data-report="ai">Report</button></div></div>
        ${closed.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th class="l">Coin</th><th class="l">Opened</th><th class="l">Closed</th><th>Entry</th><th>Exit</th><th>Result</th><th class="l">Why it closed</th></tr></thead><tbody>
          ${closed.slice(0, 60).map((t) => `<tr data-sym="${esc(t.symbol)}">
            <td class="l"><b>${esc(t.symbol)}</b></td>
            <td class="l fine">${dateTime(t.openedAt)}</td><td class="l fine">${dateTime(t.exitAt)}</td>
            <td>${money(t.entry)}</td><td>${money(t.exit)}</td>
            <td class="${t.pnl >= 0 ? 'up' : 'down'}"><b>${t.pnl >= 0 ? '+' : '−'}${money(Math.abs(t.pnl))}</b> <small>${pct(t.pnlPct)}</small></td>
            <td class="l"><span class="chip ${t.reason === 'target' ? 'up' : t.reason === 'stop-loss' ? 'down' : ''}">${esc(t.reason)}</span></td></tr>`).join('')}
        </tbody></table></div>` : '<p class="muted">No closed trades yet.</p>'}
      </div>

      <div class="card mt" style="background:var(--surface-2)">
        <h3>What this is and is not</h3>
        <p class="fine">${esc(PAPER_NOTICE)} Results include a ${cfg.feePct}% fee per side and assume the stop is hit first whenever a candle contains both the stop and the target — so the record errs against the strategy, never for it.</p>
        <p class="fine">A simulation cannot reproduce slippage, thin order books or an exchange going down mid-move. Treat a good run here as evidence the rules are sane, not as an expected return.</p>
      </div>`;

    $$('tr[data-sym]', el).forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/coin/${tr.dataset.sym}`; }));
    wireMyDemo();
    wireReal();
    wireExports();
    drawRealChart();

    st.charts.forEach((c) => c.destroy());
    st.charts = [];
    if ($('#eqChart', el)) {
      const lc = new LineChart($('#eqChart', el), { height: 240, yFormat: (v) => money(v), legend: false });
      st.charts.push(lc);
      lc.set([{ name: 'Balance', color: 'var(--accent)', width: 2.2, data: state.equityCurve.map((p) => ({ x: p.t, y: p.equity })) }]);
    }
  }

  // ---------------------------------------------------------------- settings
  $('#cfgBtn', el).addEventListener('click', () => {
    const m = modal(`<h3>Trader settings</h3>
      <p class="fine">Changing these does not rewrite past trades.</p>
      <form class="stack mt" style="gap:10px" id="cf">
        <div class="row" style="gap:8px">
          <label class="fld">Starting balance<input class="inp" name="startingBalance" type="number" min="100" step="100" value="${cfg.startingBalance}" style="width:130px"></label>
          <label class="fld">Risk per trade %<input class="inp" name="riskPct" type="number" min="0.1" max="10" step="0.1" value="${cfg.riskPct}" style="width:120px"></label>
          <label class="fld">Max open<input class="inp" name="maxPositions" type="number" min="1" max="10" value="${cfg.maxPositions}" style="width:90px"></label>
        </div>
        <label class="fld">Chart<select class="inp" name="interval">${['15m', '1h', '4h', '1d'].map((i) => `<option ${i === cfg.interval ? 'selected' : ''}>${i}</option>`).join('')}</select></label>
        <label class="fld">Coins it may trade<input class="inp" name="universe" value="${esc(cfg.universe.join(', '))}"></label>
        <p class="fine">Available: ${esc(tradable.slice(0, 24).map((c) => c.symbol).join(', '))}…</p>
        <button class="btn primary">Save settings</button>
      </form>`);
    $('#cf', m.el).addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      const uni = f.universe.value.split(',').map((x) => x.trim().toUpperCase()).filter((x) => tradable.some((c) => c.symbol === x));
      if (!uni.length) { toast('Pick at least one tradable coin.', 'down'); return; }
      Object.assign(cfg, {
        startingBalance: Math.max(100, +f.startingBalance.value),
        riskPct: Math.min(10, Math.max(0.1, +f.riskPct.value)),
        maxPositions: Math.min(10, Math.max(1, +f.maxPositions.value)),
        interval: f.interval.value,
        universe: uni.slice(0, 12),
      });
      save(CFG_KEY, cfg);
      m.close();
      toast('Settings saved.', 'up');
      draw();
    });
  });

  $('#resetBtn', el)?.addEventListener('click', () => {
    const m = modal(`<h3>Reset the trader?</h3><p>This wipes the simulated balance and the whole trade log, and starts again from ${money(cfg.startingBalance)}.</p>
      <div class="row mt" style="gap:8px"><button class="btn" id="no">Keep it</button><button class="btn primary" id="yes">Reset</button></div>`);
    $('#no', m.el).addEventListener('click', m.close);
    $('#yes', m.el).addEventListener('click', () => {
      state = newState(cfg); save(STATE_KEY, state); m.close(); draw(); toast('Trader reset.', 'info');
    });
  });

  $('#startBtn', el).addEventListener('click', catchUp);

  // live marks + periodic catch-up
  const onTick = (e) => {
    let changed = false;
    for (const t of e.detail) {
      const sym = t.s.replace(/USDT$/, '');
      if (state?.open[sym]) { st.prices[sym] = +t.c; changed = true; }
    }
    if (changed && !st.paintQueued) {
      st.paintQueued = true;
      setTimeout(() => { st.paintQueued = false; if (!st.disposed && state) draw(); }, 4000);
    }
  };
  window.addEventListener('cv:tickers', onTick);
  const timer = setInterval(() => { if (!st.disposed && state) catchUp(); }, 5 * 60e3);

  if (state) { draw(); catchUp(); }
  void compact; void amount; void bindSeg;

  return () => {
    st.disposed = true;
    clearInterval(timer);
    window.removeEventListener('cv:tickers', onTick);
    st.charts.forEach((c) => c.destroy());
  };
}
