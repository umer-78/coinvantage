// Tools: a coin/currency converter, a dollar-cost-average "what if" on real
// daily history, and a position-size calculator. Nothing here places a trade.
import { CONFIG } from '../config.js';
import { markets, findCoin, getCandles, isStable } from '../api/market.js';
import { fx, rates } from '../api/fx.js';
import { LineChart } from '../charts/line.js';
import { $, $$, icon, skeleton, bindSeg } from '../ui.js';
import { esc, price, money, pct, amount, compact, dateTime } from '../format.js';
import { convert, dcaBacktest, positionSize } from '../lib/calc.js';

export const title = 'Tools';

const PERIODS = { '6m': 182, '1y': 365, '2y': 730, '3y': 1095 };
const EVERY = { 7: 'Weekly', 14: 'Every 2 weeks', 30: 'Monthly' };
const num = (v) => { const n = parseFloat(String(v).replace(/,/g, '')); return Number.isFinite(n) ? n : NaN; };
const disp = (v) => (Number.isFinite(v) ? `${fx.symbol}${price(v)}` : '—');
// Sums of money (not prices) read best at two decimals once they reach 1.
const cash = (v) => (!Number.isFinite(v) ? '—' : Math.abs(v) >= 1 ? `${fx.symbol}${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : disp(v));
const qty = (n) => (Math.abs(n) >= 1 ? amount(n) : price(n));

export async function render(el, [section]) {
  const st = { chart: null, seq: 0, disposed: false, rate: fx.rate, dca: { every: 30, period: '1y' } };
  const all = await markets().catch(() => []);
  const fiat = await rates().catch(() => ({ USD: 1 }));
  const coins = all.slice(0, 150);
  const tradable = coins.filter((c) => !isStable(c.symbol));
  const coinOpts = (sel, list = tradable) => list.map((c) => `<option value="c:${esc(c.symbol)}" ${c.symbol === sel ? 'selected' : ''}>${esc(c.symbol)} · ${esc(c.name)}</option>`).join('');
  const fiatList = CONFIG.CURRENCIES.filter(([code]) => code === 'USD' || fiat[code]);
  const fiatOpts = (sel) => fiatList.map(([code, , name]) => `<option value="f:${code}" ${code === sel ? 'selected' : ''}>${code} · ${esc(name)}</option>`).join('');
  const pickOpts = (sel) => `<optgroup label="Coins">${coinOpts(sel.startsWith('c:') ? sel.slice(2) : '', coins)}</optgroup><optgroup label="Currencies">${fiatOpts(sel.startsWith('f:') ? sel.slice(2) : '')}</optgroup>`;

  el.innerHTML = `
    <div class="page-head"><div><h1>Tools</h1><p>Convert between coins and currencies, see what regular buying would have done, and size a trade from your stop-loss. Calculators only: nothing here places a trade.</p></div></div>

    <div class="card" id="convert">
      <div class="card-h"><h3>${icon('compare', 16)} Converter</h3><span class="fine">Live prices · currency rates refresh every 6 hours</span></div>
      <div class="row" style="gap:10px;align-items:flex-end;flex-wrap:wrap">
        <label class="fld" style="flex:1;min-width:120px">Amount<input class="inp" id="cvAmt" type="number" step="any" min="0" value="1" inputmode="decimal"></label>
        <label class="fld" style="flex:2;min-width:160px">From<select class="inp" id="cvFrom">${pickOpts('c:BTC')}</select></label>
        <button class="btn" id="cvSwap" type="button" aria-label="Swap from and to">⇄</button>
        <label class="fld" style="flex:2;min-width:160px">To<select class="inp" id="cvTo">${pickOpts(`f:${fx.code}`)}</select></label>
      </div>
      <div class="mt" aria-live="polite"><div class="stat"><span class="v" id="cvOut">—</span><span class="s fine" id="cvRate"></span></div></div>
    </div>

    <div class="card mt" id="dca">
      <div class="card-h"><h3>${icon('history', 16)} What if I had bought regularly?</h3><span class="fine">Dollar-cost averaging on real daily closes</span></div>
      <div class="row" style="gap:10px;align-items:flex-end;flex-wrap:wrap">
        <label class="fld" style="flex:2;min-width:150px">Coin<select class="inp" id="dcaCoin">${coinOpts('BTC')}</select></label>
        <label class="fld" style="flex:1;min-width:120px"><span>Each buy (<span class="curCode">${esc(fx.code)}</span>)</span><input class="inp" id="dcaAmt" type="number" step="any" min="0" value="${Math.round(100 * fx.rate)}" inputmode="decimal"></label>
        <label class="fld" style="flex:1;min-width:90px">Fee %<input class="inp" id="dcaFee" type="number" step="any" min="0" max="5" value="0.1" inputmode="decimal"></label>
      </div>
      <div class="row mt" style="gap:10px;flex-wrap:wrap">
        <div class="seg" id="dcaEvery">${Object.entries(EVERY).map(([d, l]) => `<button type="button" data-v="${d}" class="${+d === st.dca.every ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="seg" id="dcaPeriod">${Object.keys(PERIODS).map((p) => `<button type="button" data-v="${p}" class="${p === st.dca.period ? 'on' : ''}">${p.toUpperCase()}</button>`).join('')}</div>
      </div>
      <div class="grid g4 mt" id="dcaStats">${skeleton(1, 40)}</div>
      <div id="dcaChart" class="mt"></div>
      <p class="fine mt" id="dcaNote"></p>
    </div>

    <div class="card mt" id="risk">
      <div class="card-h"><h3>${icon('bolt', 16)} Position size from your stop-loss</h3><span class="fine">How much to buy so a stopped-out trade costs a fixed share of your account</span></div>
      <div class="grid g3" style="gap:10px">
        <label class="fld">Coin (fills the entry)<select class="inp" id="rkCoin"><option value="">Custom</option>${coinOpts('BTC')}</select></label>
        <label class="fld"><span>Account balance (<span class="curCode">${esc(fx.code)}</span>)</span><input class="inp" id="rkBal" type="number" step="any" min="0" value="${Math.round(1000 * fx.rate)}" inputmode="decimal"></label>
        <label class="fld">Risk per trade %<input class="inp" id="rkPct" type="number" step="any" min="0" max="100" value="1" inputmode="decimal"></label>
        <label class="fld"><span>Entry (<span class="curCode">${esc(fx.code)}</span>)</span><input class="inp" id="rkEntry" type="number" step="any" min="0" inputmode="decimal"></label>
        <label class="fld"><span>Stop-loss (<span class="curCode">${esc(fx.code)}</span>)</span><input class="inp" id="rkStop" type="number" step="any" min="0" inputmode="decimal"></label>
        <label class="fld"><span>Target, optional (<span class="curCode">${esc(fx.code)}</span>)</span><input class="inp" id="rkTarget" type="number" step="any" min="0" inputmode="decimal"></label>
        <label class="fld">Fee per side %<input class="inp" id="rkFee" type="number" step="any" min="0" value="0.1" inputmode="decimal"></label>
      </div>
      <div class="mt" id="rkOut" aria-live="polite"></div>
      <p class="fine mt">A stop can fill worse than its price in a fast market (slippage), so the real loss can be larger. This is a calculator, not advice.</p>
    </div>`;

  // ---------------------------------------------------------------- converter
  const usdOf = (v) => {
    if (v.startsWith('f:')) { const code = v.slice(2); return code === 'USD' ? 1 : (fiat[code] ? 1 / fiat[code] : null); }
    return coins.find((c) => c.symbol === v.slice(2))?.price ?? null;
  };
  const label = (v) => v.slice(2);
  const fmtIn = (v, n) => (v.startsWith('f:') ? `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${label(v)}` : `${qty(n)} ${label(v)}`);
  const drawConvert = () => {
    const a = num($('#cvAmt', el).value); const f = $('#cvFrom', el).value; const t = $('#cvTo', el).value;
    const out = convert(a, usdOf(f), usdOf(t));
    $('#cvOut', el).textContent = out === null ? '—' : `${fmtIn(f, a)} = ${fmtIn(t, out)}`;
    const one = convert(1, usdOf(f), usdOf(t));
    $('#cvRate', el).textContent = one === null ? 'Price unavailable for this pair right now.' : `1 ${label(f)} = ${fmtIn(t, one)}`;
  };
  $('#cvAmt', el).addEventListener('input', drawConvert);
  $('#cvFrom', el).addEventListener('change', drawConvert);
  $('#cvTo', el).addEventListener('change', drawConvert);
  $('#cvSwap', el).addEventListener('click', () => {
    const f = $('#cvFrom', el); const t = $('#cvTo', el); const a = f.value;
    f.value = t.value; t.value = a; drawConvert();
  });
  drawConvert();

  // ---------------------------------------------------------------- DCA
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const runDca = async () => {
    const seq = ++st.seq;
    const sym = $('#dcaCoin', el).value.slice(2);
    const amtUsd = num($('#dcaAmt', el).value) / (fx.rate || 1);
    const fee = num($('#dcaFee', el).value);
    const days = PERIODS[st.dca.period];
    $('#dcaStats', el).innerHTML = skeleton(1, 40);
    let res; let source = '';
    try {
      const coin = await findCoin(sym);
      if (!coin) throw new Error('Coin not found.');
      const got = await getCandles(coin, '1d', days + 1);
      source = got.source;
      res = dcaBacktest(got.candles.slice(-(days + 1)), { amount: amtUsd, everyDays: st.dca.every, feePct: Number.isFinite(fee) ? fee : 0 });
    } catch (e) { res = { error: e.message || 'Price history unavailable right now.' }; }
    if (st.disposed || seq !== st.seq) return;
    if (res.error) {
      $('#dcaStats', el).innerHTML = `<div class="empty" style="grid-column:1/-1"><p>${esc(res.error)}</p></div>`;
      st.chart?.destroy(); st.chart = null; $('#dcaChart', el).innerHTML = ''; $('#dcaNote', el).textContent = '';
      return;
    }
    const beat = res.value >= res.lump.value;
    $('#dcaStats', el).innerHTML = `
      <div class="stat"><span class="k">Invested</span><span class="v">${money(res.invested)}</span><span class="s fine">${res.buys} buys</span></div>
      <div class="stat"><span class="k">Worth now</span><span class="v">${money(res.value)}</span><span class="s fine">${amount(res.units)} ${esc(sym)}</span></div>
      <div class="stat"><span class="k">Profit / loss</span><span class="v ${res.pnl >= 0 ? 'up' : 'down'}">${res.pnl >= 0 ? '+' : '−'}${money(Math.abs(res.pnl))}</span><span class="s ${res.pnl >= 0 ? 'up' : 'down'}">${pct(res.pnlPct)}</span></div>
      <div class="stat"><span class="k">Average buy price</span><span class="v">${money(res.avgCost)}</span><span class="s fine">now ${money(res.lastPrice)}</span></div>`;
    const first = res.rows[0]?.t;
    $('#dcaNote', el).innerHTML = `Buying ${money(amtUsd)} ${EVERY[st.dca.every].toLowerCase()} from ${esc(dateTime(first, false))}. The same total put in all at once on day one would be worth <b>${money(res.lump.value)}</b> (${pct(res.lump.pnlPct)}), so regular buying did ${beat ? '<b class="up">better</b>' : '<b class="down">worse</b>'} this time. Past results do not predict future ones.${fx.code !== 'USD' ? ` Converted from USD at today's ${esc(fx.code)} rate.` : ''}${source === 'demo' ? ' <span class="chip warn">Demo data: live history unavailable</span>' : ''}`;
    if (!st.chart) {
      $('#dcaChart', el).innerHTML = '';
      st.chart = new LineChart($('#dcaChart', el), { height: 260, yFormat: (v) => compact(v), xFormat: (x) => new Date(x).toLocaleDateString('en-US', { month: 'short', year: '2-digit' }), tooltipX: (x) => dateTime(x, false) });
    }
    st.chart.set([
      { name: 'Worth', color: cssVar('--series-1'), width: 2, data: res.rows.map((r) => ({ x: r.t, y: r.value })) },
      { name: 'Invested', color: cssVar('--series-3'), width: 2, data: res.rows.map((r) => ({ x: r.t, y: r.invested })) },
    ]);
  };
  let dcaTimer = 0;
  const queueDca = () => { clearTimeout(dcaTimer); dcaTimer = setTimeout(runDca, 350); };
  $('#dcaCoin', el).addEventListener('change', runDca);
  $('#dcaAmt', el).addEventListener('input', queueDca);
  $('#dcaFee', el).addEventListener('input', queueDca);
  bindSeg($('#dcaEvery', el), (v) => { st.dca.every = +v; runDca(); });
  bindSeg($('#dcaPeriod', el), (v) => { st.dca.period = v; runDca(); });
  runDca();

  // ---------------------------------------------------------------- position size
  const fillEntry = () => {
    const sym = $('#rkCoin', el).value.slice(2);
    const c = coins.find((x) => x.symbol === sym);
    if (!c?.price) return;
    const e = c.price * fx.rate;
    const round = (v) => +v.toPrecision(6);
    $('#rkEntry', el).value = round(e);
    $('#rkStop', el).value = round(e * 0.97);
    $('#rkTarget', el).value = round(e * 1.06);
  };
  const drawRisk = () => {
    const r = positionSize({
      balance: num($('#rkBal', el).value), riskPct: num($('#rkPct', el).value),
      entry: num($('#rkEntry', el).value), stop: num($('#rkStop', el).value),
      target: num($('#rkTarget', el).value), feePct: num($('#rkFee', el).value) || 0,
    });
    const out = $('#rkOut', el);
    if (r.error) { out.innerHTML = `<p class="fine">${esc(r.error)}</p>`; return; }
    const sym = $('#rkCoin', el).value.slice(2) || 'units';
    const lev = r.leverage > 1 ? `<span class="down">${r.leverage.toFixed(2)}×: more than your balance, so this needs leverage or a wider stop and smaller size</span>` : `${r.leverage.toFixed(2)}× (no leverage needed)`;
    out.innerHTML = `<dl class="kv">
      <dt>Direction</dt><dd class="${r.side === 'long' ? 'up' : 'down'}">${r.side === 'long' ? 'Long (buy)' : 'Short (sell)'}</dd>
      <dt>Position size</dt><dd>${qty(r.units)} ${esc(sym)} · ${cash(r.notional)}</dd>
      <dt>Loss if the stop is hit</dt><dd class="down">−${cash(r.riskAmount)}</dd>
      <dt>Stop distance</dt><dd>${pct(r.stopPct, 2, false)}</dd>
      <dt>Size vs balance</dt><dd>${lev}</dd>
      ${r.targetError ? `<dt>Target</dt><dd class="down">${esc(r.targetError)}</dd>` : r.reward !== undefined ? `<dt>Profit at target</dt><dd class="up">+${cash(r.reward)} (${pct(r.targetPct, 2, false)})</dd><dt>Reward : risk</dt><dd>${r.rr.toFixed(2)} : 1${r.rr < 1.5 ? ' <span class="fine">(under 1.5 needs a high win rate)</span>' : ''}</dd>` : ''}
    </dl>`;
  };
  $('#rkCoin', el).addEventListener('change', () => { fillEntry(); drawRisk(); });
  $$('#risk input', el).forEach((i) => i.addEventListener('input', drawRisk));
  fillEntry(); drawRisk();

  // Money fields are typed in the display currency: rescale them when it changes.
  const onCurrency = () => {
    const k = fx.rate / (st.rate || 1); st.rate = fx.rate;
    for (const id of ['#dcaAmt', '#rkBal', '#rkEntry', '#rkStop', '#rkTarget']) {
      const i = $(id, el); const v = num(i.value);
      if (Number.isFinite(v)) i.value = +(v * k).toPrecision(6);
    }
    $$('.curCode', el).forEach((s) => { s.textContent = fx.code; });
    drawConvert(); drawRisk(); runDca();
  };
  window.addEventListener('cv:currency', onCurrency);

  if (section && $(`#${CSS.escape(section)}`, el)) setTimeout(() => $(`#${CSS.escape(section)}`, el)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);

  return () => { st.disposed = true; clearTimeout(dcaTimer); st.chart?.destroy(); window.removeEventListener('cv:currency', onCurrency); };
}
