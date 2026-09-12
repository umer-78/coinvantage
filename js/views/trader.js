// The automatic AI trader, running on simulated money.
import { markets, getCandles, isStable } from '../api/market.js';
import { newState, replaySymbol, stats, equity, DEFAULT_CONFIG, PAPER_NOTICE } from '../lib/autotrader.js';
import { LineChart } from '../charts/line.js';
import { $, $$, icon, toast, skeleton, coinLogo, modal, bindSeg } from '../ui.js';
import { esc, pct, money, compact, dateTime, ago, amount } from '../format.js';
import { load, save } from '../store.js';

export const title = 'AI trader';

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
      <div><h1>AI trader <span class="chip warn">SIMULATED</span></h1>
        <p>The AI runs the strategy by itself on live prices — opening, sizing and closing positions with no input from you. It uses <b>simulated money</b>: no exchange, no keys, no real orders.</p></div>
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
  function draw() {
    if (!state) { $('#body', el).innerHTML = startCard(); return; }
    const s = stats(state, st.prices);
    const open = Object.entries(state.open);
    const closed = [...state.closed].reverse();

    $('#body', el).innerHTML = `
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
        <div class="card-h"><h3>Trade log</h3><span class="fine">${s.trades} closed · ${money(s.feesPaid)} paid in fees</span></div>
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
