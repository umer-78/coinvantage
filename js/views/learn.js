// AI learning: how the AI grades its own calls and changes its own decisions.
import { $, $$, icon, toast, bindSeg } from '../ui.js';
import { esc, dateTime, ago, horizonText } from '../format.js';
import { load } from '../store.js';
import { INDICATORS, LEARN_TESTED, SWITCH_MIN, SWITCH_GAP, liveScores } from '../lib/learncenter.js';
import { learningPass, loadLearn } from '../lib/learnpass.js';
import { cloudLearning } from '../lib/cloudlearn.js';
import { remove } from '../store.js';
import { DEFAULT_CONFIG, CHART_TESTED, rulesForChart } from '../lib/autotrader.js';
import { DEFAULT_HORIZON } from '../ai/context.js';
import { activeLessons, reviewTrades } from '../lib/tradelearn.js';
import { TESTED_ACCURACY, recheckOverall } from '../lib/predict.js';
import { FORECAST_TESTED } from '../lib/forecastview.js';
import { learningStatus, loadLedger, learnedTrust, MIN_GRADED_FOR_TRUST, TREND_WORDS } from '../lib/selfimprove.js';

export const title = 'AI learning';

export async function render(el) {
  const st = { interval: '1h', running: false, disposed: false, last: null, cloud: null };
  const CHARTS = ['1m', '5m', '15m', '1h', '4h', '1d'];
  el.innerHTML = `
    <div class="page-head">
      <div><h1>AI learning</h1>
        <p>How the AI grades its own calls and changes its own decisions. Every indicator, the forecast and the trader are scored against what the market actually did. A method only gains influence when its record earns it, and only keeps it while it stays ahead. Every number here was measured, and each one shows how many calls it rests on. None of this has yet made calls on price direction better than chance in testing: the learned blend tied the forecast in the release test, and the trader's self-review changed a rule once in eight test runs.</p></div>
      <div class="row">
        <div class="seg" id="iv">${CHARTS.map((i) => `<button data-v="${i}" class="${i === st.interval ? 'on' : ''}">${i}</button>`).join('')}</div>
        <button class="btn primary" id="pass">${icon('refresh', 16)} Refresh</button>
      </div>
    </div>
    <p class="fine" id="status" style="margin-top:-6px"></p>
    <div id="body"></div>`;

  // A call is only scored once its horizon has passed, so right after the first
  // pass there are logged calls but nothing scored — say that, not "no calls".
  const soon = (at) => { const m = Math.max(1, Math.round((at - Date.now()) / 60e3)); return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`; };
  // waiting: how many calls wait for their outcome, and when the first is due
  const pctTxt = (s, waiting = { n: 0, next: null }) => {
    if (s && s.rate !== null) return `<b>${s.rate}%</b> <span class="fine">(${s.hits}/${s.n} · 95% range ${s.lo}–${s.hi}%)</span>`;
    if (!waiting.n) return '<span class="muted">no calls logged yet</span>';
    const next = waiting.next;
    return `<span class="muted">none scored yet · ${waiting.n} waiting${Number.isFinite(next) ? ` · first result ${next > Date.now() ? `in about ${soon(next)}` : 'at the next pass'}` : ''}</span>`;
  };
  const waitingOf = (rows, key) => {
    const w = rows.filter((r) => !r.resolved && Number.isFinite(r[key]));
    return { n: w.length, next: w.length ? Math.min(...w.map((r) => r.horizonAt || Infinity)) : null };
  };
  const chip = (s) => {
    if (!s || !s.n) return '<span class="chip">no data</span>';
    if (s.weight > 0) return '<span class="chip up">earns a vote</span>';
    if (s.weight < 0) return '<span class="chip warn">read in reverse</span>';
    return `<span class="chip">${esc(s.verdict)}</span>`;
  };

  function draw() {
    // The cloud's record for this chart when it can be read; this browser's own
    // learning passes only when it cannot (no backend, or offline).
    const C = st.cloud?.[st.interval] || null;
    const L = C ? null : loadLearn();
    const live = C ? C.live : liveScores(L, st.interval);
    const liveCall = C ? C.live : liveScores(L);
    const hist = C ? C.history : L.history?.[st.interval]?.table || null;
    const weights = (C ? C.weights : L.weights?.[st.interval]) || {};
    const champion = (C ? C.champion : L.champion) || 'forecast';
    const waitF = C ? { n: C.waiting.forecast, next: C.waiting.nextAt } : waitingOf(L.rows, 'forecastProb');
    const waitB = C ? { n: C.waiting.blend, next: C.waiting.nextAt } : waitingOf(L.rows, 'blendProb');
    const where = C ? `the cloud's live record on ${esc(st.interval)}` : 'this browser';
    // the same rules the Trading page trades: its settings, the chart the
    // account runs on, and the self-review's lessons
    const saved = load('traderCfg', {}) || {};
    const lessons = load('traderLessons', []) || [];
    const traderIv = load('traderState', null)?.interval || saved.interval || DEFAULT_CONFIG.interval;
    const cfg = rulesForChart({ ...DEFAULT_CONFIG, ...Object.fromEntries(Object.entries(saved).filter(([k]) => ['universe', 'minAdx', 'maxEntryRsi', 'excluded', 'strategy', 'custom'].includes(k))) }, traderIv, lessons);
    const ledger = loadLedger();
    const fl = learningStatus(ledger);
    const tested = LEARN_TESTED.byInterval[st.interval];
    const changes = [
      ...((C ? Object.values(st.cloud).flatMap((x) => x.changes || []) : L.changes) || []).map((c) => ({ at: c.at, text: c.text, tag: c.kind === 'champion' ? `call maker · ${c.interval}` : `indicators · ${c.interval}` })),
      ...lessons.map((l) => ({ at: l.at, text: l.text, tag: 'trader' })),
    ].sort((a, b) => b.at - a.at).slice(0, 25);
    const closedOf = (key) => (load(key, null)?.closed || []);
    const accounts = [
      { name: "The AI's trades", r: reviewTrades(closedOf('traderState')) },
      { name: 'Your demo buys', r: reviewTrades(closedOf('myDemoState'), { includeManual: true }) },
      { name: 'Your real trades', r: reviewTrades(closedOf('realTradeState'), { includeManual: true }) },
    ];
    const voting = Object.entries(weights).filter(([, w]) => w).map(([k, w]) => `${INDICATORS[k].name} (${w > 0 ? '+' : ''}${w})`);

    $('#status', el).textContent = C
      ? `Learning in the cloud around the clock, with every browser closed: ${C.coins} coins, every chart in turn. On ${st.interval}: last pass ${ago(C.lastPass)} · ${C.calls.toLocaleString('en-US')} calls logged · ${C.scored.toLocaleString('en-US')} scored${C.expired ? ` · ${C.expired} could not be graded (their candle was out of reach)` : ''}. The same record on every device.`
      : st.cloud === false
        ? (L.lastPass ? `The cloud's record could not be read, so this browser learns while the page is open. Last pass ${ago(L.lastPass)} · ${L.rows.length} calls logged · ${L.rows.filter((r) => r.resolved).length} scored.` : 'The cloud\'s record could not be read, so this browser learns while the page is open. Press Refresh to start.')
        : st.cloud ? `The cloud has not learned on ${st.interval} yet: it takes each chart in turn every five minutes, so its first pass is due within half an hour.` : 'Reading the cloud\'s record…';
    $('#body', el).innerHTML = `
      <div class="grid g2">
        <div class="card">
          <div class="card-h"><h3>${icon('ai', 16)} Who makes the call right now</h3><span class="chip ${champion === 'blend' ? 'up' : ''}">${champion === 'blend' ? 'Learned blend' : 'Forecast engine'}</span></div>
          <p class="fine" style="margin-top:0">Two methods compete. The <b>forecast engine</b> (seven models) makes the call by default. The <b>learned blend</b> adds the indicators that have earned a vote. The blend only takes over after at least ${SWITCH_MIN} scored live calls each, and only if it leads by ${SWITCH_GAP}+ points with its whole 95% range above the forecast's rate. It hands the call back as soon as it falls behind.</p>
          <dl class="kv">
            <dt>Forecast, live</dt><dd>${pctTxt(liveCall.forecast, waitF)}</dd>
            <dt>Blend, live</dt><dd>${pctTxt(liveCall.blend, waitB)}</dd>
            <dt>Release test</dt><dd>forecast ${LEARN_TESTED.forecast}% · blend ${LEARN_TESTED.blend}% <span class="fine">(${LEARN_TESTED.tests.toLocaleString()} calls${tested ? `; ${esc(st.interval)}: ${tested[0]}% vs ${tested[1]}%` : ''})</span></dd>
          </dl>
          <p class="fine mt">${(() => { const by = Object.entries(LEARN_TESTED.byInterval); const better = by.filter(([, [f, b]]) => b > f).map(([k]) => k), worse = by.filter(([, [f, b]]) => b < f).map(([k]) => k); return `In the latest test (${LEARN_TESTED.tests.toLocaleString()} calls on ${LEARN_TESTED.coins} coins) the blend scored ${LEARN_TESTED.blend}% against the forecast's ${LEARN_TESTED.forecast}%${better.length ? `: better on ${better.join(', ')}` : ''}${worse.length ? `${better.length ? ', ' : ': '}worse on ${worse.join(', ')}` : ''}. That is not a reason to switch, so it starts as the challenger and has to prove itself in ${where} first.`; })()}${C?.reason ? ` ${esc(C.reason)}` : ''}</p>
        </div>
        <div class="card">
          <div class="card-h"><h3>${icon('forecast', 16)} Forecast record</h3><span class="chip">${esc(TREND_WORDS[fl.trend] || fl.trend)}</span></div>
          <dl class="kv">
            ${(() => {
              // the latest test first, and the older release test beside it, each dated
              // the at-scale test only (5m–1d): 1m is not shown centred
              const big = Object.values(FORECAST_TESTED.centred).filter((x) => x.coins >= 20);
              const c80 = big.map((x) => x.band80);
              const n80 = big.reduce((a, x) => a + x.tests, 0);
              const ro = recheckOverall();
              return `${ro ? `<dt>Direction, latest test</dt><dd>${ro.hit}% <span class="fine">vs ${ro.baseline}% baseline · ${ro.tests.toLocaleString('en-US')} tests on ${ro.coins} coins, ${esc(ro.measuredOn)}</span></dd>` : ''}
            <dt>Direction, release test</dt><dd>${TESTED_ACCURACY.all}% <span class="fine">vs ${TESTED_ACCURACY.allBaseline}% baseline · ${TESTED_ACCURACY.tests.toLocaleString()} tests</span></dd>
            <dt>80% range held</dt><dd>${c80.length ? `${Math.min(...c80)}–${Math.max(...c80)}%` : '—'} <span class="fine">(target 80%; by chart, centred on today's price, ${n80.toLocaleString('en-US')} tests on ${(() => { const k = big.map((x) => x.coins); const lo = Math.min(...k), hi = Math.max(...k); return lo === hi ? hi : `${lo}–${hi}`; })()} coins, ${esc(FORECAST_TESTED.centredMeasuredOn)}; ${TESTED_ACCURACY.bandsAll.band80}% in the release test)</span></dd>`;
            })()}
            <dt>90% range held</dt><dd>${TESTED_ACCURACY.bandsAll.band90}% <span class="fine">(target 90%)</span></dd>
            <dt>Your record (last 50)</dt><dd>${fl.windows[50].pct === null ? '<span class="muted">not enough yet</span>' : `${fl.windows[50].pct}% <span class="fine">(${fl.windows[50].hits}/${fl.windows[50].total})</span>`}</dd>
          </dl>
          <h4 class="mt" style="margin-bottom:6px">How far its direction is trusted</h4>
          <div class="tbl-wrap"><table class="tbl"><thead><tr><th class="l">Chart</th><th>Release test</th><th>Graded for you</th><th>Used now</th></tr></thead><tbody>
            ${['1m', '5m', '15m', '1h', '4h', '1d'].map((iv) => {
              const t = learnedTrust(ledger, iv);
              return `<tr><td class="l">${iv}</td><td>${t.prior.toFixed(2)}</td><td>${t.local === null ? `<span class="muted">${t.graded} of ${MIN_GRADED_FOR_TRUST}</span>` : `${t.local.toFixed(2)} <span class="fine">(${t.graded})</span>`}</td><td><b>${t.trust.toFixed(2)}</b></td></tr>`;
            }).join('')}
          </tbody></table></div>
          <p class="fine">The chance of rise on each chart is the models' raw lean shrunk by this number: 1 keeps it as is, 0 means the lean carried no information in testing, so no chance is shown there. Once a chart has ${MIN_GRADED_FOR_TRUST} of your forecasts graded (signed in, the record is kept with your account, so every device adds to it), their record adjusts the number, weighted against the release test's ${TESTED_ACCURACY.testsPerInterval} forecasts per chart. A chart the release test found nothing on stays at 0.</p>
          <p class="fine mt">The forecast retrains all seven models on each coin's newest candles every time it runs. Once your record has enough scored calls, a weak recent record pulls the displayed confidence toward 50/50 by itself.</p>
        </div>
      </div>

      <div class="card mt">
        <div class="card-h"><h3>${icon('chart', 16)} Indicators, graded (${esc(st.interval)})</h3><span class="fine">${voting.length ? `voting now: ${esc(voting.join(', '))}` : 'no indicator has earned a vote on this timeframe'}</span></div>
        <p class="fine" style="margin-top:0">Each indicator's reading is turned into a call (for example, RSI under 30 means "up"), then checked against the price ${esc(horizonText(st.interval, DEFAULT_HORIZON[st.interval] || 12))} later (the same horizon the forecast uses on ${esc(st.interval)} charts). <b>Recent history</b> is measured on the last 500 candles of ${C ? `each of the ${C.coins} coins, again each time the cloud comes back to it` : "the trader's coins during each pass"}. <b>Live</b> counts only calls ${C ? 'the cloud' : 'this browser'} logged before the outcome was known. A reading needs 30+ calls and a 95% range clear of 50% to earn a vote. Live evidence takes over from history as it builds up.</p>
        ${hist ? `<div class="tbl-wrap"><table class="tbl fit"><thead><tr><th class="l">Indicator</th><th class="l hide-p">Rule</th><th>Recent history</th><th>Live</th><th class="hide-t">Tested alone</th><th>Weight now</th></tr></thead><tbody>
          ${Object.entries(INDICATORS).map(([k, d]) => `<tr><td class="l wrap"><b>${esc(d.name)}</b><small class="show-p-block">${esc(d.rule)}</small></td><td class="l fine wrap hide-p" style="min-width:140px">${esc(d.rule)}</td>
            <td>${hist[k] ? `${hist[k].rate ?? '—'}% <span class="fine">(${hist[k].n})</span>` : '—'}</td>
            <td>${live[k]?.n ? `${live[k].rate}% <span class="fine">(${live[k].n})</span>` : '<span class="muted">—</span>'}</td>
            <td class="fine hide-t">${LEARN_TESTED.indicatorsAlone[k] ?? '—'}%</td>
            <td>${chip({ ...(hist[k] || {}), weight: weights[k] || 0, n: (hist[k]?.n || 0) + (live[k]?.n || 0) })}</td></tr>`).join('')}
        </tbody></table></div>` : `<p class="muted">${C || st.cloud ? 'Not graded on this chart yet: the cloud takes each chart in turn.' : 'Press Refresh to grade the indicators on this timeframe.'}</p>`}
        <p class="fine mt">"Tested alone" is each indicator's hit rate at the 1,440 release-test points across all timeframes. None is far from 50%, which is why the page is careful about which ones get a vote.</p>
      </div>

      <div class="card mt">
        <div class="card-h"><h3>${icon('chart', 16)} Buy trades, graded</h3><span class="fine">what happened after each buy</span></div>
        <p class="fine" style="margin-top:0">Every closed buy is checked against what the chart did next. Buys are grouped by the chart at the moment of buying (with or against the trend, trending or ranging, RSI stretched or not), so a pattern that keeps losing shows up here. That covers the AI's simulated trades, your own demo buys, and the real trades you recorded. Results are in R: 1R is the amount a trade risked.</p>
        <div class="tbl-wrap"><table class="tbl fit"><thead><tr><th class="l">Account</th><th>Closed buys</th><th class="hide-p">Won</th><th>Average</th><th class="l">What stands out</th></tr></thead><tbody>
          ${accounts.map((a) => `<tr><td class="l wrap"><b>${esc(a.name)}</b></td><td>${a.r.overall.n}</td><td class="hide-p">${a.r.overall.winRate === null ? '—' : a.r.overall.winRate + '%'}</td><td class="${a.r.overall.avgR > 0 ? 'up' : a.r.overall.avgR < 0 ? 'down' : ''}">${a.r.overall.avgR === null ? '—' : (a.r.overall.avgR > 0 ? '+' : '') + a.r.overall.avgR + 'R'}</td><td class="l fine wrap" style="min-width:110px">${esc(a.r.findings[0] || '—')}</td></tr>`).join('')}
        </tbody></table></div>
        ${accounts.flatMap((a) => a.r.findings.slice(1).map((f) => `<p class="fine">${esc(a.name)}: ${esc(f)}</p>`)).join('')}
      </div>

      <div class="card mt">
        <div class="card-h"><h3>${icon('bolt', 16)} Trading</h3><a class="btn sm" href="#/trader">Open the trader</a></div>
        <p class="fine" style="margin-top:0">After every check the AI trader reads its own trade log. It switches on a filter when one market condition keeps losing, and switches it off again if results get worse. Its rules were picked on older candles and run on newer ones they had never seen, three times: on ${esc(cfg.interval)} they averaged ${CHART_TESTED[cfg.interval] ? (() => { const x = CHART_TESTED[cfg.interval], t = x.adopt ? x.own : x.standard; return `${t.ret}% per ${x.block} against ${x.hold}% for holding the same coins`; })() : 'an untested result'}.</p>
        <p class="fine"><b>Rules in force:</b> ${esc((activeLessons(cfg).join(' · ')) || 'the original strategy')}.</p>
      </div>

      <div class="card mt">
        <div class="card-h"><h3>${icon('info', 16)} What the AI changed, and when</h3><span class="fine">newest first</span></div>
        ${changes.length ? `<ul class="fine" style="list-style:none;padding:0;margin:0">${changes.map((c) => `<li style="padding:6px 0;border-bottom:1px solid var(--border)"><span class="muted" style="display:inline-block;min-width:150px">${dateTime(c.at)}</span><span class="chip" style="margin-right:6px">${esc(c.tag)}</span>${esc(c.text)}</li>`).join('')}</ul>`
          : '<p class="muted">Nothing yet. Changes appear here as soon as the evidence justifies one.</p>'}
      </div>`;
  }

  // Read the cloud's record; only when it cannot be read does this browser run
  // a learning pass of its own (and keep it here).
  async function pass({ force = false } = {}) {
    if (st.running) return;
    st.running = true;
    const b = $('#pass', el); const old = b.innerHTML; b.disabled = true;
    try {
      const cloud = await cloudLearning({ force });
      if (st.disposed) return;
      if (cloud) {
        st.cloud = cloud;
        // the cloud keeps the record now: this browser's old copy is not needed
        remove('aiLearn');
        return;
      }
      st.cloud = false;
      const r = await learningPass(st.interval, { onStep: (s) => { if (!st.disposed) b.innerHTML = `<span class="spinner"></span> ${esc(s)}`; } });
      if (st.disposed) return;
      toast(r.changes.length ? `Learning pass done — ${r.changes.length} change${r.changes.length > 1 ? 's' : ''}.` : 'Learning pass done — nothing clear enough to change.', r.changes.length ? 'up' : 'info');
    } catch { toast('The learning pass could not load market data. Try again in a moment.', 'down'); }
    finally { st.running = false; if (!st.disposed) { b.disabled = false; b.innerHTML = old; draw(); } }
  }

  bindSeg($('#iv', el), (v) => { st.interval = v; draw(); if (st.cloud === false && !loadLearn().history?.[v]) pass(); });
  $('#pass', el).addEventListener('click', () => pass({ force: true }));
  draw();
  pass();
  const timer = setInterval(() => { if (!st.disposed && !document.hidden) pass(); }, 2 * 60e3);
  return () => { st.disposed = true; clearInterval(timer); };
}
