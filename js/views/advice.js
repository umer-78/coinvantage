// One reading per coin across the market, ranked by how much measured evidence
// stands behind it. This was "What to buy" until the chart score it ranked on
// was measured to point the wrong way; it reports now instead of recommending.
import { markets, getCandles, isStable, INTERVAL_MS } from '../api/market.js';
import { generateSignal } from '../lib/signals.js';
import { runForecast } from '../lib/compute.js';
import { timingOutlook } from '../lib/timing.js';
import { adviseCoin, rankAdvice, ADVICE_DISCLAIMER } from '../lib/advice.js';
import { TESTED_ACCURACY } from '../lib/predict.js';
import { DEFAULT_HORIZON } from '../ai/context.js';
import { venuesFor, tradable, TRADE_DISCLAIMER } from '../lib/trade.js';
import { $, $$, icon, coinLogo, skeleton, bindSeg, modal } from '../ui.js';
import { esc, pct, money, horizonText, changeHtml } from '../format.js';
import { load } from '../store.js';

export const title = 'Market scan';

export async function render(el) {
  const st = { interval: '4h', rows: [], run: 0, disposed: false, count: 30 };

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Market scan</h1><p>Every coin read on one timeframe: what the chart is doing, where the levels sit, and how much measured evidence stands behind each reading. Components that have shown no edge in testing are weighted down to nothing, so most coins come back as "no edge" — that is the honest result, not an empty page.</p></div>
      <div class="row">
        <div class="seg" id="iv">${['1m', '5m', '15m', '1h', '4h', '1d'].map((i) => `<button data-v="${i}" class="${i === st.interval ? 'on' : ''}">${i}</button>`).join('')}</div>
        <button class="btn" id="rescan">${icon('refresh', 16)} Rescan</button>
      </div>
    </div>
    <div class="meter" id="meter" style="margin-bottom:12px"><i style="width:0%"></i></div>
    <div id="body">${skeleton(8, 26)}</div>`;

  const card = (r, rank) => {
    const a = r.advice;
    const t = a.timing;
    return `
      <div class="advice-card" data-sym="${esc(r.coin.symbol)}">
        <div class="row spread">
          <div class="coin-cell">${rank ? `<span class="rank">${rank}</span>` : ''}${coinLogo(r.coin, 30)}
            <div><b>${esc(r.coin.symbol)}</b> <small class="muted">${esc(r.coin.name)}</small><br>
              <span class="fine">${money(a.price)} ${changeHtml(r.coin.change24h)}</span></div></div>
          <div style="text-align:right">
            <span class="chip ${a.tone === 'warn' ? 'warn' : a.tone}"><b>${esc(a.verdict)}</b></span>
            <div class="fine" style="margin-top:3px">conviction ${a.conviction}/100</div>
          </div>
        </div>

        ${a.plan ? `<div class="plan mt">
          <div><div class="k">Entry zone</div><div class="v">${money(a.plan.entryZone[0])} – ${money(a.plan.entryZone[1])}</div></div>
          <div><div class="k">Stop-loss</div><div class="v down">${money(a.plan.stopLoss)} <span class="fine">(${a.plan.riskPct}%)</span></div></div>
          <div><div class="k">Target 1</div><div class="v up">${money(a.plan.takeProfits[0])}</div></div>
          <div><div class="k">Target 2</div><div class="v up">${money(a.plan.takeProfits[1])}</div></div>
        </div>` : `<p class="fine mt">No entry yet. ${esc(a.waitFor?.[0] || 'Waiting for a trigger.')}</p>`}

        ${t ? `<p class="fine mt">${t.rising
          ? `Similar past setups kept rising for about <b>${esc(horizonText(st.interval, t.bars))}</b>, topping near <b>${money(t.targetPrice)}</b>${t.turnBars ? `, then turning down around ${esc(horizonText(st.interval, t.turnBars))}` : ''}.`
          : `Similar past setups kept falling for about <b>${esc(horizonText(st.interval, t.bars))}</b> — waiting may get a better price, but that is a pattern, not a forecast.`}</p>` : ''}

        <ul class="reasons mt">${a.reasons.map((x) => `<li class="${x.tone === 'good' ? 'b' : x.tone === 'bad' ? 's' : ''}">${esc(x.text)}</li>`).join('')}</ul>
        <div class="row mt" style="gap:8px">
          <a class="btn sm" href="#/coin/${esc(r.coin.symbol)}">Open chart</a>
          ${tradable(r.coin.symbol) ? `<button class="btn sm ghost" data-trade="${esc(r.coin.symbol)}">Where to trade it</button>` : ''}
          <span class="fine" style="margin-left:auto">evidence: ${esc(a.evidence)}</span>
        </div>
      </div>`;
  };

  const draw = () => {
    const done = st.rows.filter((r) => r.advice);
    if (!done.length) { $('#body', el).innerHTML = skeleton(8, 26); return; }
    const { buys, avoid, wait } = rankAdvice(done);
    const holdings = load('holdings', []);
    const held = done.filter((r) => holdings.some((h) => h.symbol === r.coin.symbol));

    $('#body', el).innerHTML = `
      ${held.length ? `<h2 class="mt" style="margin-bottom:8px">Your holdings — what to do</h2>
        <div class="advice-grid">${held.map((r) => card(r)).join('')}</div>` : ''}

      <h2 class="mt" style="margin-bottom:8px">Where the evidence is strongest</h2>
      ${buys.length
        ? `<div class="advice-grid">${buys.slice(0, 9).map((r, i) => card(r, i + 1)).join('')}</div>`
        : `<div class="card empty"><h3>No coin clears the evidence bar on this timeframe</h3><p>This is the usual result and it is a real answer. The chart score earns no weight because it was measured to point the wrong way, and the forecast earns little because it did not beat its baseline — so a verdict only appears when something with a measured record actually leans. Browse the full list below, or read a single coin's chart directly.</p></div>`}

      ${avoid.length ? `<h2 class="mt" style="margin-bottom:8px">Reading weakest here</h2>
        <div class="advice-grid">${avoid.slice(0, 6).map((r) => card(r)).join('')}</div>` : ''}

      <div class="card mt" style="background:var(--surface-2)">
        <h3>How much to trust this</h3>
        <p class="fine">The chart score is <b>not</b> part of any verdict here. Across 244,000 bars the share of bars that rose falls as the score rises, so it is shown as a reading and given no vote — the same accuracy gate every other component passes through.</p>
        <p class="fine">Each verdict blends four readings, and each one is weighted by its own measured accuracy — a reading that has shown no edge barely moves the result. The forecast component scored <b>${TESTED_ACCURACY[st.interval] ?? TESTED_ACCURACY.all}%</b> on ${TESTED_ACCURACY.tests} out-of-sample tests across ${TESTED_ACCURACY.coins} coins, against a ${TESTED_ACCURACY.baseline[st.interval] ?? TESTED_ACCURACY.allBaseline}% baseline for simply naming the more common direction${(TESTED_ACCURACY.noEdge || []).includes(st.interval) ? ` — on ${esc(st.interval)} it did not beat that baseline either` : ''}. With both the chart score and the forecast gated to near zero, a verdict only appears when timing or the multi-year history check actually leans.</p>
        <p class="fine">${esc(ADVICE_DISCLAIMER)} ${wait.length} of ${done.length} coins scanned came back as "no edge — wait", which is usually the honest answer.</p>
      </div>`;

    $$('.advice-card', el).forEach((c) => c.addEventListener('click', (e) => {
      if (e.target.closest('a,button')) return;
      location.hash = `#/coin/${c.dataset.sym}`;
    }));
    $$('[data-trade]', el).forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const sym = b.dataset.trade;
      modal(`<h3>Where to trade ${esc(sym)}</h3>
        <div class="sheet-grid mt">${venuesFor(sym).map((v) => `<a class="sheet-item" href="${esc(v.href)}" target="_blank" rel="noopener noreferrer">${icon('exchanges', 18)}<span>${esc(v.name)}<br><small class="fine">${esc(v.pair)}</small></span></a>`).join('')}</div>
        <p class="fine mt">${esc(TRADE_DISCLAIMER)}</p>`);
    }));
  };

  const scan = async () => {
    const run = ++st.run;
    st.rows = [];
    draw();
    let list;
    try {
      list = (await markets()).filter((c) => c.binance && !isStable(c.symbol)).slice(0, st.count);
    } catch {
      $('#body', el).innerHTML = '<div class="card empty"><h3>Could not load the coin list</h3><p>The market feed did not answer, so there is nothing to scan. Press Rescan to try again.</p></div>';
      return;
    }
    const iv = st.interval;
    let done = 0;
    const setProg = () => { $('#meter i', el).style.width = `${(done / list.length) * 100}%`; };

    const queue = [...list];
    const worker = async () => {
      while (queue.length) {
        const coin = queue.shift();
        try {
          const { candles } = await getCandles(coin, iv, 500);
          if (run !== st.run || st.disposed) return;
          const signal = generateSignal(candles, { interval: iv });
          // Show the chart reading straight away; the forecast pass below only
          // refines it, so the page is never a blank skeleton while it runs.
          st.rows.push({ coin, signal, candles, advice: adviseCoin({ signal, forecast: null, timing: null, interval: iv }) });
          draw();
        } catch { /* skip coin */ }
        done++; setProg();
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (run !== st.run || st.disposed) return;
    if (!st.rows.length) {
      $('#body', el).innerHTML = '<div class="card empty"><h3>No chart data came back</h3><p>None of the coins returned candles on this timeframe, so there is nothing to read. Press Rescan to try again.</p></div>';
      $('#meter i', el).style.width = '100%';
      return;
    }

    // Forecast + timing pass, strongest technical signals first so the top of
    // the page fills in early.
    for (const row of [...st.rows].sort((a, b) => Math.abs(b.signal.score) - Math.abs(a.signal.score))) {
      if (run !== st.run || st.disposed) return;
      let fc = null, tm = null;
      try {
        fc = await runForecast(row.candles, { horizon: DEFAULT_HORIZON[iv], fast: true, intervalMs: INTERVAL_MS[iv] });
        tm = fc?.ok ? timingOutlook(fc, { intervalMs: INTERVAL_MS[iv] }) : null;
      } catch { /* the advice still works without it */ }
      row.advice = adviseCoin({ signal: row.signal, forecast: fc, timing: tm, interval: iv });
      row.candles = null;
      draw();
    }
    $('#meter i', el).style.width = '100%';
  };

  bindSeg($('#iv', el), (v) => { st.interval = v; scan(); });
  $('#rescan', el).addEventListener('click', scan);
  scan();
  return () => { st.disposed = true; st.run++; };
}
