import { markets, isStable } from '../api/market.js';
import { compareExchanges, EXCHANGE_NAMES } from '../api/exchanges.js';
import { $, skeleton, icon } from '../ui.js';
import { esc, usd, pct, compact, changeHtml } from '../format.js';

export const title = 'Exchanges';

export async function render(el, [preset]) {
  const st = { base: (preset || 'BTC').toUpperCase(), timer: null, disposed: false };
  const all = await markets().catch(() => []);
  const options = all.filter((c) => c.binance && !isStable(c.symbol)).slice(0, 120);
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Exchanges</h1><p>The same coin on ${EXCHANGE_NAMES.length} exchanges: live price, spread, volume and where it's cheapest right now.</p></div>
      <div class="row">
        <select class="inp" id="base">${options.map((c) => `<option value="${esc(c.symbol)}" ${c.symbol === st.base ? 'selected' : ''}>${esc(c.symbol)} · ${esc(c.name)}</option>`).join('')}</select>
        <button class="btn" id="refresh">${icon('refresh', 16)} Refresh</button>
      </div>
    </div>
    <div class="grid g3" id="summary"></div>
    <div class="card mt"><div id="table">${skeleton(10, 26)}</div><p class="fine mt" id="foot"></p></div>`;

  const load = async () => {
    const base = st.base;
    const r = await compareExchanges(base);
    if (st.disposed || base !== st.base) return;
    const rows = r.rows.filter((x) => x.ok).sort((a, b) => (b.vol || 0) - (a.vol || 0));
    const maxVol = Math.max(...rows.map((x) => x.vol || 0), 1);
    $('#summary', el).innerHTML = rows.length ? `
      <div class="card stat"><span class="k">Average price (median)</span><span class="v">${usd(r.median)}</span><span class="s muted">${r.okCount} exchanges reporting</span></div>
      <div class="card stat"><span class="k">Cheapest to buy</span><span class="v up">${esc(r.bestBuy?.exchange || '—')}</span><span class="s">ask ${usd(r.bestBuy?.ask)}</span></div>
      <div class="card stat"><span class="k">Best place to sell</span><span class="v">${esc(r.bestSell?.exchange || '—')}</span><span class="s">bid ${usd(r.bestSell?.bid)} · gap <b class="${r.gapPct > 0 ? 'up' : 'flat'}">${pct(r.gapPct, 3)}</b></span></div>` : '';
    $('#table', el).innerHTML = rows.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th class="l">#</th><th class="l">Exchange</th><th class="l">Pair</th><th>Price</th><th>vs median</th><th>Bid</th><th>Ask</th><th>Spread</th><th>24h</th><th class="l">Volume 24h</th></tr></thead><tbody>
      ${rows.map((q, i) => `<tr style="cursor:default"><td class="l muted">${i + 1}</td><td class="l"><b>${esc(q.exchange)}</b>${r.bestBuy?.exchange === q.exchange ? ' <span class="chip up">best buy</span>' : ''}</td><td class="l muted">${esc(q.pair)}</td>
        <td><b>${usd(q.price)}</b></td><td class="${q.deviationPct >= 0 ? 'up' : 'down'}">${pct(q.deviationPct, 3)}</td><td>${usd(q.bid)}</td><td>${usd(q.ask)}</td><td>${pct(q.spreadPct, 3, false)}</td><td>${changeHtml(q.change24h)}</td>
        <td class="l"><div class="row" style="gap:8px;flex-wrap:nowrap"><div class="meter" style="width:80px"><i style="width:${((q.vol || 0) / maxVol) * 100}%;background:var(--series-1)"></i></div>${compact(q.vol)}</div></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No exchange returned a price for this coin.</div>';
    const failed = r.rows.filter((x) => !x.ok).map((x) => x.exchange);
    $('#foot', el).textContent = `${r.demo ? 'Demo data (exchanges unreachable). ' : ''}Auto-refreshes every 10 seconds. ${failed.length ? `Not listed / unavailable: ${failed.join(', ')}. ` : ''}Gaps between exchanges ignore trading fees, withdrawal fees and transfer time, so small gaps are not free money. USD pairs (Coinbase, Kraken, Gemini) can differ slightly from USDT pairs.`;
  };

  $('#base', el).addEventListener('change', (e) => { st.base = e.target.value; $('#table', el).innerHTML = skeleton(10, 26); load(); });
  $('#refresh', el).addEventListener('click', load);
  load();
  st.timer = setInterval(load, 10000);
  return () => { st.disposed = true; clearInterval(st.timer); };
}
