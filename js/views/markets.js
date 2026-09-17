import { markets, cachedMarkets, getGlobal, getFearGreed, getTrending, isStable } from '../api/market.js';
import { $, $$, icon, coinLogo, skeleton, errorBox, bindSeg } from '../ui.js';
import { esc, price, compact, pct, changeHtml, money, dateTime } from '../format.js';
import { sparkline, gauge, treemap, changeColor } from '../charts/small.js';
import { watchlist } from '../store.js';

export const title = 'Markets';

export async function render(el) {
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Crypto prices today</h1><p id="mkSummary">Live prices, market caps and 7-day trends for the top 250 coins.</p></div>
    </div>
    <div class="global-strip" id="globalStrip">${Array.from({ length: 5 }, () => `<div class="card">${skeleton(2, 16)}</div>`).join('')}</div>
    <div class="grid g4" style="margin-bottom:14px">
      <div class="card"><div class="card-h"><h3>Fear &amp; Greed</h3><span class="fine" id="fngDate"></span></div><div id="fng">${skeleton(3)}</div></div>
      <div class="card"><div class="card-h"><h3>🔥 Trending</h3></div><div class="hl-list" id="trending">${skeleton(5)}</div></div>
      <div class="card"><div class="card-h"><h3>🚀 Top gainers 24h</h3></div><div class="hl-list" id="gainers">${skeleton(5)}</div></div>
      <div class="card"><div class="card-h"><h3>📉 Top losers 24h</h3></div><div class="hl-list" id="losers">${skeleton(5)}</div></div>
    </div>
    <div class="card">
      <div class="card-h">
        <div class="seg" id="scope"><button data-v="all" class="on">All coins</button><button data-v="watch">${icon('star', 13)} Watchlist</button></div>
        <div class="row">
          <input class="inp" id="filter" placeholder="Filter…" style="width:150px">
          <div class="seg" id="mode"><button data-v="table" class="on">Table</button><button data-v="heatmap">Heatmap</button></div>
        </div>
      </div>
      <div id="tableArea">${skeleton(10, 26)}</div>
    </div>`;

  const state = { scope: 'all', mode: 'table', sort: 'rank', dir: 1, filter: '', limit: 100, rows: cachedMarkets() || [] };
  let disposed = false;

  const drawTable = () => {
    const area = $('#tableArea', el);
    let rows = state.rows;
    if (state.scope === 'watch') { const w = watchlist.all(); rows = rows.filter((r) => w.includes(r.symbol)); }
    if (state.filter) { const f = state.filter.toLowerCase(); rows = rows.filter((r) => r.symbol.toLowerCase().includes(f) || r.name.toLowerCase().includes(f)); }
    if (!rows.length) { area.innerHTML = `<div class="empty">${state.scope === 'watch' ? 'Your watchlist is empty — tap ☆ next to a coin to add it.' : 'No coins match.'}</div>`; return; }
    if (state.mode === 'heatmap') {
      area.innerHTML = '<div class="treemap" id="tm"></div><p class="fine mt">Tile size = market cap · colour = 24h change. Tap a tile to open the coin.</p>';
      const top = rows.filter((r) => !isStable(r.symbol)).slice(0, 60);
      treemap($('#tm', area), top.map((r) => ({ value: Math.sqrt(r.marketCap || 1), label: r.symbol, sub: pct(r.change24h), color: changeColor(r.change24h), symbol: r.symbol })), { onClick: (r) => { location.hash = `#/coin/${r.symbol}`; } });
      return;
    }
    const key = state.sort;
    rows = [...rows].sort((a, b) => ((a[key] ?? -Infinity) > (b[key] ?? -Infinity) ? 1 : -1) * state.dir * (key === 'rank' || key === 'name' ? 1 : -1));
    const th = (k, label, cls = '') => `<th data-sort="${k}" class="${cls}">${label}${state.sort === k ? (state.dir === 1 ? ' ↓' : ' ↑') : ''}</th>`;
    area.innerHTML = `<div class="tbl-wrap"><table class="tbl" id="mkt">
      <thead><tr><th class="l" style="width:28px"></th>${th('rank', '#', 'l')}${th('name', 'Coin', 'l')}${th('price', 'Price')}${th('change1h', '1h', 'hide-m')}${th('change24h', '24h')}${th('change7d', '7d', 'hide-m')}${th('marketCap', 'Market cap')}${th('volume24h', 'Volume 24h', 'hide-m')}<th class="hide-m">Last 7 days</th></tr></thead>
      <tbody>${rows.slice(0, state.limit).map((r) => `
        <tr data-sym="${esc(r.symbol)}" data-pair="${r.binance || ''}">
          <td class="l"><button class="star ${watchlist.has(r.symbol) ? 'on' : ''}" data-star="${esc(r.symbol)}" aria-label="Watch ${esc(r.name)}">${icon('star', 15)}</button></td>
          <td class="l muted">${r.rank ?? ''}</td>
          <td class="l"><div class="coin-cell">${coinLogo(r, 26)}<b>${esc(r.name)}</b><small>${esc(r.symbol)}</small></div></td>
          <td class="p">${money(r.price)}</td>
          <td class="hide-m">${changeHtml(r.change1h)}</td>
          <td class="c24">${changeHtml(r.change24h)}</td>
          <td class="hide-m">${changeHtml(r.change7d)}</td>
          <td>${compact(r.marketCap)}</td>
          <td class="hide-m">${compact(r.volume24h)}</td>
          <td class="hide-m">${sparkline(r.sparkline, { w: 128, h: 38 })}</td>
        </tr>`).join('')}</tbody></table></div>
      ${rows.length > state.limit ? `<div class="row" style="justify-content:center;margin-top:12px"><button class="btn" id="more">Show more (${rows.length - state.limit})</button></div>` : ''}`;
    $$('th[data-sort]', area).forEach((h) => h.addEventListener('click', () => {
      const k = h.dataset.sort; state.dir = state.sort === k ? -state.dir : 1; state.sort = k; drawTable();
    }));
    $('#mkt tbody', area).addEventListener('click', (e) => {
      const star = e.target.closest('[data-star]');
      if (star) { e.stopPropagation(); star.classList.toggle('on', watchlist.toggle(star.dataset.star)); if (state.scope === 'watch') drawTable(); return; }
      const tr = e.target.closest('tr[data-sym]');
      if (tr) location.hash = `#/coin/${tr.dataset.sym}`;
    });
    $('#more', area)?.addEventListener('click', () => { state.limit += 150; drawTable(); });
  };

  bindSeg($('#scope', el), (v) => { state.scope = v; drawTable(); });
  bindSeg($('#mode', el), (v) => { state.mode = v; drawTable(); });
  $('#filter', el).addEventListener('input', (e) => { state.filter = e.target.value; drawTable(); });
  if (state.rows.length) drawTable();

  const listRow = (c, right) => `<a href="#/coin/${esc(c.symbol)}">${coinLogo(c, 22)}<span class="nm">${esc(c.name)} <span class="muted">${esc(c.symbol)}</span></span>${right}</a>`;

  const loadMarkets = async () => {
    try {
      state.rows = await markets();
      if (disposed) return;
      drawTable();
      const movers = state.rows.filter((r) => !isStable(r.symbol) && r.volume24h > 5e6 && Number.isFinite(r.change24h));
      const g = [...movers].sort((a, b) => b.change24h - a.change24h).slice(0, 5);
      const l = [...movers].sort((a, b) => a.change24h - b.change24h).slice(0, 5);
      $('#gainers', el).innerHTML = g.map((c) => listRow(c, changeHtml(c.change24h))).join('');
      $('#losers', el).innerHTML = l.map((c) => listRow(c, changeHtml(c.change24h))).join('');
    } catch (e) {
      $('#tableArea', el).innerHTML = errorBox('Could not load market data.', loadMarkets);
    }
  };

  const loadGlobal = async () => {
    const g = await getGlobal();
    if (disposed) return;
    const card = (k, v, s = '') => `<div class="card stat"><span class="k">${k}</span><span class="v">${v}</span><span class="s">${s}</span></div>`;
    $('#globalStrip', el).innerHTML = [
      card('Total market cap', compact(g.totalMarketCap), `${changeHtml(g.marketCapChange24h)} <span class="muted">24h</span>`),
      card('24h volume', compact(g.totalVolume), '<span class="muted">all exchanges</span>'),
      card('BTC dominance', pct(g.btcDominance, 1, false), '<span class="muted">share of market cap</span>'),
      card('ETH dominance', pct(g.ethDominance, 1, false), '<span class="muted">share of market cap</span>'),
      card('Coins tracked', g.activeCryptocurrencies?.toLocaleString('en-US') ?? '—', g.markets ? `<span class="muted">${g.markets.toLocaleString('en-US')} markets</span>` : ''),
    ].join('');
    $('#mkSummary', el).innerHTML = `The global crypto market cap is <b>${compact(g.totalMarketCap)}</b>, ${g.marketCapChange24h >= 0 ? 'up' : 'down'} <b class="${g.marketCapChange24h >= 0 ? 'up' : 'down'}">${pct(Math.abs(g.marketCapChange24h), 2, false)}</b> in the last 24 hours.`;
  };

  const loadFng = async () => {
    const f = await getFearGreed();
    if (disposed || !f?.length) return;
    const now = f[0], week = f[7], month = f[29];
    // The header had an empty slot reserved for this and nothing ever filled it,
    // so the card gave no clue how fresh the reading was.
    const stamp = $('#fngDate', el);
    if (stamp && now.timestamp) stamp.textContent = `as of ${dateTime(now.timestamp * 1000, false)}`;
    $('#fng', el).innerHTML = `${gauge(now.value, now.classification)}
      <div class="row spread fine" style="margin-top:6px"><span>Yesterday <b>${f[1]?.value ?? '—'}</b></span><span>Last week <b>${week?.value ?? '—'}</b></span><span>Last month <b>${month?.value ?? '—'}</b></span></div>`;
  };

  const loadTrending = async () => {
    const t = await getTrending();
    if (disposed) return;
    $('#trending', el).innerHTML = t.slice(0, 5).map((c) => listRow(c, changeHtml(c.change24h))).join('') || '<p class="muted">No data</p>';
  };

  loadMarkets(); loadGlobal(); loadFng(); loadTrending();

  // live price updates for visible rows
  const onTick = (e) => {
    if (state.mode !== 'table') return;
    for (const t of e.detail) {
      const tr = el.querySelector(`tr[data-pair="${t.s}"]`);
      if (!tr) continue;
      const cell = tr.querySelector('.p');
      const p = +t.c;
      const prev = +cell.dataset.v || 0;
      cell.dataset.v = p;
      const txt = `${money(p)}`;
      if (cell.textContent !== txt) {
        cell.textContent = txt;
        if (prev) { cell.classList.remove('flash-up', 'flash-down'); void cell.offsetWidth; cell.classList.add(p >= prev ? 'flash-up' : 'flash-down'); }
      }
    }
  };
  window.addEventListener('cv:tickers', onTick);
  const refresh = setInterval(loadMarkets, 90e3);
  return () => { disposed = true; window.removeEventListener('cv:tickers', onTick); clearInterval(refresh); };
}
