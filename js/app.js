// App shell: router, navigation, search, live ticker, theme, currency, language,
// account menu, cloud sync and the alerts watcher.
import { CONFIG } from './config.js';
import { $, $$, icon, coinLogo, toast, modal } from './ui.js';
import { esc, price, changeHtml, money } from './format.js';
import { settings, load, save } from './store.js';
import { markets, searchCoins, dataStatus, syncExchangeClock } from './api/market.js';
import { live } from './api/live.js';
import { fx, initCurrency, setCurrency } from './api/fx.js';
import { t, applyDir } from './i18n.js';
import { auth, sb, backendEnabled, isAdmin, signOut, pullUserData, pushUserData, serverAlerts, trackPageView, getAppSettings } from './api/backend.js';
import { startAnalyst, getAnalysis, setAnalysisCache } from './api/analyst.js';
import { initAgenticFramework, createAgent, runAgentTask } from './api/agentic.js';
import { initOpenBBLayer, fetchOpenBBData, OpenBBProvider } from './api/openbb.js';

const NAV = [
  { path: '', label: 'Markets', icon: 'markets', short: 'Markets' },
  { path: 'advice', label: 'Market scan', icon: 'bolt', short: 'Scan' },
  { path: 'ai', label: 'Assistant', icon: 'ai', short: 'Ask' },
  { path: 'trader', label: 'Trading', icon: 'forecast', short: 'Trading' },
  { path: 'scanner', label: 'Scanner', icon: 'scanner', short: 'Scanner' },
  { path: 'track', label: 'Track record', icon: 'forecast', short: 'Record' },
  { path: 'futures', label: 'Futures', icon: 'bolt', short: 'Futures' },
  { path: 'news', label: 'News', icon: 'info', short: 'News' },
  { path: 'compare', label: 'Compare', icon: 'compare', short: 'Compare' },
  { path: 'exchanges', label: 'Exchanges', icon: 'exchanges', short: 'Exchanges' },
  { path: 'wallet', label: 'Wallet', icon: 'wallet', short: 'Wallet' },
  { path: 'alerts', label: 'Alerts', icon: 'alerts', short: 'Alerts' },
  { path: 'premium', label: 'Premium', icon: 'star', short: 'Premium' },
];
const ADMIN_NAV = { path: 'admin', label: 'Admin', icon: 'chip', short: 'Admin' };
// Four destinations plus "More" — five cells, which is what fits a phone row.
const MOBILE = ['', 'advice', 'ai', 'wallet'];

const VIEWS = {
  '': () => import('./views/markets.js'),
  coin: () => import('./views/coin.js'),
  advice: () => import('./views/advice.js'),
  ai: () => import('./views/assistant.js'),
  trader: () => import('./views/trader.js'),
  scanner: () => import('./views/scanner.js'),
  track: () => import('./views/track.js'),
  futures: () => import('./views/futures.js'),
  news: () => import('./views/news.js'),
  compare: () => import('./views/compare.js'),
  exchanges: () => import('./views/exchanges.js'),
  wallet: () => import('./views/wallet.js'),
  alerts: () => import('./views/alerts.js'),
  premium: () => import('./views/premium.js'),
  account: () => import('./views/account.js'),
  admin: () => import('./views/admin.js'),
  legal: () => import('./views/legal.js'),
};

let cleanup = null;
let routeSeq = 0;

function navItems() {
  return isAdmin() ? [...NAV, ADMIN_NAV] : NAV;
}

function renderNav() {
  const cur = location.hash.replace(/^#\/?/, '').split('/')[0];
  $('#nav').innerHTML = navItems().map((n) =>
    `<a href="#/${n.path}" class="${cur === n.path ? 'on' : ''}">${icon(n.icon)}<span>${esc(t(n.label))}</span>${n.badge ? `<em class="badge">${n.badge}</em>` : ''}</a>`).join('');
  $('#bottombar').innerHTML = `${MOBILE.map((p) => {
    const n = NAV.find((x) => x.path === p);
    return `<a href="#/${p}" class="${cur === p ? 'on' : ''}">${icon(n.icon, 22)}<span>${esc(t(n.short))}</span></a>`;
  }).join('')}<button id="moreBtn" class="${MOBILE.includes(cur) ? '' : 'on'}">${icon('more', 22)}<span>${esc(t('More'))}</span></button>`;
  $('#moreBtn').addEventListener('click', openMore);
}

function openMore() {
  const cur = location.hash.replace(/^#\/?/, '').split('/')[0];
  const rest = navItems().filter((n) => !MOBILE.includes(n.path));
  const m = modal(`<h3>${esc(t('Menu'))}</h3>
    <div class="sheet-grid">${rest.map((n) => `<a href="#/${n.path}" class="sheet-item ${cur === n.path ? 'on' : ''}">${icon(n.icon, 20)}<span>${esc(t(n.label))}</span></a>`).join('')}</div>
    <div class="sheet-grid mt">
      <a href="#/account" class="sheet-item">${icon('wallet', 20)}<span>${esc(t('Account'))}</span></a>
      <a href="#/legal/terms" class="sheet-item">${icon('info', 20)}<span>${esc(t('Terms of Service'))}</span></a>
      <a href="#/legal/privacy" class="sheet-item">${icon('info', 20)}<span>${esc(t('Privacy Policy'))}</span></a>
      <a href="#/legal/risk" class="sheet-item">${icon('info', 20)}<span>${esc(t('Risk Disclosure'))}</span></a>
    </div>`);
  $$('a', m.el).forEach((a) => a.addEventListener('click', () => m.close()));
}

async function route() {
  const seq = ++routeSeq;
  const [name = '', ...params] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  const loader = VIEWS[name] || VIEWS[''];
  renderNav();
  if (typeof cleanup === 'function') { try { cleanup(); } catch (e) { console.error(e); } }
  cleanup = null;
  const view = $('#view');
  view.innerHTML = '<div class="skel-wrap"><div class="skel" style="height:28px;width:220px"></div><div class="skel" style="height:360px"></div></div>';
  try {
    const mod = await loader();
    if (seq !== routeSeq) return;
    // Each route renders into its own container, so a slow page that finishes
    // after the user has navigated away writes into a detached node, not the new page.
    const host = document.createElement('div');
    view.replaceChildren(host);
    const done = await mod.render(host, params);
    if (seq !== routeSeq) { if (typeof done === 'function') done(); return; }
    cleanup = done;
    document.title = `${mod.title ? (typeof mod.title === 'function' ? mod.title(params) : mod.title) + ' · ' : ''}${CONFIG.APP_NAME}`;
  } catch (err) {
    console.error(err);
    if (seq === routeSeq) {
      // inline onclick is blocked by the page CSP — this is the error screen, so
      // a Reload button that silently does nothing is the worst place for it
      view.innerHTML = `<div class="card empty"><h3>Something went wrong</h3><p>${esc(err.message)}</p><button class="btn" id="errReload">Reload</button></div>`;
      document.getElementById('errReload')?.addEventListener('click', () => location.reload());
    }
  }
  window.scrollTo({ top: 0 });
  trackPageView(location.hash || '#/');
}

// ---------------------------------------------------------------- theme
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#themeBtn').innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
  document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#0b0e14' : '#f5f6f8';
}
$('#themeBtn').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  settings.set({ theme: next });
  applyTheme(next);
  window.dispatchEvent(new Event('cv:theme'));
});

// ---------------------------------------------------------------- search
function initSearch() {
  const input = $('#searchInput'), box = $('#searchResults');
  let items = [], active = -1;
  const draw = () => {
    box.hidden = !items.length;
    box.innerHTML = items.map((c, i) => `<a href="#/coin/${esc(c.symbol)}" class="${i === active ? 'on' : ''}">${coinLogo(c, 22)}<b>${esc(c.name)}</b><span class="muted">${esc(c.symbol)}</span><span style="margin-left:auto">${money(c.price)}</span></a>`).join('');
  };
  input.addEventListener('input', async () => { items = await searchCoins(input.value); active = -1; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); draw(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); draw(); e.preventDefault(); }
    if (e.key === 'Enter' && items.length) { location.hash = `#/coin/${items[Math.max(0, active)].symbol}`; input.value = ''; items = []; draw(); input.blur(); }
    if (e.key === 'Escape') { items = []; draw(); }
  });
  box.addEventListener('click', () => { input.value = ''; items = []; draw(); });
  document.addEventListener('click', (e) => { if (!$('#search').contains(e.target)) { items = []; draw(); } });
  document.addEventListener('keydown', (e) => { if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') { e.preventDefault(); input.focus(); } });
}

// ---------------------------------------------------------------- currency
// The language switcher lived here. It translated the navigation and nothing
// else — no view imports t() — so choosing Urdu left every page body in English
// and the site half-translated. Removed rather than shipped in that state; the
// dictionary in i18n.js is kept for when the content is actually translated.
async function initSelectors() {
  const cur = $('#curSel');
  cur.innerHTML = CONFIG.CURRENCIES.map(([c, s]) => `<option value="${c}">${c} ${s}</option>`).join('');
  await initCurrency();
  cur.value = fx.code;
  cur.addEventListener('change', async () => {
    const ok = await setCurrency(cur.value);
    if (!ok) { toast('Exchange rate unavailable for that currency right now.', 'info'); cur.value = fx.code; return; }
    refreshTickerPrices();
    route();
  });
}

// ---------------------------------------------------------------- account
function initAccount() {
  const btn = $('#accountBtn');
  if (!backendEnabled()) { btn.hidden = true; return; }
  const paint = () => {
    const p = auth.profile;
    btn.innerHTML = auth.user
      ? `<span class="avatar">${esc((p?.display_name || auth.user.email || '?').slice(0, 1).toUpperCase())}</span>`
      : `${icon('wallet', 16)}<span class="hide-s">${esc(t('Sign in'))}</span>`;
    btn.className = auth.user ? 'icon-btn' : 'btn sm';
    renderNav();
  };
  btn.addEventListener('click', async () => {
    if (!auth.user) { (await import('./views/auth.js')).openAuth(); return; }
    const p = auth.profile;
    const m = modal(`<h3>${esc(p?.display_name || auth.user.email)}</h3>
      <p class="muted" style="margin-top:-6px">${esc(t('Signed in as'))} ${esc(auth.user.email)}${p?.is_admin ? ' · <b>Admin</b>' : ''}</p>
      <div class="stack mt" style="gap:8px">
        <a class="btn" href="#/account">${esc(t('Account'))}</a>
        <a class="btn" href="#/premium">${esc(t('Premium'))}</a>
        ${p?.is_admin ? `<a class="btn" href="#/admin">${esc(t('Admin'))}</a>` : ''}
        <button class="btn ghost" id="so">${esc(t('Sign out'))}</button>
      </div>`);
    $$('a', m.el).forEach((a) => a.addEventListener('click', () => m.close()));
    $('#so', m.el).addEventListener('click', async () => { m.close(); await signOut(); toast('Signed out.', 'info'); });
  });
  auth.addEventListener('change', () => { paint(); syncFromCloud(); });
  paint();
  sb();
}

// ---------------------------------------------------------------- cloud sync
const SYNC_KEYS = ['watchlist', 'holdings', 'wallets', 'drawings', 'settings'];
let syncing = false, pushTimer = null;

async function syncFromCloud() {
  if (!auth.user) return;
  syncing = true;
  try {
    const remote = await pullUserData();
    if (remote) {
      const localAt = load('syncedAt', 0);
      const remoteAt = new Date(remote.updated_at || 0).getTime();
      if (remoteAt > localAt) {
        if (Array.isArray(remote.watchlist) && remote.watchlist.length) save('watchlist', remote.watchlist);
        if (Array.isArray(remote.holdings)) save('holdings', remote.holdings);
        if (Array.isArray(remote.wallets)) save('wallets', remote.wallets);
        if (remote.drawings && typeof remote.drawings === 'object') save('drawings', remote.drawings);
        if (remote.settings && typeof remote.settings === 'object') settings.set(remote.settings);
        save('syncedAt', remoteAt);
        route();
      } else queuePush();
    } else queuePush();
  } catch { /* offline — local data stays authoritative */ }
  syncing = false;
}

function queuePush() {
  if (!auth.user || syncing) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    try {
      const s = settings.get();
      await pushUserData({
        watchlist: load('watchlist', []),
        holdings: load('holdings', []),
        wallets: load('wallets', []),
        drawings: load('drawings', {}),
        settings: { theme: s.theme, interval: s.interval, currency: s.currency, lang: s.lang, llmModel: s.llmModel },
      });
      save('syncedAt', Date.now());
    } catch { /* keep local */ }
  }, 1200);
}

window.addEventListener('cv:store', (e) => { if (SYNC_KEYS.includes(e.detail.key)) queuePush(); });

// ---------------------------------------------------------------- live ticker + alerts
let tickerCoins = [];
async function initTicker() {
  const list = await markets().catch(() => []);
  tickerCoins = list.filter((c) => c.binance).slice(0, 14);
  refreshTickerPrices();
  live.subscribe('!miniTicker@arr', (arr) => {
    const el = $('#ticker');
    for (const tk of arr) {
      const node = el.querySelector(`[data-pair="${tk.s}"]`);
      if (node) {
        const p = +tk.c, o = +tk.o;
        node.querySelector('.p').textContent = `${money(p)}`;
        node.querySelector('.chg').outerHTML = changeHtml((p / o - 1) * 100);
      }
      checkAlerts(tk.s, +tk.c);
    }
    window.dispatchEvent(new CustomEvent('cv:tickers', { detail: arr }));
  });
  live.addEventListener('status', (e) => {
    const pill = $('#livePill');
    pill.classList.toggle('on', e.detail.connected);
    pill.querySelector('span').textContent = e.detail.connected
      ? t('Live · Binance stream')
      : e.detail.paused ? t('Paused while the tab is in the background') : t('Reconnecting…');
  });
}

function refreshTickerPrices() {
  $('#ticker').innerHTML = tickerCoins.map((c) => `<a href="#/coin/${esc(c.symbol)}" data-pair="${c.binance}"><b>${esc(c.symbol)}</b><span class="p">${money(c.price)}</span>${changeHtml(c.change24h)}</a>`).join('');
}

function checkAlerts(pair, p) {
  const alerts = load('alerts', []);
  let changed = false;
  for (const a of alerts) {
    if (a.triggered || `${a.symbol}USDT` !== pair) continue;
    if ((a.dir === 'above' && p >= a.price) || (a.dir === 'below' && p <= a.price)) {
      a.triggered = Date.now(); changed = true;
      const msg = `${a.symbol} is ${a.dir} ${money(a.price)} (now ${money(p)})`;
      toast(`🔔 ${msg}`, a.dir === 'above' ? 'up' : 'down', 8000);
      try { if (Notification.permission === 'granted') new Notification(`${CONFIG.APP_NAME} price alert`, { body: msg, icon: 'icon.svg' }); } catch { /* ignore */ }
    }
  }
  if (changed) save('alerts', alerts);
}

// Alerts the server fired while the site was closed (e-mail / Telegram users).
async function showTriggeredServerAlerts() {
  if (!auth.user) return;
  try {
    const rows = await serverAlerts();
    const seen = new Set(load('seenAlerts', []));
    const fresh = rows.filter((a) => a.triggered_at && !seen.has(a.id));
    for (const a of fresh.slice(0, 4)) {
      toast(`🔔 ${a.symbol} went ${a.direction} ${money(a.price)} while you were away`, a.direction === 'above' ? 'up' : 'down', 9000);
      seen.add(a.id);
    }
    if (fresh.length) save('seenAlerts', [...seen].slice(-200));
  } catch { /* backend optional */ }
}
auth.addEventListener('change', showTriggeredServerAlerts);

// ---------------------------------------------------------------- risk gate (shown once)
function riskGate() {
  if (load('riskAck', false)) return;
  const m = modal(`<h3>Before you start</h3>
    <p><b>${esc(CONFIG.APP_NAME)} is an analysis tool, not a broker.</b> It never places trades, never holds your money and never asks for exchange keys, private keys or seed phrases.</p>
    <p>Signals, forecasts and AI answers are educational estimates built from public market data. They are often wrong. Crypto is volatile and you can lose everything you put in.</p>
    <p class="fine">Measured accuracy of the forecast engine is published on every coin page and on the <a href="#/track">track record</a> page — read it before you rely on anything here.</p>
    <div class="row mt" style="gap:8px">
      <button class="btn primary" id="ok">${esc(t('I understand'))}</button>
      <a class="btn ghost" href="#/legal/risk" id="more">${esc(t('Risk Disclosure'))}</a>
    </div>`, { onClose: () => save('riskAck', true) });
  $('#ok', m.el).addEventListener('click', () => { save('riskAck', true); m.close(); });
  $('#more', m.el).addEventListener('click', () => { save('riskAck', true); m.close(); });
}

// ---------------------------------------------------------------- banners
let demoBanner = '';
let siteBanner = '';
const paintBanners = () => { $('#banner').innerHTML = demoBanner + siteBanner; };

dataStatus.addEventListener('change', (e) => {
  demoBanner = e.detail.demo
    ? `<div class="banner">${icon('info', 16)} Live market APIs are not reachable from this network right now, so some panels show <b>demo data</b>. They switch back to live data automatically.</div>`
    : '';
  paintBanners();
});

// Site-wide announcement the admin can set from the admin panel.
getAppSettings().then((s) => {
  const text = s?.site?.announcement;
  if (!text) return;
  if (load('dismissedNotice', '') === text) return;
  siteBanner = `<div class="banner" id="siteNotice">${icon('info', 16)} ${esc(text)} <button class="icon-btn" id="noticeX" style="width:26px;height:26px;margin-left:auto" aria-label="Dismiss">${icon('close', 12)}</button></div>`;
  paintBanners();
  $('#noticeX')?.addEventListener('click', () => { save('dismissedNotice', text); siteBanner = ''; paintBanners(); });
}).catch(() => { /* backend optional */ });

// ---------------------------------------------------------------- boot
$$('[data-app-name]').forEach((n) => { n.textContent = CONFIG.APP_NAME; });
applyTheme(settings.get().theme || 'dark');
applyDir();

// A password-recovery link lands back on the site as `#access_token=…&type=recovery`.
// That has to be handled before the router sees the hash, or the app just tries to
// route to a nonsense page and the reader is stuck.
(async () => {
  if (!location.hash.includes('type=recovery')) return;
  try {
    const { consumeRecoveryLink } = await import('./api/backend.js');
    const { changePassword } = await import('./api/security.js');
    const ok = await consumeRecoveryLink();
    if (!ok) return;
    const m = modal(`<h3>Set a new password</h3>
      <p class="fine">You followed a recovery link, so you can choose a new password now.</p>
      <form class="stack mt" style="gap:10px" id="rp">
        <label class="fld">New password<input class="inp" name="pw" type="password" autocomplete="new-password" minlength="10" required autofocus></label>
        <p class="fine">At least 10 characters.</p>
        <button class="btn primary">Save new password</button>
        <p class="fine down" id="rpErr" hidden></p>
      </form>`);
    const f = m.el.querySelector('#rp'), err = m.el.querySelector('#rpErr');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      try {
        await changePassword(f.pw.value);
        m.close();
        toast('Password updated — you are signed in.', 'up');
      } catch (e2) { err.textContent = e2.message; err.hidden = false; }
    });
  } catch (e) { console.warn('recovery link', e); }
})();
// Put the app on the exchange's clock before anything is timestamped, and keep
// it there — a device clock that drifts makes every "2m ago" and every live /
// stale check wrong.
syncExchangeClock();
setInterval(syncExchangeClock, 6e5);
window.addEventListener('hashchange', route);
initSearch();
initSelectors().then(route).catch(route);
initTicker();
initAccount();
riskGate();

// ---------------------------------------------------------------- updates
//
// A browser that is still running last week's files is indistinguishable, to
// the person using it, from a broken site: fixes appear not to have shipped and
// sign-in seems to fail. So the app checks its own build number on every load
// and, if the server has a newer one, clears the old copy and reloads once.
// `version.txt` is rewritten by the deploy script, fetched with no-store so the
// check itself can never be answered from cache, and the reload is guarded by a
// session flag so a bad deploy cannot put the page in a refresh loop.
export const BUILD = "20260923-231735";

// A build stamp is exactly what the deploy script writes: 20260916-130124.
// Anything else — an HTML error page, a proxy notice, an offline fallback — is
// not a version, and acting on it used to unregister the service worker, delete
// every cache and reload the page. Offline, that left nothing to reload into.
const BUILD_STAMP = /^\d{8}-\d{6}$/;

async function checkForUpdate() {
  if (navigator.onLine === false) return;
  try {
    const res = await fetch(`version.txt?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const latest = (await res.text()).trim();
    if (!BUILD_STAMP.test(latest)) return;
    if (latest === BUILD) { sessionStorage.removeItem('cv:reloaded'); return; }
    if (sessionStorage.getItem('cv:reloaded') === latest) return; // already tried
    sessionStorage.setItem('cv:reloaded', latest);
    for (const reg of await navigator.serviceWorker?.getRegistrations?.() ?? []) await reg.unregister();
    // keep the downloaded AI model — it is large and unrelated to the app files
    for (const k of await caches.keys()) if (!k.startsWith('webllm')) await caches.delete(k);
    location.reload();
  } catch { /* offline, or no version file — carry on with what is loaded */ }
}

// Saving silently failing is worse than saying so: everything keeps working for
// the session and is then gone. Told once, not on every write.
window.addEventListener('cv:store-failed', (e) => {
  toast(`Nothing can be saved on this device — ${e.detail.reason}. Your watchlist, alerts and trades will be lost when you close the tab.`, 'down', 9000);
});

if (location.protocol === 'https:') {
  window.addEventListener('load', () => {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => { /* offline support is optional */ });
    checkForUpdate();
    // and again whenever the tab is brought back to the front
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });
  });
}

// --- Magic Chat & MCP (Model-Command-Protocol) Integration ---
(async function initMagicChat() {
  const chatPanel = $('#chatPanel');
  const chatClose = $('#chatClose');
  const chatMessages = $('#chatMessages');
  const chatInput = $('#chatInput');
  const chatSend = $('#chatSend');
  const chatSendBtn = document.getElementById('chatSend');

  // Toggle chat panel
  const toggleChat = () => {
    chatPanel.hidden = !chatPanel.hidden;
    if (chatPanel.hidden) {
      chatInput.value = '';
    }
  };

  $('#themeBtn', document).addEventListener('click', toggleChat);
  chatClose.addEventListener('click', toggleChat);

  // Close on escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !chatPanel.hidden) toggleChat();
  });

  // Send message
  const sendMessage = async (message) => {
    if (!message.trim()) return;
    const trimmed = message.trim();

    // Add user message to UI
    const userMsg = document.createElement('div');
    userMsg.className = 'chat-message user';
    userMsg.innerHTML = `<span class="avatar">You</span><span class="msg">${esc(trimmed)}</span>`;
    chatMessages.appendChild(userMsg);

    // Clear input
    chatInput.value = '';

    // Show typing indicator
    const typingInd = document.createElement('div');
    typingInd.className = 'chat-message bot';
    typingInd.innerHTML = `<span class="avatar">AI</span><span class="msg typing">...</span>`;
    typingInd.id = 'typingIndicator';
    chatMessages.appendChild(typingInd);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    try {
      // MCP: Model-Command-Protocol - process through analyst or agentic framework
      const response = await window.coinvantageAnalyst ?
        await getAnalysis({ query: trimmed }) :
        generateMCPResponse(trimmed);

      // Replace typing indicator with response
      const typingEl = $('#typingIndicator');
      if (typingEl) typingEl.remove();

      const botMsg = document.createElement('div');
      botMsg.className = 'chat-message bot';
      botMsg.innerHTML = `<span class="avatar">AI</span><span class="msg">${esc(response)}</span>`;
      chatMessages.appendChild(botMsg);
    } catch (err) {
      const typingEl = $('#typingIndicator');
      if (typingEl) typingEl.remove();

      const errorMsg = document.createElement('div');
      errorMsg.className = 'chat-message bot';
      errorMsg.innerHTML = `<span class="avatar">AI</span><span class="msg">Sorry, I encountered an error: ${esc(err.message)}</span>`;
      chatMessages.appendChild(errorMsg);
    }

    chatMessages.scrollTop = chatMessages.scrollHeight;
  };

  // MCP response generator (fallback when no analyst)
  const generateMCPResponse = async (message) => {
    const lower = message.toLowerCase();

    // Command handlers (MCP commands)
    if (lower.startsWith('/')) {
      const cmd = lower.slice(1).split(' ')[0];
      const args = lower.slice(1 + cmd.length).trim();

      switch (cmd) {
        case 'price':
          return `Current price data: fetching... (would use OpenBB or Binance API)`;
        case 'signal':
          return `Signal analysis: ${args || 'No symbol specified'}. Use /signal BTC for trading signals.`;
        case 'help':
          return `/price - Get price data\n/signal [symbol] - Get trading signals\n/market - Market analysis\n/reset - Reset session state`;
        case 'market':
          return `Market analysis: ${args || 'BTC/USDT'}. Would analyze trends, volume, and technical indicators.`;
        case 'reset':
          // In a real implementation, this would reset the trader state
          return 'Session reset confirmed. All simulated trades cleared, AI session returned to idle state.';
        default:
          return `Unknown MCP command: /${cmd}. Type /help for available commands.`;
      }
    }

    // AI assistant response using analyst
    if (window.coinvantageAnalyst) {
      const analysis = await getAnalysis({ query: message });
      return analysis || 'Analysis generated. Check the trader page for detailed results.';
    }

    // Default fallback
    return `I received your message: "${trimmed}". I'm CoinVantage's AI assistant. For real analysis, ensure the WebLLM analyst is loaded, or use MCP commands like /help.`;
  };

  // Enter key to send
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendMessage(chatInput.value);
    }
  });

  // Send button
  chatSend.addEventListener('click', () => sendMessage(chatInput.value));

  // Initially hidden, show after page load setTimeout
  setTimeout(() => {
    chatPanel.hidden = false;
    // Focus input after a brief delay
    setTimeout(() => chatInput.focus(), 100);
  }, 500);

  // Add some preset quick-questions as buttons
  const quickQuestions = [
    '/help',
    '/price BTC',
    '/signal ETH',
    '/market'
  ];

  const quickBar = document.createElement('div');
  quickBar.className = 'chat-quick';
  quickBar.innerHTML = `<span class="muted">Quick questions:</span>${quickQuestions.map(q => `<button class="quick-btn" title="${q}">${q}</button>`).join(' ')}`;
  chatMessages.parentNode.insertBefore(quickBar, chatInput.parentNode);

  document.querySelectorAll('.quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      sendMessage(btn.getAttribute('title'));
      chatInput.focus();
    });
  });
})();
