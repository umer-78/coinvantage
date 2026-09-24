import { findCoin, getCandles, getCoinProfile, getDepth, getTrades, getTickSize, INTERVAL_MS, isSecondInterval, MAX_BARS } from '../api/market.js';
import { compareExchanges } from '../api/exchanges.js';
import { live } from '../api/live.js';
import { generateSignal, confluence } from '../lib/signals.js';
import { runForecast, runBacktest, runHistory } from '../lib/compute.js';
import { TESTED_ACCURACY, summarizeForecast, forecastTrust } from '../lib/predict.js';
import { timingOutlook, TESTED_TIMING, timingTrust } from '../lib/timing.js';
import { remember, DEFAULT_HORIZON } from '../ai/context.js';
import { CandleChart } from '../charts/candles.js';
import { LineChart } from '../charts/line.js';
import { $, $$, icon, coinLogo, skeleton, errorBox, bindSeg, bindTabs, modal, toast } from '../ui.js';
import { esc, usd, compact, pct, amount, changeHtml, dateTime, ago, horizonText, INTERVAL_LABEL, money } from '../format.js';
import { watchlist, settings, load, save } from '../store.js';
import { venuesFor, tradable, TRADE_DISCLAIMER } from '../lib/trade.js';
import { getNews, backendEnabled } from '../api/backend.js';
import { logActivity, logForecastShown } from '../api/activity.js';
import { tradeSummary } from '../lib/summary.js';
import { newState, openManual, closeManual, equity, DEFAULT_CONFIG, PAPER_NOTICE } from '../lib/autotrader.js';
import { fx } from '../api/fx.js';

export const title = (p) => (p[0] || 'Coin').toUpperCase();
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const SERIES = ['--series-1', '--series-2', '--series-3', '--series-5', '--series-7', '--series-4'];
// Every timeframe the chart offers. The second and minute charts exist for
// watching price move right now; the forecast engine was never measured on them.
const INTERVALS = ['1s', '5s', '10s', '1m', '5m', '15m', '1h', '4h', '1d', '1w'];
// Timeframes the forecast engine was never measured on — say so rather than
// letting a number imply an accuracy nobody checked.
const UNMEASURED = ['1s', '5s', '10s'];

export async function render(el, [symParam]) {
  const sym = (symParam || 'BTC').toUpperCase();
  el.innerHTML = skeleton(8, 30);
  const coin = await findCoin(sym);
  if (!coin) { el.innerHTML = errorBox(`Coin "${sym}" was not found in the top 250.`); return; }

  const st = {
    interval: INTERVALS.includes(settings.get().interval) ? settings.get().interval : '1h',
    candles: [], source: '', signal: null, forecast: null, horizon: null, tab: 'forecast', disposed: false, unsub: [], charts: [],
  };
  st.horizon = DEFAULT_HORIZON[st.interval] || 12;
  const pair = coin.binance;

  el.innerHTML = `
    <div class="coin-head">
      ${coinLogo(coin, 44)}
      <div>
        <div class="row"><h1>${esc(coin.name)}</h1><span class="chip">${esc(coin.symbol)}</span>${coin.rank ? `<span class="chip">#${coin.rank}</span>` : ''}
          <button class="star ${watchlist.has(coin.symbol) ? 'on' : ''}" id="star" aria-label="Add to watchlist">${icon('star', 20)}</button></div>
        <div class="row"><span class="price num" id="px">${money(coin.price)}</span><span id="pxChg" style="font-size:16px">${changeHtml(coin.change24h)}</span><span class="chip" id="srcChip">…</span></div>
      </div>
      <div class="row" style="margin-left:auto">
        <a class="btn" href="#/alerts/${esc(coin.symbol)}">${icon('alerts', 16)} Alert</a>
        ${tradable(coin.symbol) ? `<button class="btn" id="tradeBtn">${icon('exchanges', 16)} Trade</button>` : ''}
        <a class="btn primary" id="askAi" href="#/ai/${esc(coin.symbol)}">${icon('ai', 16)} Ask AI about ${esc(coin.symbol)}</a>
      </div>
    </div>
    <div class="grid g4" style="margin-bottom:14px">
      <div class="card stat"><span class="k">Market cap</span><span class="v">${compact(coin.marketCap)}</span></div>
      <div class="card stat"><span class="k">Volume 24h</span><span class="v">${compact(coin.volume24h)}</span></div>
      <div class="card stat"><span class="k">24h range</span><span class="v" id="range24" style="font-size:16px">${coin.low24h ? `${usd(coin.low24h)} – ${usd(coin.high24h)}` : '—'}</span></div>
      <div class="card stat"><span class="k">All-time high</span><span class="v">${usd(coin.ath)}</span><span class="s muted">${coin.ath ? `${pct((coin.price / coin.ath - 1) * 100, 1)} from ATH` : ''}</span></div>
    </div>
    <div class="coin-layout">
      <div class="stack">
        <div class="card chart-card">
          <div class="chart-tools">
            <div class="seg scroll-x" id="ivSeg">${INTERVALS.map((iv) => `<button data-v="${iv}" class="${iv === st.interval ? 'on' : ''}" title="${esc(INTERVAL_LABEL[iv] || iv)} candles">${iv}</button>`).join('')}</div>
            <button class="btn sm ghost only-s" id="indBtn" aria-expanded="false">${icon('chart', 14)} Indicators</button>
            <button class="btn sm ghost" id="drawBtn" aria-expanded="false">${icon('compare', 14)} Draw</button>
            <div class="toggles" id="toggles"></div>
          </div>
          <div class="draw-tools" id="drawTools" hidden>
            <div class="seg" id="toolSeg">
              <button data-tool="" class="on">Off</button>
              <button data-tool="trend">Trend line</button>
              <button data-tool="hline">Horizontal</button>
              <button data-tool="fib">Fibonacci</button>
              <button data-tool="erase">Erase</button>
            </div>
            <button class="btn sm ghost" id="clearDraw">Clear all</button>
            <span class="fine" id="drawHint">Tap two points on the chart to place a trend line.</span>
          </div>
          <div class="chart-box" id="chart"></div>
          <p class="fine" style="margin:6px 4px 0">Scroll or pinch to zoom · drag to pan · double-click to reset. Yellow cone = AI forecast.</p>
        </div>
      </div>
      <div class="stack">
        <div class="card" id="signalCard">${skeleton(6)}</div>
        <div class="card" id="fcCard">${skeleton(5)}</div>
        <div class="card" id="newsCard" hidden></div>
      </div>
    </div>
    <div class="card mt">
      <div class="tabs" role="tablist" id="tabs">
        <button data-tab="forecast" class="on">${icon('forecast', 16)} AI forecast</button>
        <button data-tab="patterns">${icon('compare', 16)} Pattern comparison</button>
        <button data-tab="history">${icon('markets', 16)} History &amp; cycles</button>
        <button data-tab="news">${icon('info', 16)} News</button>
        <button data-tab="periods">History vs now</button>
        <button data-tab="backtest">Backtest</button>
        ${pair ? '<button data-tab="book">Order book</button>' : ''}
        <button data-tab="exchanges">Exchanges</button>
        <button data-tab="about">About</button>
      </div>
      <div id="tabBody"></div>
    </div>`;

  // Headlines beside the chart, not buried in a tab — the newest few, with the
  // full list one click away.
  (async () => {
    if (!backendEnabled()) return;
    const rows = await getNews({ coin: coin.symbol, limit: 4 }).catch(() => []);
    if (st.disposed || !rows.length) return;
    const card = $('#newsCard', el);
    if (!card) return;
    card.hidden = false;
    card.innerHTML = `
      <div class="card-h"><h3>${esc(coin.symbol)} news</h3><button class="btn sm ghost" id="allNews">See all</button></div>
      <div class="news-mini">${rows.map((r) => `
        <a href="${esc(r.link)}" target="_blank" rel="noopener noreferrer">
          <span>${esc(r.title)}</span>
          <small class="fine">${esc(r.source || '')} · ${esc(ago(new Date(r.published_at).getTime()))}</small>
        </a>`).join('')}</div>
      <p class="fine">Background only — the price model reads price data, not headlines.</p>`;
    $('#allNews', card)?.addEventListener('click', () => {
      const btn = $$('[data-tab]', el).find((b) => b.dataset.tab === 'news');
      btn?.click();
      btn?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  })();

  logActivity('view_coin', coin.symbol, { name: coin.name });

  $('#star', el).addEventListener('click', (e) => e.currentTarget.classList.toggle('on', watchlist.toggle(coin.symbol)));

  // Hand-off to an exchange. CoinVantage never places the order itself.
  $('#tradeBtn', el)?.addEventListener('click', () => {
    const venues = venuesFor(coin.symbol);
    const sig = st.signal;
    logActivity('trade_link', coin.symbol);
    modal(`<h3>Trade ${esc(coin.symbol)}</h3>
      <p class="fine">Pick where you already have an account. The pair opens ready to trade on their site.</p>
      ${sig?.ok && sig.plan ? `<div class="plan mt">
        <div><div class="k">Signal says</div><div class="v ${sig.tone}">${esc(sig.text)}</div></div>
        <div><div class="k">Stop-loss to set</div><div class="v down">${money(sig.plan.stopLoss)}</div></div>
      </div><p class="fine" style="margin-top:8px">Set the stop-loss on the exchange as soon as the order fills.</p>` : ''}
      <div class="sheet-grid mt">
        ${venues.map((v) => `<a class="sheet-item" href="${esc(v.href)}" target="_blank" rel="noopener noreferrer">${icon('exchanges', 18)}<span>${esc(v.name)}<br><small class="fine">${esc(v.pair)}</small></span></a>`).join('')}
      </div>
      <p class="fine mt">${esc(TRADE_DISCLAIMER)}</p>

      <h3 class="mt">Practice first — your own demo trade</h3>
      <p class="fine">Trade ${esc(coin.symbol)} yourself with simulated money at the live price. This is your own practice account, kept separate from the AI trader's. No exchange, no order, no keys.</p>
      <div id="paperWrap">${paperBlock()}</div>`);
    wirePaper();
  });

  // ---------------------------------------------------------- demo trading
  // Shares the AI trader's simulated account so one balance tells the whole story.
  // Your own demo trades are kept in a separate account from the AI trader's,
  // so one person's manual experiments never distort the record the strategy is
  // judged on. Same simulated rules, same live prices, separate balance.
  const PAPER_CFG = 'traderCfg';
  const PAPER_STATE = 'myDemoState';
  const paperCfg = () => ({ ...DEFAULT_CONFIG, ...load(PAPER_CFG, {}) });
  const paperState = () => load(PAPER_STATE, null) || newState(paperCfg());

  function paperBlock() {
    const cfg = paperCfg();
    const state = paperState();
    const pos = state.open[coin.symbol];
    const px = st.lastPrice ?? coin.price;
    const bal = equity(state, { [coin.symbol]: px });
    const suggested = Math.max(1, Math.round(state.balance * 0.1));
    if (pos) {
      const pnl = (px - pos.entry) * pos.qty;
      return `<div class="plan mt">
        <div><div class="k">Your practice position</div><div class="v">${amount(pos.qty)} ${esc(coin.symbol)}</div></div>
        <div><div class="k">Bought at</div><div class="v">${money(pos.entry, { dp: st.dp })}</div></div>
        <div><div class="k">Open profit / loss</div><div class="v ${pnl >= 0 ? 'up' : 'down'}">${pnl >= 0 ? '+' : '−'}${money(Math.abs(pnl))}</div></div>
        <div><div class="k">Practice balance</div><div class="v">${money(bal)}</div></div>
      </div>
      <div class="row mt" style="gap:8px"><button class="btn primary" id="paperClose">Sell (demo)</button><a class="btn sm ghost" href="#/trader">See all my demo trades</a></div>
      <p class="fine" id="paperMsg"></p>
      <p class="fine">${esc(PAPER_NOTICE)}</p>`;
    }
    return `<form class="row mt" style="gap:8px;align-items:flex-end" id="paperForm">
        <label class="fld" style="flex:1">Amount to put in (${esc(fx.code)})<input class="inp" name="amt" type="number" min="1" step="1" value="${suggested}"></label>
        <button class="btn primary">Buy (demo)</button>
      </form>
      <p class="fine">Practice balance ${money(bal)}. ${st.signal?.ok && st.signal.plan ? `A stop-loss at ${money(st.signal.plan.stopLoss, { dp: st.dp })} is set for you, matching the signal.` : 'A 5% stop-loss is set for you.'}</p>
      <p class="fine" id="paperMsg"></p>
      <p class="fine">${esc(PAPER_NOTICE)}</p>`;
  }

  function wirePaper() {
    const form = document.querySelector('#paperForm');
    const closeBtn = document.querySelector('#paperClose');
    const msg = () => document.querySelector('#paperMsg');
    const redraw = () => {
      const wrap = document.querySelector('#paperWrap');
      if (!wrap) return;
      wrap.innerHTML = paperBlock();
      wirePaper();
    };
    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      const cfg = paperCfg();
      const state = paperState();
      const px = st.lastPrice ?? coin.price;
      // The box is in the visitor's currency; the account is kept in USD.
      const usdAmount = (+form.amt.value || 0) / (fx.rate || 1);
      const r = openManual(state, cfg, coin.symbol, px, {
        notional: usdAmount,
        stopPrice: st.signal?.ok ? st.signal.plan?.stopLoss : undefined,
        targetPrice: st.signal?.ok ? st.signal.plan?.takeProfits?.[0] : undefined,
      });
      if (!r.ok) { const m = msg(); if (m) { m.textContent = r.error; m.className = 'fine down'; } return; }
      save(PAPER_STATE, state);
      logActivity('paper_buy', coin.symbol);
      toast(`Demo buy placed on ${coin.symbol}. No real order was sent.`, 'up');
      redraw();
    });
    closeBtn?.addEventListener('click', () => {
      const cfg = paperCfg();
      const state = paperState();
      const px = st.lastPrice ?? coin.price;
      const r = closeManual(state, cfg, coin.symbol, px);
      if (!r.ok) { const m = msg(); if (m) { m.textContent = r.error; m.className = 'fine down'; } return; }
      save(PAPER_STATE, state);
      logActivity('paper_sell', coin.symbol);
      toast(`Demo sell done — ${r.trade.pnl >= 0 ? 'profit' : 'loss'} ${r.trade.pnlPct}%.`, r.trade.pnl >= 0 ? 'up' : 'down');
      redraw();
    });
  }

  // ------------------------------------------------------------ chart
  const chart = new CandleChart($('#chart', el), {});
  const TOGGLES = [['ema20', 'EMA 20', '--series-1'], ['ema50', 'EMA 50', '--series-2'], ['ema200', 'EMA 200', '--series-7'], ['bb', 'Bollinger'], ['vwap', 'VWAP', '--series-4'], ['ichimoku', 'Ichimoku'], ['volume', 'Volume'], ['rsi', 'RSI'], ['macd', 'MACD'], ['levels', 'Levels'], ['markers', 'Signals'], ['projection', 'Forecast', '--accent']];
  $('#toggles', el).innerHTML = TOGGLES.map(([k, label, c]) => `<button class="toggle ${chart.opts[k] ? 'on' : ''}" data-k="${k}">${c ? `<i style="background:var(${c})"></i>` : ''}${label}</button>`).join('');
  $$('#toggles .toggle', el).forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.k; chart.setOptions({ [k]: !chart.opts[k] }); b.classList.toggle('on', chart.opts[k]);
  }));
  // Twelve indicator chips is a wall of buttons on a phone. On a narrow screen
  // they live behind one button and the chart gets the room instead.
  // --- drawing tools ----------------------------------------------------
  // Drawings are saved per coin and per timeframe, in time/price coordinates,
  // and ride the same sync as the watchlist so they follow the account.
  const drawKey = () => `${coin.symbol}:${st.interval}`;
  const allDrawings = () => load('drawings', {});
  const loadDrawings = () => allDrawings()[drawKey()] || [];
  const saveDrawings = (list) => {
    const all = allDrawings();
    if (list.length) all[drawKey()] = list; else delete all[drawKey()];
    save('drawings', all);
  };
  chart.onDrawingsChange = (list) => saveDrawings(list);
  chart.setDrawings(loadDrawings());

  const HINTS = {
    '': 'Drawing off — the chart pans and zooms as usual.',
    trend: 'Tap two points on the chart to place a trend line. It keeps projecting past the last one.',
    hline: 'Tap once to place a horizontal line at that price.',
    fib: 'Tap a swing low then a swing high (or the reverse) to lay Fibonacci retracements between them.',
    erase: 'Tap any drawing to remove it.',
  };

  $('#drawBtn', el)?.addEventListener('click', (e) => {
    const tools = $('#drawTools', el);
    const open = tools.hidden;
    tools.hidden = !open;
    e.currentTarget.setAttribute('aria-expanded', String(open));
    if (!open) { chart.setTool(null); $$('#toolSeg button', el).forEach((b) => b.classList.toggle('on', b.dataset.tool === '')); }
  });

  $$('#toolSeg button', el).forEach((b) => b.addEventListener('click', () => {
    $$('#toolSeg button', el).forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    const tool = b.dataset.tool || null;
    chart.setTool(tool);
    const hint = $('#drawHint', el);
    if (hint) hint.textContent = HINTS[b.dataset.tool] || HINTS[''];
  }));

  $('#clearDraw', el)?.addEventListener('click', () => {
    if (!chart.drawings.length) { toast('Nothing to clear on this chart.', 'info'); return; }
    chart.clearDrawings();
    toast('Drawings cleared.', 'info');
  });

  $('#indBtn', el)?.addEventListener('click', (e) => {
    const open = el.querySelector('.chart-tools').classList.toggle('show-toggles');
    e.currentTarget.setAttribute('aria-expanded', String(open));
  });
  const onTheme = () => chart.draw();
  window.addEventListener('cv:theme', onTheme);

  // ------------------------------------------------------------ data flow
  let liveUnsub = null;
  let signalTimer = null;

  async function loadInterval() {
    const iv = st.interval;
    st.forecast = null;
    chart.setProjection(null); chart.setMarkers([]); chart.setLevels([]);
    chart.setData([]);
    $('#signalCard', el).innerHTML = skeleton(6);
    $('#fcCard', el).innerHTML = `<div class="row"><span class="spinner"></span><b>Training AI models on ${esc(coin.symbol)} history…</b></div><p class="fine mt">Pattern matching, neural network, gradient-boosted trees and more run in your browser.</p>`;
    try {
      // A 200-period average over 5-second candles covers 17 minutes and just
      // draws noise across the chart. Switch the slow overlays off there, and
      // back on when the reader moves to a real timeframe.
      chart.setDrawings(loadDrawings());
      const fast = isSecondInterval(iv);
      if (fast !== st.wasFast) {
        chart.setOptions({ ema200: !fast, ema50: !fast, bb: false });
        $$('#toggles .toggle', el).forEach((b) => b.classList.toggle('on', !!chart.opts[b.dataset.k]));
        st.wasFast = fast;
      }
      const r = await getCandles(coin, iv, isSecondInterval(iv) ? (MAX_BARS[iv] || 600) : 1500);
      if (st.disposed || iv !== st.interval) return;
      st.candles = r.candles; st.source = r.source;
      $('#srcChip', el).textContent = r.source === 'binance' ? `● Live · Binance ${pair}` : r.source === 'demo' ? 'Demo data' : 'CoinGecko (delayed)';
      $('#srcChip', el).className = `chip ${r.source === 'binance' ? 'up' : r.source === 'demo' ? 'warn' : ''}`;
      chart.setData(r.candles);
      updateSignal();
      if (liveUnsub) liveUnsub();
      if (r.source === 'binance') {
        // Binance streams 1s candles but nothing between 1s and 1m, so the 5s and
        // 10s charts merge the 1s stream into the bucket that is still open.
        const streamIv = isSecondInterval(iv) ? '1s' : iv;
        const bucketMs = INTERVAL_MS[iv] || 6e4;
        // On a second chart a candle closes every second. Recomputing the whole
        // signal that often would heat the phone for nothing, so cap it at 5s.
        let lastSignalAt = 0;
        const refreshSignal = () => {
          if (!isSecondInterval(iv)) { updateSignal(); return; }
          if (Date.now() - lastSignalAt < 5000) return;
          lastSignalAt = Date.now();
          updateSignal();
        };
        liveUnsub = live.subscribe(`${pair}@kline_${streamIv}`, (m) => {
          const k = m.k;
          let c = { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v };
          const n = st.candles.length;
          if (!n) return;
          let closed = k.x;
          if (streamIv !== iv) {
            const t = Math.floor(c.t / bucketMs) * bucketMs;
            const open = st.candles[st.candles.length - 1];
            if (open && open.t === t) {
              c = { t, o: open.o, h: Math.max(open.h, c.h), l: Math.min(open.l, c.l), c: c.c, v: open.v + c.v };
              closed = false;
            } else {
              c = { ...c, t };
              closed = true; // the previous bucket just finished
            }
          }
          chart.update(c);
          st.candles = chart.candles;
          setPrice(c.c);
          if (closed) refreshSignal();
        });
      }
      runAi();
      runBt();
    } catch (err) {
      $('#chart', el).innerHTML = errorBox(err.message);
      $('#signalCard', el).innerHTML = `<h3>Indicator reading unavailable</h3><p class="muted">${esc(err.message || 'The candle source did not return enough data.')}</p><p class="fine">Try another timeframe or retry when the market source is reachable.</p>`;
      $('#fcCard', el).innerHTML = `<h3>AI forecast unavailable</h3><p class="muted">A forecast needs the same candle history as the chart, so no result was generated.</p><p class="fine">The page is not substituting invented values.</p>`;
    }
  }

  // The exchange quotes BTC to two decimals and PEPE to eight; show exactly what
  // it quotes rather than a rounded version of it.
  getTickSize(pair).then((dp) => { if (dp !== null && !st.disposed) { st.dp = dp; setPrice(st.lastPrice ?? coin.price); } }).catch(() => {});

  function setPrice(p) {
    if (p === null || p === undefined) return;
    st.lastPrice = p;
    const node = $('#px', el);
    if (!node) return;
    const text = money(p, { dp: st.dp });
    node.textContent = text;
    document.title = `${coin.symbol} ${text} · CoinVantage`;
  }

  // Signals: current timeframe + confluence across others
  const mtfCache = {};
  async function updateSignal() {
    if (!st.candles.length) return;
    const sig = generateSignal(st.candles, { interval: st.interval });
    st.signal = sig;
    mtfCache[st.interval] = sig;
    await Promise.all(['15m', '1h', '4h', '1d'].filter((iv) => !mtfCache[iv]).map(async (iv) => {
      try { const r = await getCandles(coin, iv, 300); mtfCache[iv] = generateSignal(r.candles, { interval: iv }); } catch { /* skip */ }
    }));
    if (st.disposed) return;
    remember(coin.symbol, st.interval, { signal: sig });
    drawSignal(sig, confluence(mtfCache));
    if (sig.ok) {
      const lv = [];
      sig.levels.resistances.slice(0, 2).forEach((p, i) => lv.push({ price: p, label: i ? '' : 'Resistance', color: cssVar('--down') }));
      sig.levels.supports.slice(0, 2).forEach((p, i) => lv.push({ price: p, label: i ? '' : 'Support', color: cssVar('--up') }));
      if (sig.plan) lv.push({ price: sig.plan.stopLoss, label: 'Stop-loss', color: cssVar('--warn') }, { price: sig.plan.takeProfits[1], label: 'Target (TP2)', color: cssVar('--series-1') });
      chart.setLevels(lv);
    }
  }

  function drawSignal(sig, conf) {
    const card = $('#signalCard', el);
    if (!sig.ok) { card.innerHTML = `<h3>Signal</h3><p class="muted">${esc(sig.reason)}</p>`; return; }
    const pos = (sig.score + 100) / 2;
    const plan = sig.plan;
    card.innerHTML = `
      <div class="card-h"><h3>${icon('bolt', 16)} Indicator reading · ${st.interval}</h3><span class="fine">${INTERVAL_LABEL[st.interval]} candles</span></div>
      <div class="verdict">
        <div><div class="big ${sig.tone}">${sig.text}</div><div class="fine">Indicator agreement ${sig.score > 0 ? '+' : ''}${sig.score} / 100 — not a probability</div></div>
        <div style="flex:1"><div class="scorebar"><i style="left:${pos}%"></i></div><div class="row spread fine" style="margin-top:4px"><span>Downward</span><span>Neutral</span><span>Upward</span></div></div>
      </div>
      ${conf ? `<p class="combined mt">Standing view across all timeframes: <b class="${conf.tone}">${conf.text}</b> (${conf.score > 0 ? '+' : ''}${conf.score}). The panel below reads the ${st.interval} chart only.</p>` : ''}
      <div class="mtf mt">${['15m', '1h', '4h', '1d'].map((iv) => { const s = mtfCache[iv]; return `<div${iv === st.interval ? ' class="on"' : ''}><div class="k">${iv}</div><div class="v ${s?.ok ? s.tone : 'flat'}">${s?.ok ? s.text : '—'}</div></div>`; }).join('')}</div>
      ${summaryHtml(sig)}
      ${plan ? `
        <h3 class="mt" style="margin-bottom:8px">Illustrative levels · ${esc(plan.side === 'long' ? 'upside' : 'downside')}</h3>
        <div class="plan">
          <div><div class="k">Entry zone</div><div class="v">${money(plan.entryZone[0])} – ${money(plan.entryZone[1])}</div></div>
          <div><div class="k">Stop-loss</div><div class="v down">${money(plan.stopLoss)} <span class="fine">(${plan.riskPct}%)</span></div></div>
          <div><div class="k">Take-profit 1</div><div class="v up">${money(plan.takeProfits[0])}</div></div>
          <div><div class="k">Take-profit 2 / 3</div><div class="v up">${money(plan.takeProfits[1])} / ${money(plan.takeProfits[2])}</div></div>
        </div>
        <ul class="reasons mt">${plan.exitRules.map((r) => `<li class="s">${esc(r)}</li>`).join('')}</ul>`
      : `<h3 class="mt" style="margin-bottom:8px">No trade — wait for a trigger</h3><ul class="reasons">${sig.waitFor.map((w) => `<li class="b">${esc(w)}</li>`).join('')}</ul>`}
      <details class="mt"><summary class="fine" style="cursor:pointer">Why this signal (${sig.reasons.bullish.length} bullish · ${sig.reasons.bearish.length} bearish)</summary>
        <ul class="reasons mt">${sig.reasons.bullish.map((r) => `<li class="b">${esc(r)}</li>`).join('')}${sig.reasons.bearish.map((r) => `<li class="s">${esc(r)}</li>`).join('')}</ul>
      </details>`;
  }

  // The plain-English version of the numbers below it: what to buy, when to buy,
  // when to sell, where you are wrong, and how much to risk.
  function summaryHtml(sig) {
    const sum = tradeSummary({
      signal: { ...sig, coinSymbol: coin.symbol },
      forecast: st.forecast ? summarizeForecast(st.forecast) : null,
      timing: st.timing || null,
      interval: st.interval,
      horizonText: st.forecast ? horizonText(st.interval, st.forecast.horizon) : null,
      mtf: mtfCache,
      fmt: (v) => money(v, { dp: st.dp }),
    });
    if (!sum.steps.length && sum.verdict === 'NO READING') {
      return `
        <div class="summary mt">
          <div class="row spread"><span class="chip">${esc(sum.verdict)}</span><span class="fine">Current chart result</span></div>
          <p class="mt" style="margin-bottom:6px">${esc(sum.headline || 'The available indicators do not agree strongly enough to produce a trade geometry.')}</p>
          <p class="fine">Indicators are still calculated above. No entry, target, or timing estimate is shown because the required evidence is not present on this timeframe.</p>
        </div>`;
    }
    return `
      <div class="summary mt">
        <div class="row spread">
          <span class="chip ${sum.tone === 'warn' ? 'warn' : sum.tone}"><b>${esc(sum.verdict)}</b></span>
          <span class="fine" title="${esc(sum.confidenceWhy || '')}">${esc(sum.confidence)} confidence</span>
        </div>
        ${sum.confidenceWhy ? `<p class="fine" style="margin:6px 0 0">${esc(sum.confidenceWhy)}</p>` : ''}
        <p class="mt" style="margin-bottom:10px">${esc(sum.headline)}</p>
        <dl class="steps">${sum.steps.map((x) => `<dt>${esc(x.label)}</dt><dd>${esc(x.text)}</dd>`).join('')}</dl>
        ${sum.caveats.map((c) => `<p class="fine" style="margin:6px 0 0">${esc(c)}</p>`).join('')}
      </div>`;
  }

  // ------------------------------------------------------------ AI forecast
  async function runAi() {
    const iv = st.interval, H = st.horizon;
    // The published walk-forward evaluation does not show a reliable edge
    // overall (and is below baseline on several intervals). Do not turn those
    // measurements into a precise-looking target or probability.
    if (UNMEASURED.includes(iv) || iv === '1w') {
      st.forecast = { ok: false, reason: `No forecast is shown for ${iv}: this timeframe has not been independently measured. The chart and historical comparisons remain available as descriptive context.` };
      st.timing = null;
      $('#fcCard', el).innerHTML = `<h3>Forecast unavailable</h3><p class="muted">${esc(st.forecast.reason)}</p>`;
      if (st.tab === 'forecast' || st.tab === 'patterns') drawTab();
      if (st.signal?.ok && !st.disposed && iv === st.interval) updateSignal();
      return;
    }
    if (st.candles.length < 200) {
      $('#fcCard', el).innerHTML = `<h3>AI forecast</h3><p class="muted">Needs at least 200 candles of history on this timeframe.</p>`;
      if (st.tab === 'forecast' || st.tab === 'patterns') drawTab();
      return;
    }
    let fc;
    try {
      fc = await runForecast(st.candles, { horizon: H, intervalMs: INTERVAL_MS[iv] });
    } catch (err) {
      if (st.disposed || iv !== st.interval || H !== st.horizon) return;
      st.forecast = { ok: false, reason: err?.message || 'The forecast engine could not complete with this candle history.' };
      st.timing = null;
      $('#fcCard', el).innerHTML = `<h3>AI forecast unavailable</h3><p class="muted">${esc(st.forecast.reason)}</p><p class="fine">The indicator reading remains available; no forecast value is being invented.</p>`;
      if (st.tab === 'forecast' || st.tab === 'patterns') drawTab();
      return;
    }
    if (st.disposed || iv !== st.interval || H !== st.horizon) return;
    const trust = forecastTrust(fc, iv);
    st.forecast = fc.ok && trust.usable ? { ...fc, trust } : fc;
    st.timing = fc.ok ? timingOutlook(fc, { intervalMs: INTERVAL_MS[iv] }) : null;
    if (st.forecast.ok) {
      // Logged before the outcome is known, so "your hit rate" is honest.
      logForecastShown({
        symbol: coin.symbol, interval: iv, price: fc.lastPrice, probUp: fc.probUp,
        targetPrice: st.forecast.targetPrice, horizonBars: st.forecast.horizon,
        horizonAt: st.forecast.path[st.forecast.path.length - 1]?.t, modelAccuracy: st.forecast.ensemble?.accuracy ?? null,
      });
    }
    remember(coin.symbol, iv, { forecast: st.forecast, timing: st.timing });
    // the summary reads the forecast, so redraw the signal card now it exists
    if (st.signal?.ok && !st.disposed && iv === st.interval) updateSignal();
    if (!st.forecast.ok) { $('#fcCard', el).innerHTML = `<h3>AI forecast</h3><p class="muted">${esc(st.forecast.reason)}</p>`; return; }
    chart.setProjection(st.forecast.path);
    drawForecastCard(st.forecast);
    if (st.tab === 'forecast' || st.tab === 'patterns') drawTab();
  }

  function ring(prob) {
    const r = 50, c = 2 * Math.PI * r, up = prob >= 0.5;
    return `<div class="prob-ring"><svg width="116" height="116" viewBox="0 0 116 116"><circle cx="58" cy="58" r="${r}" fill="none" stroke="var(--surface-3)" stroke-width="10"/>
      <circle cx="58" cy="58" r="${r}" fill="none" stroke="var(--${up ? 'up' : 'down'})" stroke-width="10" stroke-linecap="round" stroke-dasharray="${(up ? prob : 1 - prob) * c} ${c}"/></svg>
      <div class="c"><div><b class="${up ? 'up' : 'down'}">${Math.round((up ? prob : 1 - prob) * 100)}%</b><small>model share ${up ? 'UP' : 'DOWN'}</small></div></div></div>`;
  }

  function drawForecastCard(fc) {
    const dirTxt = fc.direction === 'UP' ? '<b class="up">Model leans higher</b>' : fc.direction === 'DOWN' ? '<b class="down">Model leans lower</b>' : '<b class="flat">Sideways / uncertain</b>';
    const e = fc.ensemble;
    $('#fcCard', el).innerHTML = `
      <div class="card-h"><h3>${icon('ai', 16)} AI forecast</h3><span class="chip ${fc.confidence === 'High' ? 'up' : fc.confidence === 'Moderate' ? 'warn' : ''}">${fc.confidence} confidence</span></div>
      <div class="prob">${ring(fc.probUp)}
        <div class="stack" style="gap:4px">
          <div>Next <b>${horizonText(st.interval, fc.horizon)}</b>: ${dirTxt}</div>
          <div class="fine">Illustrative model path ≈ <b>${usd(fc.targetPrice)}</b> (${pct(fc.expectedReturnPct)}); not a target</div>
          <div class="fine">Historical model range ${usd(fc.range.p25)} – ${usd(fc.range.p75)}</div>
          <div class="fine">Tested accuracy: <b>${e.accuracy !== null ? (e.accuracy * 100).toFixed(1) + '%' : '—'}</b> on ${e.samples} unseen cases</div>
        </div>
      </div>
      ${timingCardBlock()}
      <div class="row mt"><span class="fine">Horizon</span><div class="seg" id="hSeg">${[Math.max(3, Math.round(st.horizon / 2)), DEFAULT_HORIZON[st.interval] || 12, (DEFAULT_HORIZON[st.interval] || 12) * 2].filter((v, i, a) => a.indexOf(v) === i).map((h) => `<button data-v="${h}" class="${h === st.horizon ? 'on' : ''}">${horizonText(st.interval, h)}</button>`).join('')}</div></div>
      <div id="histLine" class="mt"></div>`;
    bindSeg($('#hSeg', el), (v) => { st.horizon = +v; $('#fcCard', el).innerHTML = `<div class="row"><span class="spinner"></span><b>Re-training for ${horizonText(st.interval, +v)}…</b></div>`; runAi(); });
    paintHistLine();
  }

  // The shaped path: where the move tops out or bottoms, and when it turns.
  function timingSection() {
    const t = st.timing;
    if (!t?.ok) return `<p class="fine mt">${esc(t?.reason || '')}</p>`;
    if (!t.shaped) return `<p class="fine mt">Timing: the matched past charts drifted ${t.endPct >= 0 ? 'up' : 'down'} steadily rather than spiking, so there is no clear turning point to call inside this horizon.</p>`;
    const dur = (bars) => horizonText(st.interval, bars);
    const main = t.rising ? t.peak : t.trough;
    const trust = timingTrust(st.interval);
    return `
      <h3 class="mt" style="margin-bottom:6px">How long the move lasts — and when it turns</h3>
      ${trust.level === 'bad' ? `<div class="banner" style="margin:0 0 10px">${icon('info', 16)} ${esc(trust.text)}</div>` : ''}
      <div class="grid g2">
        <div><div id="tmChart"></div>
          <p class="fine">Built from what price actually did after the ${t.matchesUsed} closest past charts, step by step — then tilted so it ends on the ensemble's expected move. Shaded band = the middle half of those past outcomes.</p></div>
        <div class="stack">
          <div class="grid g3">
            <div class="stat"><span class="k">${t.rising ? 'Rises for' : 'Falls for'}</span><span class="v">${esc(dur(main.bar))}</span></div>
            <div class="stat"><span class="k">${t.rising ? 'Peak near' : 'Low near'}</span><span class="v ${t.rising ? 'up' : 'down'}">${money(main.price)}</span><span class="s fine">${pct(main.pct, 1)}</span></div>
            <div class="stat"><span class="k">${t.turn ? 'Turns after' : t.recover ? 'Bounces after' : 'At horizon'}</span><span class="v">${esc(dur(t.turn?.bar ?? t.recover?.bar ?? t.horizonBars))}</span></div>
          </div>
          <dl class="kv">
            <dt>Best window to be in</dt><dd>${t.hold ? `${esc(dur(t.hold.fromBar))} – ${esc(dur(t.hold.toBar))}` : '—'}</dd>
            <dt>Past charts still up at the peak</dt><dd>${main.agreement === null || main.agreement === undefined ? '—' : `${Math.round(main.agreement)}%`}</dd>
            <dt>Where it ends at the horizon</dt><dd class="${t.endPct >= 0 ? 'up' : 'down'}">${pct(t.endPct, 1)}</dd>
          </dl>
          <p class="fine ${trust.level === 'bad' ? 'down' : trust.level === 'good' ? '' : 'warn'}">${esc(trust.text)}</p>
          <p class="fine">Across all timeframes: ${TESTED_TIMING.tests} walk-forward tests on ${TESTED_TIMING.coins} coins, ${TESTED_TIMING.peakHitPct}% hit versus a ${TESTED_TIMING.baselinePct}% random baseline, and the move really did turn inside the horizon ${TESTED_TIMING.turnedInsideHorizonPct}% of the time.</p>
          <p class="fine warn">Timing is the least reliable part of any forecast. Use it to plan an exit window, never as a reason to skip a stop-loss.</p>
        </div>
      </div>`;
  }

  function drawTimingChart(body) {
    const t = st.timing;
    if (!t?.ok || !t.shaped || !$('#tmChart', body)) return;
    const lc = new LineChart($('#tmChart', body), {
      height: 260, yFormat: (v) => money(v), xFormat: (x) => shortTime(x, st.interval), tooltipX: (x) => dateTime(x),
    });
    st.charts.push(lc);
    const main = t.rising ? t.peak : t.trough;
    lc.set([
      { name: 'Expected path', color: cssVar('--accent'), width: 2.6, data: t.path.map((p) => ({ x: p.t, y: p.price })) },
      { name: t.rising ? 'Expected peak' : 'Expected low', color: cssVar(t.rising ? '--up' : '--down'), width: 0, data: [{ x: main.t, y: main.price }] },
    ], {
      bands: [{ color: cssVar('--accent'), alpha: 0.14, data: t.path.map((p) => ({ x: p.t, lo: p.lo, hi: p.hi })) }],
      divider: main.t, dividerLabel: t.rising ? 'peak' : 'low',
    });
  }

  // "How long does it last, and when does it turn?" — shown right under the odds,
  // because a direction with no timing is only half an answer.
  function timingCardBlock() {
    const t = st.timing;
    if (!t?.ok) {
      return `<div class="timing-box mt"><b>Timing reading</b><p class="fine">${esc(t?.reason || 'A timing path could not be calculated from the available history.')}</p><p class="fine">The direction and indicator readings remain available; no turning point is being invented.</p></div>`;
    }
    if (!t.shaped) {
      return `<div class="timing-box mt"><b>Timing reading</b><p class="fine">The matched historical paths do not form a clear peak or low inside this horizon. The result is a steady path, not an empty forecast.</p></div>`;
    }
    const dur = (bars) => horizonText(st.interval, bars);
    const main = t.rising ? t.peak : t.trough;
    const cls = t.rising ? 'up' : 'down';
    const trust = timingTrust(st.interval);
    return `
      <div class="timing-box mt">
        <div class="row spread"><b>${t.rising ? 'How long the rise lasts' : 'How long the drop lasts'}</b>
          <span class="chip ${cls}">${t.rising ? 'peaks' : 'bottoms'} in ${esc(dur(main.bar))}</span></div>
        <div class="tl mt">
          <i class="tl-bar"></i>
          <span class="tl-mark ${cls}" style="left:${(main.bar / t.horizonBars) * 100}%" title="${t.rising ? 'peak' : 'low'}"></span>
          ${t.turn ? `<span class="tl-mark warn" style="left:${(t.turn.bar / t.horizonBars) * 100}%" title="turns"></span>` : ''}
          ${t.recover ? `<span class="tl-mark up" style="left:${(t.recover.bar / t.horizonBars) * 100}%" title="bounce"></span>` : ''}
        </div>
        <div class="row spread fine" style="margin-top:3px"><span>now</span><span>${esc(dur(t.horizonBars))}</span></div>
        <p class="fine" style="margin:8px 0 0">
          ${t.rising
            ? `Expect strength for about <b>${esc(dur(main.bar))}</b>, topping near <b>${money(main.price)}</b> (${pct(main.pct, 1)})${t.turn ? `, then fading back to ${pct(t.turn.pct, 1)} by <b>${esc(dur(t.turn.bar))}</b>` : ', holding rather than reversing inside this horizon'}.`
            : `Expect weakness for about <b>${esc(dur(main.bar))}</b>, bottoming near <b>${money(main.price)}</b> (${pct(main.pct, 1)})${t.recover ? `, with a bounce starting around <b>${esc(dur(t.recover.bar))}</b>` : ', with no clear bounce inside this horizon'}.`}
          ${main.agreement !== null && main.agreement !== undefined ? ` ${Math.round(main.agreement)}% of the ${t.matchesUsed} matched past charts were still up at that point.` : ''}
        </p>
        <p class="fine ${trust.level === 'bad' ? 'down' : trust.level === 'weak' ? 'warn' : 'muted'}" style="margin:6px 0 0">${trust.level === 'good' ? `Timing measured ${TESTED_TIMING.byInterval[st.interval].hitPct}% on ${esc(st.interval)} charts against a ${TESTED_TIMING.byInterval[st.interval].baselinePct}% random baseline.` : trust.level === 'bad' ? `⚠ Timing is unreliable on ${esc(st.interval)} charts — the 4h chart is the one it tested best on.` : trust.level === 'unknown' ? 'Timing has not been measured on this timeframe.' : `Timing barely clears chance here${TESTED_TIMING.byInterval[st.interval] ? ` (${TESTED_TIMING.byInterval[st.interval].hitPct}% against ${TESTED_TIMING.byInterval[st.interval].baselinePct}%)` : ''}.`}</p>
      </div>`;
  }

  // One-line cross-check from the long-range history study, shown next to the forecast.
  async function paintHistLine() {
    const node = $('#histLine', el);
    if (!node) return;
    node.innerHTML = '<span class="fine muted">Checking previous years…</span>';
    let h;
    try { h = await computeHistory(st.histHorizon || 30); } catch (err) {
      node.innerHTML = `<p class="fine muted">History comparison unavailable: ${esc(err?.message || 'the history source did not return enough data')}.</p>`;
      return;
    }
    if (st.disposed) return;
    const target = $('#histLine', el);
    if (!target) return;
    if (!h.ok) { target.innerHTML = `<p class="fine muted">Not enough daily history on ${esc(coin.symbol)} for a multi-year comparison.</p>`; return; }
    const v = h.verdict, s = h.analogs.stats[h.horizon];
    const cls = v.direction === 'UP' ? 'up' : v.direction === 'DOWN' ? 'down' : 'flat';
    target.innerHTML = `
      <div style="padding:10px;border-radius:10px;background:var(--surface-2)">
        <div class="row spread"><b>Previous years say</b><span class="chip ${cls === 'flat' ? '' : cls}">${v.direction === 'UP' ? 'higher' : v.direction === 'DOWN' ? 'lower' : 'mixed'} in ${h.horizon}d</span></div>
        <p class="fine" style="margin:6px 0 0">${h.weak ? `No past chart closely resembles today (best match ${Math.round(h.analogs.matches[0].similarity * 100)}%), so this is background only. ` : ''}${s.upCount}/${s.total} past look-alikes rose, median ${pct(s.median, 1)}. ${v.accuracy !== null ? `This method has been right ${(v.accuracy * 100).toFixed(0)}% of the time on ${esc(coin.symbol)}.` : 'Too few past tests to score this method here.'}</p>
        <button class="btn sm ghost" style="margin-top:8px" id="openHist">See the matching charts →</button>
      </div>`;
    $('#openHist', el)?.addEventListener('click', () => {
      $$('#tabs [data-tab]', el).forEach((b) => b.classList.toggle('on', b.dataset.tab === 'history'));
      st.tab = 'history';
      drawTab();
      $('#tabs', el).scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  // ------------------------------------------------------------ backtest
  async function runBt() {
    const iv = st.interval;
    st.backtest = await runBacktest(st.candles.slice(-1000));
    if (st.disposed || iv !== st.interval) return;
    remember(coin.symbol, iv, { backtest: st.backtest });
    if (st.backtest.ok) chart.setMarkers(st.backtest.trades.flatMap((t) => [{ t: t.entryTime, side: 'buy' }, { t: t.exitTime, side: 'sell' }]).concat(st.backtest.openTrade ? [{ t: st.backtest.openTrade.entryTime, side: 'buy' }] : []));
    if (st.tab === 'backtest') drawTab();
  }

  // ------------------------------------------------------------ tabs
  let tabCleanup = null;
  const destroyCharts = () => { st.charts.forEach((c) => c.destroy()); st.charts = []; };
  function drawTab() {
    if (tabCleanup) { tabCleanup(); tabCleanup = null; }
    destroyCharts();
    const body = $('#tabBody', el);
    const fc = st.forecast;
    const accent = cssVar('--accent'), muted = cssVar('--text-muted');

    if (st.tab === 'forecast') {
      if (!fc) { body.innerHTML = `<div class="row"><span class="spinner"></span> Training models…</div>`; return; }
      if (!fc.ok) { body.innerHTML = `<p class="muted">${esc(fc.reason)}</p>`; return; }
      const e = fc.ensemble;
      body.innerHTML = `
        <div class="grid g2">
          <div>
            <h3 style="margin-bottom:6px">Price path forecast · next ${horizonText(st.interval, fc.horizon)}</h3>
            <div id="fcChart"></div>
            <p class="fine">Solid line = actual price. Dashed = AI median forecast. Shaded = 50% and 80% likely ranges.</p>
          </div>
          <div class="stack">
            <div class="grid g3">
              <div class="stat"><span class="k">Chance of rise</span><span class="v ${fc.probUp >= 0.5 ? 'up' : 'down'}">${(fc.probUp * 100).toFixed(1)}%</span></div>
              <div class="stat"><span class="k">Expected move</span><span class="v ${fc.expectedReturnPct >= 0 ? 'up' : 'down'}">${pct(fc.expectedReturnPct)}</span></div>
              <div class="stat"><span class="k">Target</span><span class="v">${usd(fc.targetPrice)}</span></div>
            </div>
            <div class="kv">
              <dt>80% range at horizon</dt><dd>${usd(fc.range.p10)} – ${usd(fc.range.p90)}</dd>
              <dt>Direction accuracy on unseen data</dt><dd>${e.accuracy !== null ? (e.accuracy * 100).toFixed(1) + '%' : '—'} <span class="muted">(${e.samples} tests)</span></dd>
              <dt>Accuracy when models strongly agree</dt><dd>${e.confidentAccuracy !== null ? (e.confidentAccuracy * 100).toFixed(1) + '%' : '—'} <span class="muted">(${Math.round(e.confidentCoverage * 100)}% of the time)</span></dd>
              <dt>Naive baseline (always predict usual direction)</dt><dd>${(e.baseline * 100).toFixed(1)}%</dd>
              <dt>Test period</dt><dd>${dateTime(e.validationFrom, false)} → ${dateTime(e.validationTo, false)}</dd>
              <dt>Candles analysed</dt><dd>${fc.candlesUsed.toLocaleString()} · ${fc.computeMs} ms</dd>
            </div>
            ${fc.notes.length ? `<ul class="reasons">${fc.notes.map((n) => `<li class="s">${esc(n)}</li>`).join('')}</ul>` : ''}
          </div>
        </div>
        <h3 class="mt" style="margin-bottom:6px">The models behind the forecast</h3>
        <div class="tbl-wrap"><table class="tbl models-tbl"><thead><tr><th class="l">Model</th><th>Says up</th><th>Accuracy on unseen data</th><th>Weight</th></tr></thead><tbody>
          ${fc.models.map((m) => `<tr style="cursor:default"><td class="l"><b>${esc(m.name)}</b></td><td class="${m.probUp >= 0.5 ? 'up' : 'down'}">${m.probUp !== null ? (m.probUp * 100).toFixed(1) + '%' : '—'}</td>
            <td>${m.accuracy !== null ? (m.accuracy * 100).toFixed(1) + '%' : '—'}<span class="acc-bar"><i style="width:${Math.max(0, Math.min(100, ((m.accuracy ?? 0.5) - 0.3) / 0.4 * 100))}%"></i></span></td><td>${m.weightPct}%</td></tr>`).join('')}
        </tbody></table></div>
        <p class="fine mt">How it works: each model is trained on this coin's own history, then tested on the most recent period it never saw. Models that predicted better get more weight. Crypto is noisy — 55% direction accuracy is already a real edge; nothing is certain.</p>
        <p class="fine">Independent test of this engine: ${TESTED_ACCURACY.tests} forecasts on ${TESTED_ACCURACY.coins} major coins, made only with data available at the time. It called the direction right <b>${TESTED_ACCURACY.all}%</b> of the time — against <b>${TESTED_ACCURACY.allBaseline}%</b> for ignoring it entirely and always naming whichever direction was more common in that window. By timeframe, accuracy against that same baseline: ${['1m', '5m', '15m', '1h', '4h', '1d'].map((iv) => `${iv} ${TESTED_ACCURACY[iv]}% vs ${TESTED_ACCURACY.baseline[iv]}%`).join(' · ')}.${UNMEASURED.includes(st.interval) ? ` <b class="warn">This engine has never been tested on the ${esc(INTERVAL_LABEL[st.interval] || st.interval)} chart, so it has no measured accuracy here. Second charts are for watching price move — use the 5m chart or slower for a forecast you can judge.</b>` : (TESTED_ACCURACY.noEdge || []).includes(st.interval) ? ` <b class="warn">On the ${esc(INTERVAL_LABEL[st.interval] || st.interval)} chart it scored ${TESTED_ACCURACY[st.interval]}% against a ${TESTED_ACCURACY.baseline[st.interval]}% baseline — no edge. Read this forecast as background, not as a reason to trade.</b>` : st.interval === '1w' ? ` <b class="warn">The weekly chart has too few candles to test, so nothing here has a measured accuracy.</b>` : ''}</p>
        <p class="fine">Overall the engine did <b>not</b> beat that baseline (${TESTED_ACCURACY.all}% against ${TESTED_ACCURACY.allBaseline}%), and it is listed as having no edge on ${(TESTED_ACCURACY.noEdge || []).join(', ')}. ${esc(TESTED_ACCURACY.caveat)} Treat the probability below as a description of what the indicators imply, not as a reason to act.</p>`;
      body.insertAdjacentHTML('beforeend', timingSection());
      const lc = new LineChart($('#fcChart', body), { height: 300, yFormat: (v) => money(v), xFormat: (x) => shortTime(x, st.interval), tooltipX: (x) => dateTime(x) });
      st.charts.push(lc);
      const hist = st.candles.slice(-Math.max(60, fc.horizon * 5));
      const last = hist[hist.length - 1];
      const bandPts = [{ x: last.t, lo: last.c, hi: last.c }, ...fc.path.map((p) => ({ x: p.t, lo: p.p10, hi: p.p90 }))];
      const band50 = [{ x: last.t, lo: last.c, hi: last.c }, ...fc.path.map((p) => ({ x: p.t, lo: p.p25, hi: p.p75 }))];
      lc.set([
        { name: 'Price', color: cssVar('--text'), data: hist.map((c) => ({ x: c.t, y: c.c })), width: 1.8 },
        { name: 'AI median forecast', color: accent, dash: true, data: [{ x: last.t, y: last.c }, ...fc.path.map((p) => ({ x: p.t, y: p.p50 }))], width: 2.2 },
      ], { bands: [{ color: accent, alpha: 0.1, data: bandPts }, { color: accent, alpha: 0.2, data: band50 }], divider: last.t, dividerLabel: 'now' });
      drawTimingChart(body);
      return;
    }

    if (st.tab === 'patterns') {
      if (!fc) { body.innerHTML = `<div class="row"><span class="spinner"></span> Searching history for similar charts…</div>`; return; }
      const pat = fc.ok ? fc.patterns : null;
      if (!pat?.matches?.length) { body.innerHTML = '<p class="muted">No sufficiently similar past patterns were found on this timeframe. Try another timeframe.</p>'; return; }
      const W = fc.window, top = pat.matches.slice(0, 5);
      const ups = pat.matches.filter((m) => m.futureReturnPct > 0).length;
      body.innerHTML = `
        <div class="row spread" style="margin-bottom:8px">
          <div><h3>Today's chart vs the most similar moments in ${esc(coin.symbol)}'s history</h3>
          <p class="fine">Last ${W} ${st.interval} candles compared with every past window of the same length. Lines are scaled so each window ends at 100.</p></div>
          <div class="chip ${ups / pat.matches.length >= 0.5 ? 'up' : 'down'}">${ups} of ${pat.matches.length} similar charts went up next</div>
        </div>
        <div id="patChart"></div>
        <div class="match-list mt">${pat.matches.map((m, i) => `<div style="border-left:3px solid ${i < 5 ? `var(${SERIES[i]})` : 'var(--border)'}">
          <div><b>${dateTime(m.startTime, st.interval !== '1d' && st.interval !== '1w')}</b></div>
          <div class="muted">${(m.similarity * 100).toFixed(0)}% similar</div>
          <div>Then: <b class="${m.futureReturnPct >= 0 ? 'up' : 'down'}">${pct(m.futureReturnPct)}</b></div>
          <div class="fine">max ${pct(m.maxUpPct, 1)} / ${pct(m.maxDownPct, 1)}</div></div>`).join('')}</div>
        <p class="fine mt">Future moves of past matches are adjusted for today's volatility. Median outcome: <b class="${pat.medianReturn >= 0 ? 'up' : 'down'}">${pct(pat.medianReturn * 100)}</b> over ${horizonText(st.interval, fc.horizon)}.</p>`;
      const lc = new LineChart($('#patChart', body), { height: 320, yFormat: (v) => v.toFixed(1), xFormat: (x) => { const k = Math.round(x) - (W - 1); return k === 0 ? 'now' : k < 0 ? `${k}` : `+${k}`; }, tooltipX: (x) => { const k = Math.round(x) - (W - 1); return k === 0 ? 'Now' : k < 0 ? `${-k} candles before` : `${k} candles after`; } });
      st.charts.push(lc);
      lc.set([
        ...top.map((m, i) => ({ name: `${dateTime(m.startTime, false)} (${(m.similarity * 100).toFixed(0)}%)`, color: cssVar(SERIES[i]), alpha: 0.75, width: 1.5, data: m.series.map((v, k) => ({ x: k, y: v })) })),
        { name: `Now · ${coin.symbol}`, color: cssVar('--text'), width: 3, data: pat.currentSeries.map((v, k) => ({ x: k, y: v })) },
        fc.ok && { name: 'AI forecast', color: accent, dash: true, width: 2.4, data: [{ x: W - 1, y: 100 }, ...fc.path.map((p, k) => ({ x: W + k, y: (p.p50 / fc.lastPrice) * 100 }))] },
      ].filter(Boolean), { divider: W - 1, dividerLabel: 'now' });
      return;
    }

    if (st.tab === 'news') {
      body.innerHTML = `<div id="newsBody">${skeleton(6, 22)}</div>`;
      (async () => {
        if (!backendEnabled()) { $('#newsBody', body).innerHTML = '<p class="muted">News is not configured on this deployment.</p>'; return; }
        const rows = await getNews({ coin: coin.symbol, limit: 30 }).catch(() => []);
        if (st.tab !== 'news' || st.disposed) return;
        st.news = rows;
        $('#newsBody', body).innerHTML = rows.length ? `
          <p class="fine" style="margin-bottom:10px">${rows.length} recent ${rows.length === 1 ? 'story' : 'stories'} tagged <b>${esc(coin.symbol)}</b>, newest first. Headlines are collected automatically and shown unedited — check the source before acting on one.</p>
          <div class="news-list">${rows.map((r) => `
            <article class="news-item">
              ${r.image ? `<img src="${esc(r.image)}" alt="" width="92" height="64" loading="lazy" style="width:92px;height:64px;object-fit:cover;border-radius:10px;flex:none">` : ''}
              <div style="min-width:0">
                <a class="ttl" href="${esc(r.link)}" target="_blank" rel="noopener noreferrer">${esc(r.title)}</a>
                ${r.summary ? `<p class="fine" style="margin:4px 0 0">${esc(r.summary.slice(0, 180))}${r.summary.length > 180 ? '…' : ''}</p>` : ''}
                <div class="meta"><b>${esc(r.source)}</b><span>${ago(new Date(r.published_at).getTime())}</span>${(r.coins || []).filter((c) => c !== coin.symbol).slice(0, 4).map((c) => `<a href="#/coin/${esc(c)}" class="chip">${esc(c)}</a>`).join('')}</div>
              </div>
            </article>`).join('')}</div>
          <p class="fine mt"><b>Note on the forecast:</b> these headlines are shown for context and are given to the AI assistant when it answers about ${esc(coin.symbol)}. They are <b>not</b> an input to the price model — its published accuracy comes from price data alone, and adding unmeasured news sentiment would make that number a lie.</p>`
          : `<div class="empty">${icon('info', 20)}<p>No recent headlines tagged ${esc(coin.symbol)}. The collector refreshes every 20 minutes.</p><a class="btn sm" href="#/news">All crypto news</a></div>`;
        // A broken thumbnail is hidden here rather than with an inline handler,
        // which the page's Content-Security-Policy blocks outright.
        $$('#newsBody img', body).forEach((img) => img.addEventListener('error', () => img.remove()));
      })();
      return;
    }

    if (st.tab === 'history') {
      drawHistoryTab(body);
      return;
    }

    if (st.tab === 'periods') {
      body.innerHTML = `<div class="row spread" style="margin-bottom:8px"><div><h3>Compare now with previous periods</h3><p class="fine">Performance of the latest period against the period before it and the same dates one and two years ago.</p></div>
        <div class="seg" id="perSeg"><button data-v="7">7 days</button><button data-v="30" class="on">30 days</button><button data-v="90">90 days</button><button data-v="365">1 year</button></div></div>
        <div id="perChart">${skeleton(6)}</div><div id="perStats" class="grid g4 mt"></div>`;
      const drawPeriods = async (days) => {
        let daily;
        try { daily = (await getCandles(coin, '1d', 1100)).candles; } catch { body.querySelector('#perChart').innerHTML = errorBox('Daily history unavailable'); return; }
        if (st.disposed || st.tab !== 'periods') return;
        const n = daily.length;
        const seg = (endIdx) => (endIdx - days < 0 ? null : daily.slice(endIdx - days, endIdx + 1));
        const periods = [
          ['Latest', seg(n - 1), '--text'], ['Previous period', seg(n - 1 - days), '--series-1'],
          ['1 year ago', seg(n - 1 - 365), '--series-2'], ['2 years ago', seg(n - 1 - 730), '--series-7'],
        ].filter(([, s]) => s && s.length === days + 1);
        destroyCharts();
        $('#perChart', body).innerHTML = '';
        const lc = new LineChart($('#perChart', body), { height: 320, yFormat: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`, xFormat: (x) => `day ${Math.round(x)}`, tooltipX: (x) => `Day ${Math.round(x)} of ${days}`, zeroLine: 0 });
        st.charts.push(lc);
        lc.set(periods.map(([name, s, c]) => ({ name: `${name} (${dateTime(s[0].t, false)})`, color: cssVar(c), width: name === 'Latest' ? 3 : 1.8, data: s.map((d, k) => ({ x: k, y: (d.c / s[0].c - 1) * 100 })) })));
        $('#perStats', body).innerHTML = periods.map(([name, s]) => {
          const ret = (s[s.length - 1].c / s[0].c - 1) * 100;
          let peak = s[0].c, dd = 0; for (const d of s) { peak = Math.max(peak, d.c); dd = Math.max(dd, (peak - d.c) / peak); }
          return `<div class="stat"><span class="k">${name}</span><span class="v ${ret >= 0 ? 'up' : 'down'}">${pct(ret)}</span><span class="s muted">max drawdown ${pct(-dd * 100, 1)}</span></div>`;
        }).join('');
      };
      bindSeg($('#perSeg', body), (v) => drawPeriods(+v));
      drawPeriods(30);
      return;
    }

    if (st.tab === 'backtest') {
      const bt = st.backtest;
      if (!bt) { body.innerHTML = `<div class="row"><span class="spinner"></span> Backtesting…</div>`; return; }
      if (!bt.ok) { body.innerHTML = `<p class="muted">${esc(bt.reason)}</p>`; return; }
      // A backtest that lost badly to buy-and-hold is the most useful thing on
      // this page, and burying it would be dishonest. Say it in plain words.
      const lag = bt.totalReturnPct - bt.buyHoldPct;
      const verdict = bt.totalReturnPct < 0 && lag < -20
        ? `<div class="banner down" style="margin:0 0 12px"><b>These signals did not work on the ${esc(INTERVAL_LABEL[st.interval] || st.interval)} chart for ${esc(coin.symbol)}.</b> Following them would have lost ${pct(Math.abs(bt.totalReturnPct), 1, false)} while simply holding gained ${pct(bt.buyHoldPct, 1)}. Use a faster chart, or hold — do not trade this timeframe on these signals.</div>`
        : lag < -10
          ? `<div class="banner" style="margin:0 0 12px">On this timeframe the signals <b>underperformed simply holding</b> by ${pct(Math.abs(lag), 1, false)}. Holding was the better plan here.</div>`
          : bt.tradeCount < 10
            ? '<div class="banner" style="margin:0 0 12px">Fewer than 10 trades — too small a sample to conclude anything from. Treat this as an illustration, not evidence.</div>'
            : '';
      body.innerHTML = `
        ${verdict}
        <p class="fine" style="margin-bottom:10px">What would have happened if you had followed this page's Buy/Sell signals on the last ${bt.bars} ${st.interval} candles (long only, 0.1% fee per trade, stop-loss 1.5× ATR, target 2.5R, stop moved to break-even at +1R).</p>
        <div class="grid g4">
          <div class="stat"><span class="k">Strategy return</span><span class="v ${bt.totalReturnPct >= 0 ? 'up' : 'down'}">${pct(bt.totalReturnPct)}</span></div>
          <div class="stat"><span class="k">Buy &amp; hold</span><span class="v ${bt.buyHoldPct >= 0 ? 'up' : 'down'}">${pct(bt.buyHoldPct)}</span></div>
          <div class="stat"><span class="k">Win rate</span><span class="v">${bt.winRate ?? '—'}%</span><span class="s muted">${bt.tradeCount} trades</span></div>
          <div class="stat"><span class="k">Max drawdown</span><span class="v down">${pct(-bt.maxDrawdownPct)}</span><span class="s muted">profit factor ${bt.profitFactor ?? '—'}</span></div>
        </div>
        <div id="btChart" class="mt"></div>
        <div class="tbl-wrap mt"><table class="tbl"><thead><tr><th class="l">Entry</th><th>Entry price</th><th>Exit price</th><th>Result</th><th>Exit reason</th></tr></thead><tbody>
          ${bt.trades.slice(-15).reverse().map((t) => `<tr style="cursor:default"><td class="l">${dateTime(t.entryTime)}</td><td>${money(t.entry)}</td><td>${money(t.exit)}</td><td class="${t.returnPct >= 0 ? 'up' : 'down'}">${pct(t.returnPct)}</td><td>${t.reason}</td></tr>`).join('') || '<tr><td colspan="5" class="l muted">No completed trades in this window.</td></tr>'}
        </tbody></table></div>`;
      const lc = new LineChart($('#btChart', body), { height: 260, yFormat: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`, xFormat: (x) => shortTime(x, st.interval), tooltipX: (x) => dateTime(x), zeroLine: 0 });
      st.charts.push(lc);
      const base = st.candles.slice(-1000);
      const startIdx = base.findIndex((c) => c.t === bt.from);
      lc.set([
        { name: 'Signal strategy', color: accent, width: 2.2, data: bt.curve.map((p) => ({ x: p.t, y: (p.v - 1) * 100 })) },
        { name: 'Buy & hold', color: muted, width: 1.6, data: base.slice(startIdx).map((c) => ({ x: c.t, y: (c.c / base[startIdx].c - 1) * 100 })) },
      ]);
      return;
    }

    if (st.tab === 'book') {
      body.innerHTML = `<div class="grid g2"><div><h3 style="margin-bottom:8px">Order book</h3><div id="book">${skeleton(10, 14)}</div></div><div><h3 style="margin-bottom:8px">Recent trades</h3><div id="trades">${skeleton(10, 14)}</div></div></div>`;
      const drawBook = async () => {
        const [d, tr] = await Promise.all([getDepth(pair, 15), getTrades(pair, 20)]);
        if (st.tab !== 'book' || st.disposed) return;
        if (d) {
          const maxQ = Math.max(...d.bids.map((b) => b[1] * b[0]), ...d.asks.map((a) => a[1] * a[0]));
          const row = (p, q, side) => `<div class="book-row"><i style="width:${((p * q) / maxQ) * 100}%;background:var(--${side})"></i><span class="${side}">${money(p)}</span><span>${amount(q)}</span></div>`;
          $('#book', body).innerHTML = `<div class="book"><div><div class="row spread fine"><span>Bid (buy)</span><span>Amount</span></div>${d.bids.map(([p, q]) => row(p, q, 'up')).join('')}</div>
            <div><div class="row spread fine"><span>Ask (sell)</span><span>Amount</span></div>${d.asks.map(([p, q]) => row(p, q, 'down')).join('')}</div></div>
            <p class="fine mt">Spread: ${pct(((d.asks[0][0] - d.bids[0][0]) / d.bids[0][0]) * 100, 4, false)}</p>`;
        }
        if (tr) $('#trades', body).innerHTML = `<div class="book-row fine"><span>Price</span><span>Amount</span><span>Time</span></div>${tr.map((t) => `<div class="book-row"><span class="${t.buyerMaker ? 'down' : 'up'}">${money(t.price)}</span><span>${amount(t.qty)}</span><span class="muted">${new Date(t.time).toLocaleTimeString('en-US', { hour12: false })}</span></div>`).join('')}`;
      };
      drawBook();
      const iv = setInterval(drawBook, 3000);
      tabCleanup = () => clearInterval(iv);
      return;
    }

    if (st.tab === 'exchanges') {
      body.innerHTML = `<div id="exBody">${skeleton(8, 22)}</div>`;
      const drawEx = async () => {
        const r = await compareExchanges(coin.symbol);
        if (st.tab !== 'exchanges' || st.disposed) return;
        const rows = r.rows.filter((x) => x.ok).sort((a, b) => (b.vol || 0) - (a.vol || 0));
        $('#exBody', body).innerHTML = rows.length ? `
          ${r.gapPct !== null ? `<p style="margin-bottom:10px">Cheapest to buy: <b>${esc(r.bestBuy.exchange)}</b> at ${usd(r.bestBuy.ask)} · Best to sell: <b>${esc(r.bestSell.exchange)}</b> at ${usd(r.bestSell.bid)} · Gap <b class="${r.gapPct > 0 ? 'up' : 'flat'}">${pct(r.gapPct, 3)}</b> <span class="fine">(before fees & transfer time)</span></p>` : ''}
          <div class="tbl-wrap"><table class="tbl"><thead><tr><th class="l">Exchange</th><th class="l">Pair</th><th>Price</th><th>vs median</th><th>Spread</th><th>24h</th><th>Volume 24h</th></tr></thead><tbody>
          ${rows.map((q) => `<tr style="cursor:default"><td class="l"><b>${esc(q.exchange)}</b></td><td class="l muted">${esc(q.pair)}</td><td>${usd(q.price)}</td><td class="${q.deviationPct >= 0 ? 'up' : 'down'}">${pct(q.deviationPct, 3)}</td><td>${pct(q.spreadPct, 3, false)}</td><td>${changeHtml(q.change24h)}</td><td>${compact(q.vol)}</td></tr>`).join('')}
          </tbody></table></div>
          <p class="fine mt">${r.rows.filter((x) => !x.ok).map((x) => x.exchange).join(', ') || 'All exchanges responded'}${r.rows.some((x) => !x.ok) ? ': not listed or unavailable.' : '.'} <a class="acc" href="#/exchanges/${esc(coin.symbol)}">Open full comparison →</a></p>` : errorBox('No exchange returned a price for this coin.');
      };
      drawEx();
      const iv = setInterval(drawEx, 10000);
      tabCleanup = () => clearInterval(iv);
      return;
    }

    if (st.tab === 'about') {
      body.innerHTML = skeleton(4);
      getCoinProfile(coin).then((p) => {
        if (st.tab !== 'about' || st.disposed) return;
        body.innerHTML = `<div class="grid g2">
          <div><h3 style="margin-bottom:8px">About ${esc(coin.name)}</h3><p class="muted" style="line-height:1.6">${esc(p?.description || 'No description available.')}</p>
            <div class="row mt">${(p?.categories || []).map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>
            <div class="row mt">${p?.homepage ? `<a class="btn sm" target="_blank" rel="noopener" href="${esc(p.homepage)}">Website ↗</a>` : ''}${p?.explorer ? `<a class="btn sm" target="_blank" rel="noopener" href="${esc(p.explorer)}">Explorer ↗</a>` : ''}</div></div>
          <dl class="kv">
            <dt>Circulating supply</dt><dd>${compact(coin.circulatingSupply, '')} ${esc(coin.symbol)}</dd>
            <dt>Total supply</dt><dd>${p?.totalSupply ? compact(p.totalSupply, '') : '—'}</dd>
            <dt>Max supply</dt><dd>${p?.maxSupply ? compact(p.maxSupply, '') : '∞ / —'}</dd>
            <dt>Fully diluted value</dt><dd>${compact(p?.fdv)}</dd>
            <dt>All-time high</dt><dd>${usd(coin.ath)}${p?.athDate ? ` <span class="muted">${dateTime(p.athDate, false)}</span>` : ''}</dd>
            <dt>30-day change</dt><dd>${changeHtml(p?.change30d)}</dd>
            <dt>1-year change</dt><dd>${changeHtml(p?.change1y)}</dd>
            <dt>Launched</dt><dd>${p?.genesisDate || '—'}</dd>
          </dl></div>`;
      });
    }
  }

  // ------------------------------------------------------------ history & cycles
  // "When this coin's chart looked like it does today, what happened next?"
  // Runs on daily candles so it can reach back through previous bull and bear cycles.
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  async function getDaily() {
    if (st.daily) return st.daily;
    const r = await getCandles(coin, '1d', 2000);
    st.daily = r.candles;
    return st.daily;
  }

  async function computeHistory(horizon) {
    const key = `h${horizon}`;
    if (st.histCache?.[key]) return st.histCache[key];
    const daily = await getDaily();
    const h = await runHistory(daily, { window: 45, horizons: [7, 30, 90], horizon });
    st.histCache = { ...(st.histCache || {}), [key]: h };
    remember(coin.symbol, st.interval, { history: h });
    return h;
  }

  async function drawHistoryTab(body, horizon = st.histHorizon || 30) {
    st.histHorizon = horizon;
    destroyCharts();
    body.innerHTML = `<div class="row"><span class="spinner"></span> Searching ${esc(coin.symbol)}'s full daily history for moments that looked like today…</div>`;
    let h;
    try { h = await computeHistory(horizon); } catch (e) { body.innerHTML = errorBox(e.message); return; }
    if (st.disposed || st.tab !== 'history') return;

    const hzSeg = `<div class="seg" id="hzSeg">${[7, 30, 90].map((d) => `<button data-v="${d}" class="${d === horizon ? 'on' : ''}">${d} days ahead</button>`).join('')}</div>`;

    if (!h.ok) {
      body.innerHTML = `<div class="row spread" style="margin-bottom:10px"><h3>History &amp; cycles</h3>${hzSeg}</div>
        <p class="muted">${esc(h.reason || 'Not enough daily history for this coin yet.')}</p>
        ${h.season ? seasonBlock(h.season) : ''}`;
      bindSeg($('#hzSeg', body), (v) => drawHistoryTab(body, +v));
      return;
    }

    const v = h.verdict, s = h.analogs.stats[horizon], a = h.analogs;
    const dirClass = v.direction === 'UP' ? 'up' : v.direction === 'DOWN' ? 'down' : 'flat';
    const dirWord = v.direction === 'UP' ? 'Historically → UP' : v.direction === 'DOWN' ? 'Historically → DOWN' : 'Historically → MIXED';
    const reliable = v.accuracy !== null;
    const yrs = (h.years || []).filter((y) => y.points.length > 20);

    body.innerHTML = `
      <div class="row spread" style="margin-bottom:10px">
        <div><h3>What happened the last times ${esc(coin.symbol)} looked like this</h3>
        <p class="fine">Today's last <b>${h.window} days</b> compared against every 45-day window in ${esc(coin.symbol)}'s daily history (${dateTime(h.firstDate, false)} → today, ${h.days.toLocaleString()} days). Shape is compared, not price level, so a $300 chart and a $30,000 chart can match.</p></div>
        ${hzSeg}
      </div>

      ${h.weak ? `<div class="banner" style="margin:0 0 10px">${icon('info', 16)} Nothing in ${esc(coin.symbol)}'s history closely resembles today's chart — the best match below is only ${Math.round(h.analogs.matches[0].similarity * 100)}% similar. Read this section as background, not as a signal.</div>` : ''}
      <div class="hist-verdict">
        <div><div class="dir ${dirClass}">${dirWord}</div><div class="fine">${Math.round(v.probUp * 100)}% of similar cases rose over the next ${horizon} days</div></div>
        <div style="flex:1;min-width:200px">
          <div class="meter"><i style="width:${Math.round(v.probUp * 100)}%;background:var(--${v.probUp >= 0.5 ? 'up' : 'down'})"></i></div>
          <div class="row spread fine" style="margin-top:4px"><span>${s.upCount} up</span><span>${s.total - s.upCount} down</span></div>
        </div>
        <div class="grid g3" style="flex:2;min-width:260px">
          <div class="stat"><span class="k">Median move after</span><span class="v ${s.median >= 0 ? 'up' : 'down'}">${pct(s.median)}</span></div>
          <div class="stat"><span class="k">Best / worst case</span><span class="v" style="font-size:16px"><span class="${s.best >= 0 ? 'up' : 'down'}">${pct(s.best, 1)}</span> / <span class="${s.worst >= 0 ? 'up' : 'down'}">${pct(s.worst, 1)}</span></span></div>
          <div class="stat"><span class="k">Method accuracy here</span><span class="v ${reliable && v.accuracy >= 0.55 ? 'up' : reliable && v.accuracy < 0.5 ? 'down' : ''}">${reliable ? `${(v.accuracy * 100).toFixed(0)}%` : '—'}</span><span class="s fine">${h.validation?.tests || 0} past tests</span></div>
        </div>
      </div>

      <p class="mt">${esc(v.text)}</p>

      <h3 class="mt" style="margin-bottom:6px">Then vs now — and what came next</h3>
      <div id="analogChart"></div>
      <p class="fine">Every line is rebased to 100 at the moment the chart matched today's. Left of the divider is the matched shape; right of it is what actually happened afterwards. The thick line is today.</p>

      <div class="analog-list mt">
        ${a.matches.map((m, i) => `
          <div class="analog-row" style="border-left:3px solid ${i < 5 ? `var(${SERIES[i]})` : 'var(--border)'}">
            <div><div class="date">${dateTime(m.endTime, false)}</div><div class="fine">${dateTime(m.startTime, false)} → then</div></div>
            <div>
              <div class="simbar"><i style="width:${Math.round(m.similarity * 100)}%"></i></div>
              <div class="fine" style="margin-top:3px">${(m.similarity * 100).toFixed(0)}% similar shape · peaked ${pct(m.maxUpPct, 1)} / dipped ${pct(m.maxDownPct, 1)} within 90 days</div>
            </div>
            <div style="text-align:right">
              ${h.horizons.map((hz) => `<div class="fine">${hz}d: <b class="${m.outcomes[hz] >= 0 ? 'up' : 'down'}">${pct(m.outcomes[hz], 1)}</b></div>`).join('')}
            </div>
          </div>`).join('')}
      </div>

      ${yrs.length ? `
        <h3 class="mt" style="margin-bottom:6px">Year by year — is this year following an old script?</h3>
        <div id="yearChart"></div>
        <div class="row mt">${yrs.map((y) => `<span class="chip ${y.totalPct >= 0 ? 'up' : 'down'}">${y.year}: ${pct(y.totalPct, 0)}${y.year === new Date().getUTCFullYear() ? ' so far' : y.complete ? '' : ' (part year only)'}</span>`).join('')}</div>
        <p class="fine">Each line starts at 0% on 1 January. A year that crashed and then recovered shows exactly that shape — which is the point: it tells you what recovery from a drawdown has actually looked like for this coin.</p>` : ''}

      ${seasonBlock(h.season)}

      <div class="card mt" style="background:var(--surface-2)">
        <h3>How much to trust this</h3>
        <p class="fine">The same routine was replayed through ${esc(coin.symbol)}'s past: at ${h.validation?.tests || 0} earlier dates it found analogs using only the data available then, predicted the ${horizon}-day direction, and was scored against what really happened. It was right <b>${reliable ? `${(v.accuracy * 100).toFixed(0)}%` : '—'}</b> of the time${reliable && v.accuracy < 0.55 ? ' — barely better than a coin flip, so treat this as context, not a signal' : ''}. History rhymes; it does not repeat. Combine this with the live signal and the AI forecast rather than trading it alone.</p>
      </div>`;

    bindSeg($('#hzSeg', body), (val) => drawHistoryTab(body, +val));

    // analog overlay
    const W = h.window, maxH = Math.max(...h.horizons);
    const lc = new LineChart($('#analogChart', body), {
      height: 340, yFormat: (val) => val.toFixed(0),
      xFormat: (x) => { const k = Math.round(x) - (W - 1); return k === 0 ? 'match' : `${k > 0 ? '+' : ''}${k}d`; },
      tooltipX: (x) => { const k = Math.round(x) - (W - 1); return k === 0 ? 'The day the charts matched' : k < 0 ? `${-k} days before` : `${k} days after`; },
    });
    st.charts.push(lc);
    lc.set([
      ...a.matches.slice(0, 5).map((m, i) => ({
        name: `${dateTime(m.endTime, false)} (${(m.similarity * 100).toFixed(0)}%)`,
        color: cssVar(SERIES[i]), alpha: 0.8, width: 1.6,
        data: m.series.map((val, k) => ({ x: k, y: val })),
      })),
      { name: `Today · ${coin.symbol}`, color: cssVar('--text'), width: 3.2, data: a.current.map((val, k) => ({ x: k, y: val })) },
      { name: 'Average of matches', color: cssVar('--accent'), dash: true, width: 2.4, data: averagePath(a.matches, W + maxH) },
    ], { divider: W - 1, dividerLabel: 'today' });

    if (yrs.length) {
      const yc = new LineChart($('#yearChart', body), {
        height: 300, yFormat: (val) => `${val >= 0 ? '+' : ''}${val.toFixed(0)}%`,
        xFormat: (x) => MONTHS[Math.min(11, Math.max(0, Math.floor(x / 30.4)))],
        tooltipX: (x) => `Day ${Math.round(x)} · ${MONTHS[Math.min(11, Math.floor(x / 30.4))]}`,
        zeroLine: 0,
      });
      st.charts.push(yc);
      const thisYear = new Date().getUTCFullYear();
      yc.set(yrs.map((y, i) => ({
        name: `${y.year}${y.year === thisYear ? ' (now)' : ''}`,
        color: y.year === thisYear ? cssVar('--text') : cssVar(SERIES[i % SERIES.length]),
        width: y.year === thisYear ? 3 : 1.6,
        alpha: y.year === thisYear ? 1 : 0.8,
        data: y.points,
      })));
    }
  }

  function seasonBlock(season) {
    if (!season?.summary?.some((m) => m.count)) return '';
    const cur = season.currentMonth;
    return `
      <h3 class="mt" style="margin-bottom:6px">Seasonality — how ${esc(coin.symbol)} usually does each month</h3>
      <div class="season-grid">
        ${season.summary.map((m) => m.count ? `
          <div class="${m.month === cur ? 'now' : ''}" title="${m.count} years · ${m.winRate.toFixed(0)}% positive">
            <div class="m">${MONTHS[m.month]}</div>
            <div class="r ${m.avg >= 0 ? 'up' : 'down'}">${m.avg >= 0 ? '+' : ''}${m.avg.toFixed(0)}%</div>
            <div class="fine">${m.winRate.toFixed(0)}%↑</div>
          </div>` : `<div><div class="m">${MONTHS[m.month]}</div><div class="r muted">—</div></div>`).join('')}
      </div>
      <p class="fine mt">Average return per calendar month across every full month in this coin's history, with the share of years that finished positive. Highlighted box is the current month. Small samples — a handful of years is not a law of nature.</p>`;
  }

  function averagePath(matches, len) {
    const out = [];
    for (let k = 0; k < len; k++) {
      let sum = 0, n = 0;
      for (const m of matches) if (Number.isFinite(m.series[k])) { sum += m.series[k]; n++; }
      if (n) out.push({ x: k, y: sum / n });
    }
    return out;
  }

  bindTabs($('#tabs', el), (t) => { st.tab = t; drawTab(); });
  bindSeg($('#ivSeg', el), (iv) => {
    st.interval = iv; st.horizon = DEFAULT_HORIZON[iv] || 12;
    settings.set({ interval: iv });
    loadInterval().then(drawTab);
  });

  await loadInterval();
  drawTab();

  return () => {
    st.disposed = true;
    if (liveUnsub) liveUnsub();
    if (tabCleanup) tabCleanup();
    clearInterval(signalTimer);
    destroyCharts();
    chart.destroy();
    window.removeEventListener('cv:theme', onTheme);
  };
}

function shortTime(t, interval) {
  const d = new Date(t);
  if (['1d', '1w', '4h'].includes(interval)) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return d.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}
