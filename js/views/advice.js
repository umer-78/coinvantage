// One measured market reading per coin.
import { markets, getCandles, isStable, INTERVAL_MS, dataStatus } from '../api/market.js';
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

export const title = 'Market readings';

export async function render(el) {
  const st = { interval: '4h', rows: [], run: 0, disposed: false, count: 30 };

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Market readings</h1><p>Descriptive technical readings, historical comparisons and data-quality notes. The app does not turn unvalidated indicators into buy or sell instructions.</p></div>
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
          <div><div class="k">Illustrative entry zone</div><div class="v">${money(a.plan.entryZone[0])} – ${money(a.plan.entryZone[1])}</div></div>
          <div><div class="k">Reference downside level</div><div class="v down">${money(a.plan.stopLoss)} <span class="fine">(${a.plan.riskPct}%)</span></div></div>
          <div><div class="k">Reference path 1</div><div class="v up">${money(a.plan.takeProfits[0])}</div></div>
          <div><div class="k">Reference path 2</div><div class="v up">${money(a.plan.takeProfits[1])}</div></div>
        </div>` : `<p class="fine mt">No entry yet. ${esc(a.waitFor?.[0] || 'Waiting for a trigger.')}</p>`}

        ${t ? `<p class="fine mt">${t.rising
          ? `Similar historical paths rose for about <b>${esc(horizonText(st.interval, t.bars))}</b>, reaching a reference high near <b>${money(t.targetPrice)}</b>${t.turnBars ? `, then weakening around ${esc(horizonText(st.interval, t.turnBars))}` : ''}. This is historical context, not a prediction.`
          : `Similar historical paths weakened for about <b>${esc(horizonText(st.interval, t.bars))}</b> — this is context, not a prediction.`}</p>` : ''}

        <ul class="reasons mt">${a.reasons.map((x) => `<li class="${x.tone === 'good' ? 'b' : x.tone === 'bad' ? 's' : ''}">${esc(x.text)}</li>`).join('')}</ul>
        <div class="row mt" style="gap:8px">
          <a class="btn sm" href="#/coin/${esc(r.coin.symbol)}">Open market</a>
          ${tradable(r.coin.symbol) ? `<button class="btn sm ghost" data-trade="${esc(r.coin.symbol)}">View venues</button>` : ''}
          <span class="fine" style="margin-left:auto">evidence: ${esc(a.evidence)}</span>
        </div>
      </div>`;
  };

  const draw = () => {
    const done = st.rows.filter((r) => r.advice);
    if (!done.length) {
      $('#body', el).innerHTML = `<div class="card empty"><h3>No market readings available yet</h3><p>Waiting for enough candle data to calculate the indicators. Try Rescan when the market API is reachable.</p><p class="fine">${dataStatus.demo ? 'The app is using clearly labelled demo/fallback market data.' : 'Live market data has not returned enough complete candles.'}</p></div>`;
      return;
    }
    const { buys, avoid, wait } = rankAdvice(done);
    const holdings = load('holdings', []);
    const held = done.filter((r) => holdings.some((h) => h.symbol === r.coin.symbol));

    $('#body', el).innerHTML = `
      ${held.length ? `<h2 class="mt" style="margin-bottom:8px">Your holdings — market readings</h2>
        <div class="advice-grid">${held.map((r) => card(r)).join('')}</div>` : ''}

      <h2 class="mt" style="margin-bottom:8px">Strongest measured readings</h2>
      ${buys.length
        ? `<div class="advice-grid">${buys.slice(0, 9).map((r, i) => card(r, i + 1)).join('')}</div>`
        : `<div class="card empty"><h3>No reading clears the evidence bar</h3><p>No coin currently clears the bar, so the honest result is to wait. The measured technical readings are still shown below for inspection; they are not trade instructions.</p></div>
          <div class="advice-grid">${done.slice().sort((a, b) => Math.abs(b.signal.score) - Math.abs(a.signal.score)).slice(0, 9).map((r, i) => card(r, i + 1)).join('')}</div>`}

      ${avoid.length ? `<h2 class="mt" style="margin-bottom:8px">Caution readings</h2>
        <div class="advice-grid">${avoid.slice(0, 6).map((r) => card(r)).join('')}</div>` : ''}

      <div class="card mt" style="background:var(--surface-2)">
        <h3>How much to trust this</h3>
        <p class="fine">Each verdict blends four readings, and each one is weighted by its own measured accuracy — a reading that has shown no edge barely moves the result. The forecast component scored <b>${TESTED_ACCURACY[st.interval] ?? TESTED_ACCURACY.all}%</b> on ${TESTED_ACCURACY.tests} out-of-sample tests across ${TESTED_ACCURACY.coins} coins, against a ${TESTED_ACCURACY.baseline[st.interval] ?? TESTED_ACCURACY.allBaseline}% baseline for simply naming the more common direction${(TESTED_ACCURACY.noEdge || []).includes(st.interval) ? ` — on ${esc(st.interval)} it did not beat that baseline, so verdicts here lean almost entirely on the chart structure` : ''}.</p>
        <p class="fine">${esc(ADVICE_DISCLAIMER)} ${wait.length} of ${done.length} coins scanned came back as "no edge — wait", which is usually the honest answer.</p>
      </div>`;

    $$('.advice-card', el).forEach((c) => c.addEventListener('click', (e) => {
      if (e.target.closest('a,button')) return;
      location.hash = `#/coin/${c.dataset.sym}`;
    }));
    $$('[data-trade]', el).forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const sym = b.dataset.trade;
      modal(`<h3>Where to buy ${esc(sym)}</h3>
        <div class="sheet-grid mt">${venuesFor(sym).map((v) => `<a class="sheet-item" href="${esc(v.href)}" target="_blank" rel="noopener noreferrer">${icon('exchanges', 18)}<span>${esc(v.name)}<br><small class="fine">${esc(v.pair)}</small></span></a>`).join('')}</div>
        <p class="fine mt">${esc(TRADE_DISCLAIMER)}</p>`);
    }));
  };

  const scan = async () => {
    const run = ++st.run;
    st.rows = [];
    draw();
    let list = [];
    try {
      list = (await markets(true)).filter((c) => c.binance && !isStable(c.symbol)).slice(0, st.count);
    } catch {
      $('#body', el).innerHTML = `<div class="card empty"><h3>Market readings unavailable</h3><p>Live market lists could not be loaded, so no indicator result is shown. Check your connection and try Rescan.</p></div>`;
      return;
    }
    if (!list.length) {
      $('#body', el).innerHTML = `<div class="card empty"><h3>No supported market pairs available</h3><p>The exchange list returned no supported pairs for this scan. Nothing is being invented.</p></div>`;
      return;
    }
    const iv = st.interval;
    let done = 0;
    const setProg = () => { $('#meter i', el).style.width = `${Math.min(100, (done / list.length) * 100)}%`; };

    const queue = [...list];
    const worker = async () => {
      while (queue.length) {
        const coin = queue.shift();
        try {
          const { candles } = await getCandles(coin, iv, 500);
          if (run !== st.run || st.disposed) return;
          const signal = generateSignal(candles, { interval: iv });
          const row = { coin, signal, candles, advice: adviseCoin({ signal, forecast: null, timing: null }) };
          st.rows.push(row);
          // Show the measured technical reading immediately; forecast enrichment
          // is optional and must not leave the whole page looking empty.
          draw();
        } catch { /* skip coin */ }
        done++; setProg();
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (run !== st.run || st.disposed) return;

    // Forecast + timing pass, strongest technical signals first so the top of
    // the page fills in early.
    for (const row of [...st.rows].sort((a, b) => Math.abs(b.signal.score) - Math.abs(a.signal.score))) {
      if (run !== st.run || st.disposed) return;
      let fc = null, tm = null;
      try {
        fc = await runForecast(row.candles, { horizon: DEFAULT_HORIZON[iv], fast: true, intervalMs: INTERVAL_MS[iv] });
        if ((TESTED_ACCURACY.noEdge || []).includes(iv) || !fc?.validated) fc = null;
        tm = fc?.ok ? timingOutlook(fc, { intervalMs: INTERVAL_MS[iv] }) : null;
      } catch { /* the advice still works without it */ }
      row.advice = adviseCoin({ signal: row.signal, forecast: fc, timing: tm });
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
