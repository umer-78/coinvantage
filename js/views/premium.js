// Premium / pricing page. Card checkout via Stripe when the admin has enabled it,
// otherwise the manual payment instructions the admin set.
import { $, icon, toast } from '../ui.js';
import { esc } from '../format.js';
import { auth, sb, isPremium, isAdmin, getAppSettings, getPosts, callFn } from '../api/backend.js';
import { openAuth } from './auth.js';

export const title = 'Premium';

const FREE = [
  'Live prices from Binance + 10 exchanges',
  'Candlestick charts with 12 indicators',
  'Buy / sell signals with entry, stop and targets',
  'Historical analysis with published evaluation',
  'History & cycles: past-pattern comparison',
  'Portfolio, watch-only wallets and watchlist sync',
  '3 server-side price alerts',
];
const PAID = [
  'Everything in Free',
  'Up to 50 server-side alerts (e-mail + Telegram)',
  'VIP trade ideas with entry, stop-loss and targets',
  'Full signal track record with per-coin breakdown',
  'Priority access to new AI features',
];

export async function render(el) {
  await sb();
  const [settings, posts] = await Promise.all([getAppSettings().catch(() => ({})), getPosts(6).catch(() => [])]);
  const p = settings.premium || { price: 19, currency: 'USD', period_days: 30, stripe_enabled: false };
  const site = settings.site || {};
  const already = isPremium();
  const ideas = posts.filter((x) => x.kind === 'idea');

  el.innerHTML = `
    <div class="page-head"><div><h1>Premium</h1><p>The analysis stays free. Premium pays for the parts that run on a server while your browser is closed — alerts, tracking and VIP ideas.</p></div></div>

    ${isAdmin()
      ? '<div class="card" style="border-color:var(--accent)"><div class="row spread"><div><h3>You own this site — Premium is free for you</h3><p class="fine">Your admin account has every Premium feature permanently, at no cost. This page is what your visitors see.</p></div><span class="chip warn">Owner</span></div></div>'
      : already ? '<div class="card" style="border-color:var(--up)"><div class="row spread"><div><h3>Premium is active on your account</h3><p class="fine">Manage it on the <a href="#/account">account page</a>.</p></div><span class="chip up">Active</span></div></div>' : ''}

    <div class="price-grid mt">
      <div class="plan-card">
        <h2>Free</h2>
        <div class="amt">$0</div>
        <p class="fine">Forever. No card, no sign-up needed to browse.</p>
        <ul class="feat">${FREE.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
      </div>
      <div class="plan-card hero">
        <div class="row spread"><h2>Premium</h2><span class="chip warn">${icon('star', 12)} Most popular</span></div>
        <div class="amt">${esc(p.currency === 'USD' ? '$' : '')}${esc(String(p.price ?? 19))}${p.currency !== 'USD' ? ` ${esc(p.currency)}` : ''} <small class="fine">/ ${esc(String(p.period_days || 30))} days</small></div>
        <p class="fine">One-off payment, no auto-renewal. Extend whenever you want.</p>
        <ul class="feat">${PAID.map((f) => `<li>${esc(f)}</li>`).join('')}${(p.perks || []).filter((x) => !PAID.includes(x)).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        <div class="stack mt" style="gap:8px">
          <button class="btn primary" id="buy">${already ? 'Extend Premium' : 'Get Premium'}</button>
          <p class="fine" id="buyMsg"></p>
        </div>
      </div>
    </div>

    ${ideas.length ? `<div class="card mt"><div class="card-h"><h3>Latest trade ideas</h3><span class="fine">${already ? 'Full details unlocked' : 'Entry, stop and targets are Premium'}</span></div>
      <div class="stack" style="gap:10px">${ideas.map((i) => `
        <div style="padding:12px;border-radius:10px;background:var(--surface-2)">
          <div class="row spread"><b>${esc(i.title)}</b><span class="chip ${i.side === 'long' ? 'up' : i.side === 'short' ? 'down' : ''}">${esc(i.symbol || '')} ${esc(i.side || '')}</span></div>
          ${i.locked
            ? '<p class="fine warn" style="margin:6px 0 0">🔒 The reasoning, entry, stop-loss and targets are Premium-only.</p>'
            : `<p class="fine" style="margin:6px 0 0">${esc((i.body || '').slice(0, 220))}${(i.body || '').length > 220 ? '…' : ''}</p>
               <p class="fine" style="margin:6px 0 0">Entry ${esc(String(i.entry ?? '—'))} · Stop ${esc(String(i.stop_loss ?? '—'))} · Targets ${esc((i.targets || []).join(', ') || '—')}</p>`}
        </div>`).join('')}</div></div>` : ''}

    <div class="card mt">
      <h3>What Premium is not</h3>
      <p class="fine">It is not a guarantee, a managed account or a trading bot. ${esc('CoinVantage')} never places trades and never asks for exchange API keys, private keys or seed phrases. Signals and forecasts are estimates from public market data, and the measured accuracy is published on the <a href="#/track">track record</a> page — read it before paying for anything.</p>
      ${site.contact ? `<p class="fine">Questions: <b>${esc(site.contact)}</b></p>` : ''}
    </div>`;

  $('#buy', el).addEventListener('click', async () => {
    if (!auth.user) { openAuth('up'); return; }
    const msg = $('#buyMsg', el);
    if (!p.stripe_enabled) {
      msg.innerHTML = esc(p.manual_payment_text || 'Card payments are not enabled yet — contact the site owner to activate Premium manually.');
      return;
    }
    msg.textContent = 'Opening secure checkout…';
    try {
      const r = await callFn('account', { action: 'checkout', return_url: location.href });
      location.href = r.url;
    } catch (e) { msg.textContent = e.message; toast(e.message, 'down'); }
  });
}
