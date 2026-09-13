// Triple-barrier labelling.
//
// The engine's original question — "will the close be higher in H candles?" — is
// badly posed for a trader. It scores +0.01% as a win, ignores everything that
// happens in between, and is close to a coin flip by construction. That is a
// large part of why the measured accuracy sits near 54%: the target itself is
// mostly noise.
//
// The question a trade actually depends on is: starting here, does price reach
// the profit target before it reaches the stop? Three barriers — an upper, a
// lower, and a time limit — and whichever is touched first is the label. It is
// bounded, it is decidable, and it maps one-to-one onto the entry/stop/target
// plan the site already shows.
//
// Barriers are set in units of ATR so they mean the same thing on a $77,000 coin
// as on a $0.30 one.

/**
 * @param candles closed candles, oldest first
 * @param i       the bar the trade would be opened on (uses its close)
 * @param atr     ATR at i, in price
 * @param opts    upper/lower barrier width in ATRs, and the time limit in bars
 * @returns {{label: 1|0|null, touched: 'target'|'stop'|'time', bars: number, ret: number}}
 *          label 1 = target first, 0 = stop first, null = not enough future data.
 *          A time-limit exit is scored on whether it ended up in profit, which is
 *          the honest read: the trade was neither stopped nor filled.
 */
export function tripleBarrier(candles, i, atr, { up = 2, down = 1, maxBars = 24 } = {}) {
  const n = candles.length;
  if (!atr || atr <= 0) return { label: null, touched: 'time', bars: 0, ret: 0 };
  const entry = candles[i].c;
  const target = entry + up * atr;
  const stop = entry - down * atr;
  const last = Math.min(n - 1, i + maxBars);
  if (last <= i) return { label: null, touched: 'time', bars: 0, ret: 0 };

  for (let k = i + 1; k <= last; k++) {
    const c = candles[k];
    const hitStop = c.l <= stop;
    const hitTarget = c.h >= target;
    // When one candle spans both barriers there is no way to know which came
    // first from candle data, so assume the stop. Being pessimistic here keeps
    // the measured number honest rather than flattering.
    if (hitStop) return { label: 0, touched: 'stop', bars: k - i, ret: (stop - entry) / entry };
    if (hitTarget) return { label: 1, touched: 'target', bars: k - i, ret: (target - entry) / entry };
  }
  const close = candles[last].c;
  const ret = (close - entry) / entry;
  return { label: ret > 0 ? 1 : 0, touched: 'time', bars: last - i, ret };
}

/** Label a whole series. Entries with no resolved future are left null. */
export function labelSeries(candles, atrArr, opts = {}) {
  return candles.map((_, i) => (i < candles.length - 1 ? tripleBarrier(candles, i, atrArr[i], opts) : { label: null, touched: 'time', bars: 0, ret: 0 }));
}
