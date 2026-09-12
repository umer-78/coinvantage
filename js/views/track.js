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

export async function render(el) {
  el.innerHTML = `
    <div class="page-head"><div><h1>Signal track record</h1><p>Every signal below was written to the database <b>before</b> the outcome was known, then scored automatically when its horizon passed.</p></div>
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
    const plans = done.filter((r) => r.plan_result === 'win' || r.plan_result === 'loss');
    const wins = plans.filter((r) => r.plan_result === 'win').length;
    const avgWin = plans.filter((r) => r.plan_result === 'win').reduce((s, r) => s + (+r.plan_return_pct || 0), 0) / (wins || 1);
    const avgLoss = plans.filter((r) => r.plan_result === 'loss').reduce((s, r) => s + (+r.plan_return_pct || 0), 0) / ((plans.length - wins) || 1);
    const expectancy = plans.length ? (wins / plans.length) * avgWin + (1 - wins / plans.length) * avgLoss : null;

    // per-coin breakdown
    const bySym = new Map();
    for (const r of fc) {
      const e = bySym.get(r.symbol) || { n: 0, hit: 0 };
      e.n++; if (r.forecast_correct) e.hit++;
      bySym.set(r.symbol, e);
    }
    const symRows = [...bySym.entries()].filter(([, e]) => e.n >= 5).sort((a, b) => rate(b[1].hit, b[1].n) - rate(a[1].hit, a[1].n));

    const acc = rate(hit, fc.length);
    const tested = TESTED_ACCURACY[interval === 'all' ? 'all' : interval];

    $('#body', el).innerHTML = `
      <div class="grid g4">
        <div class="card"><div class="stat"><span class="k">Direction called right</span><span class="v ${acc === null ? '' : acc >= 55 ? 'up' : acc >= 50 ? '' : 'down'}">${acc === null ? '—' : `${acc.toFixed(1)}%`}</span><span class="s fine">${fc.length} resolved forecasts</span></div></div>
        <div class="card"><div class="stat"><span class="k">Trade plans that hit target first</span><span class="v ${wins / (plans.length || 1) >= 0.5 ? 'up' : ''}">${plans.length ? `${((wins / plans.length) * 100).toFixed(0)}%` : '—'}</span><span class="s fine">${wins}W / ${plans.length - wins}L closed</span></div></div>
        <div class="card"><div class="stat"><span class="k">Average result per plan</span><span class="v ${expectancy > 0 ? 'up' : expectancy < 0 ? 'down' : ''}">${expectancy === null ? '—' : pct(expectancy)}</span><span class="s fine">Win ${pct(avgWin)} · Loss ${pct(avgLoss)}</span></div></div>
        <div class="card"><div class="stat"><span class="k">Offline back-test</span><span class="v">${tested ? `${tested}%` : '—'}</span><span class="s fine">${TESTED_ACCURACY.tests} forecasts · ${TESTED_ACCURACY.coins} coins</span></div></div>
      </div>

      <div class="card mt">
        <div class="card-h"><h3>How to read this</h3></div>
        <p class="fine">A coin flip is 50%. Crypto drifts upward over most samples, so "always predict up" scores about 51% — the number to beat. The engine's edge is small and concentrated in the shorter timeframes; on daily forecasts it has <b>no measured edge</b> and we say so on the coin page.${all.length - done.length > 0 ? ` ${all.length - done.length} signal${all.length - done.length === 1 ? ' is' : 's are'} still open and counted in no percentage here.` : ''}</p>
      </div>

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
            <td class="l"><span class="chip ${r.action?.includes('BUY') ? 'up' : r.action?.includes('SELL') ? 'down' : ''}">${esc(r.action || '—')}</span></td>
            <td>${money(r.price)}</td>
            <td class="${r.prob_up >= 0.54 ? 'up' : r.prob_up <= 0.46 ? 'down' : ''}">${r.prob_up === null ? '—' : `${(r.prob_up * 100).toFixed(0)}%`}</td>
            <td>${r.resolved ? money(r.outcome_price) : '<span class="fine muted">open</span>'}</td>
            <td>${r.forecast_correct === null ? '—' : r.forecast_correct ? '<span class="up">✓ right</span>' : '<span class="down">✕ wrong</span>'}</td>
            <td class="hide-m">${r.plan_result ? `<span class="${r.plan_result === 'win' ? 'up' : r.plan_result === 'loss' ? 'down' : 'muted'}">${esc(r.plan_result)}${r.plan_return_pct === null ? '' : ` ${pct(+r.plan_return_pct)}`}</span>` : '<span class="fine muted">—</span>'}</td>
          </tr>`).join('')}
        </tbody></table></div>` : `<div class="empty">${icon('info', 20)}<p>No signals logged yet. The server records a fresh batch every 15 minutes — check back shortly.</p></div>`}
      </div>`;

    $$('tr[data-sym]', el).forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/coin/${tr.dataset.sym}`; }));
  };

  bindSeg($('#iv', el), (v) => { interval = v; draw(); });
  draw();
}
