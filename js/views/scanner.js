import { markets, getCandles, isStable, isTestedSource, INTERVAL_MS } from '../api/market.js';
import { TESTED_ACCURACY, shownProbUp, directionReliable } from '../lib/predict.js';
import { generateSignal } from '../lib/signals.js';
import { runForecast } from '../lib/compute.js';
import { timingOutlook } from '../lib/timing.js';
import { DEFAULT_HORIZON } from '../ai/context.js';
import { $, $$, coinLogo, skeleton, bindSeg, icon } from '../ui.js';
import { esc, price, changeHtml, horizonText, money} from '../format.js';

export const title = 'Scanner';

export async function render(el) {
  const st = { interval: '4h', filter: 'all', sort: 'score', rows: [], run: 0, disposed: false, count: 30, skipped: 0 };
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Scanner</h1><p>Scans the top coins (Binance, or Gate.io, HTX or OKX for coins Binance does not list) and ranks them by how far the indicators lean and what the forecast says. Sorting by score is a way to find extended charts, not a ranking of what to buy.</p></div>
      <div class="row">
        <div class="seg" id="iv">${['1m', '5m', '15m', '1h', '4h', '1d'].map((i) => `<button data-v="${i}" class="${i === st.interval ? 'on' : ''}">${i}</button>`).join('')}</div>
        <div class="seg" id="cnt"><button data-v="20">Top 20</button><button data-v="30" class="on">Top 30</button><button data-v="50">Top 50</button></div>
        <button class="btn" id="rescan">${icon('refresh', 16)} Rescan</button>
      </div>
    </div>
    <div class="card">
      <div class="card-h">
        <div class="seg" id="flt"><button data-v="all" class="on">All</button><button data-v="buy">Rising</button><button data-v="sell">Falling</button><button data-v="aiup">AI: likely up</button><button data-v="aidown">AI: likely down</button><button data-v="oversold">Oversold</button><button data-v="overbought">Overbought</button></div>
        <span class="fine" id="prog"></span>
      </div>
      <div class="meter" id="meter" style="margin-bottom:10px"><i style="width:0%"></i></div>
      <div id="tbl">${skeleton(10, 26)}</div>
      <p class="fine mt">Score: −100 to +100, measuring how strongly trend, momentum, RSI, MACD, Bollinger, Stoch RSI, volume and ADX agree. It is <b>not</b> a buy or sell rating — tested across 244,000 bars, the share of bars that rose <b>falls</b> as the score rises, so a high number means a move is extended rather than likely to continue. "AI up" is a fast version of the coin-page forecast for the next <span id="hz"></span>. "Move timing" is when that forecast expects the move to top out or bottom, from the shape of past look-alike charts. Open a coin for the full forecast with accuracy stats.</p>
    </div>`;

  // "peaks in 4 hours" — the answer to "for how long does it go up?"
  const timingCell = (r) => {
    const t = r.tm;
    if (r.fc === undefined) return '';
    // One bare dash used to cover two different things — no timing could be
    // built at all, and a forecast with no turning point inside the horizon —
    // and explained neither. The reason already exists; the coin page prints
    // it. Carry it here too so the two pages cannot disagree.
    if (!t?.ok) return `<span class="muted" title="${esc(t?.reason || 'No forecast on this chart, so there is nothing to time.')}">—</span>`;
    if (!t.shaped) return `<span class="muted" title="${esc(`The matched past charts drifted ${t.endPct >= 0 ? 'up' : 'down'} steadily rather than spiking, so there is no clear turning point to call inside this horizon.`)}">—</span>`;
    const m = t.rising ? t.peak : t.trough;
    return `<span class="${t.rising ? 'up' : 'down'}">${t.rising ? '▲ peaks' : '▼ bottoms'} in ${esc(horizonText(st.interval, m.bar))}</span>`;
  };

  const draw = () => {
    let rows = st.rows.filter((r) => r.signal?.ok);
    const f = st.filter;
    // The same shown probability as the coin page: shrunk by its measured trust
    // on this chart, and no direction at all where the test found none.
    const reliable = directionReliable(st.interval);
    const shown = (r) => (r.fc?.ok ? shownProbUp(r.fc.probUp, st.interval) : null);
    if (f === 'buy') rows = rows.filter((r) => r.signal.score >= 18);
    if (f === 'sell') rows = rows.filter((r) => r.signal.score <= -18);
    if (f === 'aiup') rows = rows.filter((r) => reliable && shown(r) !== null && shown(r) >= 0.54);
    if (f === 'aidown') rows = rows.filter((r) => reliable && shown(r) !== null && shown(r) <= 0.46);
    // `null < 32` is true in JavaScript, so coins with no RSI yet were being
    // listed as oversold.
    const rsiOf = (r) => (Number.isFinite(r.signal.indicators.rsi) ? r.signal.indicators.rsi : null);
    if (f === 'oversold') rows = rows.filter((r) => rsiOf(r) !== null && rsiOf(r) < 32);
    if (f === 'overbought') rows = rows.filter((r) => rsiOf(r) !== null && rsiOf(r) > 68);
    const key = { score: (r) => r.signal.score, ai: (r) => shown(r) ?? 0.5, rsi: (r) => r.signal.indicators.rsi ?? 50, chg: (r) => r.coin.change24h ?? 0 }[st.sort];
    rows.sort((a, b) => key(b) - key(a));
    $('#hz', el).textContent = horizonText(st.interval, DEFAULT_HORIZON[st.interval]);
    if (!rows.length) {
      const noDirection = (f === 'aiup' || f === 'aidown') && !reliable;
      const trusted = Object.keys(TESTED_ACCURACY.directionTrust).filter(directionReliable).join(', ');
      $('#tbl', el).innerHTML = st.rows.length
        ? `<div class="empty">${noDirection ? `The forecast has no reliable direction on ${esc(st.interval)} charts, so no coin is marked likely up or down. It has one on ${trusted}.` : 'No coins match this filter right now.'}</div>`
        : skeleton(10, 26);
      return;
    }
    const th = (k, label) => `<th data-sort="${k}">${label}${st.sort === k ? ' ↓' : ''}</th>`;
    $('#tbl', el).innerHTML = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th class="l">Coin</th><th>Price</th>${th('chg', '24h')}<th class="l">Signal</th>${th('score', 'Score')}${th('ai', 'AI up')}<th class="l">Move timing</th>${th('rsi', 'RSI')}<th class="hide-m">Trend</th><th class="hide-m l">Top reason</th></tr></thead><tbody>
      ${rows.map((r) => {
        const s = r.signal;
        const trend = s.indicators.ema200 ? (s.price > s.indicators.ema200 ? '<span class="up">Above 200 EMA</span>' : '<span class="down">Below 200 EMA</span>') : '—';
        const reason = (s.score >= 0 ? s.reasons.bullish[0] : s.reasons.bearish[0]) || '';
        const p = shown(r);
        const ai = !r.fc?.ok ? (r.fc === undefined ? '<span class="spinner" style="width:12px;height:12px"></span>' : '—')
          : reliable ? `<b class="${p >= 0.54 ? 'up' : p <= 0.46 ? 'down' : 'flat'}">${Math.round(p * 100)}%</b>`
          : `<span class="muted" title="No reliable direction on this chart (raw lean ${Math.round(r.fc.probUp * 100)}% up)">—</span>`;
        return `<tr data-sym="${esc(r.coin.symbol)}"><td class="l"><div class="coin-cell">${coinLogo(r.coin, 24)}<b>${esc(r.coin.symbol)}</b><small class="hide-m">${esc(r.coin.name)}</small></div></td>
          <td>${money(s.price)}</td><td>${changeHtml(r.coin.change24h)}</td>
          <td class="l"><span class="chip ${s.tone === 'flat' ? '' : s.tone}">${s.text}</span></td>
          <td class="${s.tone}"><b>${s.score > 0 ? '+' : ''}${s.score}</b></td><td>${ai}</td>
          <td class="l fine">${timingCell(r)}</td>
          <td class="${s.indicators.rsi < 30 ? 'up' : s.indicators.rsi > 70 ? 'down' : ''}">${s.indicators.rsi?.toFixed(0) ?? '—'}</td>
          <td class="hide-m">${trend}</td><td class="l hide-m muted" style="max-width:280px;overflow:hidden;text-overflow:ellipsis">${esc(reason)}</td></tr>`;
      }).join('')}</tbody></table></div>`;
    $$('th[data-sort]', el).forEach((h) => h.addEventListener('click', () => { st.sort = h.dataset.sort; draw(); }));
    $$('tr[data-sym]', el).forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/coin/${tr.dataset.sym}`; }));
  };

  const scan = async () => {
    const run = ++st.run;
    st.rows = [];
    st.skipped = 0;
    draw();
    let list;
    try {
      list = (await markets()).filter((c) => !isStable(c.symbol)).slice(0, st.count);
    } catch (err) {
      if (run !== st.run) return;
      $('#prog', el).textContent = 'Scan unavailable';
      $('#meter i', el).style.width = '0%';
      $('#tbl', el).innerHTML = `<div class="empty"><h3>Scanner data unavailable</h3><p>${esc(err?.message || 'The market list could not be loaded.')}</p><button class="btn sm" id="retryScan" type="button">${icon('refresh', 14)} Try again</button></div>`;
      $('#retryScan', el)?.addEventListener('click', scan);
      return;
    }
    if (!list.length) {
      $('#prog', el).textContent = 'No supported pairs';
      $('#meter i', el).style.width = '0%';
      $('#tbl', el).innerHTML = '<div class="empty"><h3>No coins to scan</h3><p>The market source returned no coins for this scan.</p></div>';
      return;
    }
    const iv = st.interval;
    let done = 0;
    const setProg = () => {
      $('#prog', el).textContent = done < list.length ? `Scanning ${done}/${list.length}…`
        : `Scanned ${st.rows.length} coins${st.skipped ? ` · skipped ${st.skipped} with no exchange candles on ${iv}` : ''} · ${new Date().toLocaleTimeString()}`;
      $('#meter i', el).style.width = `${(done / list.length) * 100}%`;
    };
    setProg();
    const queue = [...list];
    const worker = async () => {
      while (queue.length) {
        const coin = queue.shift();
        try {
          // The coin page's 1,500 candles, so both pages read the same chart.
          const res = await getCandles(coin, iv, 1500);
          if (run !== st.run || st.disposed) return;
          if (isTestedSource(res)) st.rows.push({ coin, signal: generateSignal(res.candles, { interval: iv }), fc: undefined, candles: res.candles });
          else st.skipped++;
        } catch { st.skipped++; }
        done++; setProg(); draw();
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    // AI pass (sequential, in the background worker)
    for (const row of [...st.rows].sort((a, b) => Math.abs(b.signal.score) - Math.abs(a.signal.score))) {
      if (run !== st.run || st.disposed) return;
      try {
        // The full forecast the coin page runs; `fast` mode was never tested.
        row.fc = await runForecast(row.candles, { horizon: DEFAULT_HORIZON[iv], intervalMs: INTERVAL_MS[iv] });
        row.tm = row.fc?.ok ? timingOutlook(row.fc, { intervalMs: INTERVAL_MS[iv] }) : null;
      } catch { row.fc = null; row.tm = null; }
      row.candles = null;
      draw();
    }
  };

  bindSeg($('#iv', el), (v) => { st.interval = v; scan(); });
  bindSeg($('#cnt', el), (v) => { st.count = +v; scan(); });
  bindSeg($('#flt', el), (v) => { st.filter = v; draw(); });
  $('#rescan', el).addEventListener('click', scan);
  scan();
  return () => { st.disposed = true; st.run++; };
}
