# CoinVantage — live crypto markets, signals & AI forecasts

[![CI](https://github.com/umer-78/coinvantage/actions/workflows/ci.yml/badge.svg)](https://github.com/umer-78/coinvantage/actions/workflows/ci.yml)

**Live demo:** https://umer-78.github.io/coinvantage/

An installable website for live crypto markets: prices, Binance-style charts,
buy/sell signals, multi-year history comparison and an AI price forecast that
runs right on your machine — **no paid API keys required**. Works on phones and
computers alike.

> Signals, forecasts and AI answers are educational tools, not financial advice.
> The site never places trades and never asks for exchange API keys, private keys or seed phrases.

## Features

| Area | What it does |
|---|---|
| **Markets** | Top 250 coins (CoinGecko, CoinPaprika fallback), live prices via Binance WebSocket, 1h/24h/7d change, sparklines, global market cap, BTC/ETH dominance, Fear & Greed gauge, trending, top gainers/losers, heatmap, watchlist |
| **Coin page** | Live candlestick chart (15m–1w) with zoom/pan/pinch, EMA 20/50/200, Bollinger, volume, RSI, MACD, support/resistance, backtest markers and the AI forecast cone |
| **Trade signal** | Buy/Sell score (−100…+100) from 9 indicator groups, multi-timeframe confluence, entry zone, stop-loss, three take-profits, exit rules and reasons |
| **AI forecast** | Leads with the 80% and 90% price ranges and how often ranges like them held in testing, then the chance of rise, shrunk by how far its direction held up on that timeframe (none on 1h, 4h and 1d, where it says so). An ensemble of 7 models trained in the browser on that coin's own history, each weighted by its accuracy on data it never saw |
| **History & cycles** | The long-range study: finds every past 45-day stretch whose *shape* matched today's, shows what price did 7/30/90 days later, overlays those charts on today's, adds year-by-year paths and monthly seasonality — and publishes how often that method was actually right on this coin |
| **Pattern comparison** | Same idea on the trading timeframe: overlays today's chart on the most similar past charts and shows what happened next |
| **History vs now** | Compares the latest 7/30/90/365 days with the previous period and the same dates 1 and 2 years ago |
| **Backtest** | Equity curve vs buy & hold, win rate, drawdown, trade list |
| **Futures** | Funding rate, annualised funding, basis, open interest and its 12h change, long/short account ratios, top-trader positioning, plus a live liquidation feed |
| **Order book & trades** | Live Binance depth and recent trades |
| **Exchanges** | Same coin on 10 exchanges (Binance, Coinbase, Kraken, OKX, Bybit, Gate.io, Bitget, HTX, Gemini, Crypto.com): price, spread, volume, best buy/sell venue |
| **Signal scanner** | Ranks the top 20/30/50 coins by signal score and the same full forecast as the coin page, on the same 1,500 candles; filters for rising, falling, oversold and overbought. Coins Binance does not list are read from Gate.io, HTX or OKX; coins with only CoinGecko or demo data are skipped and counted |
| **Compare** | Up to 6 coins: normalised performance, volatility, max drawdown, return/risk, correlation matrix |
| **Tools** | Coin ↔ currency converter (PKR and 15 more), a “what if I had bought regularly” DCA backtest on real daily closes vs a lump sum, and a position-size calculator from your stop-loss (risk %, fees, reward:risk). Calculators only, no trading |
| **Wallet** | Holdings with live P&L, allocation donut, per-coin hold/exit hints; watch-only BTC, ETH, BNB Chain, Polygon and Solana addresses |
| **Price alerts** | Browser notifications while the site is open, plus server-side alerts by e-mail and Telegram while it is closed |
| **Track record** | Public page scoring every signal the server logged *before* the outcome was known |
| **News** | Headlines from 5 crypto outlets, tagged by coin, refreshed every 20 minutes |
| **AI Assistant** | Chat about any coin. Answers are grounded in live data, signals, backtest, the forecast and the multi-year history study |
| **Accounts** | Optional sign-in syncs watchlist, holdings, wallet addresses and settings across devices |
| **Premium** | One-off payment for server-side alerts, VIP trade ideas and the full track record (Stripe or manual activation) |
| **Admin panel** | Traffic, users, premium grants, trade-idea publishing, site settings, API keys and manual job runs |
| **16 currencies** | Prices convert to USD, PKR, EUR, GBP, AED, SAR, INR, TRY, NGN, IDR, BRL, JPY, CNY, RUB, ZAR, BDT |
| **Installable (PWA)** | Add to home screen, works offline for the shell, app icon and shortcuts |

## The built-in AI (no API key)

1. **Forecast engine** (`js/lib/predict.js`) runs in a Web Worker and uses seven models:
   - chart pattern matching against the coin's history
   - similar past moves (the empirical odds after comparable moves and RSI levels)
   - gradient-boosted decision trees
   - a neural network (two-model bag)
   - logistic regression
   - nearest neighbours
   - Holt trend model

   Every model is validated walk-forward on the most recent ~36% of history. Weights come from each model's edge over a coin flip.
2. **History engine** (`js/lib/history.js`) works on daily candles so it can reach back through previous bull and bear markets. It z-normalises shape (so a $300 chart can match a $30,000 one), finds the closest past windows, measures what happened next, and then **replays the whole method through the coin's own past to report its real hit rate**. When nothing in history closely resembles today, it says so instead of inventing a verdict.
3. **Language model** (`js/ai/engine.js`): [WebLLM](https://github.com/mlc-ai/web-llm) runs a Qwen 3.5 model directly on the visitor's GPU via WebGPU. Free, private, cached after the first download:

   | Model | Download |
   |---|---|
   | 0.8B | ≈0.6 GB |
   | 2B | ≈1.4 GB |
   | 4B | ≈2.6 GB |

   The LLM rewrites verified numbers from the analyst, which keeps small models accurate.
4. **Rule-based analyst** (`js/lib/analyst.js`) answers instantly on every device, including phones without WebGPU.
5. *Optional:* any OpenAI-compatible endpoint (for example your own Ollama server) can be set under **AI Assistant → Advanced**.

### Measured accuracy (honest numbers)

`tools/evaluate-engine.mjs` ran **1,440 forecasts on 12 major coins** (BTC, ETH, SOL, BNB, XRP, DOGE, ADA, AVAX, LINK, LTC, TRX, DOT), 240 on each of six timeframes, re-measured on 2026-09-26. Each forecast used only data available at that moment, on real Binance candles, and is scored against the baseline of always naming whichever direction was more common in that window (a hindsight bar — nobody knows that in advance).

| Timeframe | Direction accuracy | Baseline | 50% range held | 80% range held |
|---|---|---|---|---|
| 1m | 59.6% | 63.3% (no edge) | 51.7% | 82.1% |
| 5m | 56.7% | 58.3% (no edge) | 46.3% | 72.9% |
| 15m | 55.0% | 60.4% (no edge) | 43.8% | 73.8% |
| 1h | 52.1% | 55.0% (no edge) | 56.7% | 84.2% |
| 4h | 47.5% | 59.2% (no edge) | 50.8% | 78.3% |
| 1d | 52.5% | 54.6% (no edge) | 41.3% | 79.6% |
| **All** | **53.9%** | 58.5% | **48.4%** | **78.5%** |

- **Direction is close to a coin flip.** "Always say up" — a bar you *can* know in advance — scored 52.2% on the same tests. The calls where the models lean hardest were right 50.7% of the time (227 tests), no better. No model can predict crypto direction 90% of the time; any site that claims it is not measuring honestly.
- **A 90% range** is shown too: on the same tests the price ended inside it 87.5% of the time (1m 90.0%, 5m 82.9%, 15m 82.5%, 1h 92.5%, 4h 87.5%, 1d 89.6%).
- **History as a second opinion was tested and not added:** on the 240 daily tests the multi-year history engine alone scored 51.3%, a 50/50 blend with the forecast 52.5% (the forecast alone: 52.5%), and the 145 cases where both agreed 53.1%. No gain, so it stays a separate tab.
- **The price range is now calibrated.** It is built from each coin's own past moves (in units of the volatility at the time) instead of a normal curve × 0.75, which drew the 80% band too narrow for crypto's fat tails. Same 1,440 tests: the 80% band now holds 78.5% of outcomes (was 71.7%) and the 50% band 48.4% (was 45.1%).
- The **History & cycles** tab scores itself separately, per coin, and prints that number next to its verdict.
- Treat forecasts as probabilities and always use stop-losses.

Re-run it yourself: `node tools/fetch-klines.mjs klines.json` then `node tools/evaluate-engine.mjs klines.json 0 1 out.json`.

## Run locally

No build step and no dependencies: plain HTML, CSS and ES modules.

```bash
node tools/serve.mjs 8080      # then open http://localhost:8080
node --test tests/*.test.mjs   # unit tests
node tools/smoke.mjs           # loads every page in a real browser (needs playwright)
```

## Deploy the website

It's a static site, so any static host works (GitHub Pages, Netlify, Vercel, Cloudflare Pages, S3).

**GitHub Pages**

1. Create a repository and push this folder to `main`.
2. Repository → **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `/ (root)`**.
3. Wait ~1 minute; the site appears at `https://<user>.github.io/<repo>/`.
4. Generate the sitemap for that address and commit it:
   `node tools/build-sitemap.mjs https://<user>.github.io/<repo>/`
5. Open the site → **Admin → Settings → Site** and paste the same URL. Alert e-mails and Telegram messages use it to link back to charts.

Everything on the free tier is fetched by the visitor's browser from public, CORS-enabled APIs, so the static site needs no server and no keys.

## The backend (optional but already set up)

Accounts, cross-device sync, alerts that fire while the browser is closed, the public
track record, news and the admin panel run on **Supabase** (Postgres + edge functions).
The site degrades gracefully without it — every backend call fails soft.

- Project URL and publishable key live in `js/config.js`. The publishable key is safe in
  client code: every table is protected by row-level security, and the tables only the
  server may touch (`admin_emails`, `auth_codes`, `rate_limits`) have RLS on with no policies at all.
- API secrets (Telegram, Resend, Stripe, the cron secret) are stored in **Supabase Vault**
  and are readable only by the service role — never by a browser.
- One edge function, `cv`, is routed by path: `/cv/account`, `/cv/admin`, `/cv/alerts-check`,
  `/cv/track-signals`, `/cv/news-fetch`, `/cv/telegram`, `/cv/stripe`, `/cv/selftest`.
- `pg_cron` runs alerts every minute, news at :07/:27/:47, signal tracking at :05/:20/:35/:50
  and a cleanup at 03:30.
- `/cv/selftest` returns a fixed result computed by the deployed engine. If it ever stops
  matching `{"score":-20,"action":"SELL","probUp":0.964211}`, the server engine has drifted
  from the browser engine.

### First-run checklist (Admin panel)

1. Sign up on the site with the e-mail that should own it, then make it an admin
   (SQL: `update profiles set is_admin = true where email = '...';`).
2. **Admin → Settings → Site**: public site URL and a contact address.
3. **Admin → Settings → Premium plan**: price, currency, period, and either enable Stripe
   or write the manual payment instructions shown to buyers.
4. **Admin → API keys** (all optional):
   - *Resend* API key + from-address → enables verification codes, password resets and e-mail alerts.
   - *Telegram* bot token from @BotFather → saving it registers the webhook automatically and the bot answers `/price`, `/signal`, `/alerts`.
   - *Stripe* secret key + webhook secret → card checkout for Premium. Point the Stripe webhook at the URL shown on that page.
     Checkout only returns buyers to `https://umer-78.github.io` (or localhost); for another domain, set the
     `SITE_ORIGINS` secret on the edge function, e.g. `https://example.com,https://www.example.com`.
5. **Admin → Jobs**: press *Run now* on each job once to confirm it works.

Without any of those keys the site still runs: alerts show in the browser, Premium can be
granted by hand from the admin panel, and news/track record keep working.

## Rebrand

Edit `APP_NAME` / `TAGLINE` in `js/config.js`, the `<title>` and meta tags in `index.html`,
the icons (`icon.svg`, `icon-192.png`, `icon-512.png`, `manifest.webmanifest`) and the
colours in `css/app.css` (`--accent`).

## Project layout

```
index.html              app shell
sw.js                   service worker (offline shell)
manifest.webmanifest    PWA manifest, icons, shortcuts
css/app.css             design system (dark/light), responsive layout
js/app.js               router, navigation, search, live ticker, currency/language, sync, alerts
js/config.js            app name, API endpoints, AI models, currencies, backend keys
js/i18n.js              English/Urdu strings and RTL switching
js/api/                 market data, exchanges, futures, WebSocket hub, FX rates, Supabase client
js/lib/                 indicators, signals + backtest, forecast engine, history engine, analyst, worker
js/ai/                  in-browser LLM engine and context builder
js/charts/              canvas candlestick chart, line chart, sparkline/donut/gauge/treemap
js/views/               pages: markets, coin, scanner, track, futures, news, compare, tools, exchanges,
                        wallet, alerts, premium, account, admin, legal, auth, assistant
supabase/functions/cv/  edge function: account, admin, alerts, news, track, telegram, stripe + engine copy
tools/                  local server, accuracy evaluation, sitemap builder, browser smoke test
tests/                  unit tests (node --test)
```

## Data sources

- Binance public market data (`data-api.binance.vision`, `data-stream.binance.vision`) and USD-M futures (`fapi`, `fstream`)
- CoinGecko and CoinPaprika public APIs
- alternative.me Fear & Greed
- Public tickers from 10 exchanges
- mempool.space / blockstream (BTC), PublicNode RPC (EVM), Solana RPC
- open.er-api.com (currency rates, CoinGecko fallback)
- RSS from Cointelegraph, CoinDesk, Decrypt, Bitcoin Magazine, The Block

If every source is unreachable, clearly-labelled demo data is shown instead.

## Known notes

- `pg_net` sits in the `public` schema because that is where Supabase installs it; the
  scheduled jobs call it through `private.call_cv()`.
- `get_posts` is an intentionally public `SECURITY DEFINER` function: it is the only way
  anonymous visitors read trade ideas, and it nulls out the body, entry, stop-loss and
  targets of premium posts before returning them.
