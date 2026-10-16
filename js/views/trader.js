// The automatic AI trader, running on simulated money.
import { markets, getCandles, isStable, isTestedSource, findCoin, INTERVAL_MS, knownVenue, findVenue } from '../api/market.js';
import { newState, rescaleAccount, replayAll, stats, equity, closeManual, recordRealTrade, DEFAULT_CONFIG, CHART_TESTED, rulesForChart, rulesInWords, PER_COIN_RULES, CUSTOM_DEFAULT, TRADER_CHARTS, MAX_COINS, TESTED_COINS, bestTestedChart, settingsWarnings, backtestSettings, expectedYield, PAPER_NOTICE, DEMO_NOTICE, REAL_NOTICE, logCheck, VOL_SCALE } from '../lib/autotrader.js';
import { reviewTrades, decideChanges, activeLessons, diagnose, MIN_TRADES } from '../lib/tradelearn.js';
import { learningPass } from '../lib/learnpass.js';
import { candleCache } from '../lib/candlecache.js';
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
import { initialSession, sessionReducer, sessionLabel, newLedger, learningStatus, accuracySparkline, sparklineSvg, LEARN_KEY, loadLedger, saveLedger, recordForecast, resolveDueLedger, TREND_WORDS } from '../lib/selfimprove.js';
import { runForecast } from '../lib/compute.js';
import { DEFAULT_HORIZON } from '../ai/context.js';

// Runs fn over items, at most n at a time.
async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => { while (queue.length) await fn(queue.shift()); }));
}

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
  const st = { disposed: false, charts: [], prices: {}, priceFrom: {}, running: false, noExchange: [] };
  // each check after the first asks only for the candles that are new
  const candlesFor = candleCache(getCandles, { window: 500, stepOf: (iv) => INTERVAL_MS[iv] });
  // Coins that keep coming back with no price data (checks in a row they failed
  // while others loaded), so the page can say so once and offer to drop them.
  const NODATA_KEY = 'traderNoData';
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
  const USER_KEYS = ['startingBalance', 'riskPct', 'maxPositions', 'interval', 'universe', 'ownRulesOff', 'maxPositionPct', 'feePct', 'strategy', 'custom'];
  // The trend filter is not carried over from a save: whether the self-review
  // switched it is read from its lessons (rulesForChart), since a saved value
  // cannot tell a learned setting from an old default.
  const LEARNED_KEYS = ['minAdx', 'maxEntryRsi', 'excluded'];
  const cfg = { ...DEFAULT_CONFIG, ...Object.fromEntries(Object.entries(savedCfg).filter(([k]) => USER_KEYS.includes(k) || (savedCfg.v === 2 && LEARNED_KEYS.includes(k)))), v: 2 };
  // Risk per trade above 5% is a setting that wipes an account out in a short
  // losing run; older saves allowed 10.
  cfg.riskPct = Math.min(5, Math.max(0.1, +cfg.riskPct || DEFAULT_CONFIG.riskPct));
  let state = load(STATE_KEY, null);
  // Each coin's own rules: on for daily accounts unless switched off (see
  // PER_COIN_RULES for what they made and what they risked in testing). It
  // follows the chart the account RUNS on, which only changes on a Reset, not
  // the chart picked in Settings. Stored as an opt-out: for an hour they were
  // opt-in, and a Save then stored "off" for anyone who never touched the box.
  const ownRulesOn = () => !cfg.ownRulesOff && cfg.strategy !== 'custom' && (state?.interval || cfg.interval) === PER_COIN_RULES.interval;
  // What the account actually trades: the settings, the chart's own measured
  // rules, the self-review's lessons. Everything that trades or describes the
  // rules reads this, so the page cannot describe one strategy and run another.
  const effective = (iv = state?.interval || cfg.interval) => rulesForChart(cfg, iv, load(LESSONS_KEY, []));

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

  // The measured result, stated before anyone starts it: each chart's rules
  // were picked on older candles and run on newer ones they had never seen,
  // three times, all coins in one account with fees. A feature that cannot
  // beat buying and holding should say so on its own page.
  function verdictCard() {
    const iv = state?.interval || cfg.interval;
    const w = CHART_TESTED[iv];
    const TFS = ['15m', '1h', '4h', '1d'];
    // Showing one timeframe's numbers under another label would present a test
    // that was never run.
    if (!w) {
      return `<div class="card" style="border-color:var(--warn)">
      <div class="card-h"><h3>${icon('info', 16)} Not tested on the ${esc(iv)} chart</h3></div>
      <p class="fine">This strategy was measured on ${TFS.join(', ')} charts. On ${esc(iv)} it trades ${cfg.strategy === 'custom' ? 'your own rules' : 'the standard rules'} with no measured result to expect; "Test these settings" in Settings shows how they did on recent candles. Rules in force: ${esc(rulesText(effective(iv)))}</p>
    </div>`;
    }
    const sign = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v)}%`;
    const traded = (x) => (x.adopt ? x.own : x.standard);
    const r = traded(w);
    const e = effective(iv);
    return `<div class="card" style="border-color:var(--warn)">
      <div class="card-h"><h3>${icon('info', 16)} What this strategy actually did when it was tested</h3><span class="fine">measured ${esc(CHART_TESTED.measuredOn)}, not estimated</span></div>
      <p>Run candle by candle over ${w.coins ?? CHART_TESTED.coins} coins in one account, fees included, in ${CHART_TESTED.blocks} back-to-back periods of about ${esc(w.block)} (${esc(w.from)} → ${esc(w.to)}). ${w.adopt ? `Before each period the rules were picked from ${CHART_TESTED.configs} rule sets on the history before it, then run on a period they had never seen.` : `The standard rules ran through all three; next to them, a pick from ${CHART_TESTED.configs} rule sets made on the history before each period ran too, and did not beat them clearly enough.`} ${cfg.strategy === 'custom' ? `<b>You are trading your own rules, which were not part of this test</b>, so it says nothing about them; use "Test these settings" in Settings for a look back. For comparison, the tested rules for ${esc(iv)} averaged <b class="${r.ret >= 0 ? 'up' : 'down'}">${sign(r.ret)}</b> a period against <b class="${w.hold >= 0 ? 'up' : 'down'}">${sign(w.hold)}</b> for holding the same coins.` : `On ${esc(iv)} the rules it trades averaged <b class="${r.ret >= 0 ? 'up' : 'down'}">${sign(r.ret)}</b> a period with an average worst drop of ${r.dd}%, while holding the same coins averaged <b class="${w.hold >= 0 ? 'up' : 'down'}">${sign(w.hold)}</b> with a worst drop of ${w.holdDrop}%. ${r.ret > w.hold ? 'On this chart it did better than holding, over three periods; that is evidence, not a promise.' : 'On this chart holding made more.'}${r.dd < w.holdDrop - 5 ? (r.ret > w.hold ? ' It also fell much less.' : ' But it fell much less.') : ''} Worst drops count open trades at every candle close, as the account itself would have shown them.${w.fillCost ? ` The test fills every order at the candle's price; with fills 0.05% worse each way (spread and slippage) it made about ${w.fillCost} points less a period.` : ''}`}</p>
      <div class="tbl-wrap mt"><table class="tbl"><thead><tr><th class="l">Chart</th><th>Tested</th><th>Rules</th><th>Result a period</th><th>Worst drop</th><th>Standard rules</th><th>Holding</th><th>Holding's worst drop</th><th>Trades</th></tr></thead><tbody>
        ${TFS.map((k) => { const x = CHART_TESTED[k], t = traded(x); return `<tr${k === iv ? ' style="font-weight:600"' : ''}><td class="l">${k}</td><td class="fine">${esc(x.from)} → ${esc(x.to)}</td><td class="fine">${x.adopt ? 'its own' : 'standard'}</td><td class="${t.ret >= 0 ? 'up' : 'down'}">${sign(t.ret)}</td><td class="down">−${t.dd}%</td><td class="${x.standard.ret >= 0 ? 'up' : 'down'}">${sign(x.standard.ret)}</td><td class="${x.hold >= 0 ? 'up' : 'down'}">${sign(x.hold)}</td><td class="down">−${x.holdDrop}%</td><td>${t.trades}</td></tr>`; }).join('')}
      </tbody></table></div>
      <p class="fine mt">Rules in force on ${esc(iv)}: ${esc(rulesText(e))} ${cfg.strategy === 'custom' ? 'These are your own rules, set in Settings.' : w.adopt ? `They are this chart's own pick: in the test, picking rules for the chart beat the standard rules in ${w.better} of ${CHART_TESTED.blocks} periods (${sign(w.own.ret)} against ${sign(w.standard.ret)} a period, worst drop ${w.own.dd}% against ${w.standard.dd}%), so they are re-picked the same way on all the history.` : `The chart's own pick did not beat the standard rules clearly enough (better in ${w.better} of ${CHART_TESTED.blocks} periods), so it keeps them.`} Fees came to ${r.fees}% of the balance a period, and ${r.win}% of trades won.${iv === '15m' ? ' A 15m period is only ten days, so these numbers swing a lot between runs.' : ''}${ownRulesText()}${ownRulesOn() ? ` Tested on ${PER_COIN_RULES.coins} coins over ${esc(PER_COIN_RULES.tested.from)} → ${esc(PER_COIN_RULES.tested.to)}, with every rule chosen on the years before: ${sign(PER_COIN_RULES.tested.own.ret)} with a worst drop of ${PER_COIN_RULES.tested.own.dd}%, against ${sign(PER_COIN_RULES.tested.standard.ret)} and ${PER_COIN_RULES.tested.standard.dd}% for the daily rules alone, and ${sign(PER_COIN_RULES.tested.hold)} for holding the coins (worst drop ${PER_COIN_RULES.tested.holdDrop}%).${PER_COIN_RULES.tested.previousRun ? ` The run before, on ${PER_COIN_RULES.tested.previousRun.coins} coins, made ${sign(PER_COIN_RULES.tested.previousRun.own)} against ${sign(PER_COIN_RULES.tested.previousRun.standard)}: one long test swings with its coins and start date, so read the size of the gain as rough.` : ''} You can switch them off in Settings.` : ''}</p>
      ${ownRulesOn() ? coinRulesTable(e) : ''}
      <p class="fine">The ${w.coins ?? CHART_TESTED.coins} coins are today's large coins: coins that collapsed or were delisted along the way are not in the test, which flatters every result here, holding's included.</p>
      <p class="fine">So this account is a demonstration of a strategy, run honestly on live prices with fees counted, including the losing stretches. It is not a promise of profit. It places no real orders and holds no keys.</p>
    </div>`;
  }

  // What each watched coin trades on the daily chart, so "its own rules" is
  // something you can read rather than take on trust.
  function coinRulesTable(base) {
    const buys = (r) => `${r.entryMode === 'breakout' ? 'new 20-candle high' : r.entryMode === 'pullback' ? 'dip in an uptrend' : `score +${r.entryScore} or more`}${r.momentumConfirm ? ', momentum up' : ''}${r.trendFilter && r.entryMode !== 'pullback' ? ', in an uptrend' : ''}`;
    const sells = (r) => `${r.trailAtr ? `stop trailing ${r.trailAtr} ATR` : `target ${r.rMultiple}R`}${r.signalExitBars ? `, or ${r.signalExitBars} reversal candles` : ''}`;
    const rows = cfg.universe.map((sym) => {
      const own = PER_COIN_RULES.rules[sym];
      const r = own ? { ...base, ...own } : base;
      return `<tr><td class="l"><b>${esc(sym)}</b>${own ? '' : ' <small class="fine">daily rules</small>'}</td><td class="l fine">${esc(buys(r))}</td><td>${r.atrStop} ATR</td><td class="l fine">${esc(sells(r))}</td></tr>`;
    }).join('');
    const n = cfg.universe.filter((sym) => PER_COIN_RULES.rules[sym]).length;
    return `<details class="mt"><summary class="fine" style="cursor:pointer">Each coin's rules on this chart (${n} of ${cfg.universe.length} have their own)</summary>
      <div class="tbl-wrap mt"><table class="tbl"><thead><tr><th class="l">Coin</th><th class="l">Buys on</th><th>Stop</th><th class="l">Sells at</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="fine">Chosen on each coin's own daily history; a coin without its own uses the daily rules. Switch them off in Settings.</p>
    </details>`;
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
      <div class="card-h"><h3>${icon('ai', 16)} This device's forecast record</h3><span class="chip ${trendCls}">${esc(TREND_WORDS[ls.trend] || ls.trend)}</span></div>
      <p class="fine">Every forecast this device shows is logged before the outcome is known, then scored when its horizon passes. Rolling windows below are hit rates over the last N resolved forecasts on <b>this device only</b> — not a claim about future performance. Keeping score does not make the forecasts better; a hit rate near 50% is a coin toss.</p>
      <div class="grid g4 mt">
        <div class="stat"><span class="k">Last 20</span><span class="v">${win(20)}</span></div>
        <div class="stat"><span class="k">Last 50</span><span class="v">${win(50)}</span></div>
        <div class="stat"><span class="k">Last 100</span><span class="v">${win(100)}</span></div>
        <div class="stat"><span class="k">Last 20 against last 50</span><span class="v ${trendCls}" style="font-size:16px">${esc(TREND_WORDS[ls.trend] || ls.trend)}</span><span class="s fine">${esc(trendText)}</span></div>
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

  // How the rules buy and sell, in words.
  // a function declaration, not a const: startCard() runs during the first render, above this line
  function rulesText(c) { return rulesInWords(c); }

  function startCard() {
    const e = effective();
    const w = CHART_TESTED[e.interval];
    const r = w && (w.adopt ? w.own : w.standard);
    return `<div class="card empty">
      <h3>Run the strategy on simulated money</h3>
      <p style="max-width:620px">It watches ${cfg.universe.length} coins on the ${esc(e.interval)} chart. ${rulesText(e)} It sizes each position so a stop-out costs at most ${cfg.riskPct}% of the balance, with no more than ${cfg.maxPositionPct}% of it in one coin and never more cash than the account has.${ownRulesText()} Every trade is logged with the fee it would have paid.</p>
      <p class="fine" style="max-width:620px">Starting balance ${money(cfg.startingBalance)}. Read the tested result above before you start it${r ? ` — on this chart ${r.ret > w.hold ? 'it did better than holding the same coins in that test, which is no promise it will again' : 'holding the same coins did better'}` : ''}. You can stop it at any time without resetting the account.</p>
    </div>${learningCard()}`;
  }

  // The rule that opens a trade, in words, for whichever entry mode is set.
  // Which of the watched coins trade their own rules, in a sentence.
  function ownRulesText() {
    if (!ownRulesOn()) return '';
    const own = cfg.universe.filter((s) => PER_COIN_RULES.rules[s]);
    if (!own.length) return ' None of the watched coins has rules of its own, so all of them use these.';
    if (own.length === cfg.universe.length) return ' Each coin trades rules chosen on its own daily history instead of these.';
    if (own.length === 1) return ` ${own[0]} trades rules chosen on its own daily history instead; the other coins use these.`;
    return ` ${own.length} of the ${cfg.universe.length} coins (${own.join(', ')}) trade rules chosen on their own daily history instead; the rest use these.`;
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
    const runCfg = { ...effective(state.interval), perCoin: ownRulesOn() ? PER_COIN_RULES.rules : null };

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
    // four coins at a time: a list of thirty used to be fetched one by one
    const syms = [...cfg.universe, ...held];
    const fetched = new Map();
    await pool(syms, 4, async (sym) => {
      const coin = all.find((c) => c.symbol === sym);
      if (!coin || st.disposed) return;
      // listed on none of the exchanges it reads: nothing to fetch
      if (knownVenue(coin) === null && !state.open[sym]) { fetched.set(sym, new Error('not listed')); return; }
      try { fetched.set(sym, await candlesFor(coin, runCfg.interval)); } catch (err) { fetched.set(sym, err); }
    });
    for (const sym of syms) {
      if (st.disposed) return;
      const coin = all.find((c) => c.symbol === sym);
      if (!coin) { failed.push(sym); continue; }
      try {
        const r = fetched.get(sym);
        if (!r || r instanceof Error) throw r || new Error('no candles');
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
    // A coin is flagged only after two checks in a row with no data while other
    // coins loaded: when the feeds are down every coin fails, and BTC must not be
    // offered for removal. Demo candles mean the feeds are down, never the coin.
    const streak = load(NODATA_KEY, {});
    if (Object.keys(bySymbol).length) {
      for (const sym of failed) if (fetched.get(sym)?.source !== 'demo') streak[sym] = (streak[sym] || 0) + 1;
      for (const sym of Object.keys(bySymbol)) delete streak[sym];
      save(NODATA_KEY, streak);
    }
    st.noExchange = noExchange;
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
    // once per visit for the same coins: every five-minute check used to repeat it
    if (failed.length && st.warnedNoData !== failed.join()) { st.warnedNoData = failed.join(); toast(`No price data for ${failed.join(', ')} this time — skipped.`, 'info'); }
    // once per visit: it would otherwise repeat on every five-minute check
    if (noExchange.length && !st.warnedNoExchange) st.warnedNoExchange = true, toast(`${noExchange.join(', ')} ${noExchange.length > 1 ? 'have' : 'has'} no exchange candles, so the AI does not trade ${noExchange.length > 1 ? 'them' : 'it'}. The notice on this page can take ${noExchange.length > 1 ? 'them' : 'it'} off its list.`, 'info');
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
      if (e.kind === 'settings') return `<b>Settings changed</b> — ${esc(e.c.text)}`;
      if (e.kind === 'buy') {
        const bar = e.p.entryBar;
        return `<b>Bought ${esc(e.sym)}</b> at ${money(e.p.entry)}${Number.isFinite(e.p.openScore) ? ` — score ${e.p.openScore > 0 ? '+' : ''}${Math.round(e.p.openScore)}${Number.isFinite(bar) ? ` cleared the +${bar} entry bar` : ''}` : ''}`;
      }
      return `<b>Sold ${esc(e.sym)}</b> at ${money(e.p.exit)} — ${esc(why[e.p.reason] || e.p.reason)} · <span class="${e.p.pnl >= 0 ? 'up' : 'down'}">${e.p.pnl >= 0 ? '+' : '−'}${money(Math.abs(e.p.pnl))} (${pct(e.p.pnlPct)})</span>`;
    };
    const replayed = ev.filter((e) => !['check', 'review', 'settings'].includes(e.kind) && e.t < liveSince).length;
    return `<div class="card mt">
      <div class="card-h"><h3>${icon('ai', 16)} AI activity</h3><span class="fine">${autoOn ? 'running · checks every 5 minutes' : session.status === 'stopped' ? 'stopped · press Resume to continue' : 'idle'}${st.lastRun ? ` · last check ${ago(st.lastRun)}` : ''}</span></div>
      ${replayed ? `<p class="fine" style="margin-top:0">Entries marked <span class="chip">replayed</span> happened on candles from before this account went live on ${dateTime(liveSince)} — the same rules run over past prices so the record does not start empty. Everything after that was decided live.</p>` : ''}
      ${ev.length ? `<ul class="fine" style="list-style:none;padding:0;margin:0">${ev.slice(0, 30).map((e) => `<li style="padding:6px 0;border-bottom:1px solid var(--border)"><span class="muted" style="display:inline-block;min-width:150px">${dateTime(e.t)}</span>${!['check', 'review', 'settings'].includes(e.kind) && e.t < liveSince ? '<span class="chip" style="margin-right:6px">replayed</span>' : ''}${line(e)}</li>`).join('')}</ul>`
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
    const { cfgPatch, changes } = decideChanges(review, effective(), lessons, state.closed);
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
    const active = activeLessons(effective());
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

  // Coins on the AI's list it cannot trade: none of the exchanges it reads has
  // them (two checks in a row), or only CoinGecko's sparse prices do.
  const unlisted = (sym) => knownVenue(all.find((c) => c.symbol === sym)) === null;
  function untradable() {
    const streak = load(NODATA_KEY, {});
    const noData = cfg.universe.filter((s) => (streak[s] || 0) >= 2 || unlisted(s));
    const sparse = cfg.universe.filter((s) => st.noExchange.includes(s) && !noData.includes(s));
    return { noData, sparse, all: [...noData, ...sparse] };
  }
  function untradableCard() {
    const u = untradable();
    if (!u.all.length) return '';
    const n = u.all.length;
    return `<div class="card" style="border-color:var(--warn)" id="untradable">
      <p style="margin:0"><b>${n} coin${n > 1 ? 's' : ''} on the AI's list can't be traded, so ${n > 1 ? 'they are' : 'it is'} skipped on every check.</b>
      ${u.noData.length ? `${esc(u.noData.join(', '))}: no price data from the exchanges it reads (Binance, Gate.io, HTX, OKX). ` : ''}${u.sparse.length ? `${esc(u.sparse.join(', '))}: only occasional CoinGecko prices, too sparse to trade on. ` : ''}The rest of the list is unaffected.</p>
      <button class="btn sm mt" type="button" id="dropUntradable">Remove ${n > 1 ? 'them' : 'it'} from the list</button>
    </div>`;
  }
  function wireUntradable() {
    $('#dropUntradable', el)?.addEventListener('click', () => {
      const gone = untradable().all;
      if (!gone.length) return;
      cfg.universe = cfg.universe.filter((s) => !gone.includes(s));
      save(CFG_KEY, cfg);
      if (state) { logCheck(state, { kind: 'settings', text: `removed ${gone.join(', ')} (no price data to trade on)` }); save(STATE_KEY, state); }
      toast(`Removed ${gone.join(', ')} from the AI's list.`, 'up');
      draw();
    });
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
      ${untradableCard()}
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
    wireUntradable();
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
  // Every choice here takes effect: a coin that cannot be traded is named and
  // left out (never silently dropped), a new chart can start a fresh account
  // straight away, and your own rules are traded as you set them.
  function resetAccount() {
    const wasRunning = autoOn;
    state = newState(cfg, { liveFrom: Date.now() }); save(STATE_KEY, state);
    st.prices = {}; st.priceFrom = {};
    applySession('RESET');
    saveLedger(newLedger());
    // a reset clears the account, not the choice to run the AI
    if (wasRunning) applySession('START');
    return wasRunning;
  }

  // What a set of settings can be expected to make: in % and money, the
  // spread between test periods, and the same test at each risk level.
  function yieldHtml(c) {
    const y = expectedYield(c);
    const sign = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v)}%`;
    if (!y) return `<b>Expected yield</b><p class="fine" style="margin:6px 0 0">Nothing measured to expect: ${c.strategy === 'custom' ? 'your own rules were never tested' : `the ${esc(c.interval)} chart was never tested`}. "Test these settings" below shows how they did on recent candles.</p>`;
    const own = c.strategy !== 'custom' && !c.ownRulesOff && c.interval === PER_COIN_RULES.interval;
    const cash = (v) => `${v >= 0 ? '+' : '−'}${money(Math.abs((c.startingBalance * v) / 100))}`;
    const top = y.levels.reduce((a, l) => (!a || l.ret > a.ret ? l : a), null);
    const n = (c.universe || []).length;
    return `<b>Expected yield</b> <span class="fine">from the walk-forward test of the ${esc(y.chart)} rules, at ${y.risk}% a trade</span>
      <p class="fine" style="margin:6px 0 0">About <b class="${y.ret >= 0 ? 'up' : 'down'}">${sign(y.ret)}</b> per ${esc(y.block)} on average (${cash(y.ret)} on ${money(c.startingBalance)}): ${sign(y.lo)} in the worst of the ${y.periods} test periods, ${sign(y.hi)} in the best, a gain in ${y.up} of ${y.periods}. Worst drop along the way about ${y.dd}%, open trades counted; about ${y.trades} trades a period. Holding the same coins made ${sign(y.hold)} a period${y.holdDrop ? `, falling as far as ${y.holdDrop}% on the way` : ''}.${y.fillCost ? ` Fills 0.05% worse each way (spread, slippage) would take about ${y.fillCost} points off a period.` : ''}</p>
      <p class="fine" style="margin:6px 0 0">Measured on ${y.coins} coins in one account${n && n < y.coins ? `; with ${n} coin${n === 1 ? '' : 's'} expect fewer trades` : ''}.${VOL_SCALE.charts.includes(c.interval) && c.strategy !== 'custom' ? ` These figures are from before ${esc(c.interval)} began buying less while a coin is unusually volatile; in a test on the same periods that added ${VOL_SCALE.tested[c.interval].ret >= 0 ? '+' : '−'}${Math.abs(VOL_SCALE.tested[c.interval].ret)} points a period and cut the worst drop by ${Math.abs(VOL_SCALE.tested[c.interval].dd)} points.` : ''}${y.capsDiffer ? ' Your caps on open trades or on one coin differ from the test\'s (5 open, 25% a coin), so treat it as rougher.' : ''}${own ? ` With each coin's own rules on, a separate test over ${PER_COIN_RULES.tested.from.slice(0, 4)}–${PER_COIN_RULES.tested.to.slice(0, 4)} made ${sign(PER_COIN_RULES.tested.own.ret)} against ${sign(PER_COIN_RULES.tested.standard.ret)} without them.` : ''} An expectation from past periods, not a promise.</p>
      ${y.levels.length ? `<div class="tbl-wrap mt"><table class="tbl fine"><thead><tr><th class="l">Risk a trade</th><th>Average a period</th><th>Worst → best</th><th>Worst drop</th><th>Periods up</th></tr></thead><tbody>
        ${y.levels.map((l) => `<tr${l.risk === y.risk ? ' style="font-weight:700"' : ''}><td class="l">${l.risk}%${l.risk === y.risk ? ' ← yours' : ''}</td><td class="${l.ret >= 0 ? 'up' : 'down'}">${sign(l.ret)}</td><td>${sign(l.lo)} → ${sign(l.hi)}</td><td>${l.dd}%</td><td>${l.up} of ${y.periods}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="fine" style="margin:6px 0 0">Each row is the same test at that risk${y.levels.some((l) => l.risk === y.risk) ? '' : `; yours (${y.risk}%) is read between the two nearest rows`}. The best average came at ${top.risk}% a trade${top.risk < y.levels[y.levels.length - 1].risk ? ' and higher settings made no more' : ''}: with at most 25% in one coin, a higher setting soon stops making positions bigger. Read off these same periods, so a guide, not a promise.</p>` : ''}`;
  }

  $('#cfgBtn', el).addEventListener('click', () => {
    const coins = all.filter((c) => !isStable(c.symbol)).slice(0, 100);
    const chosen = new Set(cfg.universe);
    // every coin seen to have no data, on the list or not, so it is not picked again
    const streakNow = load(NODATA_KEY, {});
    const noDataNow = [...Object.keys(streakNow).filter((k) => streakNow[k] >= 2), ...st.noExchange];
    // A coin none of the exchanges lists cannot be picked: CoinGecko's top 100
    // includes some (FIGR_HELOC, a tokenised home loan), and the quick picks
    // used to add them.
    const VENUE = { gate: 'Gate.io', htx: 'HTX', okx: 'OKX' };
    const venueTag = (c) => {
      const v = knownVenue(c);
      if (v === null) return ' <small class="down" title="Not traded on Binance, Gate.io, HTX or OKX, the exchanges this app reads, so there is no price data to trade on">no exchange</small>';
      if (noDataNow.includes(c.symbol)) return ' <small class="down" title="no price data the AI can trade on">no data</small>';
      if (v === 'binance') return '';
      return v ? ` <small class="muted" title="not on Binance: candles come from ${VENUE[v]}">${VENUE[v]}</small>` : ' <small class="muted" title="not on Binance: looking for it on Gate.io, HTX and OKX">checking…</small>';
    };
    const best = bestTestedChart();
    const own = cfg.custom ? { ...CUSTOM_DEFAULT, ...cfg.custom } : { ...CUSTOM_DEFAULT };
    const exitOf = (r) => (r.trailAtr ? `t${r.trailAtr}` : `r${r.rMultiple}`);
    const chartLabel = (i) => {
      const x = CHART_TESTED[i];
      if (!x) return `${i} — not tested`;
      const t = x.adopt ? x.own : x.standard;
      return `${i} — tested ${t.ret >= 0 ? '+' : '−'}${Math.abs(t.ret)}% per ${x.block} (holding ${x.hold >= 0 ? '+' : '−'}${Math.abs(x.hold)}%)`;
    };
    const m = modal(`<h3>Trader settings</h3>
      <div class="card mt" style="padding:12px" id="todo"><b>What to do</b>
        <p class="fine" style="margin:6px 0 0">Best tested setup: the <b>${esc(best.iv)}</b> chart with the tested rules — it made money in ${best.up} of 3 test periods, ${best.ret >= 0 ? '+' : '−'}${Math.abs(best.ret)}% per ${esc(best.block)} on average against ${best.hold >= 0 ? '+' : '−'}${Math.abs(best.hold)}% for holding the same coins. Keep risk at 1–2% a trade, pick at least five coins, and leave the self-review on. None of this is a promise: the tests looked back, the market goes forward.</p>
        <button class="btn sm mt" type="button" id="useBest">Use the best tested setup</button>
        <div id="todoLive"></div></div>
      <form class="stack mt" style="gap:12px" id="cf" novalidate>
        <fieldset class="stack" style="gap:8px;border:0;padding:0;margin:0;min-width:0"><legend class="fine"><b>Account and risk</b></legend>
          <div class="row" style="gap:8px;flex-wrap:wrap">
            <label class="fld">Starting balance${fx.code === 'USD' ? '' : ` (${esc(fx.code)})`}<input class="inp" name="startingBalance" type="number" min="${Math.ceil(100 * fx.rate)}" step="any" value="${Math.round(cfg.startingBalance * fx.rate)}" style="width:150px"></label>
            <label class="fld">Risk per trade %<input class="inp" name="riskPct" type="number" min="0.1" max="5" step="0.1" value="${cfg.riskPct}" style="width:110px"></label>
            <label class="fld">Max open trades<input class="inp" name="maxPositions" type="number" min="1" max="20" value="${cfg.maxPositions}" style="width:110px"></label>
            <label class="fld">Max in one coin %<input class="inp" name="maxPositionPct" type="number" min="5" max="100" step="5" value="${cfg.maxPositionPct}" style="width:120px"></label>
            <label class="fld">Fee per trade %<input class="inp" name="feePct" type="number" min="0" max="1" step="0.01" value="${cfg.feePct}" style="width:110px"></label>
          </div>
          ${fx.code === 'USD' ? '' : `<p class="fine" style="margin:0">The starting balance is in ${esc(fx.code)} at today's rate (${money(cfg.startingBalance)} is $${cfg.startingBalance.toLocaleString('en-US', { maximumFractionDigits: 2 })}); the account itself is kept in US dollars, like the prices it trades at.</p>`}
        </fieldset>
        <fieldset class="stack" style="gap:8px;border:0;padding:0;margin:0;min-width:0"><legend class="fine"><b>Chart</b></legend>
          <select class="inp" name="interval" aria-label="Chart" style="width:100%">${TRADER_CHARTS.map((i) => `<option value="${i}" ${i === cfg.interval ? 'selected' : ''}>${esc(chartLabel(i))}</option>`).join('')}</select>
          <label class="row fine" style="gap:8px;align-items:flex-start" id="switchRow" hidden><input type="checkbox" name="switchNow" checked style="margin-top:2px"><span>Start a fresh account on the new chart now. This account has trades on <b>${esc(state?.interval || cfg.interval)}</b>; mixing two charts in one balance would muddle its record, so the old trades and balance are cleared. Untick to keep this account and switch at the next Reset.</span></label>
        </fieldset>
        <fieldset class="stack" style="gap:8px;border:0;padding:0;margin:0;min-width:0"><legend class="fine"><b>Strategy</b></legend>
          <label class="row" style="gap:8px"><input type="radio" name="strategy" value="tested" ${cfg.strategy === 'custom' ? '' : 'checked'}><span>Tested rules for the chart <span class="fine">(recommended)</span></span></label>
          <label class="row" style="gap:8px;align-items:flex-start;margin-left:24px" id="ownRow"><input type="checkbox" name="ownRules" ${cfg.ownRulesOff ? '' : 'checked'} style="margin-top:3px"><span class="fine">On the daily chart, each coin trades rules chosen on its own history (${PER_COIN_RULES.coins} coins have them). Tested ${PER_COIN_RULES.tested.from.slice(0, 4)}–${PER_COIN_RULES.tested.to.slice(0, 4)}: ${PER_COIN_RULES.tested.own.ret >= 0 ? '+' : '−'}${Math.abs(PER_COIN_RULES.tested.own.ret)}% against ${PER_COIN_RULES.tested.standard.ret >= 0 ? '+' : '−'}${Math.abs(PER_COIN_RULES.tested.standard.ret)}% for the daily rules alone, worst drop ${PER_COIN_RULES.tested.own.dd}% against ${PER_COIN_RULES.tested.standard.dd}%.${(() => { const w = PER_COIN_RULES.tested.walkForward; return w && w.own < w.shared ? ` But coin by coin, over ${w.periods} walk-forward periods, they did worse than one shared rule set (${w.own >= 0 ? '+' : '−'}${Math.abs(w.own)}% against ${w.shared >= 0 ? '+' : '−'}${Math.abs(w.shared)}% a period, better in ${w.better} of ${w.periods}), so the account result rests on a few coins: switching this off is a fair choice.` : ''; })()}</span></label>
          <label class="row" style="gap:8px"><input type="radio" name="strategy" value="custom" ${cfg.strategy === 'custom' ? 'checked' : ''}><span>My own rules <span class="fine">(no published test)</span></span></label>
          <div class="stack" id="customBox" style="gap:8px;margin-left:24px">
            <div class="row" style="gap:8px;flex-wrap:wrap">
              <label class="fld">Buy when<select class="inp" name="entryMode">${[['trend', 'the score is strong'], ['breakout', 'it breaks a 20-candle high'], ['pullback', 'it dips in an uptrend']].map(([v, t]) => `<option value="${v}" ${own.entryMode === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
              <label class="fld">Stop<select class="inp" name="atrStop">${[1.5, 2, 3].map((v) => `<option value="${v}" ${own.atrStop === v ? 'selected' : ''}>${v} ATR below entry</option>`).join('')}</select></label>
              <label class="fld">Sell at<select class="inp" name="exit">${[['r2', 'a target of 2× the risk'], ['r3', 'a target of 3× the risk'], ['t3', 'a stop trailing 3 ATR'], ['t4', 'a stop trailing 4 ATR']].map(([v, t]) => `<option value="${v}" ${exitOf(own) === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
            </div>
            <label class="row fine" style="gap:8px"><input type="checkbox" name="momentumConfirm" ${own.momentumConfirm ? 'checked' : ''}>only buy when short-term momentum agrees</label>
            <label class="row fine" style="gap:8px"><input type="checkbox" name="trendFilter" ${own.trendFilter ? 'checked' : ''}>only buy coins in an uptrend (above their 200-candle average)</label>
            <label class="row fine" style="gap:8px"><input type="checkbox" name="marketFilter" ${own.marketFilter ? 'checked' : ''}>only buy while Bitcoin itself is in an uptrend</label>
            <label class="row fine" style="gap:8px"><input type="checkbox" name="signalExit" ${own.signalExitBars ? 'checked' : ''}>sell after 2 candles of signal reversal</label>
          </div>
        </fieldset>
        <fieldset class="stack" style="gap:8px;border:0;padding:0;margin:0;min-width:0"><legend class="fine"><b>Coins</b> <span id="coinCount"></span></legend>
          <div class="row" style="gap:6px;flex-wrap:wrap"><input class="inp" id="coinFind" placeholder="Find a coin" aria-label="Find a coin" style="flex:1;min-width:140px">
            <button class="btn sm" type="button" data-pick="10">Top 10</button><button class="btn sm" type="button" data-pick="20">Top 20</button><button class="btn sm" type="button" data-pick="all">All</button><button class="btn sm" type="button" data-pick="tested" title="The ${TESTED_COINS.length} coins the published results were measured on">The ${TESTED_COINS.length} tested</button><button class="btn sm" type="button" data-pick="own">Coins with own rules</button><button class="btn sm" type="button" data-pick="0">Clear</button></div>
          <div id="coinGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:4px;max-height:220px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:6px">
            ${coins.map((c) => `<label class="fine" style="display:flex;gap:6px;align-items:center" data-coin="${esc(c.symbol)}" data-name="${esc((c.name || '').toLowerCase())}"><input type="checkbox" value="${esc(c.symbol)}" ${chosen.has(c.symbol) ? 'checked' : knownVenue(c) === null ? 'disabled' : ''} ${noDataNow.includes(c.symbol) || knownVenue(c) === null ? 'data-nodata="1"' : ''}><b>${esc(c.symbol)}</b>${PER_COIN_RULES.rules[c.symbol] ? ' <small title="has its own daily rules">★</small>' : ''}${(cfg.excluded || []).includes(c.symbol) ? ' <small class="down" title="benched by the self-review">benched</small>' : ''}<span data-venue>${venueTag(c)}</span></label>`).join('')}
          </div>
          ${(cfg.excluded || []).length ? `<label class="row fine" style="gap:8px"><input type="checkbox" name="unbench"><span>Trade the coins the self-review benched again (${esc(cfg.excluded.join(', '))})</span></label>` : ''}
          <p class="fine" style="margin:0">Up to ${MAX_COINS} coins. ★ = has its own daily rules. Coins with no exchange candles are skipped at each check and named in the activity log.</p>
        </fieldset>
        <div class="row" style="gap:8px;flex-wrap:wrap"><button class="btn" type="button" id="testCfg">${icon('chart', 16)} Test these settings</button><button class="btn primary">Save settings</button></div>
        <div id="testOut"></div>
      </form>`);
    const f = $('#cf', m.el);
    // Coins Binance does not list are looked up on Gate.io, HTX and OKX (a few
    // small requests each, remembered for days); the grid says what was found.
    pool(coins.filter((c) => knownVenue(c) === undefined), 3, async (c) => {
      const v = await findVenue(c);
      const row = f.isConnected && f.querySelector(`#coinGrid [data-coin="${CSS.escape(c.symbol)}"]`);
      if (!row) return;
      row.querySelector('[data-venue]').innerHTML = venueTag(c);
      const box = row.querySelector('input');
      if (v === null) { box.dataset.nodata = '1'; if (!box.checked) box.disabled = true; }
    });
    const read = () => {
      const picks = [...f.querySelectorAll('#coinGrid input:checked')].map((x) => x.value);
      const exit = f.exit.value;
      return {
        // typed in the currency the page shows; kept in dollars, at least $100
        startingBalance: f.startingBalance.value === f.startingBalance.defaultValue || !(+f.startingBalance.value > 0)
          ? cfg.startingBalance : Math.max(100, Math.round((+f.startingBalance.value / fx.rate) * 1e6) / 1e6),
        riskPct: Math.min(5, Math.max(0.1, +f.riskPct.value || DEFAULT_CONFIG.riskPct)),
        maxPositions: Math.min(20, Math.max(1, Math.round(+f.maxPositions.value) || DEFAULT_CONFIG.maxPositions)),
        maxPositionPct: Math.min(100, Math.max(5, +f.maxPositionPct.value || DEFAULT_CONFIG.maxPositionPct)),
        feePct: Math.min(1, Math.max(0, Number.isFinite(+f.feePct.value) ? +f.feePct.value : DEFAULT_CONFIG.feePct)),
        interval: f.interval.value,
        strategy: f.querySelector('input[name="strategy"]:checked')?.value === 'custom' ? 'custom' : 'tested',
        custom: { entryMode: f.entryMode.value, atrStop: +f.atrStop.value, rMultiple: exit[0] === 'r' ? +exit.slice(1) : 3, trailAtr: exit[0] === 't' ? +exit.slice(1) : null, momentumConfirm: f.momentumConfirm.checked, trendFilter: f.trendFilter.checked, marketFilter: f.marketFilter.checked, signalExitBars: f.signalExit.checked ? 2 : null },
        ownRulesOff: !f.ownRules.checked,
        universe: picks,
      };
    };
    const refresh = () => {
      const next = read();
      $('#customBox', m.el).hidden = next.strategy !== 'custom';
      $('#ownRow', m.el).hidden = next.strategy === 'custom';
      const hasTrades = state && (Object.keys(state.open || {}).length || (state.closed || []).length);
      $('#switchRow', m.el).hidden = !(hasTrades && next.interval !== (state?.interval || cfg.interval));
      $('#coinCount', m.el).textContent = `· ${next.universe.length} chosen${next.universe.length > MAX_COINS ? ` — only ${MAX_COINS} can be traded` : ''}`;
      const warn = settingsWarnings({ ...cfg, ...next });
      // only this part is redrawn: a button redrawn under the pointer would
      // swallow the click that blurred the field before it
      $('#todoLive', m.el).innerHTML = `<div class="mt" style="border-top:1px solid var(--border);padding-top:8px">${yieldHtml({ ...cfg, ...next })}</div>
        ${warn.length ? `<ul class="fine" style="margin:8px 0 0;padding-left:18px">${warn.map((w) => `<li class="down">${esc(w)}</li>`).join('')}</ul>` : '<p class="fine up" style="margin:8px 0 0">Nothing in these settings needs a warning.</p>'}`;
    };
    $('#useBest', m.el).addEventListener('click', () => {
      f.interval.value = best.iv;
      f.querySelector('input[name="strategy"][value="tested"]').checked = true;
      f.ownRules.checked = true;
      // exactly what the published test ran: its risk, position limits and coins
      f.riskPct.value = DEFAULT_CONFIG.riskPct;
      f.maxPositions.value = DEFAULT_CONFIG.maxPositions;
      f.maxPositionPct.value = DEFAULT_CONFIG.maxPositionPct;
      for (const x of f.querySelectorAll('#coinGrid input')) x.checked = !x.disabled && TESTED_COINS.includes(x.value);
      refresh();
    });
    f.addEventListener('input', refresh);
    f.addEventListener('change', refresh);
    $('#coinFind', m.el).addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      for (const row of f.querySelectorAll('#coinGrid [data-coin]')) row.hidden = !!q && !row.dataset.coin.toLowerCase().includes(q) && !row.dataset.name.includes(q);
    });
    for (const b of f.querySelectorAll('[data-pick]')) b.addEventListener('click', () => {
      const v = b.dataset.pick;
      const boxes = [...f.querySelectorAll('#coinGrid input')];
      // the top N coins it can trade: ones with no price data are passed over
      let n = 0;
      const want = (x) => (v === 'own' ? !!PER_COIN_RULES.rules[x.value] : v === 'tested' ? TESTED_COINS.includes(x.value) : v === 'all' ? n++ < MAX_COINS : n++ < +v);
      boxes.forEach((x) => { x.checked = !x.disabled && !x.dataset.nodata && want(x); });
      refresh();
    });
    $('#testCfg', m.el).addEventListener('click', async () => {
      const next = { ...cfg, ...read() };
      const syms = next.universe.slice(0, MAX_COINS);
      const out = $('#testOut', m.el);
      if (!syms.length) { out.innerHTML = '<p class="fine down">Pick at least one coin to test.</p>'; return; }
      out.innerHTML = `<p class="fine"><span class="spinner"></span> Replaying these settings on the last 1,000 ${esc(next.interval)} candles of ${syms.length} coin${syms.length === 1 ? '' : 's'}…</p>`;
      const by = {};
      await pool(syms, 4, async (sym) => {
        const coin = all.find((c) => c.symbol === sym);
        if (!coin) return;
        try { const r = await getCandles(coin, next.interval, 1000); if (r.source !== 'demo' && r.source !== 'coingecko' && !r.lowRes) by[sym] = r.candles.slice(0, -1); } catch { /* skipped */ }
      });
      if (!m.el.isConnected) return;
      const rules = rulesForChart({ ...next, excluded: [] }, next.interval, load(LESSONS_KEY, []));
      const res = backtestSettings({ ...rules, perCoin: next.strategy !== 'custom' && !next.ownRulesOff && next.interval === PER_COIN_RULES.interval ? PER_COIN_RULES.rules : null }, by);
      if (!res.coins) { out.innerHTML = '<p class="fine down">None of these coins had enough exchange candles on this chart to test.</p>'; return; }
      const sign = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v)}%`;
      out.innerHTML = `<div class="card" style="padding:12px"><b>How these settings did on recent candles</b>
        <p class="fine" style="margin:6px 0 0">${res.coins} coin${res.coins === 1 ? '' : 's'}, ${esc(new Date(res.from).toISOString().slice(0, 10))} → ${esc(new Date(res.to).toISOString().slice(0, 10))}, fees included: <b class="${res.ret >= 0 ? 'up' : 'down'}">${sign(res.ret)}</b> against <b>${sign(res.hold)}</b> for holding the same coins. ${res.trades} trade${res.trades === 1 ? '' : 's'} closed${res.trades ? `, ${res.winRate}% won` : ''}, worst drop ${res.dd}%, ${res.open} still open. ${Object.keys(by).length < syms.length ? `${syms.length - Object.keys(by).length} coin${syms.length - Object.keys(by).length === 1 ? '' : 's'} had no exchange candles and ${syms.length - Object.keys(by).length === 1 ? 'was' : 'were'} left out.` : ''}</p>
        <p class="fine" style="margin:6px 0 0">A look back, not a promise. ${next.strategy === 'custom' ? 'Rules tuned until they look good here usually do worse live.' : 'The tested rules were picked on history that includes these candles, so they look better here than they will live; the walk-forward result is the one to expect.'}</p></div>`;
    });
    refresh();

    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const next = read();
      if (!next.universe.length) { toast('Pick at least one coin.', 'down'); return; }
      const dropped = next.universe.slice(MAX_COINS);
      next.universe = next.universe.slice(0, MAX_COINS);
      const before = { ...cfg };
      const unbench = f.unbench?.checked;
      Object.assign(cfg, next, unbench ? { excluded: [] } : {});
      save(CFG_KEY, cfg);
      // the record: what changed, in the account's activity log
      const changes = [];
      if (before.interval !== cfg.interval) changes.push(`chart ${before.interval} → ${cfg.interval}`);
      if (before.startingBalance !== cfg.startingBalance) changes.push(`starting balance ${money(before.startingBalance)} → ${money(cfg.startingBalance)}`);
      if ((before.strategy || 'tested') !== cfg.strategy) changes.push(cfg.strategy === 'custom' ? 'now your own rules' : 'now the tested rules');
      else if (cfg.strategy === 'custom' && JSON.stringify(before.custom) !== JSON.stringify(cfg.custom)) changes.push('own rules changed');
      if (before.riskPct !== cfg.riskPct) changes.push(`risk ${before.riskPct}% → ${cfg.riskPct}% a trade`);
      if (before.maxPositions !== cfg.maxPositions) changes.push(`max open ${before.maxPositions} → ${cfg.maxPositions}`);
      if (before.maxPositionPct !== cfg.maxPositionPct) changes.push(`max in one coin ${before.maxPositionPct}% → ${cfg.maxPositionPct}%`);
      if (before.feePct !== cfg.feePct) changes.push(`fee ${before.feePct}% → ${cfg.feePct}%`);
      if (!!before.ownRulesOff !== !!cfg.ownRulesOff) changes.push(cfg.ownRulesOff ? 'coins\' own daily rules off' : 'coins\' own daily rules on');
      const added = cfg.universe.filter((s) => !before.universe.includes(s)), removed = before.universe.filter((s) => !cfg.universe.includes(s));
      if (added.length) changes.push(`added ${added.join(', ')}`);
      if (removed.length) changes.push(`removed ${removed.join(', ')}`);
      if (unbench) changes.push('benched coins allowed again');
      m.close();
      const hasTrades = state && (Object.keys(state.open || {}).length || (state.closed || []).length);
      const chartChanged = state && state.interval !== cfg.interval;
      let msg = 'Settings saved.';
      if (state && hasTrades && chartChanged && f.switchNow?.checked) {
        const running = resetAccount();
        msg = `Settings saved. A fresh account started on ${cfg.interval} with ${money(cfg.startingBalance)}${running ? '; the AI keeps running' : ''}.`;
      } else if (state && !hasTrades && (chartChanged || state.startingBalance !== cfg.startingBalance)) {
        // an account with no trades has nothing to protect: it follows the settings at once
        state = state.interval === cfg.interval
          ? { ...state, balance: cfg.startingBalance, startingBalance: cfg.startingBalance, equityCurve: [] }
          : { ...newState(cfg, { liveFrom: state.liveFrom }), log: state.log || [] };
        msg = `Settings saved. The AI's account now starts at ${money(cfg.startingBalance)} on ${cfg.interval}.`;
      } else if (state) {
        if (state.startingBalance !== cfg.startingBalance) {
          // its trades were sized as a share of the balance, so scaled they are what it would have done with that much
          state = rescaleAccount(state, cfg.startingBalance);
          msg = `Settings saved. The AI's account now counts from ${money(cfg.startingBalance)}: its balance and every trade are scaled to it, so each result in % stays the same.`;
        }
        if (chartChanged) msg += ` This account keeps trading ${state.interval} until you press Reset; then it starts on ${cfg.interval}.`;
      }
      if (cfg.startingBalance === 100 && before.startingBalance !== 100 && +f.startingBalance.value / fx.rate < 100) msg += ` The starting balance cannot be under ${money(100)}.`;
      if (dropped.length) msg += ` Only ${MAX_COINS} coins can be traded, so ${dropped.join(', ')} ${dropped.length === 1 ? 'was' : 'were'} left out.`;
      if (state && changes.length) { logCheck(state, { kind: 'settings', text: changes.join(' · ') }); save(STATE_KEY, state); }
      toast(msg, dropped.length ? 'info' : 'up');
      draw();
      if (state && autoOn) catchUp();
    });
  });

  $('#resetBtn', el)?.addEventListener('click', () => {
    const m = modal(`<h3>Reset the AI's account?</h3><p>This wipes the simulated balance and the whole trade log and starts again from ${money(cfg.startingBalance)} on ${cfg.interval}. ${autoOn ? 'The AI keeps running' : 'The AI stays stopped until you start it'}, and from now on it only trades candles that open after the reset — nothing from before is replayed. It cannot be undone.</p>
      <div class="row mt" style="gap:8px"><button class="btn" id="no">Keep it</button><button class="btn primary" id="yes">Reset</button></div>`);
    $('#no', m.el).addEventListener('click', m.close);
    $('#yes', m.el).addEventListener('click', () => {
      // Start clean from now: no candle that opened before this moment is ever
      // traded, so the old trades cannot come back on the next Start.
      const wasRunning = resetAccount();
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
  // Another tab of this site saved the AI's settings or account. This tab used to
  // keep its own older copy in memory and save it back at its next check or
  // Save, so a change made in one tab came undone. It now takes the newer copy
  // (and starts no check, so two open tabs cannot set each other off).
  const onStorage = (e) => {
    if (st.disposed || !e.key) return;
    if (e.key === `cv:${CFG_KEY}`) {
      const saved = load(CFG_KEY, {}) || {};
      Object.assign(cfg, { ...DEFAULT_CONFIG, ...Object.fromEntries(Object.entries(saved).filter(([k]) => USER_KEYS.includes(k) || (saved.v === 2 && LEARNED_KEYS.includes(k)))), v: 2 });
      cfg.riskPct = Math.min(5, Math.max(0.1, +cfg.riskPct || DEFAULT_CONFIG.riskPct));
      draw();
    } else if (e.key === `cv:${STATE_KEY}` && !st.running) {
      state = load(STATE_KEY, null);
      draw();
    }
  };
  window.addEventListener('storage', onStorage);

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
    window.removeEventListener('storage', onStorage);
    auth.removeEventListener('change', onAuth);
    st.charts.forEach((c) => c.destroy());
  };
}
