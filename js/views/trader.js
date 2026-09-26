// The automatic AI trader, running on simulated money.
import { markets, getCandles, isStable, findCoin, INTERVAL_MS } from '../api/market.js';
import { newState, replaySymbol, stats, equity, closeManual, recordRealTrade, DEFAULT_CONFIG, AUTOTRADER_TESTED, PAPER_NOTICE, REAL_NOTICE, logCheck } from '../lib/autotrader.js';
import { reviewTrades, decideChanges, activeLessons, MIN_TRADES } from '../lib/tradelearn.js';
import { learningPass } from '../lib/learnpass.js';
import { parseTradeCsv, matchFills } from '../lib/importer.js';
import { tradesCsv, downloadText, reportHtml } from '../lib/export.js';
import { LineChart } from '../charts/line.js';
import { $, $$, icon, toast, skeleton, coinLogo, modal, bindSeg } from '../ui.js';
import { esc, pct, money, compact, dateTime, ago, amount, price } from '../format.js';
import { fx } from '../api/fx.js';
import { load, save } from '../store.js';
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
  const tradable = all.filter((c) => !isStable(c.symbol)).slice(0, 60);

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Trading</h1>
        <p>Three accounts, side by side: the practice trades you place yourself, the trades you really made, and the AI running the strategy on its own. Only the real account involves real money — CoinVantage never places an order and holds no keys.</p></div>
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
      <div class="tbl-wrap mt"><table class="tbl"><thead><tr><th class="l">Chart</th><th>These rules</th><th>Worst drawdown</th><th>Previous rules</th><th>Buy &amp; hold</th><th>Trades</th></tr></thead><tbody>
        ${TFS.map((k) => { const x = AUTOTRADER_TESTED[k]; return `<tr${k === iv ? ' style="font-weight:600"' : ''}><td class="l">${k}</td><td class="${x.pickedReturn >= 0 ? 'up' : 'down'}">${sign(x.pickedReturn)}</td><td class="down">−${x.maxDrawdownPct}%</td><td class="${x.previousReturn >= 0 ? 'up' : 'down'}">${sign(x.previousReturn)} <small class="fine">(−${x.previousDrawdownPct}%)</small></td><td class="${x.buyHold >= 0 ? 'up' : 'down'}">${sign(x.buyHold)}</td><td>${x.trades}</td></tr>`; }).join('')}
      </tbody></table></div>
      <p class="fine mt">Current rules: stop 3 ATR below entry, target 3× the risk, and only buy while price is above its 200-bar average. Compared with the previous rules they did better on 15m, 4h and 1d and worse on 1h, with about half the fees. Fees on ${esc(iv)} came to ${t.feeDragPct}% of the balance across ${t.trades} trades.</p>
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
        <div class="fine">Once 15 forecasts have resolved, a hit rate below 55% over the last 50 (or 20, if fewer) pulls displayed confidence toward 50/50 — halfway below 40%. This is purely local measurement; no external validation is performed.</div>
      </div>
    </div>`;
  }

  function startCard() {
    return `<div class="card empty">
      <h3>Run the strategy on play money</h3>
      <p style="max-width:620px">It watches ${cfg.universe.length} coins on the ${esc(cfg.interval)} chart. When the score clears +${cfg.entryScore} it buys, sizes the position so a stop-out costs ${cfg.riskPct}% of the balance, and sells at the target (${cfg.rMultiple}R), the stop (${cfg.atrStop} ATR) or a signal reversal. Every trade is logged with the fee it would have paid.</p>
      <p class="fine" style="max-width:620px">Starting balance ${money(cfg.startingBalance)}. Read the tested result above before you start it — it did not beat buying and holding. You can stop it at any time without resetting the account.</p>
    </div>${learningCard()}`;
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

    let processed = 0, failed = [];
    const forecastInputs = [];
    const scores = [];
    const tradesBefore = state.closed.length;
    const openKeysBefore = new Set(Object.values(state.open).map((p) => `${p.symbol}:${p.openedAt}`));
    for (const sym of cfg.universe) {
      if (st.disposed) return;
      const coin = all.find((c) => c.symbol === sym);
      if (!coin) { failed.push(sym); continue; }
      try {
        const r = await getCandles(coin, runCfg.interval, 500);
        // only fully closed candles drive decisions
        const candles = r.candles.slice(0, -1);
        // Open positions used to be marked at their ENTRY price until a live
        // tick arrived, so every one showed +$0.00 (0.00%). The newest candle's
        // close is a real, recent price — use it until a tick replaces it.
        const lastPx = r.candles[r.candles.length - 1]?.c;
        if (Number.isFinite(lastPx) && st.priceFrom[sym] !== 'live') { st.prices[sym] = lastPx; st.priceFrom[sym] = 'candle'; }
        const res = replaySymbol(state, runCfg, sym, candles);
        processed += res.processed;
        if (Number.isFinite(res.lastScore)) scores.push({ sym, score: res.lastScore });
        forecastInputs.push({ sym, candles });
      } catch { failed.push(sym); }
    }
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
    draw();
    if (processed) toast(`Processed ${processed} new candles.`, 'up');
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
        const fc = await runForecast(candles, { horizon: DEFAULT_HORIZON[interval] || 12 }).catch(() => null);
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
    const why = { target: 'hit its target', 'stop-loss': 'hit its stop-loss', 'trailing stop': 'hit its trailing stop', 'signal reversal': 'the signal turned against it' };
    const line = (e) => {
      if (e.kind === 'check') {
        const c = e.c;
        const did = c.opened || c.closed ? `${c.opened ? `opened ${c.opened}` : ''}${c.opened && c.closed ? ', ' : ''}${c.closed ? `closed ${c.closed}` : ''}` : 'no trade';
        return `<b>Checked ${c.coins} coin${c.coins === 1 ? '' : 's'}</b> — ${c.candles} new closed candle${c.candles === 1 ? '' : 's'}, ${did}${c.best ? ` · highest score ${esc(c.best.sym)} ${c.best.score > 0 ? '+' : ''}${c.best.score} (buys at +${c.bar})` : ''}`;
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
    const s3 = has ? stats(rs, st.prices) : null;
    const open = has ? Object.entries(rs.open) : [];
    const closed = has ? [...rs.closed].reverse().slice(0, 25) : [];
    return `<div class="card mt">
      <div class="card-h"><h3>Real account</h3><div class="row" style="gap:8px"><span class="chip up">Your own money</span>${has ? '<button class="btn sm ghost" id="realReset">Reset</button>' : ''}</div></div>
      <p class="fine">Record the trades you actually placed on an exchange and they are measured the same way as the accounts above. ${esc(REAL_NOTICE)}</p>

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
        <div class="stat"><span class="k">Max drawdown</span><span class="v down">${pct(-s3.maxDrawdownPct, 1)}</span></div>
        <div class="stat"><span class="k">Trades</span><span class="v">${s3.trades}</span><span class="s fine">${s3.openCount} open</span></div>
      </div>` : ''}

      ${open.length ? `<div class="tbl-wrap mt"><table class="tbl"><thead><tr><th class="l">Coin</th><th>Side</th><th>In at</th><th>Now</th><th>Size</th><th>Open P&amp;L</th><th></th></tr></thead><tbody>
        ${open.map(([sym, p]) => {
          const px = st.prices[sym] ?? p.entry;
          const pnl = (p.side === 'short' ? (p.entry - px) : (px - p.entry)) * p.qty;
          return `<tr><td class="l"><b>${esc(sym)}</b></td><td>${p.side === 'short' ? 'Short' : 'Long'}</td><td>${money(p.entry)}</td><td>${money(px)}</td><td>${money(p.notional)}</td>
            <td class="${pnl >= 0 ? 'up' : 'down'}"><b>${pnl >= 0 ? '+' : '−'}${money(Math.abs(pnl))}</b></td>
            <td><button class="btn sm" data-realclose="${esc(sym)}">Close at live price</button></td></tr>`;
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
      const s2 = stats(src, st.prices);
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
      toast(r.trade ? `Recorded — ${r.trade.pnl >= 0 ? 'profit' : 'loss'} ${r.trade.pnlPct}%.` : `Open ${f3.sym.value} trade recorded.`, r.trade && r.trade.pnl < 0 ? 'down' : 'up');
      draw();
    });
    $$('[data-realclose]', el).forEach((b) => b.addEventListener('click', () => {
      const sym = b.dataset.realclose;
      const rs = realState();
      const px = st.prices[sym] ?? rs.open[sym]?.entry;
      const r = closeManual(rs, cfg, sym, px);
      if (!r.ok) { toast(r.error, 'down'); return; }
      save(REAL_KEY, rs);
      toast(`${sym} closed at ${money(px)}.`, r.trade.pnl >= 0 ? 'up' : 'down');
      draw();
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
        <p class="fine">Nothing here yet. Open any coin, press <b>Trade</b>, and use <b>Buy (demo)</b> to place a practice trade yourself at the live price. It is kept apart from the AI's account below, so your experiments never distort the strategy's record.</p></div>`;
    }
    const s2 = stats(ms, st.prices);
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
          const px = st.prices[sym] ?? p.entry;
          const pnl = (px - p.entry) * p.qty;
          return `<tr><td class="l"><b>${esc(sym)}</b></td><td>${money(p.entry)}</td><td>${money(px)}</td><td>${money(p.notional)}</td>
            <td class="${pnl >= 0 ? 'up' : 'down'}"><b>${pnl >= 0 ? '+' : '−'}${money(Math.abs(pnl))}</b> <small>${pct((px / p.entry - 1) * 100)}</small></td>
            <td><button class="btn sm" data-mysell="${esc(sym)}">Sell</button></td></tr>`;
        }).join('')}
      </tbody></table></div>` : ''}
      ${closed.length ? `<div class="tbl-wrap mt"><table class="tbl"><thead><tr><th class="l">Coin</th><th class="l">Closed</th><th>Bought</th><th>Sold</th><th>Result</th></tr></thead><tbody>
        ${closed.map((t) => `<tr><td class="l"><b>${esc(t.symbol)}</b></td><td class="l fine">${dateTime(t.exitAt, false)}</td><td>${money(t.entry)}</td><td>${money(t.exit)}</td>
          <td class="${t.pnl >= 0 ? 'up' : 'down'}"><b>${t.pnl >= 0 ? '+' : '−'}${money(Math.abs(t.pnl))}</b> <small>${pct(t.pnlPct)}</small></td></tr>`).join('')}
      </tbody></table></div>` : ''}
      <p class="fine mt">${esc(PAPER_NOTICE)}</p>
    </div>`;
  }

  function wireMyDemo() {
    $('#myReset', el)?.addEventListener('click', () => {
      save(MY_KEY, newState(cfg));
      toast('Your demo account is back to its starting balance.', 'info');
      draw();
    });
    $$('[data-mysell]', el).forEach((b) => b.addEventListener('click', () => {
      const sym = b.dataset.mysell;
      const ms = myState();
      const px = st.prices[sym] ?? ms.open[sym]?.entry;
      const r = closeManual(ms, cfg, sym, px);
      if (!r.ok) { toast(r.error, 'down'); return; }
      save(MY_KEY, ms);
      toast(`Sold ${sym} — ${r.trade.pnl >= 0 ? 'profit' : 'loss'} ${r.trade.pnlPct}%.`, r.trade.pnl >= 0 ? 'up' : 'down');
      draw();
    }));
  }

  function draw() {
    if (!state) { $('#body', el).innerHTML = `${myDemoCard()}${realCard()}<div class="mt">${verdictCard()}</div>${startCard()}`; wireMyDemo(); wireReal(); wireExports(); drawRealChart(); syncRunButtons(); syncSessionChip(); return; }
    const s = stats(state, st.prices);
    const open = Object.entries(state.open);
    const closed = [...state.closed].reverse();

    $('#body', el).innerHTML = `
      ${myDemoCard()}
      ${realCard()}
      <h3 class="mt" style="margin-bottom:8px">The AI's own account</h3>
      ${verdictCard()}
      <div class="grid g4">
        <div class="card"><div class="stat"><span class="k">Balance now</span><span class="v ${s.returnPct >= 0 ? 'up' : 'down'}">${money(s.equity)}</span><span class="s fine">started at ${money(s.startingBalance)}</span></div></div>
        <div class="card"><div class="stat"><span class="k">Return</span><span class="v ${s.returnPct >= 0 ? 'up' : 'down'}">${pct(s.returnPct)}</span><span class="s fine">since ${dateTime(s.since, false)}${s.since < s.liveSince - 60e3 ? ` · replayed until ${dateTime(s.liveSince)}` : ''}</span></div></div>
        <div class="card"><div class="stat"><span class="k">Win rate</span><span class="v">${s.winRate === null ? '—' : `${s.winRate}%`}</span><span class="s fine">${s.wins}W / ${s.losses}L${s.profitFactor ? ` · PF ${s.profitFactor}` : ''}</span></div></div>
        <div class="card"><div class="stat"><span class="k">Max drawdown</span><span class="v down">${pct(-s.maxDrawdownPct, 1)}</span><span class="s fine">${s.openCount} open · ${s.trades} closed</span></div></div>
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
          <label class="fld">Risk per trade %<input class="inp" name="riskPct" type="number" min="0.1" max="10" step="0.1" value="${cfg.riskPct}" style="width:120px"></label>
          <label class="fld">Max open<input class="inp" name="maxPositions" type="number" min="1" max="10" value="${cfg.maxPositions}" style="width:90px"></label>
        </div>
        <label class="fld">Chart<select class="inp" name="interval">${['15m', '1h', '4h', '1d'].map((i) => `<option ${i === cfg.interval ? 'selected' : ''}>${i}</option>`).join('')}</select></label>
        <label class="fld">Coins it may trade<input class="inp" name="universe" value="${esc(cfg.universe.join(', '))}"></label>
        <p class="fine">Available: ${esc(tradable.slice(0, 24).map((c) => c.symbol).join(', '))}…</p>
        <button class="btn primary">Save settings</button>
      </form>`);
    $('#cf', m.el).addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      const uni = f.universe.value.split(',').map((x) => x.trim().toUpperCase()).filter((x) => tradable.some((c) => c.symbol === x));
      if (!uni.length) { toast('Pick at least one tradable coin.', 'down'); return; }
      Object.assign(cfg, {
        startingBalance: Math.max(100, +f.startingBalance.value),
        riskPct: Math.min(10, Math.max(0.1, +f.riskPct.value)),
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
  const timer = setInterval(() => { if (!st.disposed && state && autoOn) catchUp(); }, 5 * 60e3);

  // draw() renders the demo and real accounts too, so it has to run whether or
  // not the AI has ever been started — otherwise a user who placed a demo trade
  // from a coin page arrives here and sees nothing but the start card.
  draw();
  syncRunButtons();
  syncSessionChip();
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
    st.charts.forEach((c) => c.destroy());
  };
}
