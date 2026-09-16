// Futures & derivatives: funding, open interest, long/short positioning and live liquidations.
import { markets, isStable } from '../api/market.js';
import { futuresOverview, futuresSnapshot, liquidationStream, interpretFutures, annualiseFunding } from '../api/futures.js';
import { LineChart } from '../charts/line.js';
import { $, $$, skeleton, coinLogo, icon, errorBox } from '../ui.js';
import { esc, pct, money, compact, num, ago, dateTime } from '../format.js';

export const title = 'Futures';

export async function render(el, [symParam]) {
  const st = { sym: (symParam || 'BTC').toUpperCase(), liqs: [], charts: [], stop: null, disposed: false, coinSeq: 0, liqTimer: null, poll: null, liqState: 'connecting' };
  // Everything on this page is a point-in-time reading. It used to load once and
  // then sit there while the pill said "streaming", so the frozen numbers looked
  // live by association. Now they refresh, and each panel says when it was read.
  const REFRESH_MS = 60e3;
  const tsLine = (at) => `<span class="fine" title="${esc(dateTime(at, true))}">read ${esc(ago(at))}</span>`;

  el.innerHTML = `
    <div class="page-head"><div><h1>Futures</h1><p>Leverage data from Binance USD-M perpetuals: what traders are paying to hold positions, how crowded those positions are, and who is being liquidated right now.</p></div></div>
    <div class="coin-layout" id="layout">
      <div class="stack" style="gap:14px">
        <div class="card" id="coinCard">${skeleton(5, 22)}</div>
        <div class="card" id="tableCard">${skeleton(8, 22)}</div>
      </div>
      <div class="card" id="liqCard"><div class="card-h"><h3>Live liquidations</h3><span class="live-pill" id="liqPill"><i></i><span>connecting…</span></span></div><div id="liqList"><p class="fine muted">Waiting for the first liquidation…</p></div><p class="fine mt">Every row is a real leveraged position force-closed on Binance futures. This is a sample, not a tally: Binance pushes at most one liquidation per symbol per second, and rows under $3,000 are hidden — so during a cascade you are seeing far fewer events than actually happened. Read the sizes, not the count.</p></div>
    </div>`;

  // ---------------------------------------------------------------- market table
  async function drawTable() {
    let list = [];
    try {
      list = (await markets()).filter((c) => c.binance && !isStable(c.symbol)).slice(0, 24);
    } catch {
      // a coin-list failure is not a futures outage, and saying so sent people
      // looking for the wrong problem
      if (!st.disposed) $('#tableCard', el).innerHTML = errorBox('The coin list could not be loaded, so there is nothing to look up futures data for.', drawTable);
      return;
    }
    const rows = await futuresOverview(list.map((c) => c.symbol));
    if (st.disposed) return;
    const byS = new Map(list.map((c) => [c.symbol, c]));
    if (!rows.length) { $('#tableCard', el).innerHTML = errorBox('Binance futures data is not reachable from this network. Binance blocks its futures API in some regions, and the browser cannot see the difference between that and an outage.', drawTable); return; }
    const intervals = [...new Set(rows.map((r) => r.fundingIntervalHours || 8))].sort((a, b) => a - b);
    $('#tableCard', el).innerHTML = `
      <div class="card-h"><h3>Perpetual futures market</h3>${tsLine(Date.now())}</div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th class="l">Coin</th><th>Mark price</th><th>Funding</th><th>Every</th><th>Annualised</th><th>Basis (mark vs index)</th><th>Open interest</th></tr></thead><tbody>
      ${rows.sort((a, b) => (b.openInterestUsd || 0) - (a.openInterestUsd || 0)).map((r) => {
        const f = r.fundingRate === null ? null : r.fundingRate * 100;
        const hrs = r.fundingIntervalHours || 8;
        const yr = annualiseFunding(f, hrs);
        return `<tr data-sym="${esc(r.symbol)}"><td class="l"><div class="coin-cell">${coinLogo(byS.get(r.symbol) || { symbol: r.symbol }, 22)}<b>${esc(r.symbol)}</b></div></td>
          <td>${money(r.markPrice)}</td>
          <td class="${f > 0.01 ? 'up' : f < -0.01 ? 'down' : ''}">${f === null ? '—' : `${f > 0 ? '+' : ''}${f.toFixed(4)}%`}</td>
          <td class="fine">${hrs}h</td>
          <td class="fine">${yr === null ? '—' : `${yr > 0 ? '+' : ''}${yr.toFixed(1)}%`}</td>
          <td class="${r.basisPct > 0 ? 'up' : r.basisPct < 0 ? 'down' : ''}">${r.basisPct === null ? '—' : pct(r.basisPct, 3)}</td>
          <td>${compact(r.openInterestUsd)}</td></tr>`;
      }).join('')}
      </tbody></table></div>
      <p class="fine mt">Positive funding means longs pay shorts — the crowd is long and the market is paying for it. Deeply negative funding means the opposite. Extremes in either direction tend to unwind. Funding settles every ${intervals.join(' or ')} hours depending on the contract, which is why the annualised column is not the same multiple for every row. "Basis" here is mark price against index price; Binance's mark already smooths the basis in, so it reads smaller than the gap between the last traded price and the index.</p>`;
    $$('tr[data-sym]', el).forEach((tr) => tr.addEventListener('click', () => {
      st.sym = tr.dataset.sym;
      location.hash = `#/futures/${tr.dataset.sym}`;
    }));
  }

  // ---------------------------------------------------------------- per-coin panel
  async function drawCoin(quiet = false) {
    const card = $('#coinCard', el);
    const want = st.sym;
    const seq = ++st.coinSeq;
    if (!quiet) card.innerHTML = skeleton(5, 22);
    const f = await futuresSnapshot(want).catch(() => null);
    // clicking two rows quickly used to let the slower response repaint the card
    // as the wrong coin, with nothing on screen revealing the swap
    if (st.disposed || seq !== st.coinSeq || want !== st.sym) return;
    if (!f) {
      st.charts.forEach((c) => c.destroy());
      st.charts = [];
      card.innerHTML = errorBox(`No futures market data for ${st.sym} — it may be spot-only, or Binance futures may be unreachable from here.`, () => drawCoin());
      return;
    }
    const iv = interpretFutures(f);
    // the live openInterest call is already in hand; the hourly history bucket
    // closes on the hour and was being preferred over it, so the headline number
    // could be an hour stale at first paint
    const oiNow = f.openInterestUsd ?? f.oiHistory?.at(-1)?.usd ?? null;
    card.innerHTML = `
      <div class="card-h"><h3>${esc(f.pair)} · ${esc(f.source)}</h3><div class="row" style="gap:8px">${tsLine(f.fetchedAt)}<a class="btn sm ghost" href="#/coin/${esc(st.sym)}">Open ${esc(st.sym)} analysis</a></div></div>
      <div class="grid g4">
        <div class="stat"><span class="k">Mark price</span><span class="v">${money(f.markPrice)}</span><span class="s fine">Mark vs index ${f.basisPct === null ? '—' : pct(f.basisPct, 3)}</span></div>
        <div class="stat"><span class="k">Funding rate</span><span class="v ${iv.fundingPct > 0.01 ? 'up' : iv.fundingPct < -0.01 ? 'down' : ''}">${iv.fundingPct === null ? '—' : `${iv.fundingPct > 0 ? '+' : ''}${iv.fundingPct.toFixed(4)}%`}</span><span class="s fine">${iv.annualisedFundingPct === null ? '' : `${iv.annualisedFundingPct.toFixed(1)}% a year · settles every ${iv.fundingIntervalHours}h`}</span></div>
        <div class="stat"><span class="k">Open interest</span><span class="v">${compact(oiNow)}</span><span class="s fine ${iv.oiChange12hPct > 0 ? 'up' : iv.oiChange12hPct < 0 ? 'down' : ''}">${iv.oiChange12hPct === null ? '' : `${pct(iv.oiChange12hPct, 1)} in 12h`}</span></div>
        <div class="stat"><span class="k">Accounts long</span><span class="v">${iv.longAccountsPct === null ? '—' : `${iv.longAccountsPct.toFixed(0)}%`}</span><span class="s fine">${f.topTraders?.at(-1)?.longPositionPct != null ? `Top traders' positions ${f.topTraders.at(-1).longPositionPct.toFixed(0)}% long` : ''}</span></div>
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
      const c = new LineChart($('#oiC', el), { height: 190, yFormat: (v) => compact(v), legend: false, xFormat: (x) => new Date(x).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric' }), tooltipX: (x) => dateTime(x, true) });
      c.set([{ name: 'Open interest', color: 'var(--series-1)', data: f.oiHistory.map((r) => ({ x: r.t, y: r.usd })) }]);
      c.resize(); st.charts.push(c);
    }
    if (f.fundingHistory?.length) {
      const c = new LineChart($('#fdC', el), { height: 190, yFormat: (v) => `${(v * 100).toFixed(3)}%`, legend: false, zeroLine: 0, xFormat: (x) => new Date(x).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric' }), tooltipX: (x) => dateTime(x, true) });
      c.set([{ name: 'Funding', color: 'var(--series-4)', data: f.fundingHistory.map((r) => ({ x: r.t, y: r.rate })) }]);
      c.resize(); st.charts.push(c);
    }
  }
  drawTable();
  drawCoin();
  st.poll = setInterval(() => { if (!st.disposed && !document.hidden) { drawTable(); drawCoin(true); } }, REFRESH_MS);

  // ---------------------------------------------------------------- liquidation stream
  const setPill = (state) => {
    st.liqState = state;
    const pill = $('#liqPill', el);
    if (!pill) return;
    pill.classList.toggle('on', state === 'streaming');
    pill.classList.toggle('warn', state === 'failed');
    pill.querySelector('span').textContent =
      state === 'streaming' ? 'streaming' : state === 'open' ? 'connected — waiting' : state === 'failed' ? 'unreachable' : 'connecting…';
  };

  let pending = false;
  st.stop = liquidationStream((ev, status) => {
    // the pill only ever turned green inside the first event, so a healthy
    // socket with no large liquidation yet looked identical to a dead one
    if (!ev) { if (st.liqState !== 'streaming' || status === 'failed') setPill(status); return; }
    if (ev.usd < 3000) return;
    st.liqs.unshift(ev);
    st.liqs = st.liqs.slice(0, 25);
    if (pending) return;
    pending = true;
    st.liqTimer = setTimeout(() => {
      pending = false;
      if (st.disposed) return;
      setPill('streaming');
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
    clearInterval(st.poll);
    clearTimeout(st.liqTimer);
    st.stop?.();
    st.charts.forEach((c) => c.destroy());
  };
}
