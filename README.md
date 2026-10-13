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
| **Coin page** | Live candlestick chart (1-second to weekly candles) with zoom/pan/pinch, EMA 20/50/200, Bollinger, volume, RSI, MACD, support/resistance, backtest markers and the AI forecast cone. Coins Binance does not list stream live from Gate.io, HTX or OKX over WebSocket; if the socket is blocked the chart polls every 20 s, and after a gap (a sleeping tab, a dropped socket) it fetches the missing candles instead of drawing past them |
| **Trade signal** | Buy/Sell score (−100…+100) from 9 indicator groups, multi-timeframe confluence, entry zone, stop-loss, three take-profits, exit rules and reasons |
| **AI forecast** | Leads with the 80% and 90% price ranges and how often ranges like them held in testing, then the chance of rise, shrunk by how far its direction held up on that timeframe (none on 5m, 15m, 1h, 4h and 1d, where it says so, and the ranges are centred on today's price instead of the model's lean). Where it was measured to help (5m, 1h, 4h) it also says whether a bigger or smaller move than usual is coming. An ensemble of 7 models trained in the browser on that coin's own history, each weighted by its accuracy on data it never saw |
| **History & cycles** | The long-range study: finds every past 45-day stretch whose *shape* matched today's, shows what price did 7/30/90 days later, overlays those charts on today's, adds year-by-year paths and monthly seasonality — and publishes how often that method was actually right on this coin |
| **Pattern comparison** | Same idea on the trading timeframe: overlays today's chart on the most similar past charts and shows what happened next |
| **History vs now** | Compares the latest 7/30/90/365 days with the previous period and the same dates 1 and 2 years ago |
| **Backtest** | Equity curve vs buy & hold, win rate, drawdown, trade list |
| **Futures** | Funding rate, annualised funding, basis, open interest and its 12h change, long/short account ratios, top-trader positioning, plus a live liquidation feed |
| **Order book & trades** | Live Binance depth and recent trades |
| **Exchanges** | Same coin on 10 exchanges (Binance, Coinbase, Kraken, OKX, Bybit, Gate.io, Bitget, HTX, Gemini, Crypto.com): price, spread, volume, best buy/sell venue |
| **Signal scanner** | Ranks the top 20/30/50 coins by signal score and the same full forecast as the coin page, on the same 1,500 candles; filters for rising, falling, oversold and overbought, and a sortable 80% range column (where price should end 8 times in 10 — the part of the forecast that tested accurate). Coins Binance does not list are read from Gate.io, HTX or OKX; coins with only CoinGecko or demo data are skipped and counted |
| **Compare** | Up to 6 coins: normalised performance, volatility, max drawdown, return/risk, correlation matrix |
| **Tools** | Coin ↔ currency converter (PKR and 15 more), a “what if I had bought regularly” DCA backtest on real daily closes vs a lump sum, and a position-size calculator from your stop-loss (risk %, fees, reward:risk). Calculators only, no trading |
| **Trading** | Three accounts side by side: demo trades you place yourself from any coin page, real trades you record (or import from a Binance trade-history CSV), and an AI running a tested strategy on simulated money with fees counted. The page states that strategy's measured result against buy-and-hold first, and the AI reviews its own trade log to switch filters on or off. A "What drove the result" panel explains any account's result in numbers: how trades ended, the win rate needed to break even, fees, the coins that cost most, and whether positions ever added up to more than the account. Nothing here places an order |
| **AI learning** | Grades every indicator reading, the forecast and the trader against what the market did next. An indicator only earns a vote after 30+ calls with a 95% range clear of 50% |
| **Wallet** | Holdings with live P&L, allocation donut, per-coin hold/exit hints; watch-only BTC, ETH, BNB Chain, Polygon and Solana addresses |
| **Price alerts** | Browser notifications while the site is open, plus server-side alerts by e-mail and Telegram while it is closed |
| **Track record** | Public page scoring every signal the server logged *before* the outcome was known, against the hit rate of always calling the more common outcome. A live check fits the same trust the coin page uses to the graded rows, counting coins on one candle as one observation, and says whether the live record supports showing a direction on each timeframe |
| **News** | Headlines from 5 crypto outlets, tagged by coin, refreshed every 20 minutes |
| **AI Assistant** | Chat about any coin. Answers are grounded in live data, signals, backtest, the forecast and the multi-year history study. It also explains about 40 trading terms ("what is RSI?"), how its own method works, and how to check whether a coin is a scam |
| **Accounts** | Optional sign-in keeps the watchlist, holdings, wallet addresses, chart drawings, settings and all three Trading accounts the same on every device |
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

   The LLM rewrites verified numbers from the analyst, which keeps small models accurate. Each model has a 4,096-token window shared by the question and the answer, so the prompt is budgeted in tokens (instructions and question, then the analyst's answer, then the last turn of the chat, then the raw data with its least useful detail dropped first) and always leaves at least 700 tokens for the reply. Every price, percentage and level in the model's answer is checked against the data it was given: one or two unknown figures are pointed out under the answer, and more than that brings back the analyst's own answer instead.
4. **Rule-based analyst** (`js/lib/analyst.js`) answers instantly on every device, including phones without WebGPU.
5. *Optional:* any OpenAI-compatible endpoint (for example your own Ollama server) can be set under **AI Assistant → Advanced**. Ollama only answers other websites when started with `OLLAMA_ORIGINS` set to the site's address; LM Studio needs CORS turned on.

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
- **Re-checked 2026-10-12 on fresh candles** (same 1,440-forecast design): direction 1m 54.2%, 5m 52.1%, 15m 47.1%, 1h 50.8%, 4h 51.2%, 1d 43.3% — still no edge, so no direction is shown on 5m–1d. The same ranges centred on today's price (without the model's lean) held as well or better; re-measured at scale on 2026-10-13 (24 coins, about 28,000 non-overlapping ranges on 5m–1d) the centred 80% range held 76.5–80.0% depending on the chart (1d 77.2%), and a width factor fitted on older candles did not improve newer ones on any chart, so none is applied. A "bigger or smaller move than usual" call from volatility separated big moves from small ones on 5m, 1h and 4h (after a "bigger" call the move averaged 1.4–1.6× the coin's usual, after a "smaller" one 0.8–1.0×). The forecast's own per-coin recent check, once shown as "tested accuracy", was no guide: forecasts were right 49.5% when it read 60%+ and 49.7% otherwise, so it is no longer shown.
- Treat forecasts as probabilities and always use stop-losses.

Re-run it yourself: `node tools/fetch-klines.mjs klines.json` then `node tools/evaluate-engine.mjs klines.json 0 1 out.json`.

The AI trader's rules are re-tested the same way, walk-forward: `node tools/evaluate-trader-folds.mjs klines.json` cuts each chart's history into four blocks and three times picks the best of 432 rule sets on everything before a block, then runs it on that block next to the standard rules, all coins in one account with fees. 1h and 1d cleared the bar written in the script and trade their own picks (`CHART_RULES`); 15m and 4h keep the standard rules. On the daily chart each coin also trades its own rules (`PER_COIN_RULES`, from `tools/evaluate-selection.mjs`) unless switched off. The **Evaluate** workflow (Actions → Evaluate → Run workflow) runs both on fresh Binance candles for 24 coins; the latest results (2026-10-12) are on the Trading page and in `CHART_TESTED` and `PER_COIN_RULES` in `js/lib/autotrader.js`. Holding the same coins made more than the trader on 15m and 1h and in the daily per-coin test; the trader made more on 4h and in the daily walk-forward. Each coin page shows the AI signal for its chart (buy, hold, sell or wait, from the same tested rules) with the record of buys like it on candles the rules were not chosen on: on no chart did a buy pick direction better than chance, and the page says so. Settings on the Trading page shows what the chosen chart and risk can be expected to make, read off the same walk-forward test (it was run at six risk levels; past 2% a trade more risk made at most 0.4 points more a period, and less on three of the four charts), and can replay any settings on recent candles. It is a demonstration, not a reliable way to beat the market.

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
- The whole database schema is in `supabase/migrations/`, in the order it was applied.
  To run your own copy, create a Supabase project, apply them in order (SQL editor, or
  `supabase link` then `supabase db push`), change the project address inside
  `private.call_cv()` (in `20260912115252_schedule_background_jobs.sql`) to your own, and
  put your project URL and publishable key in `js/config.js`. Then create the two
  secrets the jobs and the Telegram webhook check, each a long random string:
  `select vault.create_secret('<random>', 'cron_secret');` and
  `select vault.create_secret('<random>', 'telegram_webhook_secret');`. Without the
  first every scheduled job is refused; without the second the bot ignores every
  message.
- Sync merges each piece of a user's data separately (`js/lib/cloudsync.js`): whichever
  device changed something since the two last agreed wins. When two devices changed the
  same thing, the saved copy is kept, and demo or real trades only the other device had
  are set aside for the Trading page to offer back; two AI accounts meeting for the first
  time keep the one that has run longest. Saves go through `public.sync_user_data()`,
  which only writes the keys that changed.

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
the icons (`icon.svg`, `icon-192.png`, `icon-512.png`, `manifest.webmanifest`), the link-preview image `og-image.png` and the site address in the `og:` and canonical tags and the
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
js/views/               pages: markets, coin, advice, trader, learn, scanner, track, futures, news, compare,
                        tools, exchanges, wallet, alerts, premium, account, admin, legal, auth, assistant
supabase/functions/cv/  edge function: account, admin, alerts, news, track, telegram, stripe + engine copy
supabase/migrations/    the database schema, one file per change, in the order applied
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

## Licence

MIT licence (see [LICENSE](LICENSE)).
