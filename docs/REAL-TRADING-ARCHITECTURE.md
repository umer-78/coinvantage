# If the client wants real trading: how it has to be built

CoinVantage does not place orders, and the reason is architectural rather than
squeamish. This document is the design that *would* work, so the decision can be
made on facts.

## Why the current shape cannot do it

CoinVantage is static files on GitHub Pages. There is no server. Anything the app
"knows" lives in the visitor's browser, which means an exchange API key would
live there too — in `localStorage`, readable by:

- any browser extension the user has installed (extensions with `storage` or
  content-script access read it trivially),
- any successful XSS on the page, including one introduced by a future
  dependency,
- anyone with physical access to an unlocked machine,
- anyone who can get the user to paste a key into a lookalike page.

A trade-enabled Binance key can drain a spot balance even without withdrawal
permission, by selling into an illiquid pair the attacker controls the other side
of. "Read-only keys are fine" is also not quite true: they leak the client's
entire position history, which is itself sellable data.

So the question is not "is the code careful enough". There is no way to hold a
trading credential safely in a static page.

## The architecture that works

```
Browser  ──►  Your backend (a real server you control)  ──►  Exchange
             - holds the API keys, encrypted at rest
             - signs every order server-side
             - enforces the limits below
```

**1 — Keys never reach the browser.**
The user adds a key on a server-rendered page over TLS. It is encrypted with a
KMS-held key (AWS KMS, GCP KMS, or Supabase Vault), and the plaintext exists only
in server memory while an order is being signed. The browser never receives it,
not even masked.

**2 — Exchange-side restrictions, verified before the key is accepted.**
On save, call the exchange's key-info endpoint and reject the key unless:
withdrawals are disabled, an IP allow-list containing only your server's egress
IP is set, and the permissions are spot-trade only. If the exchange cannot
confirm those, do not store the key.

**3 — Server-side risk limits, not client-side.**
Maximum order size, maximum daily loss, maximum open positions, a per-symbol
whitelist, and a global kill switch — all enforced in the order path, all
configurable only by the account owner with a second factor. The client UI can
show them; it must never be the thing enforcing them.

**4 — Idempotency and reconciliation.**
Every order carries a client order ID derived from (user, signal, timestamp) so a
retry after a network failure cannot double-fill. A reconciliation job compares
your order book against the exchange's every minute and alarms on drift.

**5 — An audit log the user can read.**
Every order: who, what, why (which signal), what the limits were at the time,
what the exchange returned. Append-only. This is what you produce when a customer
says the bot lost their money.

**6 — Explicit, revocable consent.**
Per-strategy opt-in, a maximum capital allocation, and a one-tap stop that
cancels open orders. Default off.

## The part that is not engineering

In most jurisdictions, software that places trades on someone else's behalf is a
regulated activity — the analysis and signals CoinVantage does today are not.
Depending on where the client operates this can mean registration as an
investment adviser or portfolio manager, capital requirements, professional
indemnity insurance, and a named person who is accountable when it loses money.
That person cannot be "the algorithm".

Get a lawyer in the relevant jurisdiction to answer this *before* writing the
server, because the answer changes what the server has to log and retain.

## What to check before building any of it

The strategy currently does not justify automation. Measured on this repo's own
tooling:

- direction accuracy 54.0% overall, and 47% on the daily chart — worse than a
  coin flip;
- the 15m and 4h trade geometry has negative expectancy at every configuration
  tested;
- a higher signal score does not reliably mean a better trade.

Automating a strategy with those numbers converts a slow loss into a fast one.
Fix the edge first, prove it on paper for a few hundred trades, and only then
consider the server. The paper trader and the real-account journal in the app
exist precisely so that evidence can be gathered before any money moves.

## Interim: what the app already does instead

- **Signal alerts** — fire the moment a setup triggers, with entry, stop and
  targets in the message, delivered by Telegram or e-mail while the browser is
  closed.
- **Exchange hand-off** — one tap from the alert or the Trade button opens the
  pair on Binance, Coinbase, Kraken, OKX, Bybit or Gate, ready to order. Keys
  never leave the exchange.
- **Paper trader and real journal** — to build the track record that would
  justify step one above.

That is seconds of manual confirmation rather than full automation, and it is the
version that can ship today without a server, a licence, or a liability.
