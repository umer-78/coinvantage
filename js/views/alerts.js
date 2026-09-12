import { markets, isStable } from '../api/market.js';
import { $, $$, icon, toast, coinLogo } from '../ui.js';
import { esc, price, usd, ago, money} from '../format.js';
import { load, save } from '../store.js';

export const title = 'Price alerts';

export async function render(el, [preset]) {
  const all = await markets().catch(() => []);
  const coins = all.filter((c) => c.binance && !isStable(c.symbol));
  const perm = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
  el.innerHTML = `
    <div class="page-head"><div><h1>Price alerts</h1><p>Get a notification when a coin crosses your price — checked live against the Binance stream while this site is open.</p></div></div>
    <div class="grid g2">
      <div class="card">
        <h3 style="margin-bottom:12px">New alert</h3>
        <form id="f" class="stack" style="gap:10px">
          <label class="fld">Coin<select class="inp" name="sym">${coins.map((c) => `<option value="${esc(c.symbol)}" ${c.symbol === (preset || 'BTC').toUpperCase() ? 'selected' : ''}>${esc(c.symbol)} · ${esc(c.name)}</option>`).join('')}</select></label>
          <div class="row">
            <label class="fld">When price is<select class="inp" name="dir"><option value="above">Above</option><option value="below">Below</option></select></label>
            <label class="fld" style="flex:1">Price (USD)<input class="inp" name="price" type="number" step="any" min="0" required></label>
          </div>
          <p class="fine" id="cur"></p>
          <button class="btn primary">${icon('alerts', 16)} Create alert</button>
        </form>
        <div class="mt" id="permBox">${perm === 'granted' ? '<p class="fine up">Browser notifications are on.</p>' : perm === 'unsupported' ? '<p class="fine">This browser does not support notifications — alerts appear as on-screen messages.</p>' : '<button class="btn sm" id="perm">Enable browser notifications</button>'}</div>
      </div>
      <div class="card"><div class="card-h"><h3>Your alerts</h3><button class="btn sm ghost" id="clear">Clear triggered</button></div><div id="list"></div></div>
    </div>`;

  const f = $('#f', el);
  const showCur = () => { const c = coins.find((x) => x.symbol === f.sym.value); if (c) { $('#cur', el).textContent = `Current price: ${money(c.price)}`; if (!f.price.value) f.price.placeholder = price(c.price); } };
  f.sym.addEventListener('change', () => { f.price.value = ''; showCur(); });
  showCur();

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
    alerts.unshift({ symbol: f.sym.value, dir: f.dir.value, price: parseFloat(f.price.value), created: Date.now() });
    save('alerts', alerts);
    toast(`Alert set: ${f.sym.value} ${f.dir.value} ${money(parseFloat(f.price.value))}`, 'info');
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
  return () => window.removeEventListener('cv:store', onStore);
}
