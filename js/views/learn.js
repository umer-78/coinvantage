// AI learning: how the AI grades its own calls and changes its own decisions.
import { $, $$, icon, toast, bindSeg } from '../ui.js';
import { esc, dateTime, ago } from '../format.js';
import { load } from '../store.js';
import { INDICATORS, LEARN_TESTED, SWITCH_MIN, SWITCH_GAP, liveScores } from '../lib/learncenter.js';
import { learningPass, loadLearn } from '../lib/learnpass.js';
import { DEFAULT_CONFIG, AUTOTRADER_TESTED } from '../lib/autotrader.js';
import { activeLessons, reviewTrades } from '../lib/tradelearn.js';
import { TESTED_ACCURACY } from '../lib/predict.js';
import { learningStatus, loadLedger, learnedTrust, MIN_GRADED_FOR_TRUST } from '../lib/selfimprove.js';

export const title = 'AI learning';

export async function render(el) {
  const st = { interval: '1h', running: false, disposed: false, last: null };
  el.innerHTML = `
    <div class="page-head">
      <div><h1>AI learning</h1>
        <p>How the AI grades its own calls and changes its own decisions. Every indicator, the forecast and the trader are scored against what the market actually did. A method only gains influence when its record earns it, and only keeps it while it stays ahead. Every number here was measured, and each one shows how many calls it rests on.</p></div>
      <div class="row">
        <div class="seg" id="iv">${['15m', '1h', '4h', '1d'].map((i) => `<button data-v="${i}" class="${i === st.interval ? 'on' : ''}">${i}</button>`).join('')}</div>
        <button class="btn primary" id="pass">${icon('refresh', 16)} Run a learning pass now</button>
      </div>
    </div>
    <p class="fine" id="status" style="margin-top:-6px"></p>
    <div id="body"></div>`;

  // A call is only scored once its horizon has passed, so right after the first
  // pass there are logged calls but nothing scored — say that, not "no calls".
  const soon = (at) => { const m = Math.max(1, Math.round((at - Date.now()) / 60e3)); return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`; };
  const pctTxt = (s, rows = [], key = '') => {
    if (s && s.rate !== null) return `<b>${s.rate}%</b> <span class="fine">(${s.hits}/${s.n} · 95% range ${s.lo}–${s.hi}%)</span>`;
    const waiting = rows.filter((r) => !r.resolved && Number.isFinite(r[key]));
    if (!waiting.length) return '<span class="muted">no calls logged yet</span>';
    const next = Math.min(...waiting.map((r) => r.horizonAt || Infinity));
    return `<span class="muted">none scored yet · ${waiting.length} waiting${Number.isFinite(next) ? ` · first result ${next > Date.now() ? `in about ${soon(next)}` : 'at the next pass'}` : ''}</span>`;
  };
  const chip = (s) => {
    if (!s || !s.n) return '<span class="chip">no data</span>';
    if (s.weight > 0) return '<span class="chip up">earns a vote</span>';
    if (s.weight < 0) return '<span class="chip warn">read in reverse</span>';
    return `<span class="chip">${esc(s.verdict)}</span>`;
  };

  function draw() {
    const L = loadLearn();
    const live = liveScores(L, st.interval);
    const liveAll = liveScores(L);
    const hist = L.history?.[st.interval]?.table || null;
    const weights = L.weights?.[st.interval] || {};
    const champion = L.champion || 'forecast';
    const cfg = { ...DEFAULT_CONFIG, ...(load('traderCfg', {}) || {}) };
    const lessons = load('traderLessons', []) || [];
    const ledger = loadLedger();
    const fl = learningStatus(ledger);
    const tested = LEARN_TESTED.byInterval[st.interval];
    const changes = [
      ...(L.changes || []).map((c) => ({ at: c.at, text: c.text, tag: c.kind === 'champion' ? 'call maker' : `indicators · ${c.interval}` })),
      ...lessons.map((l) => ({ at: l.at, text: l.text, tag: 'trader' })),
    ].sort((a, b) => b.at - a.at).slice(0, 25);
    const closedOf = (key) => (load(key, null)?.closed || []);
    const accounts = [
      { name: "AI's paper trades", r: reviewTrades(closedOf('traderState')) },
      { name: 'Your demo buys', r: reviewTrades(closedOf('myDemoState'), { includeManual: true }) },
      { name: 'Your real trades', r: reviewTrades(closedOf('realTradeState'), { includeManual: true }) },
    ];
    const voting = Object.entries(weights).filter(([, w]) => w).map(([k, w]) => `${INDICATORS[k].name} (${w > 0 ? '+' : ''}${w})`);

    $('#status', el).textContent = L.lastPass ? `Last learning pass ${ago(L.lastPass)} · ${L.rows.length} calls logged on this device · ${L.rows.filter((r) => r.resolved).length} already scored` : 'No learning pass on this device yet. Press "Run a learning pass now" to start.';
    $('#body', el).innerHTML = `
      <div class="grid g2">
        <div class="card">
          <div class="card-h"><h3>${icon('ai', 16)} Who makes the call right now</h3><span class="chip ${champion === 'blend' ? 'up' : ''}">${champion === 'blend' ? 'Learned blend' : 'Forecast engine'}</span></div>
          <p class="fine" style="margin-top:0">Two methods compete. The <b>forecast engine</b> (seven models) makes the call by default. The <b>learned blend</b> adds the indicators that have earned a vote. The blend only takes over after at least ${SWITCH_MIN} scored live calls each, and only if it leads by ${SWITCH_GAP}+ points with its whole 95% range above the forecast's rate. It hands the call back as soon as it falls behind.</p>
          <dl class="kv">
            <dt>Forecast, live</dt><dd>${pctTxt(liveAll.forecast, L.rows, 'forecastProb')}</dd>
            <dt>Blend, live</dt><dd>${pctTxt(liveAll.blend, L.rows, 'blendProb')}</dd>
            <dt>Release test</dt><dd>forecast ${LEARN_TESTED.forecast}% · blend ${LEARN_TESTED.blend}% <span class="fine">(${LEARN_TESTED.tests.toLocaleString()} calls${tested ? `; ${esc(st.interval)}: ${tested[0]}% vs ${tested[1]}%` : ''})</span></dd>
          </dl>
          <p class="fine mt">In the release test the blend <b>tied</b> the forecast overall. It did better on 1h, 4h and 1d and worse on 1m, 5m and 15m. A tie is not a reason to switch, so it starts as the challenger and has to prove itself on this device first.</p>
        </div>
        <div class="card">
          <div class="card-h"><h3>${icon('forecast', 16)} Forecast record</h3><span class="chip">${esc(fl.trend.replace('-', ' '))}</span></div>
          <dl class="kv">
            <dt>Tested accuracy</dt><dd>${TESTED_ACCURACY.all}% <span class="fine">vs ${TESTED_ACCURACY.allBaseline}% baseline · ${TESTED_ACCURACY.tests.toLocaleString()} tests</span></dd>
            <dt>80% range held</dt><dd>${TESTED_ACCURACY.bandsAll.band80}% <span class="fine">(target 80%)</span></dd>
            <dt>90% range held</dt><dd>${TESTED_ACCURACY.bandsAll.band90}% <span class="fine">(target 90%)</span></dd>
            <dt>This device (last 50)</dt><dd>${fl.windows[50].pct === null ? '<span class="muted">not enough yet</span>' : `${fl.windows[50].pct}% <span class="fine">(${fl.windows[50].hits}/${fl.windows[50].total})</span>`}</dd>
          </dl>
          <h4 class="mt" style="margin-bottom:6px">How far its direction is trusted</h4>
          <div class="tbl-wrap"><table class="tbl"><thead><tr><th class="l">Chart</th><th>Release test</th><th>Graded here</th><th>Used now</th></tr></thead><tbody>
            ${['1m', '5m', '15m', '1h', '4h', '1d'].map((iv) => {
              const t = learnedTrust(ledger, iv);
              return `<tr><td class="l">${iv}</td><td>${t.prior.toFixed(2)}</td><td>${t.local === null ? `<span class="muted">${t.graded} of ${MIN_GRADED_FOR_TRUST}</span>` : `${t.local.toFixed(2)} <span class="fine">(${t.graded})</span>`}</td><td><b>${t.trust.toFixed(2)}</b></td></tr>`;
            }).join('')}
          </tbody></table></div>
          <p class="fine">The chance of rise on each chart is the models' raw lean shrunk by this number: 1 keeps it as is, 0 means the lean carried no information in testing, so no chance is shown there. Once a chart has ${MIN_GRADED_FOR_TRUST} forecasts graded on this device, their record adjusts the number, weighted against the release test's ${TESTED_ACCURACY.testsPerInterval} forecasts per chart. A chart the release test found nothing on stays at 0.</p>
          <p class="fine mt">The forecast retrains all seven models on each coin's newest candles every time it runs. Once a device has enough scored calls, a weak recent record pulls its displayed confidence toward 50/50 by itself.</p>
        </div>
      </div>

      <div class="card mt">
        <div class="card-h"><h3>${icon('chart', 16)} Indicators, graded (${esc(st.interval)})</h3><span class="fine">${voting.length ? `voting now: ${esc(voting.join(', '))}` : 'no indicator has earned a vote on this timeframe'}</span></div>
        <p class="fine" style="margin-top:0">Each indicator's reading is turned into a call (for example, RSI under 30 means "up"), then checked against the price ${esc(st.interval)} candles later. <b>Recent history</b> is measured on the last 500 candles of the trader's coins during each pass. <b>Live</b> counts only calls this device logged before the outcome was known. A reading needs 30+ calls and a 95% range clear of 50% to earn a vote. Live evidence takes over from history as it builds up.</p>
        ${hist ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th class="l">Indicator</th><th class="l">Rule</th><th>Recent history</th><th>Live here</th><th>Tested alone</th><th>Weight now</th></tr></thead><tbody>
          ${Object.entries(INDICATORS).map(([k, d]) => `<tr><td class="l"><b>${esc(d.name)}</b></td><td class="l fine">${esc(d.rule)}</td>
            <td>${hist[k] ? `${hist[k].rate ?? '—'}% <span class="fine">(${hist[k].n})</span>` : '—'}</td>
            <td>${live[k]?.n ? `${live[k].rate}% <span class="fine">(${live[k].n})</span>` : '<span class="muted">—</span>'}</td>
            <td class="fine">${LEARN_TESTED.indicatorsAlone[k] ?? '—'}%</td>
            <td>${chip({ ...(hist[k] || {}), weight: weights[k] || 0, n: (hist[k]?.n || 0) + (live[k]?.n || 0) })}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="muted">Run a learning pass to grade the indicators on this timeframe.</p>'}
        <p class="fine mt">"Tested alone" is each indicator's hit rate at the 1,440 release-test points across all timeframes. None is far from 50%, which is why the page is careful about which ones get a vote.</p>
      </div>

      <div class="card mt">
        <div class="card-h"><h3>${icon('chart', 16)} Buy trades, graded</h3><span class="fine">what happened after each buy</span></div>
        <p class="fine" style="margin-top:0">Every closed buy is checked against what the chart did next. Buys are grouped by the chart at the moment of buying (with or against the trend, trending or ranging, RSI stretched or not), so a pattern that keeps losing shows up here. That covers the AI's paper trades, your own demo buys, and the real trades you recorded. Results are in R: 1R is the amount a trade risked.</p>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th class="l">Account</th><th>Closed buys</th><th>Won</th><th>Average</th><th class="l">What stands out</th></tr></thead><tbody>
          ${accounts.map((a) => `<tr><td class="l"><b>${esc(a.name)}</b></td><td>${a.r.overall.n}</td><td>${a.r.overall.winRate === null ? '—' : a.r.overall.winRate + '%'}</td><td class="${a.r.overall.avgR > 0 ? 'up' : a.r.overall.avgR < 0 ? 'down' : ''}">${a.r.overall.avgR === null ? '—' : (a.r.overall.avgR > 0 ? '+' : '') + a.r.overall.avgR + 'R'}</td><td class="l fine">${esc(a.r.findings[0] || '—')}</td></tr>`).join('')}
        </tbody></table></div>
        ${accounts.flatMap((a) => a.r.findings.slice(1).map((f) => `<p class="fine">${esc(a.name)}: ${esc(f)}</p>`)).join('')}
      </div>

      <div class="card mt">
        <div class="card-h"><h3>${icon('bolt', 16)} Trading</h3><a class="btn sm" href="#/trader">Open the trader</a></div>
        <p class="fine" style="margin-top:0">After every check the paper trader reads its own trade log. It switches on a filter when one market condition keeps losing, and switches it off again if results get worse. Its current rules were chosen on training data and scored on data they had never seen: on ${esc(cfg.interval)} they returned ${AUTOTRADER_TESTED[cfg.interval] ? `${AUTOTRADER_TESTED[cfg.interval].pickedReturn}% against ${AUTOTRADER_TESTED[cfg.interval].buyHold}% for buy-and-hold` : 'an untested result'}.</p>
        <p class="fine"><b>Rules in force:</b> ${esc((activeLessons(cfg).join(' · ')) || 'the original strategy')}.</p>
      </div>

      <div class="card mt">
        <div class="card-h"><h3>${icon('info', 16)} What the AI changed, and when</h3><span class="fine">newest first</span></div>
        ${changes.length ? `<ul class="fine" style="list-style:none;padding:0;margin:0">${changes.map((c) => `<li style="padding:6px 0;border-bottom:1px solid var(--border)"><span class="muted" style="display:inline-block;min-width:150px">${dateTime(c.at)}</span><span class="chip" style="margin-right:6px">${esc(c.tag)}</span>${esc(c.text)}</li>`).join('')}</ul>`
          : '<p class="muted">Nothing yet. Changes appear here as soon as the evidence justifies one.</p>'}
      </div>`;
  }

  async function pass() {
    if (st.running) return;
    st.running = true;
    const b = $('#pass', el); const old = b.innerHTML; b.disabled = true;
    try {
      const r = await learningPass(st.interval, { onStep: (s) => { if (!st.disposed) b.innerHTML = `<span class="spinner"></span> ${esc(s)}`; } });
      if (st.disposed) return;
      toast(r.changes.length ? `Learning pass done — ${r.changes.length} change${r.changes.length > 1 ? 's' : ''}.` : 'Learning pass done — nothing clear enough to change.', r.changes.length ? 'up' : 'info');
    } catch { toast('The learning pass could not load market data. Try again in a moment.', 'down'); }
    finally { st.running = false; if (!st.disposed) { b.disabled = false; b.innerHTML = old; draw(); } }
  }

  bindSeg($('#iv', el), (v) => { st.interval = v; draw(); if (!loadLearn().history?.[v]) pass(); });
  $('#pass', el).addEventListener('click', pass);
  draw();
  const L0 = loadLearn();
  if (!L0.lastPass || Date.now() - L0.lastPass > 5 * 60e3) pass();
  const timer = setInterval(() => { if (!st.disposed && !document.hidden) pass(); }, 5 * 60e3);
  return () => { st.disposed = true; clearInterval(timer); };
}
