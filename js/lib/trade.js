// Hand-off links to exchanges.
//
// CoinVantage does not execute trades and holds no funds or keys. These links
// simply open the coin's spot market on an exchange the person already uses, so
// they can act on a signal without hunting for the pair. Nothing is pre-filled
// beyond the market, no referral codes are attached, and the trade happens
// entirely on the exchange's own site under their own login.

export const VENUES = [
  { id: 'binance', name: 'Binance', quote: 'USDT', url: (s) => `https://www.binance.com/en/trade/${s}_USDT?type=spot` },
  { id: 'coinbase', name: 'Coinbase', quote: 'USD', url: (s) => `https://www.coinbase.com/advanced-trade/spot/${s}-USD` },
  { id: 'kraken', name: 'Kraken', quote: 'USD', url: (s) => `https://pro.kraken.com/app/trade/${s.toLowerCase()}-usd` },
  { id: 'okx', name: 'OKX', quote: 'USDT', url: (s) => `https://www.okx.com/trade-spot/${s.toLowerCase()}-usdt` },
  { id: 'bybit', name: 'Bybit', quote: 'USDT', url: (s) => `https://www.bybit.com/en/trade/spot/${s}/USDT` },
  { id: 'gate', name: 'Gate.io', quote: 'USDT', url: (s) => `https://www.gate.io/trade/${s}_USDT` },
];

// Stablecoins have no meaningful "buy" market here.
const NO_TRADE = new Set(['USDT', 'USDC', 'DAI', 'FDUSD', 'TUSD', 'USDE', 'BUSD', 'PYUSD']);

export const tradable = (symbol) => !!symbol && !NO_TRADE.has(String(symbol).toUpperCase());

export function venuesFor(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (!tradable(s)) return [];
  return VENUES.map((v) => ({ ...v, href: v.url(s), pair: `${s}/${v.quote}` }));
}

export const TRADE_DISCLAIMER = 'These open the exchange in a new tab. CoinVantage never places the order, never holds your funds, and never asks for exchange API keys, private keys or seed phrases.';
