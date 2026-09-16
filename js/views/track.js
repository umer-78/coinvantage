// Public track record: every signal the server logged, and how it actually turned out.
// Nothing here is curated — resolved rows are counted exactly as they closed.
import { $, $$, bindSeg, skeleton, icon } from '../ui.js';
import { esc, pct, money, dateTime } from '../format.js';
import { TESTED_ACCURACY } from '../lib/predict.js';
import { getTrackRecord, backendEnabled } from '../api/backend.js';
import { CONFIG } from '../config.js';
import { clockOffsetMs } from '../api/clock.js';
import { fx } from '../api/fx.js';

export const title = 'Track record';

const rate = (hit, n) => (n ? (hit / n) * 100 : null);

// What the scorer actually writes. The page used to look for 'win' and 'loss',
// which the database has never produced, so every plan statistic on this page
// rendered as an em dash from the day it launched.
const PLAN_WIN = new Set(['tp1', 'tp2', 'tp3', 'target']);
const PLAN_LOSS = new Set(['stop']);
// Rows logged before the relabelling still carry BUY / STRONG_BUY, so both
// vocabularies are rendered — the history is not rewritten to match the new
// wording, it is translated at display time.
const ACTION_WORDS = {
  STRONG_BUY: 'Extended up', BUY: 'Leaning up', NEUTRAL: 'No trend', SELL: 'Leaning down', STRONG_SELL: 'Extended down',
  EXTENDED_UP: 'Extended up', LEANING_UP: 'Leaning up', NO_TREND: 'No trend', LEANING_DOWN: 'Leaning down', EXTENDED_DOWN: 'Extended down',
};
const readable = (a) => ACTION_WORDS[a] || a || '—';
const toneOf = (a) => (/UP|BUY/.test(a || '') ? 'up' : /DOWN|SELL/.test(a || '') ? 'down' : '');

const PLAN_WORDS = { tp1: 'target 1', tp2: 'target 2', tp3: 'target 3', stop: 'stopped out', expired: 'expired flat', none: 'no plan' };

export async function render(el) {
  el.innerHTML = `
    <div class="page-head"><div><h1>Track record</h1><p>Every signal below was written to the database <b>before</b> the outcome was known, then scored automatically when its horizon passed.</p></div>
      <div class="seg" id="iv"><button data-v="all" class="on">All</button><button data-v="15m">15m</button><button data-v="1h">1h</button><button data-v="4h">4h</button><button data-v="1d">1d</button></div></div>
    <div class="card" id="dataCheck"><div class="row"><span class="spinner"></span><b>Checking live data against the exchange…</b></div></div>
    <div id="body">${skeleton(8, 24)}</div>`;

  // A claim you can check. This compares what the site shows right now against
  // the exchange's own number, live, in front of the reader.
  (async () => {
    const card = $('#dataCheck', el);
    if (!card) return;
    const rows = [];
    let worst = 0;
    try {
      const pairs = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
      const live = await fetch(`${CONFIG.BINANCE_REST[0]}/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(pairs))}`).then((r) => r.json());
      const list = await import('../api/market.js').then((m) => m.markets());
      for (const row of live) {
        const sym = row.symbol.replace('USDT', '');
        const ours = list.find((c) => c.symbol === sym);
        if (!ours) continue;
        const diff = Math.abs((ours.price - +row.price) / +row.price) * 100;
        worst = Math.max(worst, diff);
        rows.push(`<tr><td class="l"><b>${esc(sym)}</b></td><td>${money(+row.price)}</td><td>${money(ours.price)}</td><td class="${diff < 0.1 ? 'up' : 'warn'}">${diff.toFixed(3)}%</td></tr>`);
      }
    } catch { /* offline — say so rather than claiming a pass */ }
    const skew = clockOffsetMs();
    card.innerHTML = rows.length ? `
      <div class="card-h"><h3>Live data check</h3><span class="chip ${worst < 0.1 ? 'up' : 'warn'}">${worst < 0.1 ? 'Matching the exchange' : 'Slight drift'}</span></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th class="l">Coin</th><th>Exchange now</th><th>Shown here</th><th>Difference</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
      <p class="fine mt">Prices come straight from the exchange and are shown to the same number of decimals it quotes. Small differences are the seconds between the two readings, not rounding.
      Clock: this device is <b>${Math.abs(skew)} ms ${skew >= 0 ? 'behind' : 'ahead of'}</b> the exchange, and the app corrects for it, so every timestamp on the site is exchange time.
      Currency: 1 USD = ${fx.rate.toFixed(4)} ${esc(fx.code)}, from a live rate feed.</p>
      <p class="fine"><b>What is not exact:</b> forecasts. Prices are facts; a forecast is a probability, and the measured accuracy of this one is published below — never rounded up.</p>`
      : '<div class="card-h"><h3>Live data check</h3><span class="chip warn">Could not reach the exchange</span></div><p class="fine">The check needs a live connection to the exchange. It did not run, so nothing is being claimed here.</p>';
  })();

  if (!backendEnabled()) {
    $('#body', el).innerHTML = '<div class="card empty"><h3>Live tracking is not configured</h3><p>The backend that logs and scores signals is not connected on this deployment.</p></div>';
    return;
  }

  const rows = await getTrackRecord({ limit: 1000 }).catch(() => []);
  let interval = 'all';

  const draw = () => {
    const all = interval === 'all' ? rows : rows.filter((r) => r.interval === interval);
    const done = all.filter((r) => r.resolved);
    const fc = done.filter((r) => r.forecast_correct !== null);
    const hit = fc.filter((r) => r.forecast_correct).length;

    const plans = done.filter((r) => r.plan_result && r.plan_result !== 'none');
    const wins = plans.filter((r) => PLAN_WIN.has(r.plan_result)).length;
    const losses = plans.filter((r) => PLAN_LOSS.has(r.plan_result)).length;
    const expired = plans.filter((r) => r.plan_result === 'expired').length;
    const avgOf = (rs) => (rs.length ? rs.reduce((s, r) => s + (+r.plan_return_pct || 0), 0) / rs.length : null);
    const avgWin = avgOf(plans.filter((r) => PLAN_WIN.has(r.plan_result)));
    const avgLoss = avgOf(plans.filter((r) => PLAN_LOSS.has(r.plan_result)));
    // the average over every plan that closed, however it closed — expired ones
    // included, because a trade that went nowhere still tied up money
    const expectancy = avgOf(plans);

    // The number the hit rate has to beat. Always calling the more common
    // outcome costs nothing and needs no model, so an accuracy below it is not
    // an edge no matter how far above 50% it sits. This is computed from the
    // rows on screen rather than assumed, because the assumption the page
    // shipped with — "crypto drifts up, so always-up scores about 51%" — was
    // wrong for this sample, where only a third of the calls rose.
    const rose = fc.filter((r) => +r.outcome_price > +r.price).length;
    const rosePct = fc.length ? (rose / fc.length) * 100 : null;
    const baseline = rosePct === null ? null : Math.max(rosePct, 100 - rosePct);
    const baselineCall = rosePct === null ? null : rosePct >= 50 ? 'up' : 'down';

    // How each kind of call actually turned out. If the loudest label is the
    // worst performer, that belongs on this page and not in a footnote.
    const byAction = new Map();
    for (const r of fc) {
      const k = r.action || '—';
      const e = byAction.get(k) || { n: 0, hit: 0, rose: 0, ret: 0, retN: 0 };
      e.n++;
      if (r.forecast_correct) e.hit++;
      if (+r.outcome_price > +r.price) e.rose++;
      if (r.plan_return_pct !== null && r.plan_return_pct !== undefined) { e.ret += +r.plan_return_pct; e.retN++; }
      byAction.set(k, e);
    }
    const actionRows = [...byAction.entries()].sort((a, b) => b[1].n - a[1].n);

    // per-coin breakdown
    const bySym = new Map();
    for (const r of fc) {
      const e = bySym.get(r.symbol) || { n: 0, hit: 0 };
      e.n++; if (r.forecast_correct) e.hit++;
      bySym.set(r.symbol, e);
    }
    const symRows = [...bySym.entries()].filter(([, e]) => e.n >= 5).sort((a, b) => rate(b[1].hit, b[1].n) - rate(a[1].hit, a[1].n));

    const acc = rate(hit, fc.length);
    const beatsBaseline = acc !== null && baseline !== null && acc > baseline;
    const tested = TESTED_ACCURACY[interval === 'all' ? 'all' : interval];

    $('#body', el).innerHTML = `
      <div class="grid g4">
        <div class="card"><div class="stat"><span class="k">Direction called right</span><span class="v ${acc === null ? '' : beatsBaseline ? 'up' : 'down'}">${acc === null ? '—' : `${acc.toFixed(1)}%`}</span><span class="s fine">${fc.length} resolved forecast${fc.length === 1 ? '' : 's'}</span></div></div>
        <div class="card"><div class="stat"><span class="k">The number to beat</span><span class="v">${baseline === null ? '—' : `${baseline.toFixed(1)}%`}</span><span class="s fine">${baselineCall === null ? 'no resolved rows yet' : `always saying &quot;${baselineCall}&quot; over this same set`}</span></div></div>
        <div class="card"><div class="stat"><span class="k">Trade plans that reached a target</span><span class="v ${plans.length && wins / plans.length >= 0.5 ? 'up' : plans.length ? 'down' : ''}">${plans.length ? `${((wins / plans.length) * 100).toFixed(0)}%` : '—'}</span><span class="s fine">${wins} hit target · ${losses} stopped out · ${expired} expired</span></div></div>
        <div class="card"><div class="stat"><span class="k">Average result per plan</span><span class="v ${expectancy > 0 ? 'up' : expectancy < 0 ? 'down' : ''}">${expectancy === null ? '—' : pct(expectancy)}</span><span class="s fine">${avgWin === null ? '' : `winners ${pct(avgWin)}`}${avgLoss === null ? '' : ` · losers ${pct(avgLoss)}`}</span></div></div>
      </div>

      <div class="card mt" ${acc !== null && !beatsBaseline ? 'style="border-color:var(--warn)"' : ''}>
        <div class="card-h"><h3>How to read this</h3>${acc === null ? '' : `<span class="chip ${beatsBaseline ? 'up' : 'warn'}">${beatsBaseline ? `beating the baseline by ${(acc - baseline).toFixed(1)} points` : `${(baseline - acc).toFixed(1)} points behind the baseline`}</span>`}</div>
        ${acc === null ? '<p class="fine">Nothing has resolved yet, so there is no percentage to read.</p>' : `
        <p>Over these ${fc.length} resolved calls the market rose ${rosePct.toFixed(1)}% of the time. So anyone who ignored the model entirely and said &quot;${baselineCall}&quot; every single time would have been right <b>${baseline.toFixed(1)}%</b> of the time. The engine scored <b>${acc.toFixed(1)}%</b>.
        ${beatsBaseline
          ? 'That is ahead of the baseline, which is the only comparison that means anything — but it is a small lead over a short sample, not a reason to size up.'
          : 'That is <b>behind</b> the baseline. On this sample the model has not earned its place: a constant answer would have done better, and no amount of being above 50% changes that.'}</p>
        <p class="fine">Two things make this sample weaker than its row count suggests. The rows cover ${Math.max(1, Math.round((Date.now() - new Date(all[all.length - 1]?.candle_time || Date.now()).getTime()) / 864e5))} day${Math.round((Date.now() - new Date(all[all.length - 1]?.candle_time || Date.now()).getTime()) / 864e5) === 1 ? '' : 's'} of one market, and crypto moves together — twelve coins falling in the same week is closer to one observation than to twelve. Treat every number on this page as provisional until the sample spans several different market conditions.${all.length - done.length > 0 ? ` ${all.length - done.length} signal${all.length - done.length === 1 ? ' is' : 's are'} still open and counted in no percentage here.` : ''}</p>
        <p class="fine">One detail that makes the plan column harsher than the plan itself: the scorer walks each candle and records a stop as a loss even when the first target was reached earlier, while the plan's own exit rules say to take partial profit at target 1 and move the stop to break-even. So the average result above is more pessimistic than following the plan would have been. It is left that way deliberately — the numbers already scored under this rule stay comparable, and erring against ourselves is the safer error.</p>
        <p class="fine">The offline back-test, run over ${TESTED_ACCURACY.tests} forecasts on ${TESTED_ACCURACY.coins} coins before any of this was live, scored ${tested ? `${tested}%` : '—'} on this timeframe. Where the live number disagrees with it, the live number is the one that counts.</p>`}
      </div>

      ${actionRows.length ? `<div class="card mt">
        <div class="card-h"><h3>How each kind of call turned out</h3><span class="fine">the label the site showed, against what price actually did</span></div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th class="l">Call</th><th>Logged</th><th>Direction right</th><th>Price actually rose</th><th>Average plan result</th></tr></thead><tbody>
        ${actionRows.map(([a, e]) => `<tr style="cursor:default">
          <td class="l"><span class="chip ${toneOf(a)}">${esc(readable(a))}</span></td>
          <td>${e.n}</td>
          <td>${rate(e.hit, e.n).toFixed(0)}%</td>
          <td class="${rate(e.rose, e.n) >= 50 ? 'up' : 'down'}">${rate(e.rose, e.n).toFixed(0)}%</td>
          <td class="${e.retN && e.ret / e.retN > 0 ? 'up' : e.retN ? 'down' : ''}">${e.retN ? pct(e.ret / e.retN) : '—'}</td></tr>`).join('')}
        </tbody></table></div>
        <p class="fine mt">Read the &quot;price actually rose&quot; column against the strength of the call. If the strongest label is not the column's best row, then a bigger score is not a better signal — which is what the offline band test found too, and why the coin page calls the score &quot;indicator agreement&quot; rather than a probability.</p>
      </div>` : ''}

      ${symRows.length ? `<div class="card mt"><div class="card-h"><h3>By coin</h3><span class="fine">coins with 5+ resolved forecasts</span></div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th class="l">Coin</th><th>Resolved</th><th>Right</th><th>Accuracy</th></tr></thead><tbody>
        ${symRows.map(([s, e]) => `<tr data-sym="${esc(s)}"><td class="l"><b>${esc(s)}</b></td><td>${e.n}</td><td>${e.hit}</td><td class="${rate(e.hit, e.n) >= 55 ? 'up' : rate(e.hit, e.n) < 45 ? 'down' : ''}"><b>${rate(e.hit, e.n).toFixed(0)}%</b></td></tr>`).join('')}
        </tbody></table></div></div>` : ''}

      <div class="card mt">
        <div class="card-h"><h3>Recent signals</h3><span class="fine">${all.length} logged${interval === 'all' ? '' : ` on ${interval}`}</span></div>
        ${all.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th class="l">Logged</th><th class="l">Coin</th><th>TF</th><th class="l">Call</th><th>Price then</th><th>AI up</th><th>Price after</th><th>Direction</th><th class="hide-m">Plan</th></tr></thead><tbody>
          ${all.slice(0, 200).map((r) => `<tr data-sym="${esc(r.symbol)}">
            <td class="l fine">${dateTime(new Date(r.candle_time).getTime())}</td>
            <td class="l"><b>${esc(r.symbol)}</b></td><td class="fine">${esc(r.interval)}</td>
            <td class="l"><span class="chip ${toneOf(r.action)}">${esc(readable(r.action))}</span></td>
            <td>${money(r.price)}</td>
            <td class="${r.prob_up >= 0.54 ? 'up' : r.prob_up <= 0.46 ? 'down' : ''}">${r.prob_up === null ? '—' : `${(r.prob_up * 100).toFixed(0)}%`}</td>
            <td>${r.resolved ? money(r.outcome_price) : '<span class="fine muted">open</span>'}</td>
            <td>${r.forecast_correct === null ? '—' : r.forecast_correct ? '<span class="up">✓ right</span>' : '<span class="down">✕ wrong</span>'}</td>
            <td class="hide-m">${r.plan_result && r.plan_result !== 'none' ? `<span class="${PLAN_WIN.has(r.plan_result) ? 'up' : PLAN_LOSS.has(r.plan_result) ? 'down' : 'muted'}">${esc(PLAN_WORDS[r.plan_result] || r.plan_result)}${r.plan_return_pct === null ? '' : ` ${pct(+r.plan_return_pct)}`}</span>` : '<span class="fine muted">—</span>'}</td>
          </tr>`).join('')}
        </tbody></table></div>` : `<div class="empty">${icon('info', 20)}<p>No signals logged yet. The server records a fresh batch every 15 minutes — check back shortly.</p></div>`}
      </div>`;

    $$('tr[data-sym]', el).forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/coin/${tr.dataset.sym}`; }));
  };

  bindSeg($('#iv', el), (v) => { interval = v; draw(); });
  draw();
}
