import { markets, isStable } from '../api/market.js';
import { $, $$, icon, toast, coinLogo, skeleton } from '../ui.js';
import { esc, price, usd, ago, money} from '../format.js';
import { load, save } from '../store.js';
import { fx } from '../api/fx.js';
import { auth, backendEnabled, serverAlerts, createServerAlert, deleteServerAlert } from '../api/backend.js';
import { openAuth } from './auth.js';

export const title = 'Alerts';

export async function render(el, [preset]) {
  const all = await markets().catch(() => []);
  const coins = all.filter((c) => c.binance && !isStable(c.symbol));
  const perm = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
  el.innerHTML = `
    <div class="page-head"><div><h1>Alerts</h1><p>Two kinds: a <b>price alert</b> that watches a level, and a <b>signal alert</b> that fires the moment the engine's setup triggers on a chart — with the entry, stop and targets in the message.</p></div></div>

    <div class="card" style="margin-bottom:14px">
      <div class="card-h"><h3>Signal alert</h3><span class="chip warn">Runs on the server</span></div>
      <div id="sigBox">${skeleton(3, 22)}</div>
    </div>

    <div class="grid g2">
      <div class="card">
        <h3 style="margin-bottom:12px">New price alert</h3>
        <form id="f" class="stack" style="gap:10px">
          <label class="fld">Coin<select class="inp" name="sym">${coins.map((c) => `<option value="${esc(c.symbol)}" ${c.symbol === (preset || 'BTC').toUpperCase() ? 'selected' : ''}>${esc(c.symbol)} · ${esc(c.name)}</option>`).join('')}</select></label>
          <div class="row">
            <label class="fld">When price is<select class="inp" name="dir"><option value="above">Above</option><option value="below">Below</option></select></label>
            <label class="fld" style="flex:1">Price (<span id="curCode">${esc(fx.code)}</span>)<input class="inp" name="price" type="number" step="any" min="0" required></label>
          </div>
          <p class="fine" id="cur"></p>
          <button class="btn primary">${icon('alerts', 16)} Create alert</button>
        </form>
        <div class="mt" id="permBox">${perm === 'granted' ? '<p class="fine up">Browser notifications are on.</p>' : perm === 'unsupported' ? '<p class="fine">This browser does not support notifications — alerts appear as on-screen messages.</p>' : '<button class="btn sm" id="perm">Enable browser notifications</button>'}</div>
      </div>
      <div class="card"><div class="card-h"><h3>Your alerts</h3><button class="btn sm ghost" id="clear">Clear triggered</button></div><div id="list"></div></div>
    </div>`;

  const f = $('#f', el);
  // Alerts are compared against the exchange's USD price, but the whole app is
  // shown in the chosen display currency. The field used to be labelled USD and
  // sat directly under a price printed in that other currency, so anyone not on
  // USD typed the number they could see and set a level that could never be
  // reached. The field now takes the display currency and converts on save.
  const toUsd = (v) => (fx.rate ? v / fx.rate : v);
  const showCur = () => {
    const c = coins.find((x) => x.symbol === f.sym.value);
    const code = $('#curCode', el);
    if (code) code.textContent = fx.code;
    if (c) {
      $('#cur', el).textContent = fx.code === 'USD'
        ? `Current price: ${money(c.price)}`
        : `Current price: ${money(c.price)} (US$${price(c.price)})`;
      if (!f.price.value) f.price.placeholder = price(c.price * fx.rate);
    }
  };
  f.sym.addEventListener('change', () => { f.price.value = ''; showCur(); });
  const onCurrency = () => { f.price.value = ''; showCur(); draw(); };
  window.addEventListener('cv:currency', onCurrency);
  showCur();

  // --- signal alerts (server side) --------------------------------------
  // These run in the backend so they still fire with the browser closed. The
  // message carries the whole plan, because an alert that just says "BTC is
  // interesting" makes you open the site to find out what to do.
  const INTERVALS = ['15m', '1h', '4h', '1d'];
  const SIDES = [['any', 'Either direction'], ['long', 'Upside setups only'], ['short', 'Downside setups only']];

  async function drawSignals() {
    const box = $('#sigBox', el);
    if (!box) return;

    if (!backendEnabled()) {
      box.innerHTML = '<p class="fine">Signal alerts need the backend, which is not connected on this deployment. Price alerts below still work while the site is open.</p>';
      return;
    }
    if (!auth.user) {
      box.innerHTML = `<p class="fine">Sign in to set a signal alert — it runs on the server, so it reaches you with the browser closed.</p>
        <button class="btn primary mt" id="sigSignIn">${icon('bolt', 16)} Sign in</button>`;
      $('#sigSignIn', box).addEventListener('click', () => openAuth('in'));
      return;
    }

    const rows = await serverAlerts().catch(() => []);
    const sigs = rows.filter((r) => r.kind === 'signal');
    box.innerHTML = `
      <form id="sf" class="row" style="gap:10px;align-items:flex-end;flex-wrap:wrap">
        <label class="fld">Coin<select class="inp" name="sym">${coins.slice(0, 60).map((c) => `<option value="${esc(c.symbol)}">${esc(c.symbol)} · ${esc(c.name)}</option>`).join('')}</select></label>
        <label class="fld">Chart<select class="inp" name="iv">${INTERVALS.map((i) => `<option ${i === '4h' ? 'selected' : ''}>${i}</option>`).join('')}</select></label>
        <label class="fld">Tell me about<select class="inp" name="side">${SIDES.map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join('')}</select></label>
        <label class="fld">Only if indicator agreement is at least<input class="inp" name="score" type="number" min="10" max="100" step="5" value="25" style="width:90px"></label>
        <button class="btn primary">${icon('alerts', 16)} Create signal alert</button>
      </form>
      <p class="fine mt">This number is how strongly the indicators agree, not how likely the trade is to pay — testing showed a higher figure does not mean a better outcome. It checks once each time a candle on that chart closes, and waits a full candle before telling you again. Delivery goes to Telegram and e-mail if you have linked them on the <a href="#/account">account page</a>.</p>
      ${sigs.length ? `<div class="stack mt" style="gap:8px">${sigs.map((a) => `
        <div class="row spread" style="padding:10px;border-radius:10px;background:var(--surface-2)">
          <div><b>${esc(a.symbol)}</b> · ${esc(a.interval)} chart · ${esc(SIDES.find(([v]) => v === (a.side || 'any'))?.[1] || 'Either direction')} · agreement ≥ ${esc(String(a.min_score ?? 25))}
            <br><small class="muted">${a.last_fired_at ? `Last fired ${ago(new Date(a.last_fired_at).getTime())}` : 'Waiting for a setup'}</small></div>
          <button class="icon-btn" style="width:32px;height:32px" data-sigdel="${esc(String(a.id))}" aria-label="Delete signal alert">${icon('trash', 14)}</button>
        </div>`).join('')}</div>` : '<p class="fine mt">No signal alerts yet.</p>'}`;

    $('#sf', box).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f2 = e.currentTarget;
      const btn = f2.querySelector('button');
      btn.disabled = true;
      try {
        await createServerAlert({
          kind: 'signal', symbol: f2.sym.value, interval: f2.iv.value,
          side: f2.side.value, min_score: Math.round(+f2.score.value) || 25,
          channels: ['telegram', 'email'], active: true,
        });
        toast(`Signal alert set for ${f2.sym.value} on the ${f2.iv.value} chart.`, 'up');
        drawSignals();
      } catch (err) {
        toast(err.message, 'down');
        btn.disabled = false;
      }
    });
    $$('[data-sigdel]', box).forEach((b) => b.addEventListener('click', async () => {
      await deleteServerAlert(b.dataset.sigdel).catch(() => {});
      drawSignals();
    }));
  }

  drawSignals();
  const onAuth = () => drawSignals();
  auth.addEventListener('change', onAuth);

  const draw = () => {
    const alerts = load('alerts', []);
    $('#list', el).innerHTML = alerts.length ? `<div class="stack" style="gap:8px">${alerts.map((a, i) => {
      const c = coins.find((x) => x.symbol === a.symbol);
      return `<div class="row spread" style="padding:10px;border-radius:10px;background:var(--surface-2)">
        <div class="row">${coinLogo(c || { symbol: a.symbol }, 26)}<div><b>${esc(a.symbol)}</b> ${a.dir} <b>${usd(a.price)}</b><br><small class="muted">${a.triggered ? `✅ Triggered ${ago(a.triggered)}` : `Waiting · now ${money(c?.price)}`}</small></div></div>
        <button class="icon-btn" style="width:32px;height:32px" data-del="${i}" aria-label="Delete alert">${icon('trash', 14)}</button></div>`;
    }).join('')}</div>` : '<p class="muted">No alerts yet.</p>';
    $$('[data-del]', el).forEach((b) => b.addEventListener('click', () => { const al = load('alerts', []); al.splice(+b.dataset.del, 1); save('alerts', al); draw(); }));
  };

  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const alerts = load('alerts', []);
    const typed = parseFloat(f.price.value);
    const usdLevel = toUsd(typed);
    alerts.unshift({ symbol: f.sym.value, dir: f.dir.value, price: usdLevel, created: Date.now() });
    save('alerts', alerts);
    toast(`Alert set: ${f.sym.value} ${f.dir.value} ${money(usdLevel)}`, 'info');
    f.price.value = '';
    draw();
  });
  $('#perm', el)?.addEventListener('click', async () => {
    const r = await Notification.requestPermission();
    $('#permBox', el).innerHTML = r === 'granted' ? '<p class="fine up">Browser notifications are on.</p>' : '<p class="fine">Notifications blocked — alerts will show on screen instead.</p>';
  });
  $('#clear', el).addEventListener('click', () => { save('alerts', load('alerts', []).filter((a) => !a.triggered)); draw(); });
  const onStore = (e) => { if (e.detail.key === 'alerts') draw(); };
  window.addEventListener('cv:store', onStore);
  draw();
  return () => {
    window.removeEventListener('cv:store', onStore);
    window.removeEventListener('cv:currency', onCurrency);
    auth.removeEventListener('change', onAuth);
  };
}
