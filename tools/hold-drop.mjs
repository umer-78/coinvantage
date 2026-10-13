// Holding the coins instead of trading them: equal amounts bought at candle
// `from` of every series, valued at every close after it. Returns its worst
// fall in % — measured the way dropTracker (js/lib/autotrader.js) measures an
// account, so the two can stand side by side.
export function holdDrop(series, from) {
  const base = series.map((x) => x.candles[from].c), last = [...base], idx = series.map(() => from + 1);
  let peak = 1, dd = 0;
  for (;;) {
    let t = Infinity;
    for (let j = 0; j < series.length; j++) if (idx[j] < series[j].candles.length) t = Math.min(t, series[j].candles[idx[j]].t);
    if (t === Infinity) break;
    for (let j = 0; j < series.length; j++) while (idx[j] < series[j].candles.length && series[j].candles[idx[j]].t === t) last[j] = series[j].candles[idx[j]++].c;
    const v = last.reduce((a, p, j) => a + p / base[j], 0) / series.length;
    if (v > peak) peak = v; else dd = Math.max(dd, (peak - v) / peak);
  }
  return dd * 100;
}
