# CoinVantage — live crypto markets, signals & AI forecasts

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
| **AI forecast** | Chance of rise, expected move, target and 50%/80% ranges. An ensemble of 7 models trained in the browser on that coin's own history, each weighted by its accuracy on data it never saw |
| **History & cycles** | The long-range study: finds every past 45-day stretch whose *shape* matched today's, shows what price did 7/30/90 days later, overlays those charts on today's, adds year-by-year paths and monthly seasonality — and publishes how often that method was actually right on this coin |
| **Pattern comparison** | Same idea on the trading timeframe: overlays today's chart on the most similar past charts and shows what happened next |
| **History vs now** | Compares the latest 7/30/90/365 days with the previous period and the same dates 1 and 2 years ago |
| **Backtest** | Equity curve vs buy & hold, win rate, drawdown, trade list |
| **Futures** | Funding rate, annualised funding, basis, open interest and its 12h change, long/short account ratios, top-trader positioning, plus a live liquidation feed |
| **Order book & trades** | Live Binance depth and recent trades |
| **Exchanges** | Same coin on 10 exchanges (Binance, Coinbase, Kraken, OKX, Bybit, Gate.io, Bitget, HTX, Gemini, Crypto.com): price, spread, volume, best buy/sell venue |
| **Signal scanner** | Ranks the top 20/30/50 coins by signal score and fast AI forecast; filters for buy, sell, oversold and overbought |
| **Compare** | Up to 6 coins: normalised performance, volatility, max drawdown, return/risk, correlation matrix |
| **Wallet** | Holdings with live P&L, allocation donut, per-coin hold/exit hints; watch-only BTC, ETH, BNB Chain, Polygon and Solana addresses |
| **Price alerts** | Browser notifications while the site is open, plus server-side alerts by e-mail and Telegram while it is closed |
| **Track record** | Public page scoring every signal the server logged *before* the outcome was known |
| **News** | Headlines from 5 crypto outlets, tagged by coin, refreshed every 20 minutes |
| **AI Assistant** | Chat about any coin. Answers are grounded in live data, signals, backtest, the forecast and the multi-year history study |
| **Accounts** | Optional sign-in syncs watchlist, holdings, wallet addresses and settings across devices |
| **Premium** | One-off payment for server-side alerts, VIP trade ideas and the full track record (Stripe or manual activation) |
| **Admin panel** | Traffic, users, premium grants, trade-idea publishing, site settings, API keys and manual job runs |
| **16 currencies · English/اردو** | Prices convert to USD, PKR, EUR, GBP, AED, SAR, INR, TRY, NGN, IDR, BRL, JPY, CNY, RUB, ZAR, BDT; Urdu UI with right-to-left layout |
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

`tools/evaluate-engine.mjs` ran **672 forecasts on 12 major coins** (BTC, ETH, SOL, BNB, XRP, DOGE, ADA, AVAX, LINK, LTC, TRX, DOT). Each forecast used only data available at that moment, on real Binance candles.

| Timeframe | Horizon | Direction accuracy |
|---|---|---|
| 15m | 2 hours | **60.1%** |
| 1h | 12 hours | **55.4%** |
| 4h | 1 day | **56.0%** |
| 1d | 1 week | 49.4% |
| **All** | | **55.2%** (up-moves were 51.3% of cases) |

- Predicted ranges were calibrated on the same test: σ is scaled by 0.75 so the 50% and 80% bands match reality.
- Daily/weekly forecasts showed no edge. The UI says so, and suggests 15m–4h charts for timing.
- The **History & cycles** tab scores itself separately, per coin, and prints that number next to its verdict — on most coins it lands in the 45–62% range, which is context, not a trading edge.
- No model can predict crypto reliably. Treat forecasts as probabilities and always use stop-losses.

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
js/views/               pages: markets, coin, scanner, track, futures, news, compare, exchanges,
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
