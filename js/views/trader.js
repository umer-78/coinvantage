// The automatic AI trader, running on simulated money.
import { markets, getCandles, isStable, isTestedSource, findCoin, INTERVAL_MS } from '../api/market.js';
import { newState, replayAll, stats, equity, closeManual, recordRealTrade, DEFAULT_CONFIG, AUTOTRADER_TESTED, PAPER_NOTICE, DEMO_NOTICE, REAL_NOTICE, logCheck } from '../lib/autotrader.js';
import { reviewTrades, decideChanges, activeLessons, diagnose, MIN_TRADES } from '../lib/tradelearn.js';
import { learningPass } from '../lib/learnpass.js';
import { parseTradeCsv, matchFills } from '../lib/importer.js';
import { tradesCsv, downloadText, reportHtml } from '../lib/export.js';
import { LineChart } from '../charts/line.js';
import { $, $$, icon, toast, skeleton, coinLogo, modal, bindSeg } from '../ui.js';
import { esc, pct, money, compact, dateTime, ago, amount, price } from '../format.js';
import { fx } from '../api/fx.js';
import { load, save, remove } from '../store.js';
import { auth, backendEnabled } from '../api/backend.js';
import { backupFor, restoreBackup, missingTrades } from '../lib/cloudsync.js';
import { openAuth } from './auth.js';
import { initialSession, sessionReducer, sessionLabel, newLedger, learningStatus, accuracySparkline, sparklineSvg, LEARN_KEY, loadLedger, saveLedger, recordForecast, resolveDueLedger } from '../lib/selfimprove.js';
import { runForecast } from '../lib/compute.js';
import { DEFAULT_HORIZON } from '../ai/context.js';

export const title = 'Trading';

const CFG_KEY = 'traderCfg';
const STATE_KEY = 'traderState';
const RUN_KEY = 'traderRunning';
const SESSION_KEY = 'aiSession';
const AUTO_KEY = 'traderAutoStarted';
const LESSONS_KEY = 'traderLessons';   // the self-review's changelog
const AUTOLEARN_KEY = 'traderAutoLearn';

export async function render(el) {
  // prices: newest known price per coin. priceFrom says where it came from
  // (a live tick, or the latest candle when no tick has arrived yet).
  const st = { disposed: false, charts: [], prices: {}, priceFrom: {}, running: false };
  // Formal session machine: idle → running → stopped → running, RESET from any
  // state. autoOn mirrors status === 'running' so the periodic catch-up timer
  // and RUN_KEY keep working exactly as before.
  let session = load(SESSION_KEY, null);
  if (!session || !['idle', 'running', 'stopped'].includes(session.status)) {
    const hasState = !!load(STATE_KEY, null);
    session = initialSession(hasState && load(RUN_KEY, false) === true ? 'running' : hasState ? 'stopped' : 'idle');
    save(SESSION_KEY, session);
  }
  let autoOn = session.status === 'running';
  // Saved settings used to include the strategy's own numbers (stop, target…),
  // so a strategy update never reached anyone who had once pressed Save. Only
  // the user's own choices — and, from v2, what the self-review learned — carry over.
  const savedCfg = load(CFG_KEY, {}) || {};
  const USER_KEYS = ['startingBalance', 'riskPct', 'maxPositions', 'interval', 'universe'];
  const LEARNED_KEYS = ['minAdx', 'maxEntryRsi', 'excluded', 'trendFilter'];
  const cfg = { ...DEFAULT_CONFIG, ...Object.fromEntries(Object.entries(savedCfg).filter(([k]) => USER_KEYS.includes(k) || (savedCfg.v === 2 && LEARNED_KEYS.includes(k)))), v: 2 };
  // Risk per trade above 5% is a setting that wipes an account out in a short
  // losing run; older saves allowed 10.
  cfg.riskPct = Math.min(5, Math.max(0.1, +cfg.riskPct || DEFAULT_CONFIG.riskPct));
  let state = load(STATE_KEY, null);

  const applySession = (event) => {
    const next = sessionReducer(session, event);
    if (next !== session) {
      session = next;
      autoOn = next.status === 'running';
      save(SESSION_KEY, session);
      save(RUN_KEY, autoOn);
    }
    syncSessionChip();
    syncRunButtons();
  };

  function syncSessionChip() {
    const chip = $('#sessionChip', el);
    if (!chip) return;
    chip.className = `session-chip ${session.status}`;
    chip.innerHTML = `<i></i>${sessionLabel(session.status)}`;
  }

  const all = await markets().catch(() => []);
  // The best real price this page has for a coin: a live tick, the latest
  // candle, or the market list (refreshed every minute). Never the entry price:
  // Sell and Close used to fall back to it before the first tick arrived, or
  // for a coin with no live stream, and recorded a 0% trade that never happened.
  const priceOf = (sym) => {
    if (Number.isFinite(st.prices[sym])) return st.prices[sym];
    const c = all.find((x) => x.symbol === sym && x.source !== 'demo');
    return Number.isFinite(c?.price) && c.price > 0 ? c.price : null;
  };
  // A fresh exchange price for one coin, from its latest 1-minute candle, for
  // when the live stream is blocked or has not delivered this coin yet.
  async function fetchPrice(sym) {
    const coin = all.find((c) => c.symbol === sym);
    if (!coin) return null;
    try {
      const r = await getCandles(coin, '1m', 3);
      const px = r.candles.at(-1)?.c;
      if (!isTestedSource(r) || !Number.isFinite(px)) return null;
      if (st.priceFrom[sym] !== 'live') { st.prices[sym] = px; st.priceFrom[sym] = 'candle'; }
      return px;
    } catch { return null; }
  }
  // Prices to mark every account with: the list prices, overridden by live ones.
  const marks = () => {
    const m = {};
    for (const c of all) if (c.source !== 'demo' && Number.isFinite(c.price)) m[c.symbol] = c.price;
    return { ...m, ...st.prices };
  };
  const tradable = all.filter((c) => !isStable(c.symbol)).slice(0, 60);

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Trading</h1>
        <p>Three accounts, side by side: the demo trades you place yourself, the trades you really made, and the AI running the strategy on its own. Only the real account involves real money — CoinVantage never places an order and holds no keys.</p>
        <p class="fine" id="syncNote">${syncNote()}</p></div>
      <div class="row">
        <span class="session-chip ${session.status}" id="sessionChip"><i></i>${sessionLabel(session.status)}</span>
        <button class="btn" id="cfgBtn">${icon('chip', 16)} Settings</button>
        <button class="btn ghost" id="resetBtn"${state ? '' : ' hidden'}>Reset</button>
        <button class="btn ghost" id="stopBtn" hidden>${icon('close', 16)} Stop the AI</button>
        <button class="btn primary" id="startBtn">${state ? icon('refresh', 16) + ' Catch up now' : icon('bolt', 16) + ' Start the trader'}</button>
      </div>
    </div>
    <div id="body">${state ? skeleton(6, 26) : startCard()}</div>`;

  // The measured result, stated before anyone starts it. This ruleset was run
  // over 12 coins and 4,000 candles each at 108 different settings, tuned on the
  // first half of history and scored on the second — and on the half it had
  // never seen it did not beat simply owning the coins, on any timeframe. A
  // feature that cannot beat buying and holding should say so on its own page.
  function verdictCard() {
    const iv = state?.interval || cfg.interval;
    const t = AUTOTRADER_TESTED[iv];
    const TFS = ['15m', '1h', '4h', '1d'];
    // Showing one timeframe's numbers under another label would present a test
    // that was never run.
    if (!t) {
      return `<div class="card" style="border-color:var(--warn)">
      <div class="card-h"><h3>${icon('info', 16)} Not tested on the ${esc(iv)} chart</h3></div>
      <p class="fine">This strategy was measured on ${TFS.join(', ')} charts. Pick one of those in Settings to see its measured result.</p>
    </div>`;
    }
    const sign = (v) => `${v >= 0 ? '+' : ''}${v}%`;
    const beat = t.pickedReturn > t.buyHold;
    return `<div class="card" style="border-color:var(--warn)">
      <div class="card-h"><h3>${icon('info', 16)} What this strategy actually did when it was tested</h3><span class="fine">measured ${esc(AUTOTRADER_TESTED.measuredOn || '')}, not estimated</span></div>
      <p>Run candle by candle over ${AUTOTRADER_TESTED.coins} coins, with settings chosen on the first half of history and scored on the second half it had never seen, the ${esc(iv)} version returned <b class="${t.pickedReturn >= 0 ? 'up' : 'down'}">${sign(t.pickedReturn)}</b> with a worst drawdown of ${t.maxDrawdownPct}% — while buying the same coins and holding them returned <b class="${t.buyHold >= 0 ? 'up' : 'down'}">${sign(t.buyHold)}</b> over the identical window. ${beat ? 'On this timeframe it did better than holding.' : 'On this timeframe holding did better.'}</p>
      <div class="tbl-wrap mt"><table class="tbl"><thead><tr><th class="l">Chart</th><th>Tested on</th><th>These rules</th><th>Worst drawdown</th><th>Best alternative</th><th>Buy &amp; hold</th><th>Trades</th></tr></thead><tbody>
        ${TFS.map((k) => { const x = AUTOTRADER_TESTED[k]; return `<tr${k === iv ? ' style="font-weight:600"' : ''}><td class="l">${k}</td><td class="fine">${esc(x.from)} → ${esc(x.to)}</td><td class="${x.pickedReturn >= 0 ? 'up' : 'down'}">${sign(x.pickedReturn)}</td><td class="down">−${x.maxDrawdownPct}%</td><td class="${x.alt.ret >= 0 ? 'up' : 'down'}">${sign(x.alt.ret)} <small class="fine">(−${x.alt.dd}%)</small></td><td class="${x.buyHold >= 0 ? 'up' : 'down'}">${sign(x.buyHold)}</td><td>${x.trades}</td></tr>`; }).join('')}
      </tbody></table></div>
      <p class="fine mt">Current rules: buy when the score clears +${DEFAULT_CONFIG.entryScore} in an uptrend (price above its 200-bar average and the 50-bar above the 200-bar), stop ${DEFAULT_CONFIG.atrStop} ATR below entry, target ${DEFAULT_CONFIG.rMultiple}× the risk, and sell after ${DEFAULT_CONFIG.signalExitBars} candles of reversal. ${AUTOTRADER_TESTED.configs} other rule sets were tried — breakouts, buying dips, momentum confirmation, pausing while Bitcoin falls, other stops and exits. The best of them on the older data (${esc(AUTOTRADER_TESTED.altRules)}) did no better on the newer data, so these rules stay. On ${esc(iv)}, fees came to ${t.feeDragPct}% of the balance across ${t.trades} trades, and ${t.winRate}% of trades won.${iv === '15m' ? ` On 15m only ${t.madeMoney} of the ${AUTOTRADER_TESTED.configs} rule sets made money after fees — this chart is the hardest to profit from.` : ''}</p>
      <p class="fine">So this account is a demonstration of a strategy, run honestly on live prices with fees counted, including the losing stretches. It is not a promise of profit. It places no real orders and holds no keys.</p>
    </div>`;
  }

  // Self-improvement status: rolling hit-rate windows over forecasts this
  // device recorded and later resolved. Purely local — nothing is invented.
  function learningCard() {
    const ledger = loadLedger();
    const ls = learningStatus(ledger);
    const spark = accuracySparkline(ledger, 50);
    const trendText = {
      'improving': 'recent window above the longer one',
      'stable': 'holding steady',
      'declining': 'recent window below the longer one',
      'warming-up': 'needs at least 10 resolved forecasts',
      'unknown': 'not enough resolved forecasts yet',
    }[ls.trend] || ls.trend;
    const trendCls = ls.trend === 'improving' ? 'up' : ls.trend === 'declining' ? 'down' : 'flat';
    const win = (w) => {
      const r = ls.windows[w];
      if (r.pct === null) return `<span class="muted">—</span>`;
      const cls = r.pct >= 55 ? 'up' : r.pct < 45 ? 'down' : '';
      return `<b class="${cls}">${r.pct}%</b> <span class="fine">(${r.hits}/${r.total})</span>`;
    };
    return `<div class="card mt" id="learnCard">
      <div class="card-h"><h3>${icon('ai', 16)} Self-improving model</h3><span class="chip ${trendCls}">${esc(ls.trend.replace('-', ' '))}</span></div>
      <p class="fine">Every forecast this device shows is logged before the outcome is known, then scored when its horizon passes. Rolling windows below are hit rates over the last N resolved forecasts on <b>this device only</b> — not a claim about future performance.</p>
      <div class="grid g4 mt">
        <div class="stat"><span class="k">Last 20</span><span class="v">${win(20)}</span></div>
        <div class="stat"><span class="k">Last 50</span><span class="v">${win(50)}</span></div>
        <div class="stat"><span class="k">Last 100</span><span class="v">${win(100)}</span></div>
        <div class="stat"><span class="k">Trend</span><span class="v ${trendCls}" style="font-size:16px">${esc(ls.trend.replace('-', ' '))}</span><span class="s fine">${esc(trendText)}</span></div>
      </div>
      ${spark.length > 1 ? `<div class="mt"><div class="fine" style="margin-bottom:4px">Hit rate over the last ${spark.length} resolved forecasts (rolling 20)</div>${sparklineSvg(spark, { width: 240, height: 36, color: 'var(--accent)' })}</div>` : ''}
      <p class="fine mt">Model v${ls.modelVersion} · ${ls.total} forecast${ls.total === 1 ? '' : 's'} recorded · ${ls.resolved} resolved · ${ls.pending} still waiting for their horizon.</p>
      <div class="mt">
        <div class="fine">Once 15 forecasts have resolved, a hit rate below 55% over the last 50 (or the last 20, if fewer have resolved) pulls the displayed confidence a quarter of the way toward 50/50, and halfway if the hit rate is below 40%. This is purely local measurement; no external validation is performed.</div>
      </div>
    </div>`;
  }

  // Tells people where their trades are kept, on the page where they look for them.
  function syncNote() {
    if (auth.user) return 'Saved to your account: every device you sign in on shows these same trades.';
    if (backendEnabled()) return 'Saved in this browser only. <a href="#" id="syncSignIn">Sign in</a> to see the same trades on every device.';
    return 'Saved in this browser only.';
  }

  // Trades this device had that the account did not, set aside when another
  // device's copy was saved first (see lib/cloudsync.js).
  function backupCard() {
    const b = auth.user ? backupFor(load, auth.user.id) : null;
    if (!b) return '';
    const NAMES = { myDemoState: 'your demo account', realTradeState: 'your real account' };
    const parts = Object.entries(b.keys).map(([k, v]) => [k, missingTrades(v, load(k, null)).length]).filter(([, n]) => n)
      .map(([k, n]) => `${n} trade${n === 1 ? '' : 's'} in ${NAMES[k]}`);
    if (!parts.length) return '';
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
    return `<div class="card" id="backupCard" style="border-color:var(--warn)">
      <div class="card-h"><h3>${icon('info', 16)} Trades from this device were set aside</h3><span class="fine">${dateTime(b.at, false)}</span></div>
      <p class="fine">Another device saved a different copy of your trades before this one could. The saved copy is the one shown here and on your other devices. This device's copy has ${esc(list)} that the saved copy does not.</p>
      <p class="fine">Use this device's copy to replace the saved one everywhere, or keep the saved copy and drop this one.</p>
      <div class="row mt" style="gap:8px"><button class="btn sm" id="bkUse">Use this device's copy</button><button class="btn sm ghost" id="bkDrop">Keep the saved copy</button></div>
    </div>`;
  }

  function wireBackup() {
    $('#bkUse', el)?.addEventListener('click', () => {
      if (!auth.user) return;
      restoreBackup({ load, save, remove }, auth.user.id);
      toast("This device's copy is now the saved copy on every device.", 'up');
      window.dispatchEvent(new HashChangeEvent('hashchange'));   // redraw from the restored accounts
    });
    $('#bkDrop', el)?.addEventListener('click', () => { remove('syncBackup'); draw(); });
  }

  function startCard() {
    return `<div class="card empty">
      <h3>Run the strategy on simulated money</h3>
      <p style="max-width:620px">It watches ${cfg.universe.length} coins on the ${esc(cfg.interval)} chart. ${entryRule(cfg)} It sizes each position so a stop-out costs at most ${cfg.riskPct}% of the balance, with no more than ${cfg.maxPositionPct}% of it in one coin and never more cash than the account has, and sells at ${cfg.trailAtr ? `a stop that trails ${cfg.trailAtr} ATR under the highest price since it bought` : `the target (${cfg.rMultiple}R)`}, the stop (${cfg.atrStop} ATR)${cfg.signalExitBars ? ` or ${cfg.entryMode === 'pullback' ? 'once the bounce has come' : 'a signal reversal'}` : ''}. Every trade is logged with the fee it would have paid.</p>
      <p class="fine" style="max-width:620px">Starting balance ${money(cfg.startingBalance)}. Read the tested result above before you start it — it did not beat buying and holding. You can stop it at any time without resetting the account.</p>
    </div>${learningCard()}`;
  }

  // The rule that opens a trade, in words, for whichever entry mode is set.
  function entryRule(c) {
    const extra = `${c.momentumConfirm ? ' while the short-term trend and momentum also point up' : ''}${c.marketFilter ? ', and only while Bitcoin itself is in an uptrend' : ''}`;
    if (c.entryMode === 'pullback') return `When a coin in an uptrend dips until the score falls to −${c.entryScore} or lower, it buys the dip${extra}.`;
    if (c.entryMode === 'breakout') return `When a coin closes above its highest price of the previous 20 candles${c.trendFilter ? ' in an uptrend' : ''}, it buys${extra}.`;
    return `When the score clears +${c.entryScore}${c.trendFilter ? ' in an uptrend' : ''} it buys${extra}.`;
  }

  // ---------------------------------------------------------------- engine
  async function catchUp() {
    if (st.running) return;
    st.running = true;
    const btn = $('#startBtn', el);
    const old = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Working…';
    if (!state) state = newState(cfg);
    // Replaying daily candles into an account that was started on hourly ones
    // would mix two strategies in one balance, so the account keeps its own
    // timeframe. Older saved accounts adopt the current setting once.
    if (!state.interval) state.interval = cfg.interval;
    const runCfg = { ...cfg, interval: state.interval };

    let processed = 0;
    const failed = [], noExchange = [];
    const forecastInputs = [];
    const scores = [];
    const tradesBefore = state.closed.length;
    const openKeysBefore = new Set(Object.values(state.open).map((p) => `${p.symbol}:${p.openedAt}`));
    // A coin taken off the list while a position in it was open used to be
    // skipped for good, leaving that position with no stop or target. It is
    // still checked now, for its exits only.
    const held = Object.keys(state.open).filter((sym) => !cfg.universe.includes(sym));
    const bySymbol = {};
    for (const sym of [...cfg.universe, ...held]) {
      if (st.disposed) return;
      const coin = all.find((c) => c.symbol === sym);
      if (!coin) { failed.push(sym); continue; }
      try {
        const r = await getCandles(coin, runCfg.interval, 500);
        // Demo candles are invented: never trade on them or price a position with them.
        if (r.source === 'demo') { failed.push(sym); continue; }
        // Open positions used to be marked at their ENTRY price until a live
        // tick arrived, so every one showed +$0.00 (0.00%). The newest candle's
        // close is a real, recent price — use it until a tick replaces it.
        const lastPx = r.candles[r.candles.length - 1]?.c;
        if (Number.isFinite(lastPx) && st.priceFrom[sym] !== 'live') { st.prices[sym] = lastPx; st.priceFrom[sym] = 'candle'; }
        // Only coins with real exchange candles are traded. One without them
        // gets sparse price samples from CoinGecko (FIGR_HELOC, a tokenised
        // home loan, was traded that way: 12 trades, nearly all losses), so it
        // is skipped and a position already open in it is closed at that price.
        if (r.source === 'coingecko' || r.lowRes) {
          noExchange.push(sym);
          if (state.open[sym] && Number.isFinite(lastPx)) closeManual(state, runCfg, sym, lastPx, Date.now(), 'no exchange price');
          continue;
        }
        // only fully closed candles drive decisions
        const candles = r.candles.slice(0, -1);
        bySymbol[sym] = candles;
        forecastInputs.push({ sym, candles });
      } catch { failed.push(sym); }
    }
    if (st.disposed) return;
    // Every coin advances together, candle by candle, as in the published test.
    const results = replayAll(state, { ...runCfg, excluded: [...(runCfg.excluded || []), ...held] }, bySymbol);
    for (const [sym, res] of Object.entries(results)) {
      processed += res.processed;
      if (Number.isFinite(res.lastScore)) scores.push({ sym, score: res.lastScore });
    }
    // The page was closed or redrawn (a sync brought newer trades) while the last
    // coin loaded: saving now would put this older copy back over them. Nothing
    // is lost, since the next check replays the same candles.
    if (st.disposed) return;
    // One line per check in the activity feed, with the real time of the check.
    const best = scores.sort((a, b) => b.score - a.score)[0];
    logCheck(state, {
      kind: 'check', coins: cfg.universe.length - failed.length, candles: processed,
      opened: [...Object.values(state.open), ...state.closed.slice(tradesBefore)].filter((p) => !openKeysBefore.has(`${p.symbol}:${p.openedAt}`)).length,
      closed: state.closed.length - tradesBefore,
      best: best ? { sym: best.sym, score: Math.round(best.score) } : null, bar: runCfg.entryScore,
    });
    selfReview({ auto: true });
    save(STATE_KEY, state);
    st.lastRun = Date.now();
    st.running = false;
    if (st.disposed) return;
    btn.disabled = false;
    btn.innerHTML = old;
    if (failed.length) toast(`No data for ${failed.join(', ')} — skipped.`, 'info');
    // once per visit: it would otherwise repeat on every five-minute check
    if (noExchange.length && !st.warnedNoExchange) st.warnedNoExchange = true, toast(`${noExchange.join(', ')} ${noExchange.length > 1 ? 'have' : 'has'} no exchange candles, so the AI does not trade ${noExchange.length > 1 ? 'them' : 'it'}. Take ${noExchange.length > 1 ? 'them' : 'it'} off its list in Settings.`, 'info');
    draw();
    if (processed) toast(`Checked ${processed.toLocaleString('en-US')} new candle${processed === 1 ? '' : 's'}.`, 'up');
    learnFrom(forecastInputs, runCfg.interval);
    // The AI learning center grades every indicator and the forecast on the same
    // candles, so the system keeps learning whenever the trader is open.
    learningPass(runCfg.interval, { candlesBySymbol: Object.fromEntries(forecastInputs.map((x) => [x.sym, x.candles])) }).catch(() => {});
  }

  // Self-improvement: score the forecasts whose horizon has passed, then log a
  // fresh one per watched coin before its outcome is known. Runs in the worker
  // after the account is drawn, so the page never waits on it.
  async function learnFrom(inputs, interval) {
    if (st.learning || !inputs.length) return;
    st.learning = true;
    try {
      let ledger = loadLedger();
      for (const { sym, candles } of inputs) {
        if (st.disposed) return;
        ledger = resolveDueLedger(ledger, candles, { symbol: sym, interval });
        const fc = await runForecast(candles, { horizon: DEFAULT_HORIZON[interval] || 12, intervalMs: INTERVAL_MS[interval] }).catch(() => null);
        if (fc?.ok && Number.isFinite(fc.probUp) && fc.path?.length) {
          ledger = recordForecast(ledger, {
            symbol: sym, interval, price: fc.lastPrice, probUp: fc.probUp,
            horizonBars: fc.horizon, horizonAt: fc.path[fc.path.length - 1]?.t,
          });
        }
      }
      saveLedger(ledger);
      if (!st.disposed && $('#learnCard', el)) $('#learnCard', el).outerHTML = learningCard();
    } finally { st.learning = false; }
  }

  // What the AI did, newest first: every entry and exit it made, with the
  // reading that triggered it. Built from the account itself, so it is always
  // in step with the trade log.
  function activityCard() {
    // Times are when the AI actually decided: at the CLOSE of the candle it
    // read (the old feed printed the candle's opening time, an interval early).
    // Anything before the account went live was replayed from past candles and
    // is labelled so, instead of reading as if the AI did it live.
    const step = INTERVAL_MS[state.interval] || 0;
    const liveSince = state.startedAt;
    const ev = [];
    for (const p of Object.values(state.open)) ev.push({ t: p.openedAt + step, sym: p.symbol, kind: 'buy', p });
    for (const p of state.closed) {
      ev.push({ t: p.openedAt + step, sym: p.symbol, kind: 'buy', p });
      ev.push({ t: p.exitAt + step, sym: p.symbol, kind: 'sell', p });
    }
    for (const c of state.log || []) ev.push({ t: c.t, kind: c.kind, c });
    ev.sort((a, b) => b.t - a.t);
    const why = { target: 'hit its target', 'stop-loss': 'hit its stop-loss', 'trailing stop': 'hit its trailing stop', 'break-even stop': 'came back to its entry after the stop was raised there', 'signal reversal': 'the signal turned against it', 'sold into strength': 'the bounce it bought for had arrived', 'no exchange price': 'no exchange trades this coin, so the AI stopped trading it' };
    const line = (e) => {
      if (e.kind === 'check') {
        const c = e.c;
        const did = c.opened || c.closed ? `${c.opened ? `opened ${c.opened}` : ''}${c.opened && c.closed ? ', ' : ''}${c.closed ? `closed ${c.closed}` : ''}` : 'no trade';
        return `<b>Checked ${c.coins} coin${c.coins === 1 ? '' : 's'}</b> — ${c.candles.toLocaleString('en-US')} new closed candle${c.candles === 1 ? '' : 's'}, ${did}${c.best ? ` · highest score ${esc(c.best.sym)} ${c.best.score > 0 ? '+' : ''}${c.best.score} (buys at +${c.bar})` : ''}`;
      }
      if (e.kind === 'review') return `<b>Self-review</b> — ${esc(e.c.text)}`;
      if (e.kind === 'buy') {
        const bar = e.p.entryBar;
        return `<b>Bought ${esc(e.sym)}</b> at ${money(e.p.entry)}${Number.isFinite(e.p.openScore) ? ` — score ${e.p.openScore > 0 ? '+' : ''}${Math.round(e.p.openScore)}${Number.isFinite(bar) ? ` cleared the +${bar} entry bar` : ''}` : ''}`;
      }
      return `<b>Sold ${esc(e.sym)}</b> at ${money(e.p.exit)} — ${esc(why[e.p.reason] || e.p.reason)} · <span class="${e.p.pnl >= 0 ? 'up' : 'down'}">${e.p.pnl >= 0 ? '+' : '−'}${money(Math.abs(e.p.pnl))} (${pct(e.p.pnlPct)})</span>`;
    };
    const replayed = ev.filter((e) => e.kind !== 'check' && e.kind !== 'review' && e.t < liveSince).length;
    return `<div class="card mt">
      <div class="card-h"><h3>${icon('ai', 16)} AI activity</h3><span class="fine">${autoOn ? 'running · checks every 5 minutes' : session.status === 'stopped' ? 'stopped · press Resume to continue' : 'idle'}${st.lastRun ? ` · last check ${ago(st.lastRun)}` : ''}</span></div>
      ${replayed ? `<p class="fine" style="margin-top:0">Entries marked <span class="chip">replayed</span> happened on candles from before this account went live on ${dateTime(liveSince)} — the same rules run over past prices so the record does not start empty. Everything after that was decided live.</p>` : ''}
      ${ev.length ? `<ul class="fine" style="list-style:none;padding:0;margin:0">${ev.slice(0, 30).map((e) => `<li style="padding:6px 0;border-bottom:1px solid var(--border)"><span class="muted" style="display:inline-block;min-width:150px">${dateTime(e.t)}</span>${e.kind !== 'check' && e.kind !== 'review' && e.t < liveSince ? '<span class="chip" style="margin-right:6px">replayed</span>' : ''}${line(e)}</li>`).join('')}</ul>`
        : `<p class="muted">${autoOn ? 'No trades yet — the AI is watching for a setup that meets its rules.' : `No trades yet. The AI is ${session.status === 'stopped' ? 'stopped' : 'not running'}, so it is not looking for setups — press ${session.status === 'stopped' ? 'Resume the AI' : 'Start the trader'} to let it trade.`}</p>`}
    </div>`;
  }

  // ---------------------------------------------------------------- self-review
  // The trader reads its own trade log, finds conditions that keep losing and
  // switches on the filter that avoids them (or off, if a filter made things
  // worse). Runs by itself after every check; the button runs it on demand.
  function selfReview({ auto = false } = {}) {
    if (!state) return null;
    const review = reviewTrades(state.closed);
    if (auto && load(AUTOLEARN_KEY, true) === false) return { review, changes: [] };
    const lessons = load(LESSONS_KEY, []);
    const { cfgPatch, changes } = decideChanges(review, cfg, lessons, state.closed);
    if (changes.length) {
      Object.assign(cfg, cfgPatch);
      save(CFG_KEY, cfg);
      const now = Date.now();
      for (const c of changes) {
        lessons.push({ at: now, lens: c.lens || null, undo: !!c.undo, text: c.text });
        if (c.undo) for (const h of lessons) if (h.lens === c.lens && !h.undo && h.at < now) h.undone = true;
        logCheck(state, { kind: 'review', text: c.text });
      }
      save(LESSONS_KEY, lessons.slice(-50));
      save(STATE_KEY, state);
      if (!auto) toast(`Self-review changed ${changes.length} rule${changes.length > 1 ? 's' : ''}.`, 'up');
    }
    return { review, changes };
  }

  function reviewCard() {
    if (!state) return '';
    const review = reviewTrades(state.closed);
    const lessons = load(LESSONS_KEY, []);
    const active = activeLessons(cfg);
    const autoLearn = load(AUTOLEARN_KEY, true) !== false;
    const o = review.overall;
    return `<div class="card mt" id="reviewCard">
      <div class="card-h"><h3>${icon('ai', 16)} Self-review of the trade log</h3>
        <div class="row" style="gap:8px"><label class="fine" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="autoLearn" ${autoLearn ? 'checked' : ''}> learn by itself</label>
        <button class="btn sm" id="reviewNow">${icon('refresh', 14)} Review my trades now</button></div></div>
      <p class="fine" style="margin-top:0">After every check the AI reads its own closed trades, groups them by what the market looked like when it bought, and switches on a filter when one condition keeps losing — or back off if a filter made results worse. It needs ${MIN_TRADES} closed trades before it changes anything, and every change is listed below with the numbers behind it.</p>
      <div class="grid g4 mt">
        <div class="stat"><span class="k">Trades read</span><span class="v">${o.n}</span></div>
        <div class="stat"><span class="k">Won</span><span class="v">${o.winRate === null ? '—' : `${o.winRate}%`}</span></div>
        <div class="stat"><span class="k">Average result</span><span class="v ${o.avgR > 0 ? 'up' : o.avgR < 0 ? 'down' : ''}">${o.avgR === null ? '—' : `${o.avgR > 0 ? '+' : ''}${o.avgR}R`}</span><span class="s fine">R = the amount risked per trade</span></div>
        <div class="stat"><span class="k">Rules it changed</span><span class="v">${lessons.filter((l) => !l.undo && !l.undone).length}</span></div>
      </div>
      ${review.findings.length ? `<ul class="reasons mt">${review.findings.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
      ${(() => { const d = diagnose(state.closed, { startingBalance: state.startingBalance }); return d.length ? `<div class="mt"><div class="fine" style="margin-bottom:4px"><b>What drove the result</b></div><ul class="reasons">${d.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''; })()}
      <p class="fine mt"><b>Rules in force now:</b> ${active.length ? esc(active.join(' · ')) : 'none yet — the original strategy'}.</p>
      ${lessons.length ? `<div class="mt"><div class="fine" style="margin-bottom:4px"><b>What it changed, and when</b></div><ul class="fine" style="list-style:none;padding:0;margin:0">${[...lessons].reverse().slice(0, 12).map((l) => `<li style="padding:4px 0;border-bottom:1px solid var(--border)"><span class="muted" style="display:inline-block;min-width:150px">${dateTime(l.at)}</span>${esc(l.text)}${l.undone ? ' <span class="chip">later undone</span>' : ''}</li>`).join('')}</ul></div>` : ''}
    </div>`;
  }

  function wireReview() {
    $('#reviewNow', el)?.addEventListener('click', () => {
      const r = selfReview({ auto: false });
      if (r && !r.changes.length) toast(r.review.overall.n < MIN_TRADES ? `Read ${r.review.overall.n} trades — needs ${MIN_TRADES} before it changes anything.` : 'Read the log — nothing clear enough to change yet.', 'info');
      draw();
    });
    $('#autoLearn', el)?.addEventListener('change', (e) => { save(AUTOLEARN_KEY, e.target.checked); toast(e.target.checked ? 'The AI will adjust its rules by itself after each check.' : 'Self-adjusting is off — use the button to review on demand.', 'info'); });
  }

  // ---------------------------------------------------------------- view
  // --- the real account -------------------------------------------------
  // Trades actually placed on an exchange, typed in here. CoinVantage records
  // them; it never places one. Same statistics as the simulated accounts so the
  // three can be compared honestly.
  const REAL_KEY = 'realTradeState';
  const realState = () => load(REAL_KEY, null);

  function realCard() {
    const rs = realState();
    const has = rs && (Object.keys(rs.open).length || rs.closed.length);
    const s3 = has ? stats(rs, marks()) : null;
    const open = has ? Object.entries(rs.open) : [];
    const closed = has ? [...rs.closed].reverse().slice(0, 25) : [];
    return `<div class="card mt">
      <div class="card-h"><h3>Real account</h3><div class="row" style="gap:8px"><span class="chip up">Your own money</span>${has ? '<button class="btn sm ghost" id="realReset">Reset</button>' : ''}</div></div>
      <p class="fine">Record the trades you actually placed on an exchange, and they are measured the same way as the accounts above. ${esc(REAL_NOTICE)}</p>

      <div class="row mt" style="gap:10px;align-items:center;flex-wrap:wrap">
        <label class="btn sm" style="cursor:pointer">${icon('exchanges', 14)} Import from Binance
          <input type="file" id="csvIn" accept=".csv,.tsv,.txt" hidden>
        </label>
        <span class="fine">Binance → Orders → Trade History → Export. The file is read in your browser; nothing is uploaded.</span>
      </div>
      ${has ? `<div class="row mt" style="gap:8px;flex-wrap:wrap">
        <button class="btn sm ghost" data-export="real-csv">Download trades (CSV)</button>
        <button class="btn sm ghost" data-report="real">Printable report</button>
      </div>` : ''}
      <p class="fine" id="csvMsg" hidden></p>

      <form id="rf" class="row mt" style="gap:8px;align-items:flex-end;flex-wrap:wrap">
        <label class="fld">Coin<select class="inp" name="sym">${tradable.slice(0, 60).map((c) => `<option value="${esc(c.symbol)}">${esc(c.symbol)}</option>`).join('')}</select></label>
        <label class="fld">Side<select class="inp" name="side"><option value="long">Bought</option><option value="short">Sold short</option></select></label>
        <label class="fld">Amount<input class="inp" name="qty" type="number" step="any" min="0" placeholder="0.05" style="width:100px" required></label>
        <label class="fld">Price in (${esc(fx.code)})<input class="inp" name="entry" type="number" step="any" min="0" placeholder="${esc(price(60000 * fx.rate))}" style="width:130px" required></label>
        <label class="fld">Price out (${esc(fx.code)})<input class="inp" name="exit" type="number" step="any" min="0" placeholder="still open" style="width:130px"></label>
        <label class="fld">Fee (${esc(fx.code)})<input class="inp" name="fee" type="number" step="any" min="0" placeholder="0" style="width:100px"></label>
        <button class="btn primary">Record trade</button>
      </form>
      <p class="fine down" id="rfErr" hidden></p>

      ${s3 ? `<div class="grid g4 mt">
        <div class="stat"><span class="k">Realised result</span><span class="v ${s3.returnPct >= 0 ? 'up' : 'down'}">${pct(s3.returnPct)}</span><span class="s fine">${money(s3.equity - s3.startingBalance)} on a ${money(s3.startingBalance)} basis</span></div>
        <div class="stat"><span class="k">Win rate</span><span class="v">${s3.winRate === null ? '—' : `${s3.winRate}%`}</span><span class="s fine">${s3.wins}W / ${s3.losses}L${s3.profitFactor ? ` · PF ${s3.profitFactor}` : ''}</span></div>
        <div class="stat"><span class="k">Max drawdown</span><span class="v ${s3.maxDrawdownPct > 0 ? 'down' : 'flat'}">${pct(-s3.maxDrawdownPct, 1)}</span></div>
        <div class="stat"><span class="k">Trades</span><span class="v">${s3.trades}</span><span class="s fine">${s3.openCount} open</span></div>
      </div>` : ''}

      ${open.length ? `<div class="tbl-wrap mt"><table class="tbl"><thead><tr><th class="l">Coin</th><th>Side</th><th>In at</th><th>Now</th><th>Size</th><th>Open P&amp;L</th><th></th></tr></thead><tbody>
        ${open.map(([sym, p]) => {
          const px = priceOf(sym);
          const pnl = px === null ? null : (p.side === 'short' ? (p.entry - px) : (px - p.entry)) * p.qty;
          return `<tr><td class="l"><b>${esc(sym)}</b></td><td>${p.side === 'short' ? 'Short' : 'Long'}</td><td>${money(p.entry)}</td><td>${px === null ? '<span class="muted">no price yet</span>' : money(px)}</td><td>${money(p.notional)}</td>
            <td class="${pnl === null ? 'muted' : pnl >= 0 ? 'up' : 'down'}">${pnl === null ? '—' : `<b>${pnl >= 0 ? '+' : '−'}${money(Math.abs(pnl))}</b>`}</td>
            <td><button class="btn sm" data-realclose="${esc(sym)}">Record the sale…</button></td></tr>`;
        }).join('')}</tbody></table></div>` : ''}

      ${closed.length ? `<div class="tbl-wrap mt"><table class="tbl"><thead><tr><th class="l">Coin</th><th class="l">Closed</th><th>In</th><th>Out</th><th>Result</th></tr></thead><tbody>
        ${closed.map((t) => `<tr><td class="l"><b>${esc(t.symbol)}</b>${t.side === 'short' ? ' <small class="muted">short</small>' : ''}</td><td class="l fine">${dateTime(t.exitAt, false)}</td><td>${money(t.entry)}</td><td>${money(t.exit)}</td>
          <td class="${t.pnl >= 0 ? 'up' : 'down'}"><b>${t.pnl >= 0 ? '+' : '−'}${money(Math.abs(t.pnl))}</b> <small>${pct(t.pnlPct)}</small></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="fine mt">No real trades recorded yet.</p>'}
      ${has && rs.equityCurve.length > 2 ? `<div class="mt"><div class="card-h" style="margin-bottom:6px"><h3 style="font-size:14px">Your money over time</h3><span class="fine">against simply holding Bitcoin</span></div><div id="realChart"></div><p class="fine" id="realChartNote"></p></div>` : ''}
    </div>`;
  }

  // The chart that answers "was any of this worth it?": the real account's
  // balance against the same money left in Bitcoin over the same period. A
  // trading record without that comparison flatters itself — a 20% gain in a
  // year Bitcoin doubled is a loss in every sense that matters.
  async function drawRealChart() {
    const host = $('#realChart', el);
    if (!host) return;
    const rs = realState();
    if (!rs || rs.equityCurve.length < 3) return;
    const curve = rs.equityCurve;
    const from = curve[0].t, to = curve[curve.length - 1].t;
    const note = $('#realChartNote', el);

    let holdSeries = null;
    try {
      const btc = await findCoin('BTC');
      const span = to - from;
      const iv = span > 120 * 864e5 ? '1d' : span > 10 * 864e5 ? '4h' : '1h';
      const { candles } = await getCandles(btc, iv, 1000);
      const inRange = candles.filter((c) => c.t >= from - 864e5 && c.t <= to + 864e5);
      if (inRange.length > 2) {
        const base = inRange[0].c;
        holdSeries = inRange.map((c) => ({ x: c.t, y: (c.c / base) * rs.startingBalance }));
      }
    } catch { /* the comparison is a bonus, not a requirement */ }

    if (st.disposed) return;
    const lc = new LineChart(host, { height: 240, yFormat: (v) => money(v), legend: true });
    st.charts.push(lc);
    const series = [{ name: 'Your account', color: 'var(--accent)', width: 2.4, data: curve.map((p) => ({ x: p.t, y: p.equity })) }];
    if (holdSeries) series.push({ name: 'Holding BTC', color: 'var(--text-muted)', width: 1.6, dash: true, data: holdSeries });
    lc.set(series);

    if (note && holdSeries) {
      const mine = ((curve[curve.length - 1].equity / rs.startingBalance) - 1) * 100;
      const hold = ((holdSeries[holdSeries.length - 1].y / rs.startingBalance) - 1) * 100;
      const diff = mine - hold;
      note.textContent = diff >= 0
        ? `You are ${pct(diff, 1)} ahead of simply holding Bitcoin over this period.`
        : `Holding Bitcoin would have done ${pct(Math.abs(diff), 1, false)} better over this period. Worth knowing before trading more.`;
      note.className = `fine ${diff >= 0 ? 'up' : 'down'}`;
    }
  }

  // Downloads happen entirely in the browser — the data never left it, and the
  // export should not be the moment it starts to.
  function wireExports() {
    const stamp = new Date().toISOString().slice(0, 10);
    $$('[data-export]', el).forEach((b) => b.addEventListener('click', () => {
      const which = b.dataset.export;
      const src = which === 'ai-csv' ? state : realState();
      if (!src?.closed?.length) { toast('No closed trades to export yet.', 'info'); return; }
      downloadText(`coinvantage-${which === 'ai-csv' ? 'ai-trader' : 'my-trades'}-${stamp}.csv`, tradesCsv(src.closed));
      toast(`${src.closed.length} trades exported.`, 'up');
    }));
    $$('[data-report]', el).forEach((b) => b.addEventListener('click', () => {
      const isAi = b.dataset.report === 'ai';
      const src = isAi ? state : realState();
      if (!src) { toast('Nothing to report on yet.', 'info'); return; }
      const s2 = stats(src, marks());
      const notes = isAi
        ? ['<b>Simulated money.</b> These trades were never placed on an exchange. Fees are modelled, slippage is not.']
        : ['<b>Recorded by hand or imported.</b> These are trades placed on an exchange; this app did not place them.'];
      const html = reportHtml({
        title: isAi ? 'AI trader — performance report' : 'Trading performance report',
        accountName: isAi ? 'Simulated account' : 'Real account',
        stats: s2, closed: [...src.closed].reverse(),
        fmtMoney: (v) => money(v), notes,
      });
      const w = window.open('', '_blank');
      if (!w) { downloadText(`coinvantage-report-${stamp}.html`, html, 'text/html;charset=utf-8'); toast('Report downloaded.', 'up'); return; }
      w.document.write(html);
      w.document.close();
    }));
  }

  function wireReal() {
    // Import: parse in the browser, match buys to sells FIFO, and show what
    // happened before writing anything.
    $('#csvIn', el)?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const msg = $('#csvMsg', el);
      msg.hidden = false;
      msg.className = 'fine';
      msg.textContent = `Reading ${file.name}…`;
      try {
        const text = await file.text();
        const { fills, errors, skipped } = parseTradeCsv(text);
        if (errors.length) { msg.className = 'fine down'; msg.textContent = errors[0]; return; }
        const { closed, open } = matchFills(fills);
        if (!closed.length && !open.length) { msg.className = 'fine down'; msg.textContent = 'No trades could be matched from that file.'; return; }

        const rs = realState() || newState(cfg);
        let added = 0;
        for (const t of closed) {
          const r = recordRealTrade(rs, cfg, {
            symbol: t.symbol, side: 'long', qty: t.qty, entry: t.entry, exit: t.exit,
            fee: t.fee, openedAt: t.openedAt, closedAt: t.closedAt, note: 'imported',
          });
          if (r.ok) added++;
        }
        for (const o of open) {
          const r = recordRealTrade(rs, cfg, { symbol: o.symbol, side: 'long', qty: o.qty, entry: o.entry, fee: o.fee, openedAt: o.at, note: 'imported' });
          if (r.ok) added++;
        }
        save(REAL_KEY, rs);
        msg.className = 'fine up';
        msg.textContent = `Imported ${added} trade${added === 1 ? '' : 's'} from ${fills.length} fills — ${closed.length} closed, ${open.length} still open${skipped ? `, ${skipped} row${skipped === 1 ? '' : 's'} skipped` : ''}.`;
        toast(`${added} trades imported.`, 'up');
        draw();
      } catch (err) {
        msg.className = 'fine down';
        msg.textContent = `Could not read that file: ${err.message}`;
      } finally {
        e.target.value = '';
      }
    });

    const f3 = $('#rf', el);
    f3?.addEventListener('submit', (e) => {
      e.preventDefault();
      const err = $('#rfErr', el);
      err.hidden = true;
      const rs = realState() || newState(cfg);
      // The account is kept in USD so it can be marked against the exchange's
      // own price; the form is in whatever currency the site is displaying.
      const toUsd = (v) => (v === null || v === '' || v === undefined ? v : (fx.rate ? +v / fx.rate : +v));
      const r = recordRealTrade(rs, cfg, {
        symbol: f3.sym.value, side: f3.side.value,
        qty: f3.qty.value, entry: toUsd(f3.entry.value),
        exit: f3.exit.value === '' ? null : toUsd(f3.exit.value),
        fee: toUsd(f3.fee.value || 0),
      });
      if (!r.ok) { err.textContent = r.error; err.hidden = false; return; }
      save(REAL_KEY, rs);
      toast(r.trade ? `Recorded: ${r.trade.pnl >= 0 ? 'a profit' : 'a loss'} of ${money(Math.abs(r.trade.pnl))} after fees.` : `Open ${f3.sym.value} trade recorded.`, r.trade && r.trade.pnl < 0 ? 'down' : 'up');
      draw();
    });
    // A real trade closes at the price it was actually sold at on the exchange,
    // so ask for it, with the current price filled in as a starting point.
    $$('[data-realclose]', el).forEach((b) => b.addEventListener('click', async () => {
      const sym = b.dataset.realclose;
      const now = priceOf(sym) ?? await fetchPrice(sym);
      const m = modal(`<h3>Record the sale of ${esc(sym)}</h3>
        <p class="fine">Enter the price you sold at on your exchange. CoinVantage only records it: no order is placed.</p>
        <form class="stack mt" style="gap:10px" id="rcf">
          <label class="fld">Price sold at (${esc(fx.code)})<input class="inp" name="px" type="number" step="any" min="0" required value="${now === null ? '' : esc(String(+(now * (fx.rate || 1)).toPrecision(8)))}"></label>
          <label class="fld">Fee paid on the sale (${esc(fx.code)})<input class="inp" name="fee" type="number" step="any" min="0" value="${now === null ? '0' : esc(String(+(now * (realState()?.open[sym]?.qty || 0) * (cfg.feePct / 100) * (fx.rate || 1)).toPrecision(4)))}"><small class="fine">Filled in at the usual ${cfg.feePct}%; change it to what your exchange charged.</small></label>
          <p class="fine down" id="rcfErr" hidden></p>
          <button class="btn primary">Record the sale</button>
        </form>`);
      $('#rcf', m.el).addEventListener('submit', (e) => {
        e.preventDefault();
        const f = e.target;
        const rate = fx.rate || 1;
        const px = +f.px.value / rate;
        const rs = realState();
        const pos = rs?.open[sym];
        if (pos) pos.feePaid = (pos.feePaid || 0) + Math.max(0, +f.fee.value || 0) / rate;
        const r = rs ? closeManual(rs, { ...cfg, feePct: 0 }, sym, px, Date.now(), 'recorded by you') : { ok: false, error: 'This trade is no longer open.' };
        if (!r.ok) { const err = $('#rcfErr', m.el); err.textContent = r.error; err.hidden = false; return; }
        save(REAL_KEY, rs);
        m.close();
        toast(`${sym} sale recorded: ${r.trade.pnl >= 0 ? 'a profit' : 'a loss'} of ${money(Math.abs(r.trade.pnl))} after fees.`, r.trade.pnl >= 0 ? 'up' : 'down');
        draw();
      });
    }));
    $('#realReset', el)?.addEventListener('click', () => {
      save(REAL_KEY, newState(cfg));
      toast('Real account cleared.', 'info');
      draw();
    });
  }

  // Trades you placed yourself, from a coin page. Kept in their own account so
  // the AI's record stays a record of the AI.
  const MY_KEY = 'myDemoState';
  const myState = () => load(MY_KEY, null);

  function myDemoCard() {
    const ms = myState();
    if (!ms || (!Object.keys(ms.open).length && !ms.closed.length)) {
      return `<div class="card"><div class="card-h"><h3>Your own demo trades</h3><span class="chip">Separate account</span></div>
        <p class="fine">Nothing here yet. Open any coin, press <b>Trade</b>, and use <b>Buy (demo)</b> to place a demo trade yourself at the live price. It is kept apart from the AI's account below, so your experiments never distort the strategy's record.</p></div>`;
    }
    const s2 = stats(ms, marks());
    const open = Object.entries(ms.open);
    const closed = [...ms.closed].reverse().slice(0, 20);
    return `<div class="card">
      <div class="card-h"><h3>Your own demo trades</h3><div class="row" style="gap:8px"><span class="chip">Separate account</span><button class="btn sm ghost" id="myReset">Reset</button></div></div>
      <div class="grid g4">
        <div class="stat"><span class="k">Balance</span><span class="v ${s2.returnPct >= 0 ? 'up' : 'down'}">${money(s2.equity)}</span><span class="s fine">started at ${money(s2.startingBalance)}</span></div>
        <div class="stat"><span class="k">Return</span><span class="v ${s2.returnPct >= 0 ? 'up' : 'down'}">${pct(s2.returnPct)}</span></div>
        <div class="stat"><span class="k">Win rate</span><span class="v">${s2.winRate === null ? '—' : `${s2.winRate}%`}</span><span class="s fine">${s2.wins}W / ${s2.losses}L</span></div>
        <div class="stat"><span class="k">Trades</span><span class="v">${s2.trades}</span><span class="s fine">${s2.openCount} still open</span></div>
      </div>
      ${open.length ? `<div class="tbl-wrap mt"><table class="tbl"><thead><tr><th class="l">Coin</th><th>Bought at</th><th>Now</th><th>Size</th><th>Open P&amp;L</th><th></th></tr></thead><tbody>
        ${open.map(([sym, p]) => {
          const px = priceOf(sym);
          const pnl = px === null ? null : (px - p.entry) * p.qty;
          return `<tr><td class="l"><b>${esc(sym)}</b></td><td>${money(p.entry)}</td><td>${px === null ? '<span class="muted">no price yet</span>' : money(px)}</td><td>${money(p.notional)}</td>
            <td class="${pnl === null ? 'muted' : pnl >= 0 ? 'up' : 'down'}">${pnl === null ? '—' : `<b>${pnl >= 0 ? '+' : '−'}${money(Math.abs(pnl))}</b> <small>${pct((px / p.entry - 1) * 100)}</small>`}</td>
            <td><button class="btn sm" data-mysell="${esc(sym)}">Sell</button></td></tr>`;
        }).join('')}
      </tbody></table></div>` : ''}
      ${closed.length ? `<div class="tbl-wrap mt"><table class="tbl"><thead><tr><th class="l">Coin</th><th class="l">Closed</th><th>Bought</th><th>Sold</th><th>Result</th></tr></thead><tbody>
        ${closed.map((t) => `<tr><td class="l"><b>${esc(t.symbol)}</b></td><td class="l fine">${dateTime(t.exitAt, false)}</td><td>${money(t.entry)}</td><td>${money(t.exit)}</td>
          <td class="${t.pnl >= 0 ? 'up' : 'down'}"><b>${t.pnl >= 0 ? '+' : '−'}${money(Math.abs(t.pnl))}</b> <small>${pct(t.pnlPct)}</small></td></tr>`).join('')}
      </tbody></table></div>` : ''}
      <p class="fine mt">${esc(DEMO_NOTICE)}</p>
    </div>`;
  }

  function wireMyDemo() {
    $('#myReset', el)?.addEventListener('click', () => {
      save(MY_KEY, newState(cfg));
      toast('Your demo account is back to its starting balance.', 'info');
      draw();
    });
    $$('[data-mysell]', el).forEach((b) => b.addEventListener('click', async () => {
      const sym = b.dataset.mysell;
      const ms = myState();
      const px = priceOf(sym) ?? await fetchPrice(sym);
      if (px === null) { toast(`No price for ${sym} right now — try again in a moment.`, 'info'); return; }
      const r = closeManual(ms, cfg, sym, px);
      if (!r.ok) { toast(r.error, 'down'); return; }
      save(MY_KEY, ms);
      toast(`Sold ${sym}: ${r.trade.pnl >= 0 ? 'a profit' : 'a loss'} of ${money(Math.abs(r.trade.pnl))} after fees.`, r.trade.pnl >= 0 ? 'up' : 'down');
      draw();
    }));
  }

  function draw() {
    if (!state) { $('#body', el).innerHTML = `${backupCard()}${myDemoCard()}${realCard()}<div class="mt">${verdictCard()}</div>${startCard()}`; wireBackup(); wireMyDemo(); wireReal(); wireExports(); drawRealChart(); syncRunButtons(); syncSessionChip(); return; }
    const s = stats(state, marks());
    const open = Object.entries(state.open);
    const closed = [...state.closed].reverse();

    $('#body', el).innerHTML = `
      ${backupCard()}
      ${myDemoCard()}
      ${realCard()}
      <h3 class="mt" style="margin-bottom:8px">The AI's own account</h3>
      ${verdictCard()}
      <div class="grid g4">
        <div class="card"><div class="stat"><span class="k">Balance now</span><span class="v ${s.returnPct >= 0 ? 'up' : 'down'}">${money(s.equity)}</span><span class="s fine">started at ${money(s.startingBalance)}</span></div></div>
        <div class="card"><div class="stat"><span class="k">Return</span><span class="v ${s.returnPct >= 0 ? 'up' : 'down'}">${pct(s.returnPct)}</span><span class="s fine">since ${dateTime(s.since, false)}${s.since < s.liveSince - 60e3 ? ` · replayed until ${dateTime(s.liveSince)}` : ''}</span></div></div>
        <div class="card"><div class="stat"><span class="k">Win rate</span><span class="v">${s.winRate === null ? '—' : `${s.winRate}%`}</span><span class="s fine">${s.wins}W / ${s.losses}L${s.profitFactor ? ` · PF ${s.profitFactor}` : ''}</span></div></div>
        <div class="card"><div class="stat"><span class="k">Max drawdown</span><span class="v ${s.maxDrawdownPct > 0 ? 'down' : 'flat'}">${pct(-s.maxDrawdownPct, 1)}</span><span class="s fine">${s.openCount} open · ${s.trades} closed</span></div></div>
      </div>

      <div class="card mt">
        <div class="card-h"><h3>Open positions</h3><span class="fine">marked against the live price (or the latest candle until a live price arrives)</span></div>
        ${open.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th class="l">Coin</th><th>Entry</th><th>Now</th><th>Stop</th><th>Target</th><th>Size</th><th>Open P&amp;L</th><th class="l">Opened</th></tr></thead><tbody>
          ${open.map(([sym, p]) => {
            const px = st.prices[sym];
            if (!Number.isFinite(px)) {
              const coin = all.find((c) => c.symbol === sym);
              return `<tr data-sym="${esc(sym)}"><td class="l"><div class="coin-cell">${coinLogo(coin || { symbol: sym }, 22)}<b>${esc(sym)}</b></div></td>
                <td>${money(p.entry)}</td><td class="muted">loading…</td>
                <td class="down">${money(p.stop)}</td><td class="up">${p.tp === null || p.tp === undefined ? 'trailing' : money(p.tp)}</td>
                <td>${money(p.notional)}</td><td class="muted fine">waiting for a price</td><td class="l fine">${dateTime(p.openedAt + (INTERVAL_MS[state.interval] || 0))}</td></tr>`;
            }
            const pnl = (px - p.entry) * p.qty;
            const coin = all.find((c) => c.symbol === sym);
            return `<tr data-sym="${esc(sym)}">
              <td class="l"><div class="coin-cell">${coinLogo(coin || { symbol: sym }, 22)}<b>${esc(sym)}</b></div></td>
              <td>${money(p.entry)}</td><td>${money(px)}${st.priceFrom[sym] === 'candle' ? '<br><small class="fine">last candle</small>' : ''}</td>
              <td class="down">${money(p.stop)}${p.movedToBreakEven ? ' <span class="fine">(BE)</span>' : ''}</td>
              <td class="up">${p.tp === null || p.tp === undefined ? 'trailing' : money(p.tp)}</td>
              <td>${money(p.notional)}</td>
              <td class="${pnl >= 0 ? 'up' : 'down'}"><b>${pnl >= 0 ? '+' : '−'}${money(Math.abs(pnl))}</b><br><small>${pct((px / p.entry - 1) * 100)}</small></td>
              <td class="l fine">${dateTime(p.openedAt + (INTERVAL_MS[state.interval] || 0))}<br><small>${ago(p.openedAt + (INTERVAL_MS[state.interval] || 0))}</small></td></tr>`;
          }).join('')}
        </tbody></table></div>` : `<p class="muted">${autoOn ? 'No position open right now — the AI is waiting for a setup that meets its rules.' : 'No position open. The AI is not running, so none will open until you start it.'}</p>`}
      </div>

      ${activityCard()}
      ${reviewCard()}

      ${state.equityCurve.length > 2 ? `<div class="card mt"><div class="card-h"><h3>Balance over time</h3><span class="fine">simulated</span></div><div id="eqChart"></div></div>` : ''}

      <div class="card mt">
        <div class="card-h"><h3>Trade log</h3><div class="row" style="gap:8px"><span class="fine">${s.trades} closed · ${money(s.feesPaid)} paid in fees</span><button class="btn sm ghost" data-export="ai-csv">CSV</button><button class="btn sm ghost" data-report="ai">Report</button></div></div>
        ${closed.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th class="l">Coin</th><th class="l">Opened</th><th class="l">Closed</th><th>Entry</th><th>Exit</th><th>Result</th><th class="l">Why it closed</th></tr></thead><tbody>
          ${closed.slice(0, 60).map((t) => `<tr data-sym="${esc(t.symbol)}">
            <td class="l"><b>${esc(t.symbol)}</b></td>
            <td class="l fine">${dateTime(t.openedAt + (INTERVAL_MS[state.interval] || 0))}</td><td class="l fine">${dateTime(t.exitAt + (INTERVAL_MS[state.interval] || 0))}</td>
            <td>${money(t.entry)}</td><td>${money(t.exit)}</td>
            <td class="${t.pnl >= 0 ? 'up' : 'down'}"><b>${t.pnl >= 0 ? '+' : '−'}${money(Math.abs(t.pnl))}</b> <small>${pct(t.pnlPct)}</small></td>
            <td class="l"><span class="chip ${t.reason === 'target' ? 'up' : t.reason === 'stop-loss' ? 'down' : ''}">${esc(t.reason)}</span></td></tr>`).join('')}
        </tbody></table></div>` : '<p class="muted">No closed trades yet.</p>'}
      </div>

      <div class="card mt" style="background:var(--surface-2)">
        <h3>What this is and is not</h3>
        <p class="fine">${esc(PAPER_NOTICE)} Results include a ${cfg.feePct}% fee per side and assume the stop is hit first whenever a candle contains both the stop and the target — so the record errs against the strategy, never for it.</p>
        <p class="fine">A simulation cannot reproduce slippage, thin order books or an exchange going down mid-move. Treat a good run here as evidence the rules are sane, not as an expected return.</p>
      </div>
      ${learningCard()}`;

    $$('tr[data-sym]', el).forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/coin/${tr.dataset.sym}`; }));
    wireBackup();
    wireMyDemo();
    wireReal();
    wireExports();
    wireReview();
    drawRealChart();
    syncRunButtons();
    syncSessionChip();

    st.charts.forEach((c) => c.destroy());
    st.charts = [];
    if ($('#eqChart', el)) {
      const lc = new LineChart($('#eqChart', el), { height: 240, yFormat: (v) => money(v), legend: false });
      st.charts.push(lc);
      lc.set([{ name: 'Balance', color: 'var(--accent)', width: 2.2, data: state.equityCurve.map((p) => ({ x: p.t, y: p.equity })) }]);
    }
  }

  // ---------------------------------------------------------------- settings
  $('#cfgBtn', el).addEventListener('click', () => {
    const m = modal(`<h3>Trader settings</h3>
      <p class="fine">Changing these does not rewrite past trades. Risk, max open and coins apply to the next trade. A new starting balance or chart applies straight away while the account has no trades, and after a Reset once it has some.</p>
      <form class="stack mt" style="gap:10px" id="cf">
        <div class="row" style="gap:8px">
          <label class="fld">Starting balance<input class="inp" name="startingBalance" type="number" min="100" step="100" value="${cfg.startingBalance}" style="width:130px"></label>
          <label class="fld">Risk per trade %<input class="inp" name="riskPct" type="number" min="0.1" max="5" step="0.1" value="${cfg.riskPct}" style="width:120px"></label>
          <label class="fld">Max open<input class="inp" name="maxPositions" type="number" min="1" max="10" value="${cfg.maxPositions}" style="width:90px"></label>
        </div>
        <label class="fld">Chart<select class="inp" name="interval">${['15m', '1h', '4h', '1d'].map((i) => { const x = AUTOTRADER_TESTED[i]; return `<option value="${i}" ${i === cfg.interval ? 'selected' : ''}>${i} — tested ${x.pickedReturn >= 0 ? '+' : '−'}${Math.abs(x.pickedReturn)}% (holding ${x.buyHold >= 0 ? '+' : '−'}${Math.abs(x.buyHold)}%)</option>`; }).join('')}</select></label>
        <label class="fld">Coins it may trade<input class="inp" name="universe" value="${esc(cfg.universe.join(', '))}"></label>
        <p class="fine">Available: ${esc(tradable.filter((c) => c.binance).slice(0, 24).map((c) => c.symbol).join(', '))}… The AI only trades coins with real exchange candles.</p>
        <button class="btn primary">Save settings</button>
      </form>`);
    $('#cf', m.el).addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      const uni = f.universe.value.split(',').map((x) => x.trim().toUpperCase()).filter((x) => tradable.some((c) => c.symbol === x));
      if (!uni.length) { toast('Pick at least one tradable coin.', 'down'); return; }
      Object.assign(cfg, {
        startingBalance: Math.max(100, +f.startingBalance.value),
        riskPct: Math.min(5, Math.max(0.1, +f.riskPct.value)),
        maxPositions: Math.min(10, Math.max(1, +f.maxPositions.value)),
        interval: f.interval.value,
        universe: uni.slice(0, 12),
      });
      save(CFG_KEY, cfg);
      m.close();
      // An account with no trades yet has nothing to protect, so a new starting
      // balance or chart applies to it at once (it used to keep showing the old
      // balance until a Reset, which looked like the setting was ignored).
      const untouched = state && !Object.keys(state.open || {}).length && !(state.closed || []).length;
      if (untouched && (state.startingBalance !== cfg.startingBalance || state.interval !== cfg.interval)) {
        state = state.interval === cfg.interval
          ? { ...state, balance: cfg.startingBalance, startingBalance: cfg.startingBalance, equityCurve: [] }
          : { ...newState(cfg, { liveFrom: state.liveFrom }), log: state.log || [] };
        save(STATE_KEY, state);
        toast(`Settings saved. The AI's account now starts at ${money(cfg.startingBalance)} on ${cfg.interval}.`, 'up');
      } else if (state && (state.startingBalance !== cfg.startingBalance || state.interval !== cfg.interval)) {
        toast(`Settings saved. This account already has trades, so it keeps ${money(state.startingBalance)} on ${state.interval}; press Reset to start again with ${money(cfg.startingBalance)} on ${cfg.interval}.`, 'info');
      } else toast('Settings saved.', 'up');
      draw();
      if (untouched && autoOn) catchUp();
    });
  });

  $('#resetBtn', el)?.addEventListener('click', () => {
    const m = modal(`<h3>Reset the AI's account?</h3><p>This wipes the simulated balance and the whole trade log and starts again from ${money(cfg.startingBalance)} on ${cfg.interval}. ${autoOn ? 'The AI keeps running' : 'The AI stays stopped until you start it'}, and from now on it only trades candles that open after the reset — nothing from before is replayed. It cannot be undone.</p>
      <div class="row mt" style="gap:8px"><button class="btn" id="no">Keep it</button><button class="btn primary" id="yes">Reset</button></div>`);
    $('#no', m.el).addEventListener('click', m.close);
    $('#yes', m.el).addEventListener('click', () => {
      // Start clean from now: no candle that opened before this moment is ever
      // traded, so the old trades cannot come back on the next Start.
      const wasRunning = autoOn;
      state = newState(cfg, { liveFrom: Date.now() }); save(STATE_KEY, state);
      st.prices = {}; st.priceFrom = {};
      applySession('RESET');
      saveLedger(newLedger());
      // A reset clears the account, not the user's choice to run the AI.
      if (wasRunning) applySession('START');
      m.close(); draw();
      toast(wasRunning ? `Account reset to ${money(cfg.startingBalance)}. The AI is still running and trades new ${cfg.interval} candles from now on.` : `Account reset to ${money(cfg.startingBalance)}. Press Start the trader when you want it running.`, 'info');
      if (wasRunning) catchUp();
    });
  });

  // Stop must actually stop: it clears the run flag, so neither the 5-minute
  // timer nor a page reload opens another position. The account and its history
  // are left untouched — stopping is not resetting.
  function syncRunButtons() {
    const stopB = $('#stopBtn', el);
    const startB = $('#startBtn', el);
    if (stopB) stopB.hidden = !(state && autoOn);
    const resetB = $('#resetBtn', el);
    if (resetB) resetB.hidden = !state;
    if (startB) {
      startB.innerHTML = !state ? `${icon('bolt', 16)} Start the trader`
        : autoOn ? `${icon('refresh', 16)} Catch up now`
        : `${icon('bolt', 16)} ${session.status === 'stopped' ? 'Resume the AI' : 'Start the trader'}`;
    }
  }

  $('#stopBtn', el)?.addEventListener('click', () => {
    applySession('STOP');
    draw(); // the account cards say whether the AI is looking for trades
    const openCount = Object.keys(state?.open || {}).length;
    toast(openCount ? `AI stopped. ${openCount} open position${openCount > 1 ? 's stay' : ' stays'} open — close them from the table, or resume.` : 'AI stopped. It will not open any new trades.', 'info');
  });

  $('#startBtn', el).addEventListener('click', () => {
    applySession('START');
    catchUp();
  });

  // live marks + periodic catch-up
  const onTick = (e) => {
    // Every account marks against these prices, so a symbol held only in the
    // demo or real account has to be recorded too. It used to keep prices for
    // the AI's positions alone, which left the other two frozen at their entry
    // price and closed them at a fabricated 0%.
    const wanted = new Set([
      ...Object.keys(state?.open || {}),
      ...Object.keys(myState()?.open || {}),
      ...Object.keys(realState()?.open || {}),
    ]);
    let changed = false;
    for (const t of e.detail) {
      const sym = t.s.replace(/USDT$/, '');
      if (wanted.has(sym)) { st.prices[sym] = +t.c; st.priceFrom[sym] = 'live'; changed = true; }
    }
    if (changed && !st.paintQueued) {
      st.paintQueued = true;
      setTimeout(() => { st.paintQueued = false; if (!st.disposed) draw(); }, 4000);
    }
  };
  window.addEventListener('cv:tickers', onTick);
  // Signing in or out here changes where the trades are kept.
  const wireSyncNote = () => $('#syncSignIn', el)?.addEventListener('click', (e) => { e.preventDefault(); openAuth(); });
  const onAuth = () => { const n = $('#syncNote', el); if (n) { n.innerHTML = syncNote(); wireSyncNote(); } };
  auth.addEventListener('change', onAuth);
  wireSyncNote();
  const timer = setInterval(() => { if (!st.disposed && state && autoOn) catchUp(); }, 5 * 60e3);

  // draw() renders the demo and real accounts too, so it has to run whether or
  // not the AI has ever been started — otherwise a user who placed a demo trade
  // from a coin page arrives here and sees nothing but the start card.
  draw();
  syncRunButtons();
  syncSessionChip();
  // Your demo and real positions in coins the AI does not watch get a price
  // here, so their open profit shows without waiting for the live stream.
  (async () => {
    const need = [...new Set([...Object.keys(myState()?.open || {}), ...Object.keys(realState()?.open || {})])].filter((sym) => !Number.isFinite(st.prices[sym]));
    let got = 0;
    for (const sym of need) { if (st.disposed) return; if ((await fetchPrice(sym)) !== null) got++; }
    if (got && !st.disposed) draw();
  })();
  if (state && autoOn) catchUp();
  // First visit: run the play-money account once on its own, so the page opens
  // on a replayed record instead of an empty start card. Only ever automatic
  // once per device — after a Stop or a Reset it waits for the user again.
  else if (!state && session.status === 'idle' && !load(AUTO_KEY, false)) {
    save(AUTO_KEY, true);
    applySession('START');
    catchUp();
  }
  void compact; void amount; void bindSeg; void LEARN_KEY;

  return () => {
    st.disposed = true;
    clearInterval(timer);
    window.removeEventListener('cv:tickers', onTick);
    auth.removeEventListener('change', onAuth);
    st.charts.forEach((c) => c.destroy());
  };
}
