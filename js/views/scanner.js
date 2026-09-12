import { markets, getCandles, isStable, INTERVAL_MS } from '../api/market.js';
import { generateSignal } from '../lib/signals.js';
import { runForecast } from '../lib/compute.js';
import { DEFAULT_HORIZON } from '../ai/context.js';
import { $, $$, coinLogo, skeleton, bindSeg, icon } from '../ui.js';
import { esc, price, changeHtml, horizonText, money} from '../format.js';

export const title = 'Signal scanner';

export async function render(el) {
  const st = { interval: '4h', filter: 'all', sort: 'score', rows: [], run: 0, disposed: false, count: 30 };
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Signal scanner</h1><p>Scans the top coins on Binance and ranks them by technical signal strength and AI forecast.</p></div>
      <div class="row">
        <div class="seg" id="iv">${['15m', '1h', '4h', '1d'].map((i) => `<button data-v="${i}" class="${i === st.interval ? 'on' : ''}">${i}</button>`).join('')}</div>
        <div class="seg" id="cnt"><button data-v="20">Top 20</button><button data-v="30" class="on">Top 30</button><button data-v="50">Top 50</button></div>
        <button class="btn" id="rescan">${icon('refresh', 16)} Rescan</button>
      </div>
    </div>
    <div class="card">
      <div class="card-h">
        <div class="seg" id="flt"><button data-v="all" class="on">All</button><button data-v="buy">Buy signals</button><button data-v="sell">Sell signals</button><button data-v="aiup">AI: likely up</button><button data-v="aidown">AI: likely down</button><button data-v="oversold">Oversold</button><button data-v="overbought">Overbought</button></div>
        <span class="fine" id="prog"></span>
      </div>
      <div class="meter" id="meter" style="margin-bottom:10px"><i style="width:0%"></i></div>
      <div id="tbl">${skeleton(10, 26)}</div>
      <p class="fine mt">Score: −100 (strong sell) to +100 (strong buy), from trend, momentum, RSI, MACD, Bollinger, Stoch RSI, volume and ADX. "AI up" is a fast version of the coin-page forecast for the next <span id="hz"></span>. Open a coin for the full forecast with accuracy stats.</p>
    </div>`;

  const draw = () => {
    let rows = st.rows.filter((r) => r.signal?.ok);
    const f = st.filter;
    if (f === 'buy') rows = rows.filter((r) => r.signal.score >= 18);
    if (f === 'sell') rows = rows.filter((r) => r.signal.score <= -18);
    if (f === 'aiup') rows = rows.filter((r) => r.fc?.ok && r.fc.probUp >= 0.54);
    if (f === 'aidown') rows = rows.filter((r) => r.fc?.ok && r.fc.probUp <= 0.46);
    if (f === 'oversold') rows = rows.filter((r) => r.signal.indicators.rsi < 32);
    if (f === 'overbought') rows = rows.filter((r) => r.signal.indicators.rsi > 68);
    const key = { score: (r) => r.signal.score, ai: (r) => r.fc?.probUp ?? 0.5, rsi: (r) => r.signal.indicators.rsi ?? 50, chg: (r) => r.coin.change24h ?? 0 }[st.sort];
    rows.sort((a, b) => key(b) - key(a));
    $('#hz', el).textContent = horizonText(st.interval, DEFAULT_HORIZON[st.interval]);
    if (!rows.length) { $('#tbl', el).innerHTML = st.rows.length ? '<div class="empty">No coins match this filter right now.</div>' : skeleton(10, 26); return; }
    const th = (k, label) => `<th data-sort="${k}">${label}${st.sort === k ? ' ↓' : ''}</th>`;
    $('#tbl', el).innerHTML = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th class="l">Coin</th><th>Price</th>${th('chg', '24h')}<th class="l">Signal</th>${th('score', 'Score')}${th('ai', 'AI up')}${th('rsi', 'RSI')}<th class="hide-m">Trend</th><th class="hide-m l">Top reason</th></tr></thead><tbody>
      ${rows.map((r) => {
        const s = r.signal;
        const trend = s.indicators.ema200 ? (s.price > s.indicators.ema200 ? '<span class="up">Above 200 EMA</span>' : '<span class="down">Below 200 EMA</span>') : '—';
        const reason = (s.score >= 0 ? s.reasons.bullish[0] : s.reasons.bearish[0]) || '';
        const ai = r.fc?.ok ? `<b class="${r.fc.probUp >= 0.54 ? 'up' : r.fc.probUp <= 0.46 ? 'down' : 'flat'}">${Math.round(r.fc.probUp * 100)}%</b>` : r.fc === undefined ? '<span class="spinner" style="width:12px;height:12px"></span>' : '—';
        return `<tr data-sym="${esc(r.coin.symbol)}"><td class="l"><div class="coin-cell">${coinLogo(r.coin, 24)}<b>${esc(r.coin.symbol)}</b><small class="hide-m">${esc(r.coin.name)}</small></div></td>
          <td>${money(s.price)}</td><td>${changeHtml(r.coin.change24h)}</td>
          <td class="l"><span class="chip ${s.tone === 'flat' ? '' : s.tone}">${s.text}</span></td>
          <td class="${s.tone}"><b>${s.score > 0 ? '+' : ''}${s.score}</b></td><td>${ai}</td>
          <td class="${s.indicators.rsi < 30 ? 'up' : s.indicators.rsi > 70 ? 'down' : ''}">${s.indicators.rsi?.toFixed(0) ?? '—'}</td>
          <td class="hide-m">${trend}</td><td class="l hide-m muted" style="max-width:280px;overflow:hidden;text-overflow:ellipsis">${esc(reason)}</td></tr>`;
      }).join('')}</tbody></table></div>`;
    $$('th[data-sort]', el).forEach((h) => h.addEventListener('click', () => { st.sort = h.dataset.sort; draw(); }));
    $$('tr[data-sym]', el).forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/coin/${tr.dataset.sym}`; }));
  };

  const scan = async () => {
    const run = ++st.run;
    st.rows = [];
    draw();
    const list = (await markets()).filter((c) => c.binance && !isStable(c.symbol)).slice(0, st.count);
    const iv = st.interval;
    let done = 0;
    const setProg = () => { $('#prog', el).textContent = done < list.length ? `Scanning ${done}/${list.length}…` : `Scanned ${list.length} coins · ${new Date().toLocaleTimeString()}`; $('#meter i', el).style.width = `${(done / list.length) * 100}%`; };
    setProg();
    const queue = [...list];
    const worker = async () => {
      while (queue.length) {
        const coin = queue.shift();
        try {
          const { candles } = await getCandles(coin, iv, 500);
          if (run !== st.run || st.disposed) return;
          const row = { coin, signal: generateSignal(candles, { interval: iv }), fc: undefined, candles };
          st.rows.push(row);
        } catch { /* skip coin */ }
        done++; setProg(); draw();
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    // AI pass (sequential, in the background worker)
    for (const row of [...st.rows].sort((a, b) => Math.abs(b.signal.score) - Math.abs(a.signal.score))) {
      if (run !== st.run || st.disposed) return;
      try { row.fc = await runForecast(row.candles, { horizon: DEFAULT_HORIZON[iv], fast: true, intervalMs: INTERVAL_MS[iv] }); } catch { row.fc = null; }
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
