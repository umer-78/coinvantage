import { markets, isStable } from '../api/market.js';
import { $, $$, icon, toast, coinLogo, skeleton } from '../ui.js';
import { esc, price, ago, money } from '../format.js';
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
    <div class="page-head"><div><h1>Alerts</h1><p>Three kinds: a <b>price alert</b> that watches a level, a <b>signal alert</b> that fires the moment the engine's setup triggers on a chart — with the entry, stop and targets in the message — and an <b>AI signal alert</b> that tells you when the AI signal buys or sells a coin.</p></div></div>

    <div class="card" style="margin-bottom:14px">
      <div class="card-h"><h3>Signal alert</h3><span class="chip warn">Runs on the server</span></div>
      <div id="sigBox">${skeleton(3, 22)}</div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="card-h"><h3>AI signal alert</h3><span class="chip warn">Runs on the server</span></div>
      <div id="aiBox">${skeleton(3, 22)}</div>
    </div>

    <div class="grid g2">
      <div class="card">
        <h3 style="margin-bottom:12px">New price alert</h3>
        <form id="f" class="stack" style="gap:10px">
          <label class="fld">Coin<select class="inp" name="sym">${coins.map((c) => `<option value="${esc(c.symbol)}" ${c.symbol === (preset || 'BTC').toUpperCase() ? 'selected' : ''}>${esc(c.symbol)} · ${esc(c.name)}</option>`).join('')}</select></label>
          <div class="row">
            <label class="fld">When price is<select class="inp" name="dir"><option value="above">Above</option><option value="below">Below</option></select></label>
            <label class="fld" style="flex:1"><span>Price (<span id="curCode">${esc(fx.code)}</span>)</span><input class="inp" name="price" type="number" step="any" min="0" required></label>
          </div>
          <p class="fine" id="cur"></p>
          <button class="btn primary">${icon('alerts', 16)} Create alert</button>
          <p class="fine" id="reach"></p>
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

    const rows = await serverAlerts().catch(() => null);
    // A failed load used to read "No signal alerts yet" while alerts existed.
    if (!rows) {
      box.innerHTML = `<p class="fine">Could not load your signal alerts — the server did not answer.</p><button class="btn sm" id="sigRetry">Try again</button>`;
      $('#sigRetry', box).addEventListener('click', drawSignals);
      return;
    }
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
      try { await deleteServerAlert(b.dataset.sigdel); } catch (err) { toast(err.message, 'down'); }
      drawSignals();
    }));
  }

  // AI signal alerts: a message when the coin page's AI signal (the chart's
  // tested trading rules) buys or sells, checked on the server at each close.
  const AI_SIDES = [['any', 'Buys and sells'], ['long', 'Buys only'], ['short', 'Sells only']];
  async function drawAi() {
    const box = $('#aiBox', el);
    if (!box) return;
    if (!backendEnabled()) { box.innerHTML = '<p class="fine">AI signal alerts need the backend, which is not connected on this deployment.</p>'; return; }
    if (!auth.user) {
      box.innerHTML = `<p class="fine">Sign in to get a message when the AI signal buys or sells a coin — it runs on the server, so it reaches you with the browser closed.</p>
        <button class="btn primary mt" id="aiSignIn">${icon('bolt', 16)} Sign in</button>`;
      $('#aiSignIn', box).addEventListener('click', () => openAuth('in'));
      return;
    }
    const rows = await serverAlerts().catch(() => null);
    if (!rows) {
      box.innerHTML = '<p class="fine">Could not load your AI signal alerts — the server did not answer.</p><button class="btn sm" id="aiRetry">Try again</button>';
      $('#aiRetry', box).addEventListener('click', drawAi);
      return;
    }
    const mine = rows.filter((r) => r.kind === 'ai');
    box.innerHTML = `
      <form id="af" class="row" style="gap:10px;align-items:flex-end;flex-wrap:wrap">
        <label class="fld">Coin<select class="inp" name="sym">${coins.slice(0, 60).map((c) => `<option value="${esc(c.symbol)}">${esc(c.symbol)} · ${esc(c.name)}</option>`).join('')}</select></label>
        <label class="fld">Chart<select class="inp" name="iv">${['15m', '1h', '4h', '1d'].map((i) => `<option ${i === '1d' ? 'selected' : ''}>${i}</option>`).join('')}</select></label>
        <label class="fld">Tell me about<select class="inp" name="side">${AI_SIDES.map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join('')}</select></label>
        <button class="btn primary">${icon('alerts', 16)} Create AI signal alert</button>
      </form>
      <p class="fine mt">The same signal as on each coin page: the chart's tested trading rules, checked when a candle closes. The message says what it did — bought (with the stop) or sold (with the result after fees). In testing, buys like these picked direction no better than chance; the coin page and the Track record show the record. Nothing here places an order.</p>
      ${mine.length ? `<div class="stack mt" style="gap:8px">${mine.map((a) => `
        <div class="row spread" style="padding:10px;border-radius:10px;background:var(--surface-2)">
          <div><b>${esc(a.symbol)}</b> · ${esc(a.interval)} chart · ${esc(AI_SIDES.find(([v]) => v === (a.side || 'any'))?.[1] || 'Buys and sells')}
            <br><small class="muted">${a.last_fired_at ? `Last fired ${ago(new Date(a.last_fired_at).getTime())}` : 'Waiting for a buy or sell'}</small></div>
          <button class="icon-btn" style="width:32px;height:32px" data-aidel="${esc(String(a.id))}" aria-label="Delete AI signal alert">${icon('trash', 14)}</button>
        </div>`).join('')}</div>` : '<p class="fine mt">No AI signal alerts yet.</p>'}`;
    $('#af', box).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f2 = e.currentTarget;
      const btn = f2.querySelector('button');
      btn.disabled = true;
      try {
        await createServerAlert({ kind: 'ai', symbol: f2.sym.value, interval: f2.iv.value, side: f2.side.value, channels: ['telegram', 'email'], active: true });
        toast(`AI signal alert set for ${f2.sym.value} on the ${f2.iv.value} chart.`, 'up');
        drawAi();
      } catch (err) {
        toast(err.message, 'down');
        btn.disabled = false;
      }
    });
    $$('[data-aidel]', box).forEach((b) => b.addEventListener('click', async () => {
      try { await deleteServerAlert(b.dataset.aidel); } catch (err) { toast(err.message, 'down'); }
      drawAi();
    }));
  }

  drawSignals();
  drawAi();
  const onAuth = () => { drawSignals(); drawAi(); loadElsewhere(); };
  auth.addEventListener('change', onAuth);

  // Price alerts were kept only in this browser, so nothing reached Telegram or
  // e-mail with the site closed, though the server already knew how to send
  // them. Signed in, each one is now saved on the server as well.
  const signedIn = () => !!auth.user && backendEnabled();
  const reach = () => {
    const r = $('#reach', el);
    if (r) r.textContent = signedIn()
      ? 'Signed in: the server watches your price alerts too and sends them to Telegram or e-mail with the site closed, once you link them on the account page.'
      : 'Works while this site is open. Sign in to also get price alerts by Telegram or e-mail with the site closed.';
  };
  let elsewhere = [];   // server price alerts saved from another device
  const row = (c, sym, dir, lvl, sub, attr) => `<div class="row spread" style="padding:10px;border-radius:10px;background:var(--surface-2)">
        <div class="row">${coinLogo(c || { symbol: sym }, 26)}<div><b>${esc(sym)}</b> ${esc(dir)} <b>${money(lvl)}</b><br><small class="muted">${sub}</small></div></div>
        <button class="icon-btn" style="width:32px;height:32px" ${attr} aria-label="Delete alert">${icon('trash', 14)}</button></div>`;
  const draw = () => {
    const alerts = load('alerts', []);
    const items = [
      ...alerts.map((a, i) => {
        const c = coins.find((x) => x.symbol === a.symbol);
        return row(c, a.symbol, a.dir, a.price, `${a.triggered ? `✅ Triggered ${ago(a.triggered)}` : `Waiting · now ${money(c?.price)}`}${a.serverId ? ' · also by Telegram / e-mail' : ''}`, `data-del="${i}"`);
      }),
      ...elsewhere.map((a) => row(coins.find((x) => x.symbol === a.symbol), a.symbol, a.direction, Number(a.price),
        `${a.triggered_at ? `✅ Triggered ${ago(new Date(a.triggered_at).getTime())}` : 'Waiting'} · saved on another device`, `data-srv="${esc(String(a.id))}"`)),
    ];
    $('#list', el).innerHTML = items.length ? `<div class="stack" style="gap:8px">${items.join('')}</div>` : '<p class="muted">No alerts yet.</p>';
    $$('[data-del]', el).forEach((b) => b.addEventListener('click', async () => {
      const al = load('alerts', []);
      const [gone] = al.splice(+b.dataset.del, 1);
      save('alerts', al);
      if (gone?.serverId) { try { await deleteServerAlert(gone.serverId); } catch (err) { toast(err.message, 'down'); } }
    }));
    $$('[data-srv]', el).forEach((b) => b.addEventListener('click', async () => {
      try { await deleteServerAlert(b.dataset.srv); elsewhere = elsewhere.filter((a) => String(a.id) !== b.dataset.srv); draw(); } catch (err) { toast(err.message, 'down'); }
    }));
  };
  const loadElsewhere = async () => {
    reach();
    if (!signedIn()) { elsewhere = []; draw(); return; }
    const rows = await serverAlerts().catch(() => null);
    if (!rows) return;
    const mine = new Set(load('alerts', []).map((a) => String(a.serverId)));
    elsewhere = rows.filter((a) => (a.kind ?? 'price') === 'price' && !mine.has(String(a.id)));
    draw();
  };

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = f.querySelector('button');
    const typed = parseFloat(f.price.value);
    // "0" passed the form's own check and made an alert that could never fire.
    if (!(typed > 0)) { toast('Enter a price above zero.', 'down'); return; }
    const entry = { symbol: f.sym.value, dir: f.dir.value, price: toUsd(typed), created: Date.now() };
    const nowPx = coins.find((c) => c.symbol === entry.symbol)?.price;
    const already = Number.isFinite(nowPx) && ((entry.dir === 'above' && nowPx >= entry.price) || (entry.dir === 'below' && nowPx <= entry.price));
    let where = 'It works while this site is open.';
    if (signedIn()) {
      btn.disabled = true;
      try {
        entry.serverId = await createServerAlert({ kind: 'price', symbol: entry.symbol, direction: entry.dir, price: entry.price, channels: ['telegram', 'email'], active: true });
        where = 'The server watches it too.';
      } catch (err) { where = `Saved in this browser only: ${err.message}`; }
      btn.disabled = false;
    }
    const alerts = load('alerts', []);
    alerts.unshift(entry);
    save('alerts', alerts);
    toast(`Alert set: ${entry.symbol} ${entry.dir} ${money(entry.price)}. ${where}${already ? ` ${entry.symbol} is already ${entry.dir} that price, so it will go off straight away.` : ''}`, 'info');
    f.price.value = '';
  });
  $('#perm', el)?.addEventListener('click', async () => {
    const r = await Notification.requestPermission();
    $('#permBox', el).innerHTML = r === 'granted' ? '<p class="fine up">Browser notifications are on.</p>' : '<p class="fine">Notifications blocked — alerts will show on screen instead.</p>';
  });
  $('#clear', el).addEventListener('click', () => {
    const all = load('alerts', []);
    save('alerts', all.filter((a) => !a.triggered));
    // a server copy that has not fired yet would still fire later
    for (const a of all) if (a.triggered && a.serverId) deleteServerAlert(a.serverId).catch(() => {});
  });
  const onStore = (e) => { if (e.detail.key === 'alerts') draw(); };
  window.addEventListener('cv:store', onStore);
  draw();
  loadElsewhere();
  return () => {
    window.removeEventListener('cv:store', onStore);
    window.removeEventListener('cv:currency', onCurrency);
    auth.removeEventListener('change', onAuth);
  };
}
