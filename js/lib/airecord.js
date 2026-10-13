// The AI signal's live record: rows the server wrote to ai_signal_log, one per
// closed candle, before anyone knew what came next. Read by the Track page.
// Only trades bought after tracking began on a coin and chart are counted,
// so nothing here was known when the rules were chosen.

/** "3 of 7" while a sample is small, "42.9%" once it is not. */
export const shareText = (k, n) => (n < 10 ? `${k} of ${n}` : `${((k / n) * 100).toFixed(1)}%`);

/**
 * Per chart: candles graded and how often the price was higher `horizon_bars`
 * later from any of them, the same for the candles where it bought, and the
 * closed trades with their result after fees.
 */
export function aiRecordStats(rows) {
  const by = {};
  for (const r of rows || []) (by[r.interval] ||= []).push(r);
  const out = {};
  for (const [iv, list] of Object.entries(by)) {
    // tracking began on each coin at its first logged candle
    const start = {};
    for (const r of list) { const t = Date.parse(r.candle_time); if (!(r.symbol in start) || t < start[r.symbol]) start[r.symbol] = t; }
    const graded = list.filter((r) => r.resolved && typeof r.fwd_up === 'boolean');
    const buys = graded.filter((r) => r.action === 'buy');
    const sells = list.filter((r) => r.action === 'sell' && Number.isFinite(Number(r.trade_pct)) && r.opened_at && Date.parse(r.opened_at) >= start[r.symbol]);
    const pct = (k, n) => (n ? +((k / n) * 100).toFixed(1) : null);
    const tradePcts = sells.map((r) => Number(r.trade_pct));
    out[iv] = {
      logged: list.length, coins: Object.keys(start).length,
      since: Math.min(...Object.values(start)),
      graded: graded.length, anyUp: graded.filter((r) => r.fwd_up).length, anyUpPct: pct(graded.filter((r) => r.fwd_up).length, graded.length),
      buys: buys.length, buyUp: buys.filter((r) => r.fwd_up).length, buyUpPct: pct(buys.filter((r) => r.fwd_up).length, buys.length),
      trades: sells.length, wins: tradePcts.filter((v) => v > 0).length,
      avgTradePct: tradePcts.length ? +(tradePcts.reduce((a, b) => a + b, 0) / tradePcts.length).toFixed(2) : null,
      open: latestOpen(list),
    };
  }
  return out;
}

/** How many coins are in a trade on their latest logged candle. */
function latestOpen(list) {
  const latest = {};
  for (const r of list) if (!latest[r.symbol] || Date.parse(r.candle_time) > Date.parse(latest[r.symbol].candle_time)) latest[r.symbol] = r;
  return Object.values(latest).filter((r) => r.action === 'buy' || r.action === 'hold').length;
}
