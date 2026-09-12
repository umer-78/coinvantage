// Futures & derivatives: funding, open interest, long/short positioning and live liquidations.
import { markets, isStable } from '../api/market.js';
import { futuresOverview, futuresSnapshot, liquidationStream, interpretFutures } from '../api/futures.js';
import { LineChart } from '../charts/line.js';
import { $, $$, skeleton, coinLogo, icon, errorBox } from '../ui.js';
import { esc, pct, money, compact, num } from '../format.js';

export const title = 'Futures';

export async function render(el, [symParam]) {
  const st = { sym: (symParam || 'BTC').toUpperCase(), liqs: [], charts: [], stop: null, disposed: false };

  el.innerHTML = `
    <div class="page-head"><div><h1>Futures &amp; derivatives</h1><p>Leverage data from Binance USD-M perpetuals: what traders are paying to hold positions, how crowded those positions are, and who is being liquidated right now.</p></div></div>
    <div class="coin-layout" id="layout">
      <div class="stack" style="gap:14px">
        <div class="card" id="coinCard">${skeleton(5, 22)}</div>
        <div class="card" id="tableCard">${skeleton(8, 22)}</div>
      </div>
      <div class="card" id="liqCard"><div class="card-h"><h3>Live liquidations</h3><span class="live-pill" id="liqPill"><i></i><span>connecting…</span></span></div><div id="liqList"><p class="fine muted">Waiting for the first liquidation…</p></div><p class="fine mt">Every row is a leveraged position force-closed on Binance futures. Clusters of large liquidations often mark short-term turning points.</p></div>
    </div>`;

  // ---------------------------------------------------------------- market table
  (async () => {
    const list = (await markets().catch(() => [])).filter((c) => c.binance && !isStable(c.symbol)).slice(0, 24);
    const rows = await futuresOverview(list.map((c) => c.symbol));
    if (st.disposed) return;
    const byS = new Map(list.map((c) => [c.symbol, c]));
    if (!rows.length) { $('#tableCard', el).innerHTML = errorBox('Binance futures data is not reachable from this network.'); return; }
    $('#tableCard', el).innerHTML = `
      <div class="card-h"><h3>Perpetual futures market</h3><span class="fine">funding is paid every 8 hours</span></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th class="l">Coin</th><th>Mark price</th><th>Funding</th><th>Annualised</th><th>Basis</th><th>Open interest</th></tr></thead><tbody>
      ${rows.sort((a, b) => (b.openInterestUsd || 0) - (a.openInterestUsd || 0)).map((r) => {
        const f = r.fundingRate === null ? null : r.fundingRate * 100;
        return `<tr data-sym="${esc(r.symbol)}"><td class="l"><div class="coin-cell">${coinLogo(byS.get(r.symbol) || { symbol: r.symbol }, 22)}<b>${esc(r.symbol)}</b></div></td>
          <td>${money(r.markPrice)}</td>
          <td class="${f > 0.01 ? 'up' : f < -0.01 ? 'down' : ''}">${f === null ? '—' : `${f > 0 ? '+' : ''}${f.toFixed(4)}%`}</td>
          <td class="fine">${f === null ? '—' : `${(f * 3 * 365) > 0 ? '+' : ''}${(f * 3 * 365).toFixed(1)}%`}</td>
          <td class="${r.basisPct > 0 ? 'up' : r.basisPct < 0 ? 'down' : ''}">${r.basisPct === null ? '—' : pct(r.basisPct, 3)}</td>
          <td>${compact(r.openInterestUsd)}</td></tr>`;
      }).join('')}
      </tbody></table></div>
      <p class="fine mt">Positive funding means longs pay shorts — the crowd is long and the market is paying for it. Deeply negative funding means the opposite. Extremes in either direction tend to unwind.</p>`;
    $$('tr[data-sym]', el).forEach((tr) => tr.addEventListener('click', () => { st.sym = tr.dataset.sym; drawCoin(); }));
  })();

  // ---------------------------------------------------------------- per-coin panel
  async function drawCoin() {
    const card = $('#coinCard', el);
    card.innerHTML = skeleton(5, 22);
    const f = await futuresSnapshot(st.sym);
    if (st.disposed) return;
    if (!f) { card.innerHTML = errorBox(`No futures market data for ${st.sym}.`); return; }
    const iv = interpretFutures(f);
    const oiNow = f.oiHistory?.at(-1)?.usd ?? f.openInterestUsd;
    card.innerHTML = `
      <div class="card-h"><h3>${esc(f.pair)} · ${esc(f.source)}</h3><a class="btn sm ghost" href="#/coin/${esc(st.sym)}">Open ${esc(st.sym)} analysis</a></div>
      <div class="grid g4">
        <div class="stat"><span class="k">Mark price</span><span class="v">${money(f.markPrice)}</span><span class="s fine">Basis ${f.basisPct === null ? '—' : pct(f.basisPct, 3)}</span></div>
        <div class="stat"><span class="k">Funding rate</span><span class="v ${iv.fundingPct > 0.01 ? 'up' : iv.fundingPct < -0.01 ? 'down' : ''}">${iv.fundingPct === null ? '—' : `${iv.fundingPct > 0 ? '+' : ''}${iv.fundingPct.toFixed(4)}%`}</span><span class="s fine">${iv.annualisedFundingPct === null ? '' : `${iv.annualisedFundingPct.toFixed(1)}% a year`}</span></div>
        <div class="stat"><span class="k">Open interest</span><span class="v">${compact(oiNow)}</span><span class="s fine ${iv.oiChange12hPct > 0 ? 'up' : iv.oiChange12hPct < 0 ? 'down' : ''}">${iv.oiChange12hPct === null ? '' : `${pct(iv.oiChange12hPct, 1)} in 12h`}</span></div>
        <div class="stat"><span class="k">Accounts long</span><span class="v">${iv.longAccountsPct === null ? '—' : `${iv.longAccountsPct.toFixed(0)}%`}</span><span class="s fine">${f.topTraders?.length ? `Top traders ${f.topTraders.at(-1).longPct.toFixed(0)}%` : ''}</span></div>
      </div>
      ${iv.notes.length ? `<ul class="reasons mt">${iv.notes.map((n) => `<li class="${/squeeze|liquidat|closed/i.test(n) ? 's' : 'b'}">${esc(n)}</li>`).join('')}</ul>` : ''}
      <div class="grid g2 mt">
        <div><h4 class="fine">Open interest (72h)</h4><div id="oiC"></div></div>
        <div><h4 class="fine">Funding history</h4><div id="fdC"></div></div>
      </div>
      <p class="fine mt">Rising price with rising open interest = new money entering the move. Rising price with falling open interest = a short squeeze that can fade fast.</p>`;

    st.charts.forEach((c) => c.destroy());
    st.charts = [];
    if (f.oiHistory?.length) {
      const c = new LineChart($('#oiC', el), { height: 190, yFormat: (v) => compact(v), legend: false });
      c.set([{ name: 'Open interest', color: 'var(--series-1)', data: f.oiHistory.map((r) => ({ x: r.t, y: r.usd })) }]);
      c.resize(); st.charts.push(c);
    }
    if (f.fundingHistory?.length) {
      const c = new LineChart($('#fdC', el), { height: 190, yFormat: (v) => `${(v * 100).toFixed(3)}%`, legend: false, zeroLine: 0 });
      c.set([{ name: 'Funding', color: 'var(--series-4)', data: f.fundingHistory.map((r) => ({ x: r.t, y: r.rate })) }]);
      c.resize(); st.charts.push(c);
    }
  }
  drawCoin();

  // ---------------------------------------------------------------- liquidation stream
  let pending = false;
  st.stop = liquidationStream((ev) => {
    if (ev.usd < 3000) return;
    st.liqs.unshift(ev);
    st.liqs = st.liqs.slice(0, 25);
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      if (st.disposed) return;
      const pill = $('#liqPill', el);
      if (pill && !pill.classList.contains('on')) { pill.classList.add('on'); pill.querySelector('span').textContent = 'streaming'; }
      $('#liqList', el).innerHTML = st.liqs.map((l) => `
        <div class="row spread" style="padding:6px 0;border-bottom:1px solid var(--border)">
          <div><b>${esc(l.symbol)}</b> <span class="chip ${l.side === 'long' ? 'down' : 'up'}">${l.side === 'long' ? 'Long liquidated' : 'Short liquidated'}</span></div>
          <div style="text-align:right"><b>${compact(l.usd)}</b><br><small class="fine">${money(l.price)} · ${new Date(l.time).toLocaleTimeString()}</small></div>
        </div>`).join('');
    }, 400);
  });

  void icon; void num;
  return () => {
    st.disposed = true;
    st.stop?.();
    st.charts.forEach((c) => c.destroy());
  };
}
