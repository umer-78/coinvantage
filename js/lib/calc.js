// Pure maths behind the Tools page: currency conversion, a dollar-cost-average
// backtest on real daily candles, and position sizing from a stop-loss.
// No DOM and no network, so every number here is unit-tested.

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// `fromUsd` / `toUsd` are the USD value of one unit of each side
// (1 for USD, 1 / rate for a fiat currency, the coin price for a coin).
export function convert(amount, fromUsd, toUsd) {
  if (!finite(amount) || !finite(fromUsd) || !finite(toUsd) || fromUsd <= 0 || toUsd <= 0) return null;
  return (amount * fromUsd) / toUsd;
}

// Buy `amount` (USD) every `everyDays` days, at each day's close, starting at
// candles[0]. Returns the running totals (for the chart) and a lump-sum
// comparison: the same total invested all at once on the first day.
export function dcaBacktest(candles, { amount, everyDays = 30, feePct = 0 } = {}) {
  if (!Array.isArray(candles) || candles.length < 2) return { error: 'Not enough price history.' };
  if (!finite(amount) || amount <= 0) return { error: 'Enter an amount above zero.' };
  if (!finite(everyDays) || everyDays < 1) return { error: 'Pick how often to buy.' };
  const fee = Math.max(0, Math.min(5, finite(feePct) ? feePct : 0)) / 100;
  let invested = 0; let units = 0; let buys = 0;
  const rows = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!finite(c?.c) || c.c <= 0) continue;
    if (i % everyDays === 0) {
      invested += amount;
      units += (amount * (1 - fee)) / c.c;
      buys += 1;
    }
    rows.push({ t: c.t, invested, value: units * c.c });
  }
  if (!buys) return { error: 'No usable prices in this range.' };
  const last = candles.at(-1).c;
  const first = candles.find((c) => finite(c?.c) && c.c > 0).c;
  const value = units * last;
  const lumpUnits = (invested * (1 - fee)) / first;
  const lumpValue = lumpUnits * last;
  return {
    rows,
    buys,
    invested,
    units,
    value,
    avgCost: (invested * (1 - fee)) / units,
    pnl: value - invested,
    pnlPct: ((value - invested) / invested) * 100,
    lump: { units: lumpUnits, value: lumpValue, pnlPct: ((lumpValue - invested) / invested) * 100 },
    lastPrice: last,
  };
}

// Size a position so that hitting the stop loses exactly `riskPct` of the
// balance. Direction comes from where the stop sits: below entry = long.
export function positionSize({ balance, riskPct, entry, stop, target, feePct = 0 } = {}) {
  if (!finite(balance) || balance <= 0) return { error: 'Enter your account balance.' };
  if (!finite(riskPct) || riskPct <= 0 || riskPct > 100) return { error: 'Risk per trade must be between 0 and 100%.' };
  if (!finite(entry) || entry <= 0) return { error: 'Enter an entry price.' };
  if (!finite(stop) || stop <= 0) return { error: 'Enter a stop-loss price.' };
  if (stop === entry) return { error: 'The stop-loss cannot equal the entry.' };
  const side = stop < entry ? 'long' : 'short';
  const fee = Math.max(0, finite(feePct) ? feePct : 0) / 100;
  const riskAmount = (balance * riskPct) / 100;
  // Loss per unit at the stop, including a fee on the way in and on the way out.
  const perUnit = Math.abs(entry - stop) + fee * (entry + stop);
  const units = riskAmount / perUnit;
  const notional = units * entry;
  const out = {
    side,
    riskAmount,
    units,
    notional,
    leverage: notional / balance,
    stopPct: (Math.abs(entry - stop) / entry) * 100,
  };
  if (finite(target) && target > 0) {
    const rightWay = side === 'long' ? target > entry : target < entry;
    if (!rightWay) return { ...out, targetError: `For a ${side}, the target must be ${side === 'long' ? 'above' : 'below'} the entry.` };
    const reward = units * Math.abs(target - entry) - fee * units * (entry + target);
    out.reward = reward;
    out.rr = reward / riskAmount;
    out.targetPct = (Math.abs(target - entry) / entry) * 100;
  }
  return out;
}
