// Terms, privacy policy and risk disclosure. Plain language, no filler.
import { CONFIG } from '../config.js';
import { getAppSettings } from '../api/backend.js';
import { esc } from '../format.js';

export const title = (p) => ({ terms: 'Terms of Service', privacy: 'Privacy Policy', risk: 'Risk Disclosure' }[p?.[0]] || 'Legal');

const N = CONFIG.APP_NAME;

const PAGES = (contact) => ({
  terms: {
    h: 'Terms of Service',
    body: `
      <p class="fine">Last updated: ${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</p>
      <h2>1. What this service is</h2>
      <p>${N} is a market-analysis website. It shows public market data, technical indicators, statistical forecasts and historical comparisons. It is an information tool and nothing more.</p>
      <h2>2. What it is not</h2>
      <p>${N} is <b>not</b> a broker, exchange, custodian, fund, or investment adviser. It never executes trades, never holds or moves your money or crypto, and never asks for exchange API keys, private keys or seed phrases. Anyone asking you for those while claiming to be us is committing fraud — do not comply.</p>
      <h2>3. No financial advice</h2>
      <p>Signals, scores, forecasts, AI answers and trade ideas are automated estimates produced from public data. They are frequently wrong. They are not personalised advice and take no account of your circumstances, tax position or risk tolerance. Every decision you make with this information is your own.</p>
      <h2>4. Accounts</h2>
      <p>You are responsible for keeping your password safe and for everything done through your account. Use a password you don't use elsewhere. You may delete your account at any time from the account page, which removes your profile and synced data.</p>
      <h2>5. Acceptable use</h2>
      <p>Don't scrape the service at volumes that degrade it for others, don't try to break authentication or access other users' data, don't resell or redistribute the data feeds, and don't use the service where it would be unlawful for you to do so.</p>
      <h2>6. Premium</h2>
      <p>Premium is a one-off payment for a fixed period, with no automatic renewal. It buys server-side features (alerts while your browser is closed, tracking, VIP ideas). It does not buy better predictions or any guarantee of profit. If a paid feature is unavailable for a sustained period, contact us and we will extend or refund the affected period.</p>
      <h2>7. Third-party data</h2>
      <p>Prices, candles, order books, derivatives data, news and exchange rates come from third parties (including Binance, CoinGecko, CoinPaprika and public news feeds). They may be delayed, incomplete or wrong, and they can stop working without notice. We don't control them and don't warrant them.</p>
      <h2>8. Availability and liability</h2>
      <p>The service is provided "as is", without warranty of any kind. To the maximum extent permitted by law, we are not liable for trading losses, missed opportunities, data errors, downtime, or any indirect or consequential loss. Where liability cannot be excluded, it is limited to the amount you paid us in the previous 12 months.</p>
      <h2>9. Changes</h2>
      <p>We may change these terms as the service evolves. Continued use after a change means you accept it.</p>
      ${contact ? `<h2>10. Contact</h2><p>${esc(contact)}</p>` : ''}`,
  },
  privacy: {
    h: 'Privacy Policy',
    body: `
      <p class="fine">Last updated: ${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</p>
      <h2>The short version</h2>
      <p>Most of ${N} runs inside your browser. Charts, indicators, signals, forecasts and the built-in AI are computed on your device. We collect the minimum needed to run accounts and alerts.</p>
      <h2>Without an account</h2>
      <p>Your watchlist, portfolio entries, wallet addresses you watch, alerts and settings are stored in your browser's local storage on your device. We cannot read them. Clearing your browser data deletes them.</p>
      <p>We record anonymous page views (page path, referrer, coarse device type, browser language and a random session id that is discarded when you close the tab) to see which pages are worth improving. No cookies are used for advertising and no data is sold or shared with advertisers.</p>
      <h2>With an account</h2>
      <p>We store your e-mail address, display name, an encrypted password hash, and the data you choose to sync: watchlist, holdings, watch-only wallet addresses, chart drawings and app preferences. If you enable alerts we store the alerts you create and, if you link them, your Telegram chat id.</p>
      <h2>Your market data stays yours</h2>
      <p>Questions you type into the AI assistant are processed in your browser by the built-in model and are not sent to us. If you deliberately configure an external AI endpoint in settings, your prompts go to that provider under their policy, not ours.</p>
      <h2>Third parties we send data to</h2>
      <p>Your browser requests market data directly from public APIs (Binance, CoinGecko, CoinPaprika, mempool.space and others), so those providers see your IP address like any website you visit. Our backend runs on Supabase. E-mail, when enabled, is sent through Resend. Card payments, when enabled, are handled by Stripe — we never see your card details.</p>
      <h2>Retention and deletion</h2>
      <p>Account data is kept until you delete your account, which you can do yourself on the account page; it removes your profile, synced data and alerts. Anonymous page-view records are retained for 30 days. Verification codes expire in 15 minutes.</p>
      <h2>Your rights</h2>
      <p>You can download everything we hold for you as JSON from the account page, correct your details there, or delete the account outright. If you are in a jurisdiction with statutory data rights (such as the UK/EU GDPR), those rights apply and the export and delete tools are how we honour them.</p>
      ${contact ? `<h2>Contact</h2><p>${esc(contact)}</p>` : ''}`,
  },
  risk: {
    h: 'Risk Disclosure',
    body: `
      <h2>Read this before you trade anything</h2>
      <p>Crypto assets are volatile, largely unregulated, and can lose most or all of their value quickly. Nothing on ${N} changes that.</p>
      <h2>The forecasts are estimates, not predictions</h2>
      <p>The engine is validated by walk-forward testing on out-of-sample data: every forecast is made using only the data that existed at that moment. Across 672 forecasts on 12 coins it called direction right <b>54.0%</b> of the time overall — 57.1% on 15-minute, 53.0% on hourly, 58.9% on 4-hour, and <b>47.0% on daily, which is worse than a coin flip</b>. When the models agreed strongly enough to take a side (about 38% of forecasts) accuracy was 56.9%. Simply assuming "up" every time scored 51.3% on the same sample. A small statistical edge is not a licence to bet large, and past accuracy does not carry over to the future.</p>
      <h2>Leverage</h2>
      <p>The futures page shows what leveraged traders are doing because it is useful market context. It is not encouragement. Leverage magnifies losses, liquidations are permanent, and most retail leveraged accounts lose money.</p>
      <h2>Position sizing beats prediction</h2>
      <p>Never risk money you need. A common discipline is to risk a small fixed fraction of your capital per trade so no single wrong call matters much. ${N} shows a stop-loss with every signal for exactly this reason — a plan without an exit is not a plan.</p>
      <h2>Scams</h2>
      <p>${N} will never ask for your seed phrase, private key or exchange API key, never ask you to send crypto to "activate" anything, and never DM you with a guaranteed return. Wallet tracking here is watch-only: addresses are public information and cannot move funds.</p>
      <h2>Regulation and tax</h2>
      <p>Crypto rules and taxes differ by country and change often. You are responsible for your own compliance. We are not a licensed adviser in any jurisdiction.</p>
      <h2>If trading is hurting you</h2>
      <p>Chasing losses, hiding trades from people close to you, or borrowing to trade are warning signs. Trading can be addictive; if any of that sounds familiar, step away and talk to someone you trust or a professional support service in your country.</p>`,
  },
});

export async function render(el, [page = 'terms']) {
  const settings = await getAppSettings().catch(() => ({}));
  const pages = PAGES(settings.site?.contact || null);
  const p = pages[page] || pages.terms;
  el.innerHTML = `
    <div class="page-head"><div><h1>${esc(p.h)}</h1></div>
      <div class="seg">${Object.entries(pages).map(([k, v]) => `<button data-p="${k}" class="${k === page ? 'on' : ''}">${esc(v.h.split(' ')[0])}</button>`).join('')}</div></div>
    <div class="card prose">${p.body}</div>`;
  el.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => { location.hash = `#/legal/${b.dataset.p}`; }));
}
