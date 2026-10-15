// The candles each coin was last checked on, so the next check asks only for
// what is new: a handful of candles instead of the whole window (much less
// data on a phone, and fewer requests that can fail). The merged window is the
// one a full fetch would return; a gap, a change of exchange or a long pause
// fetches the whole window again.
export function candleCache(fetchCandles, { window = 500, maxAgeMs = 6 * 3600e3, stepOf } = {}) {
  const seen = new Map();
  return async function candles(coin, interval) {
    const key = `${coin.symbol}:${interval}`, prev = seen.get(key), step = stepOf(interval);
    const full = async () => {
      const r = await fetchCandles(coin, interval, window);
      seen.set(key, { at: Date.now(), r });
      return r;
    };
    if (!prev || !(step > 0) || Date.now() - prev.at > maxAgeMs || !prev.r.candles.length) return full();
    const last = prev.r.candles[prev.r.candles.length - 1];
    const need = Math.ceil((Date.now() - last.t) / step) + 3;
    if (need >= window / 5) return full();
    const r = await fetchCandles(coin, interval, Math.max(need, 5));
    if (r.source === prev.r.source && r.candles.length) {
      const first = r.candles[0].t;
      const old = prev.r.candles.filter((c) => c.t < first);
      if (old.length && first - old[old.length - 1].t === step) {
        const merged = { ...r, candles: [...old, ...r.candles].slice(-window) };
        seen.set(key, { at: Date.now(), r: merged });
        return merged;
      }
    }
    return full();
  };
}
