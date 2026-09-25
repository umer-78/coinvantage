// Account page: profile, alert channels (e-mail + Telegram), premium status, data & deletion.
import { $, $$, icon, toast, modal } from '../ui.js';
import { esc, money } from '../format.js';
import { load } from '../store.js';
import { myActivity, myForecasts, forecastScore, resolveDueForecasts, clearMyActivity } from '../api/activity.js';
import { changePassword, signOutEverywhere } from '../api/security.js';
import { getCandles, findCoin } from '../api/market.js';
import { dateTime, pct, ago } from '../format.js';
import { auth, sb, isPremium, isAdmin, callFn, updateProfile, refreshProfile, signOut } from '../api/backend.js';
import { openAuth } from './auth.js';

export const title = 'Account';

export async function render(el, [flag]) {
  await sb();
  if (!auth.user) {
    el.innerHTML = `<div class="card empty"><h3>You're not signed in</h3><p>An account keeps your watchlist, portfolio and alerts in sync on every device, and lets alerts reach you by e-mail or Telegram while the site is closed.</p><button class="btn primary" id="si">Sign in or create an account</button></div>`;
    $('#si', el).addEventListener('click', () => openAuth('up'));
    return;
  }
  if (flag === '?paid=1' || location.hash.includes('paid=1')) {
    await refreshProfile();
    toast('Payment received — Premium is active. Thank you!', 'up', 7000);
  }

  const p = auth.profile || {};
  const premium = isPremium();
  const emailStatus = await callFn('account', { action: 'email-status' }).catch(() => ({ emailEnabled: false }));

  el.innerHTML = `
    <div class="page-head"><div><h1>Account</h1><p>Signed in as <b>${esc(auth.user.email)}</b>${p.is_admin ? ' · <span class="chip warn">Admin</span>' : ''}</p></div>
      <button class="btn ghost" id="out">Sign out</button></div>

    <div class="grid g2">
      <div class="card">
        <h3>Profile</h3>
        <form class="stack mt" style="gap:10px" id="pf">
          <label class="fld">Display name<input class="inp" name="display_name" maxlength="60" value="${esc(p.display_name || '')}"></label>
          <label class="fld">E-mail<input class="inp" value="${esc(p.email || auth.user.email)}" disabled></label>
          <button class="btn">Save profile</button>
        </form>
        <p class="fine mt">Member since ${p.created_at ? new Date(p.created_at).toLocaleDateString() : '—'}.</p>
      </div>

      <div class="card">
        <h3>${premium ? 'Premium' : 'Plan'}</h3>
        ${premium
          ? `<p class="mt"><span class="chip ${isAdmin() ? 'warn' : 'up'}">${isAdmin() ? 'Owner — Premium free, forever' : 'Premium active'}</span></p><p>${isAdmin() ? 'You own this site, so every Premium feature is yours at no cost and never expires.' : p.premium_until ? `Runs until <b>${new Date(p.premium_until).toLocaleDateString()}</b> — ${Math.max(0, Math.ceil((new Date(p.premium_until) - Date.now()) / 864e5))} days left.` : 'Lifetime access.'}</p>
             <ul class="feat"><li>Up to 50 active server-side alerts</li><li>Telegram + e-mail delivery</li><li>Signal alerts that fire with the browser closed</li><li>Full track record with per-coin breakdown and CSV export</li></ul>`
          : `<p class="mt">You're on the <b>free</b> plan: live prices, charts, signals, forecasts, history comparison and 3 server-side alerts.</p>
             <a class="btn primary mt" href="#/premium">${icon('star', 16)} See Premium</a>`}
      </div>

      <div class="card">
        <h3>Alerts by e-mail</h3>
        <div id="emailBox" class="mt"></div>
      </div>

      <div class="card">
        <h3>Alerts on Telegram</h3>
        <div id="tgBox" class="mt"></div>
      </div>

      <div class="card" style="grid-column:1/-1">
        <div class="card-h"><h3>Your activity</h3><button class="btn sm ghost" id="clearAct">Clear history</button></div>
        <div id="activityBox">Loading…</div>
      </div>

      <div class="card">
        <h3>Your data</h3>
        <p class="fine">Your watchlist, holdings, watch-only wallet addresses and chart drawings sync to your account. Prices, signals and forecasts are computed in your browser — we never see them.</p>
        <div class="row mt" style="gap:8px">
          <button class="btn sm" id="export">Download my data (JSON)</button>
          <button class="btn sm" id="test">Send me a test alert</button>
        </div>
      </div>

      <div class="card" style="grid-column:1/-1">
        <div class="card-h"><h3>Security</h3></div>
        <div id="secBox">Loading…</div>
      </div>

      <div class="card">
        <h3>Danger zone</h3>
        <p class="fine">Deleting your account removes your profile, synced data and alerts permanently. Local data on this device stays until you clear it.</p>
        <button class="btn sm ghost down mt" id="del" style="color:var(--down);border-color:var(--down)">Delete my account</button>
      </div>
    </div>`;

  // ---------------------------------------------------------------- profile
  $('#pf', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    await updateProfile({ display_name: e.target.display_name.value.trim().slice(0, 60) });
    toast('Profile saved.', 'up');
  });
  $('#out', el).addEventListener('click', async () => { await signOut(); location.hash = '#/'; });

  // ---------------------------------------------------------------- e-mail alerts
  const paintEmail = () => {
    const pr = auth.profile || {};
    const box = $('#emailBox', el);
    if (!emailStatus.emailEnabled) {
      box.innerHTML = '<p class="fine">E-mail delivery is not configured on this site yet, so alerts will only show in the browser. Telegram works independently.</p>';
      return;
    }
    box.innerHTML = pr.email_verified
      ? `<p><span class="chip up">E-mail verified</span></p>
         <label class="row" style="gap:8px"><input type="checkbox" id="ea" ${pr.email_alerts ? 'checked' : ''}> Send my price alerts to ${esc(pr.email)}</label>`
      : `<p class="fine">Verify your e-mail so alerts can reach you when the site is closed.</p>
         <div class="row" style="gap:8px"><button class="btn sm" id="sendV">Send verification code</button><span class="fine" id="vMsg"></span></div>
         <div class="row mt" style="gap:8px"><input class="inp" id="vCode" inputmode="numeric" maxlength="6" placeholder="6-digit code" style="max-width:140px"><button class="btn sm" id="doV">Verify</button></div>`;
    $('#ea', el)?.addEventListener('change', async (e) => { await updateProfile({ email_alerts: e.target.checked }); toast(e.target.checked ? 'E-mail alerts on.' : 'E-mail alerts off.', 'info'); });
    $('#sendV', el)?.addEventListener('click', async () => {
      $('#vMsg', el).textContent = 'Sending…';
      try { await callFn('account', { action: 'send-code', purpose: 'verify' }); $('#vMsg', el).textContent = 'Code sent.'; }
      catch (e) { $('#vMsg', el).textContent = e.message; }
    });
    $('#doV', el)?.addEventListener('click', async () => {
      try {
        await callFn('account', { action: 'verify-email', code: $('#vCode', el).value.trim() });
        await refreshProfile();
        toast('E-mail verified.', 'up');
        paintEmail();
      } catch (e) { toast(e.message, 'down'); }
    });
  };
  paintEmail();

  // ---------------------------------------------------------------- telegram
  const paintTg = () => {
    const pr = auth.profile || {};
    const box = $('#tgBox', el);
    box.innerHTML = pr.telegram_chat_id
      ? `<p><span class="chip up">Connected</span> ${pr.telegram_username ? `@${esc(pr.telegram_username)}` : ''}</p>
         <p class="fine">The bot also answers /price BTC, /signal ETH and /alerts.</p>
         <button class="btn sm ghost" id="tgOff">Disconnect</button>`
      : `<p class="fine">Get alerts pushed to Telegram — free, instant, and works when this site is closed.</p>
         <button class="btn sm" id="tgOn">${icon('send', 14)} Connect Telegram</button><p class="fine" id="tgMsg"></p>`;
    $('#tgOn', el)?.addEventListener('click', async () => {
      $('#tgMsg', el).textContent = 'Preparing link…';
      try {
        const r = await callFn('account', { action: 'telegram-link' });
        $('#tgMsg', el).innerHTML = `Open <a href="${esc(r.url)}" target="_blank" rel="noopener"><b>@${esc(r.bot)}</b></a> and press Start. Code: <code>${esc(r.code)}</code> (valid 20 minutes). Come back and refresh this page.`;
        window.open(r.url, '_blank', 'noopener');
      } catch (e) { $('#tgMsg', el).textContent = e.message; }
    });
    $('#tgOff', el)?.addEventListener('click', async () => {
      await callFn('account', { action: 'telegram-unlink' });
      await refreshProfile();
      paintTg();
      toast('Telegram disconnected.', 'info');
    });
  };
  paintTg();

  // ---------------------------------------------------------------- data
  $('#export', el).addEventListener('click', () => {
    const data = {
      exported: new Date().toISOString(), email: auth.user.email,
      watchlist: load('watchlist', []), holdings: load('holdings', []), wallets: load('wallets', []),
      alerts: load('alerts', []), settings: load('settings', {}),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'coinvantage-data.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });
  $('#test', el).addEventListener('click', async () => {
    try { await callFn('account', { action: 'test-alert' }); toast('Test alert sent.', 'up'); }
    catch (e) { toast(e.message, 'down'); }
  });

  $('#del', el).addEventListener('click', () => {
    const m = modal(`<h3>Delete your account?</h3><p>This removes your profile, synced watchlist and holdings, and all server-side alerts. It cannot be undone.</p>
      <label class="fld mt">Type <b>DELETE</b> to confirm<input class="inp" id="cf"></label>
      <div class="row mt" style="gap:8px"><button class="btn" id="no">Keep my account</button><button class="btn primary" id="yes" disabled style="background:var(--down);color:#fff">Delete permanently</button></div>`);
    $('#cf', m.el).addEventListener('input', (e) => { $('#yes', m.el).disabled = e.target.value.trim().toUpperCase() !== 'DELETE'; });
    $('#no', m.el).addEventListener('click', m.close);
    $('#yes', m.el).addEventListener('click', async () => {
      try { await callFn('account', { action: 'delete-account' }); await signOut(); m.close(); location.hash = '#/'; toast('Your account was deleted.', 'info'); }
      catch (e) { toast(e.message, 'down'); }
    });
  });

  // ---------------------------------------------------------------- security
  const paintSecurity = async () => {
    const box = $('#secBox', el);
    try {
      box.innerHTML = `
        <div>
          <div>
            <h4 class="fine">Password &amp; sessions</h4>
            <form class="stack" style="gap:8px" id="pwForm">
              <label class="fld">New password<input class="inp" name="pw" type="password" minlength="10" autocomplete="new-password" placeholder="at least 10 characters"></label>
              <button class="btn sm">Change password</button>
              <p class="fine" id="pwMsg"></p>
            </form>
            <p class="fine mt">Signed in on another device you no longer use?</p>
            <button class="btn sm ghost" id="soAll">Sign out everywhere</button>
          </div>
        </div>
        <p class="fine mt">This site never asks for exchange API keys, private keys or seed phrases — not on this page, not anywhere. Anyone who does is not us.</p>`;

      $('#pwForm', el).addEventListener('submit', async (e) => {
        e.preventDefault();
        const msg = $('#pwMsg', el);
        try {
          await changePassword(e.target.pw.value);
          e.target.reset();
          msg.innerHTML = '<span class="up">Password changed.</span>';
        } catch (e2) { msg.innerHTML = `<span class="down">${esc(e2.message)}</span>`; }
      });

      $('#soAll', el).addEventListener('click', async () => {
        try { await signOutEverywhere(); toast('Signed out on every device.', 'info'); location.hash = '#/'; }
        catch (e) { toast(e.message, 'down'); }
      });
    } catch (e) {
      box.innerHTML = `<p class="fine">Could not load security settings: ${esc(e.message)}</p>`;
    }
  };
  paintSecurity();

  // ---------------------------------------------------------------- activity
  // Forecasts you were shown are logged before the outcome is known, then scored
  // against the real close — so this hit rate is yours, not a marketing number.
  const closeAt = async (symbol, interval, atMs) => {
    let coin, r;
    try {
      coin = await findCoin(symbol);
      if (!coin) return NaN;
      r = await getCandles(coin, interval, 500);
    } catch { return NaN; }
    let best = NaN, bestGap = Infinity;
    for (const c of r.candles) {
      const gap = Math.abs(c.t - atMs);
      if (c.t <= atMs && gap < bestGap) { bestGap = gap; best = c.c; }
    }
    return bestGap < 6 * 3600e3 ? best : NaN;
  };

  const paintActivity = async () => {
    const box = $('#activityBox', el);
    try {
      await resolveDueForecasts(closeAt);
      const [acts, fcs] = await Promise.all([myActivity(50), myForecasts(100)]);
      const sc = forecastScore(fcs);
      const label = { view_coin: 'Opened', alert_created: 'Created an alert for', alert_fired: 'Alert fired on', forecast_seen: 'Saw a forecast for', trade_link: 'Opened a trade link for', signed_in: 'Signed in' };
      box.innerHTML = `
        <div class="grid g4">
          <div class="stat"><span class="k">Forecasts you were shown</span><span class="v">${sc.shown}</span><span class="s fine">${sc.open} still open</span></div>
          <div class="stat"><span class="k">Scored so far</span><span class="v">${sc.resolved}</span><span class="s fine">${sc.right} called right</span></div>
          <div class="stat"><span class="k">Your hit rate</span><span class="v ${sc.accuracy === null ? '' : sc.accuracy >= 55 ? 'up' : sc.accuracy < 50 ? 'down' : ''}">${sc.accuracy === null ? '—' : `${sc.accuracy.toFixed(0)}%`}</span><span class="s fine">on what you actually viewed</span></div>
          <div class="stat"><span class="k">Coins you follow most</span><span class="v" style="font-size:16px">${topCoins(acts) || '—'}</span></div>
        </div>

        ${fcs.length ? `<h4 class="mt fine">Forecasts you were shown</h4>
          <div class="tbl-wrap"><table class="tbl"><thead><tr><th class="l">Coin</th><th>TF</th><th class="l">Shown</th><th>Price then</th><th>AI up</th><th>Price after</th><th>Result</th></tr></thead><tbody>
          ${fcs.slice(0, 25).map((f) => `<tr data-sym="${esc(f.symbol)}">
            <td class="l"><b>${esc(f.symbol)}</b></td><td class="fine">${esc(f.interval)}</td>
            <td class="l fine">${dateTime(new Date(f.shown_at).getTime())}</td>
            <td>${money(f.price)}</td>
            <td class="${f.prob_up >= 0.54 ? 'up' : f.prob_up <= 0.46 ? 'down' : ''}">${f.prob_up === null ? '—' : `${(f.prob_up * 100).toFixed(0)}%`}</td>
            <td>${f.resolved ? money(f.outcome_price) : '<span class="fine muted">open</span>'}</td>
            <td>${f.was_right === null ? '—' : f.was_right ? '<span class="up">✓ right</span>' : '<span class="down">✕ wrong</span>'}</td></tr>`).join('')}
          </tbody></table></div>` : '<p class="fine mt">No forecasts logged yet — open a coin page and one will be recorded here.</p>'}

        ${acts.length ? `<h4 class="mt fine">Recent activity</h4>
          <div class="stack" style="gap:4px">${acts.slice(0, 20).map((a) => `<div class="row spread fine" style="padding:5px 0;border-bottom:1px solid var(--border)">
            <span>${esc(label[a.kind] || a.kind)} ${a.symbol ? `<a href="#/coin/${esc(a.symbol)}"><b>${esc(a.symbol)}</b></a>` : ''}</span>
            <span class="muted">${ago(new Date(a.created_at).getTime())}</span></div>`).join('')}</div>` : ''}

        <p class="fine mt">Only you can read this — the database blocks every other account. The prediction half of each forecast row can never be edited after it is written, which is what makes the hit rate above trustworthy.</p>`;
      $$('#activityBox tr[data-sym]', el).forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/coin/${tr.dataset.sym}`; }));
    } catch (e) {
      box.innerHTML = `<p class="fine">Could not load your activity: ${esc(e.message)}</p>`;
    }
  };
  const topCoins = (acts) => {
    const n = {};
    for (const a of acts) if (a.symbol) n[a.symbol] = (n[a.symbol] || 0) + 1;
    return Object.entries(n).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([s]) => esc(s)).join(', ');
  };
  paintActivity();
  $('#clearAct', el).addEventListener('click', async () => {
    await clearMyActivity();
    toast('Activity history cleared.', 'info');
    paintActivity();
  });
  void pct;

  const onAuth = () => { paintEmail(); paintTg(); };
  auth.addEventListener('change', onAuth);
  void money;
  return () => auth.removeEventListener('change', onAuth);
}
