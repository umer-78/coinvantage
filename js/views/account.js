// Account page: profile, alert channels (e-mail + Telegram), premium status, data & deletion.
import { $, $$, icon, toast, modal } from '../ui.js';
import { esc, money } from '../format.js';
import { load } from '../store.js';
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
             <ul class="feat"><li>Unlimited server-side alerts</li><li>Telegram + e-mail delivery</li><li>Premium trade ideas</li><li>Full signal track record</li></ul>`
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

      <div class="card">
        <h3>Your data</h3>
        <p class="fine">Your watchlist, holdings, watch-only wallet addresses and chart drawings sync to your account. Prices, signals and forecasts are computed in your browser — we never see them.</p>
        <div class="row mt" style="gap:8px">
          <button class="btn sm" id="export">Download my data (JSON)</button>
          <button class="btn sm" id="test">Send me a test alert</button>
        </div>
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

  const onAuth = () => { paintEmail(); paintTg(); };
  auth.addEventListener('change', onAuth);
  void money;
  return () => auth.removeEventListener('change', onAuth);
}
