import { markets, getCandles, isStable, isTestedSource, INTERVAL_MS } from '../api/market.js';
import { TESTED_ACCURACY, shownProbUp, directionReliable } from '../lib/predict.js';
import { directionTrustFor } from '../lib/selfimprove.js';
import { generateSignal, THRESHOLDS, SCORE_BUCKETS_TESTED } from '../lib/signals.js';
import { runForecast } from '../lib/compute.js';
import { timingOutlook } from '../lib/timing.js';
import { forecastForDisplay } from '../lib/forecastview.js';
import { aiSignal } from '../lib/autotrader.js';
import { DEFAULT_HORIZON } from '../ai/context.js';
import { $, $$, coinLogo, skeleton, bindSeg, icon, wireSortHeaders } from '../ui.js';
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
        <div class="seg" id="flt"><button data-v="all" class="on">All</button><button data-v="buy">Rising</button><button data-v="sell">Falling</button><button data-v="aibuy">AI signal: BUY or HOLD</button><button data-v="aiup">AI: likely up</button><button data-v="aidown">AI: likely down</button><button data-v="oversold">Oversold</button><button data-v="overbought">Overbought</button></div>
        <span class="fine" id="prog"></span>
      </div>
      <div class="meter" id="meter" style="margin-bottom:10px"><i style="width:0%"></i></div>
      <div id="tbl">${skeleton(10, 26)}</div>
      <p class="fine mt">Score: −100 to +100, measuring how strongly trend, momentum, RSI, MACD, Bollinger, Stoch RSI, volume and ADX agree. It is <b>not</b> a buy or sell rating — tested across ${SCORE_BUCKETS_TESTED.bars.toLocaleString('en-US')} candles of ${SCORE_BUCKETS_TESTED.coins} coins, the share that rose mostly <b>falls</b> as the score rises, so a high number means a move is extended rather than likely to continue. "AI signal" is what the chart's tested trading rules do with the coin now — BUY, HOLD (in a trade), SELL or WAIT; in testing its buys picked direction no better than chance, and a coin's page shows the record. "AI up" is the coin page's forecast for the next <span id="hz"></span>, shown only where its direction held up in testing. "80% range" is where price should end up 8 times in 10 by then, centred on today's price where the direction is not reliable — the part of the forecast that tests accurate (in a test of 24 coins and about 100,000 ranges it held 77–80% of outcomes, depending on the chart); sort by it to find the coins that swing most. "Move timing" is when the high (or low) of that span came in similar past charts — when, not which way. Open a coin for the full forecast with accuracy stats.</p>
    </div>`;

  // How far price may travel by the horizon: the forecast's 80% range, as a
  // percentage of the price now. Unlike the direction, this part is measured to
  // be right — the 80% range held 78.5% of real outcomes in the release test —
  // so a wide range is a reliable warning that the coin swings hard.
  const rangeOf = (r) => {
    const f = r.fc;
    if (!f?.ok || !f.range || !(f.lastPrice > 0)) return null;
    return { lo: (f.range.p10 / f.lastPrice - 1) * 100, hi: (f.range.p90 / f.lastPrice - 1) * 100 };
  };
  const moveOf = (r) => { const g = rangeOf(r); return g ? g.hi - g.lo : null; };
  const rangeCell = (r) => {
    if (r.fc === undefined) return '<span class="spinner" style="width:12px;height:12px"></span>';
    const g = rangeOf(r);
    if (!g) return `<span class="muted" title="${esc(r.fc?.reason || 'No forecast on this chart, so there is no range to show.')}">—</span>`;
    const f = (v) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(1)}%`;
    return `<span title="8 times in 10, price should end the next ${esc(horizonText(st.interval, DEFAULT_HORIZON[st.interval]))} between ${money(r.fc.range.p10)} and ${money(r.fc.range.p90)}">${f(g.lo)} to ${f(g.hi)}</span>`;
  };

  // The coin page's AI signal: what the chart's tested rules do with this coin now.
  const aiCell = (r) => {
    const a = r.ai;
    if (!a) return '<span class="muted" title="Not enough history for its rules on this chart.">—</span>';
    const label = { buy: 'BUY', hold: 'HOLD', sell: 'SELL', wait: 'WAIT' }[a.action];
    const tone = { buy: 'up', hold: 'up', sell: 'down', wait: '' }[a.action];
    const why = a.action === 'wait' ? `No buy now: ${a.why}.` : a.action === 'sell' ? `Sold on the last candle (${a.why}).` : a.action === 'buy' ? 'Bought on the last closed candle.' : 'In a trade it bought earlier.';
    return `<span class="chip ${tone}" title="${esc(`${why} ${a.tested ? 'In testing, buys like this picked direction no better than chance; the coin page shows the record.' : 'This rule was never tested on this chart.'}`)}">${label}</span>`;
  };

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
    // where the direction is not reliable only the timing was measured, so no arrow or colour
    if (t.priceless) return `<span title="In similar past charts the ${t.rising ? 'high' : 'low'} of this horizon came about this far in. When, not which way.">${t.rising ? 'high' : 'low'} in ${esc(horizonText(st.interval, m.bar))}</span>`;
    return `<span class="${t.rising ? 'up' : 'down'}">${t.rising ? '▲ peaks' : '▼ bottoms'} in ${esc(horizonText(st.interval, m.bar))}</span>`;
  };

  const draw = () => {
    let rows = st.rows.filter((r) => r.signal?.ok);
    const f = st.filter;
    // The same shown probability as the coin page: shrunk by its measured trust
    // on this chart, and no direction at all where the test found none.
    const trust = directionTrustFor(st.interval).trust;
    const reliable = directionReliable(st.interval, trust);
    const shown = (r) => (r.fc?.ok ? shownProbUp(r.fc.probUp, st.interval, trust) : null);
    if (f === 'buy') rows = rows.filter((r) => r.signal.score >= THRESHOLDS.normal);
    if (f === 'sell') rows = rows.filter((r) => r.signal.score <= -THRESHOLDS.normal);
    if (f === 'aibuy') rows = rows.filter((r) => r.ai?.action === 'buy' || r.ai?.action === 'hold');
    if (f === 'aiup') rows = rows.filter((r) => reliable && shown(r) !== null && shown(r) >= 0.54);
    if (f === 'aidown') rows = rows.filter((r) => reliable && shown(r) !== null && shown(r) <= 0.46);
    // `null < 32` is true in JavaScript, so coins with no RSI yet were being
    // listed as oversold.
    const rsiOf = (r) => (Number.isFinite(r.signal.indicators.rsi) ? r.signal.indicators.rsi : null);
    // the same 30 / 70 lines as the RSI column's colours, the analyst and the glossary
    // (the filters used 32 / 68, so a coin could be listed as oversold without being shown as one)
    if (f === 'oversold') rows = rows.filter((r) => rsiOf(r) !== null && rsiOf(r) < 30);
    if (f === 'overbought') rows = rows.filter((r) => rsiOf(r) !== null && rsiOf(r) > 70);
    const AI_RANK = { buy: 3, hold: 2, sell: 1, wait: 0 };
    const key = { aisig: (r) => AI_RANK[r.ai?.action] ?? -1, score: (r) => r.signal.score, ai: (r) => shown(r) ?? 0.5, rsi: (r) => r.signal.indicators.rsi ?? 50, chg: (r) => r.coin.change24h ?? 0, move: (r) => moveOf(r) ?? -1 }[st.sort];
    rows.sort((a, b) => key(b) - key(a));
    // "for the next 1 day" → "for the next day"
    const hz = horizonText(st.interval, DEFAULT_HORIZON[st.interval]);
    $('#hz', el).textContent = hz.startsWith('1 ') ? hz.slice(2) : hz;
    if (!rows.length) {
      const noDirection = (f === 'aiup' || f === 'aidown') && !reliable;
      // filter((k) => directionReliable(k)) — NOT filter(directionReliable): passing
      // the function directly hands Array's index in as the trust argument, so the
      // list would come from positions, not measured trust.
      const trusted = Object.keys(TESTED_ACCURACY.directionTrust).filter((k) => directionReliable(k)).join(', ');
      $('#tbl', el).innerHTML = st.rows.length
        ? `<div class="empty">${noDirection ? `The forecast has no reliable direction on ${esc(st.interval)} charts, so no coin is marked likely up or down. It has one on ${trusted}.` : f === 'aibuy' ? `The tested ${esc(st.interval)} rules are not in a trade on any of these coins right now.` : 'No coins match this filter right now.'}</div>`
        : skeleton(10, 26);
      return;
    }
    const th = (k, label, cls = '') => `<th${cls ? ` class="${cls}"` : ''} data-sort="${k}" aria-sort="${st.sort === k ? 'descending' : 'none'}">${label}${st.sort === k ? '\u00a0↓' : ''}</th>`;
    $('#tbl', el).innerHTML = `<div class="tbl-wrap"><table class="tbl fit"><thead><tr><th class="l">Coin</th><th class="hide-p">Price</th>${th('chg', '24h', 'hide-p')}<th class="l">Signal</th>${th('aisig', 'AI signal')}${th('score', 'Score')}${th('ai', 'AI up', 'hide-p')}${th('move', '80% range', 'hide-p')}<th class="l hide-t">Move timing</th>${th('rsi', 'RSI', 'hide-t')}<th class="hide-l">Trend</th></tr></thead><tbody>
      ${rows.map((r) => {
        const s = r.signal;
        const trend = s.indicators.ema200 ? (s.price > s.indicators.ema200 ? '<span class="up">Above 200 EMA</span>' : '<span class="down">Below 200 EMA</span>') : '—';
        const reason = (s.score >= 0 ? s.reasons.bullish[0] : s.reasons.bearish[0]) || '';
        const p = shown(r);
        const ai = !r.fc?.ok ? (r.fc === undefined ? '<span class="spinner" style="width:12px;height:12px"></span>' : '—')
          : reliable ? `<b class="${p >= 0.54 ? 'up' : p <= 0.46 ? 'down' : 'flat'}">${Math.round(p * 100)}%</b>`
          : `<span class="muted" title="No reliable direction on this chart (raw lean ${Math.round(r.fc.probUp * 100)}% up)">—</span>`;
        return `<tr data-sym="${esc(r.coin.symbol)}"><td class="l"><div class="coin-cell">${coinLogo(r.coin, 24)}<b>${esc(r.coin.symbol)}</b><small class="hide-l">${esc(r.coin.name)}</small></div><small class="show-p-block">${money(s.price)}</small><small class="show-p-block">${changeHtml(r.coin.change24h)}</small></td>
          <td class="hide-p">${money(s.price)}</td><td class="hide-p">${changeHtml(r.coin.change24h)}</td>
          <td class="l"><span class="chip ${s.tone === 'flat' ? '' : s.tone}"${reason ? ` title="${esc(reason)}"` : ''}>${s.text}</span></td>
          <td>${aiCell(r)}</td>
          <td class="${s.tone}"><b>${s.score > 0 ? '+' : ''}${s.score}</b></td><td class="hide-p">${ai}</td><td class="fine wrap hide-p" style="min-width:84px">${rangeCell(r)}</td>
          <td class="l fine wrap hide-t" style="min-width:96px">${timingCell(r)}</td>
          <td class="hide-t ${s.indicators.rsi < 30 ? 'up' : s.indicators.rsi > 70 ? 'down' : ''}">${s.indicators.rsi?.toFixed(0) ?? '—'}</td>
          <td class="hide-l">${trend}</td></tr>`;
      }).join('')}</tbody></table></div>`;
    wireSortHeaders($('#tbl', el), (k) => { st.sort = k; draw(); });
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
          // the AI signal decides on closed candles only, as on the coin page
          if (isTestedSource(res)) st.rows.push({ coin, signal: generateSignal(res.candles, { interval: iv }), ai: aiSignal(res.candles.slice(0, -1), iv, coin.symbol), fc: undefined, candles: res.candles });
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
        const fc = await runForecast(row.candles, { horizon: DEFAULT_HORIZON[iv], intervalMs: INTERVAL_MS[iv] });
        row.tm = fc?.ok ? timingOutlook(fc, { intervalMs: INTERVAL_MS[iv], interval: iv }) : null;
        // shown without the lean where the direction is not reliable, as on the coin page
        row.fc = fc?.ok ? forecastForDisplay(fc, iv, directionTrustFor(iv).trust) : fc;
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
