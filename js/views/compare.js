import { markets, findCoin, getCandles, isStable } from '../api/market.js';
import { LineChart } from '../charts/line.js';
import { $, $$, coinLogo, skeleton, bindSeg, icon, errorBox } from '../ui.js';
import { esc, pct, dateTime } from '../format.js';
import { historyMatch, backtestAnalog, analogVerdict } from '../lib/analog.js';

export const title = 'Compare';
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const COLORS = ['--series-1', '--series-2', '--series-3', '--series-5', '--series-7', '--series-4'];
const PERIODS = { '7d': ['1h', 168, 24 * 365], '30d': ['4h', 180, 6 * 365], '90d': ['1d', 90, 365], '1y': ['1d', 365, 365], '3y': ['1d', 1095, 365] };

export async function render(el, [preset]) {
  const st = { coins: preset ? preset.split(',').map((s) => s.toUpperCase()).slice(0, 6) : ['BTC', 'ETH', 'SOL'], period: '30d', chart: null, selfSym: null, selfChart: null, selfSeq: 0, disposed: false };
  const all = await markets().catch(() => []);
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Compare</h1><p>Overlay performance, volatility, drawdowns and how closely coins move together.</p></div>
      <div class="seg" id="per">${Object.keys(PERIODS).map((p) => `<button data-v="${p}" class="${p === st.period ? 'on' : ''}">${p.toUpperCase()}</button>`).join('')}</div>
    </div>
    <div class="card">
      <div class="row" id="picked" style="margin-bottom:12px"></div>
      <div id="chartArea"></div>
    </div>
    <div class="grid g2 mt">
      <div class="card"><div class="card-h"><h3>Statistics</h3></div><div id="stats">${skeleton(5)}</div></div>
      <div class="card"><div class="card-h"><h3>Correlation</h3><span class="fine">1 = move together · 0 = unrelated · −1 = opposite</span></div><div id="corr">${skeleton(5)}</div></div>
    </div>
    <div class="card mt">
      <div class="card-h">
        <h3>${icon('history', 16)} Compare a coin with its own past</h3>
        <span class="fine">Finds the stretches of history that traced the same shape, and shows what price did next</span>
      </div>
      <div class="seg" id="selfPick" style="margin-bottom:12px"></div>
      <div id="selfBody">${skeleton(6, 26)}</div>
    </div>
    <datalist id="coinList">${all.filter((c) => !isStable(c.symbol)).map((c) => `<option value="${esc(c.symbol)}">${esc(c.name)}</option>`).join('')}</datalist>`;

  const drawPicked = () => {
    $('#picked', el).innerHTML = st.coins.map((s, i) => `<span class="chip" style="border-left:4px solid var(${COLORS[i]})">${esc(s)} <button class="star" data-rm="${esc(s)}" aria-label="Remove ${esc(s)}" style="padding:0">${icon('close', 13)}</button></span>`).join('')
      + (st.coins.length < 6 ? `<input class="inp" id="add" list="coinList" placeholder="+ Add coin" style="width:130px;height:30px">` : '');
    $$('[data-rm]', el).forEach((b) => b.addEventListener('click', () => { st.coins = st.coins.filter((c) => c !== b.dataset.rm); drawPicked(); load(); drawSelfPick(); loadSelf(); }));
    $('#add', el)?.addEventListener('change', (e) => {
      const v = e.target.value.trim().toUpperCase();
      if (v && !st.coins.includes(v) && all.some((c) => c.symbol === v)) { st.coins.push(v); drawPicked(); load(); drawSelfPick(); }
      else e.target.value = '';
    });
  };

  const load = async () => {
    if (!st.coins.length) { $('#chartArea', el).innerHTML = '<div class="empty">Add a coin to compare.</div>'; return; }
    const [iv, count, perYear] = PERIODS[st.period];
    $('#chartArea', el).innerHTML = skeleton(8, 30);
    const series = (await Promise.all(st.coins.map(async (sym, i) => {
      try {
        const coin = await findCoin(sym);
        const { candles } = await getCandles(coin, iv, count + 1);
        return { sym, coin, candles: candles.slice(-(count + 1)), color: cssVar(COLORS[i]) };
      } catch { return null; }
    }))).filter(Boolean);
    if (st.disposed) return;
    if (!series.length) { $('#chartArea', el).innerHTML = errorBox('No data for these coins.', load); return; }
    $('#chartArea', el).innerHTML = '';
    st.chart?.destroy();
    st.chart = new LineChart($('#chartArea', el), { height: 380, zeroLine: 0, yFormat: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`, xFormat: (x) => new Date(x).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), tooltipX: (x) => dateTime(x, iv !== '1d') });
    st.chart.set(series.map((s) => ({ name: s.sym, color: s.color, width: 2, data: s.candles.map((c) => ({ x: c.t, y: (c.c / s.candles[0].c - 1) * 100 })) })));

    // stats
    const rets = series.map((s) => s.candles.slice(1).map((c, k) => Math.log(c.c / s.candles[k].c)));
    // A coin with almost no history on this timeframe — a recent listing, or one
    // the fallback feed can only give a handful of candles for — produced an
    // empty returns array here. Dividing by its length gave NaN and spreading it
    // into Math.max gave -Infinity, so the whole row rendered as nonsense
    // instead of saying there was not enough data.
    const stats = series.map((s, i) => {
      const r = rets[i];
      if (!r.length || s.candles.length < 2) {
        return { ...s, total: null, vol: null, dd: null, best: null, worst: null, ratio: null, thin: true };
      }
      const mean = r.reduce((a, b) => a + b, 0) / r.length;
      const vol = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / r.length) * Math.sqrt(perYear);
      let peak = s.candles[0].c, dd = 0; for (const c of s.candles) { peak = Math.max(peak, c.c); dd = Math.max(dd, 1 - c.c / peak); }
      const total = (s.candles[s.candles.length - 1].c / s.candles[0].c - 1) * 100;
      return { ...s, total, vol: vol * 100, dd: dd * 100, best: Math.max(...r) * 100, worst: Math.min(...r) * 100, ratio: vol ? (mean * perYear) / vol : 0, thin: false };
    });
    $('#stats', el).innerHTML = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th class="l">Coin</th><th>Return</th><th>Volatility (yr)</th><th>Max drawdown</th><th class="hide-m">Best / worst candle</th><th>Return ÷ risk</th></tr></thead><tbody>
      ${stats.sort((a, b) => (b.total ?? -Infinity) - (a.total ?? -Infinity)).map((s) => `<tr data-sym="${esc(s.sym)}"><td class="l"><div class="coin-cell">${coinLogo(s.coin, 22)}<b>${esc(s.sym)}</b></div></td>
        ${s.thin
          ? `<td colspan="5" class="muted fine">Not enough price history on this timeframe to measure</td>`
          : `<td class="${s.total >= 0 ? 'up' : 'down'}"><b>${pct(s.total)}</b></td><td>${s.vol.toFixed(0)}%</td><td class="down">${pct(-s.dd, 1)}</td>
        <td class="hide-m"><span class="up">${pct(s.best, 1)}</span> / <span class="down">${pct(s.worst, 1)}</span></td><td>${s.ratio.toFixed(2)}</td>`}</tr>`).join('')}
    </tbody></table></div><p class="fine mt">${stats.filter((x) => !x.thin).length ? `Winner over ${st.period.toUpperCase()}: <b>${esc(stats.find((x) => !x.thin).sym)}</b>.` : ''} Return ÷ risk above 1 means the gain was large relative to the swings.</p>`;
    $$('#stats tr[data-sym]', el).forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/coin/${tr.dataset.sym}`; }));

    // correlation matrix on aligned timestamps
    const maps = series.map((s) => new Map(s.candles.slice(1).map((c, k) => [c.t, Math.log(c.c / s.candles[k].c)])));
    const corr = (a, b) => {
      const xs = [], ys = [];
      for (const [t, v] of maps[a]) if (maps[b].has(t)) { xs.push(v); ys.push(maps[b].get(t)); }
      if (xs.length < 5) return null;
      const mx = xs.reduce((p, q) => p + q, 0) / xs.length, my = ys.reduce((p, q) => p + q, 0) / ys.length;
      let sxy = 0, sx = 0, sy = 0;
      for (let k = 0; k < xs.length; k++) { sxy += (xs[k] - mx) * (ys[k] - my); sx += (xs[k] - mx) ** 2; sy += (ys[k] - my) ** 2; }
      return sxy / Math.sqrt(sx * sy);
    };
    const cell = (v) => {
      if (v === null) return '<td>—</td>';
      const a = Math.abs(v);
      const bg = v >= 0 ? `rgba(57,135,229,${0.1 + a * 0.55})` : `rgba(230,103,103,${0.1 + a * 0.55})`;
      return `<td style="background:${bg};text-align:center;font-weight:600">${v.toFixed(2)}</td>`;
    };
    $('#corr', el).innerHTML = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th></th>${series.map((s) => `<th style="text-align:center">${esc(s.sym)}</th>`).join('')}</tr></thead><tbody>
      ${series.map((s, i) => `<tr style="cursor:default"><td class="l"><b>${esc(s.sym)}</b></td>${series.map((_, j) => (i === j ? '<td style="text-align:center" class="muted">1.00</td>' : cell(corr(i, j)))).join('')}</tr>`).join('')}
    </tbody></table></div><p class="fine mt">High correlation means holding both adds little diversification.</p>`;
  };


  // ---------------------------------------------------------------------------
  // The other comparison: a coin against its own past.
  //
  // Takes the shape of the most recent candles, finds the stretches of this
  // coin's history that traced the same shape, and draws what happened after
  // each of them on top of each other. The matcher only ever looks backwards
  // from the bar it is asked about, so the same call can be replayed at past
  // bars and scored — which is what the hit-rate line underneath is. If the
  // method does not beat simply always calling the more common outcome on this
  // coin, the card says so instead of quietly showing the percentage anyway.
  const CANDLE_WORD = { '1h': 'hourly', '4h': '4-hour', '1d': 'daily' };

  const drawSelfPick = () => {
    const host = $('#selfPick', el);
    if (!host) return;
    if (!st.coins.length) { host.innerHTML = ''; return; }
    if (!st.coins.includes(st.selfSym)) st.selfSym = st.coins[0];
    host.innerHTML = st.coins.map((s) => `<button data-self="${esc(s)}" class="${s === st.selfSym ? 'on' : ''}">${esc(s)}</button>`).join('');
    $$('[data-self]', host).forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.self === st.selfSym) return;
      st.selfSym = b.dataset.self;
      drawSelfPick();
      loadSelf();
    }));
  };

  const loadSelf = async () => {
    const body = $('#selfBody', el);
    if (!body) return;
    if (!st.selfSym) { body.innerHTML = '<div class="empty">Add a coin to compare it with its own history.</div>'; return; }
    const seq = ++st.selfSeq;
    const sym = st.selfSym;
    const iv = PERIODS[st.period][0];
    body.innerHTML = skeleton(6, 26);
    st.selfChart?.destroy(); st.selfChart = null;

    let candles;
    try {
      const coin = await findCoin(sym);
      ({ candles } = await getCandles(coin, iv, 1000));
    } catch {
      if (st.disposed || seq !== st.selfSeq) return;
      body.innerHTML = errorBox(`Could not load history for ${sym}.`, loadSelf);
      return;
    }
    if (st.disposed || seq !== st.selfSeq) return;

    const match = historyMatch(candles, { interval: iv });
    const score = match.ok ? backtestAnalog(candles, { interval: iv }) : null;
    const v = analogVerdict(match, score, { symbol: sym, interval: iv, horizonText: match.ok ? `${match.horizon} ${CANDLE_WORD[iv] || ''} candles`.trim() : null });

    if (!match.ok) {
      body.innerHTML = `<div class="empty"><p>${esc(match.reason)}</p></div>`;
      return;
    }

    const chip = score?.ok && !score.beatsBaseline ? 'NO MEASURED EDGE'
      : match.direction === 'up' ? 'HISTORY LEANS UP'
      : match.direction === 'down' ? 'HISTORY LEANS DOWN' : 'HISTORY IS SPLIT';

    body.innerHTML = `
      <div class="row spread" style="gap:10px;flex-wrap:wrap">
        <span class="chip ${v.tone === 'warn' ? 'warn' : v.tone}"><b>${esc(chip)}</b></span>
        <span class="fine">${match.matches.length} matching stretches · ${match.window} ${esc(CANDLE_WORD[iv] || '')} candles of shape · ${match.horizon} candles ahead</span>
      </div>
      <p class="mt">${esc(v.headline)}</p>
      <div id="selfChart" class="mt"></div>
      <p class="fine" style="margin-top:6px">Each faint line is one past stretch that matched, lined up so the match ends at 0 on the axis. Everything right of the divider is what actually happened next.</p>
      ${v.lines.map((l) => `<p class="fine" style="margin:8px 0 0">${esc(l)}</p>`).join('')}
      <div class="tbl-wrap mt"><table class="tbl"><thead><tr>
        <th class="l">Matched stretch ended</th><th>Similarity</th><th>Move over next ${match.horizon}</th><th class="hide-m">Peak</th><th class="hide-m">Trough</th>
      </tr></thead><tbody>
        ${match.matches.map((m) => `<tr style="cursor:default"><td class="l">${esc(dateTime(m.endTime, iv !== '1d'))}</td>
          <td>${(m.similarity * 100).toFixed(0)}%</td>
          <td class="${m.futureReturnPct >= 0 ? 'up' : 'down'}"><b>${pct(m.futureReturnPct)}</b></td>
          <td class="hide-m up">${pct(m.maxUpPct)}</td><td class="hide-m down">${pct(m.maxDownPct)}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="fine mt">How this is scored: the matcher is replayed at ${score?.ok ? score.tests : 'past'} earlier bars using only the data that existed at each one, spaced at least one horizon apart so the outcomes do not overlap, and marked against what price actually did. Shape matching is one input among several — it is not a forecast on its own.</p>`;

    const W = match.window;
    const host = $('#selfChart', el);
    st.selfChart = new LineChart(host, {
      height: 320, zeroLine: 0,
      yFormat: (y) => `${y >= 0 ? '+' : ''}${y.toFixed(1)}%`,
      xFormat: (x) => `${x > 0 ? '+' : ''}${Math.round(x)}`,
      tooltipX: (x) => (x === 0 ? 'match ends' : `${x > 0 ? '+' : ''}${Math.round(x)} candles`),
    });
    const lines = match.matches.map((m, i) => ({
      name: dateTime(m.endTime, false),
      color: cssVar(COLORS[i % COLORS.length]),
      width: 1.2, alpha: 0.5,
      data: m.series.map((y, j) => ({ x: j - (W - 1), y: y - 100 })),
    }));
    lines.push({
      name: `${sym} now`, color: cssVar('--accent'), width: 2.8,
      data: match.currentSeries.map((y, j) => ({ x: j - (W - 1), y: y - 100 })),
    });
    st.selfChart.set(lines, { divider: 0, dividerLabel: 'now' });
  };

  bindSeg($('#per', el), (v) => { st.period = v; load(); drawSelfPick(); loadSelf(); });
  drawPicked();
  drawSelfPick();
  load();
  loadSelf();
  return () => { st.disposed = true; st.chart?.destroy(); st.selfChart?.destroy(); };
}
