// The AI trader's self-review: it reads its own trade log and changes its rules.
//
// Every trade the paper trader opens records what the market looked like at the
// moment it bought (trend, ADX, RSI, volatility — see `ctx` in autotrader.js).
// After enough trades have closed, this module groups them by those conditions,
// finds the conditions that keep losing money, and switches on the filter that
// avoids them. It also switches a filter back OFF if the trades taken since it
// was switched on did worse than before — so a bad lesson gets unlearned.
//
// Honesty rules, same as the rest of the app:
// - it never acts on a handful of trades: a group needs MIN_GROUP trades, the
//   log needs MIN_TRADES, and a change needs a clear gap, not a rounding error;
// - every change is written to a visible changelog with the numbers behind it;
// - it only changes the paper trader's filters. It never places a real order.

export const MIN_TRADES = 12;    // closed trades before the review may change anything
export const MIN_GROUP = 10;     // trades a condition needs before it can be judged (6 was measured to be noise)
const GAP_R = 0.25;              // how much worse (in R) a condition must be to act on it

const r2 = (v) => Math.round(v * 100) / 100;

/** Result of one trade in R: profit or loss as a multiple of the cash it risked. */
export function tradeR(t) {
  const risk = t.riskCash || (t.entry - t.initialStop) * t.qty;
  return risk > 0 ? t.pnl / risk : 0;
}

function summarise(trades) {
  const n = trades.length;
  if (!n) return { n: 0, winRate: null, avgR: null, totalR: 0 };
  const rs = trades.map(tradeR);
  const wins = trades.filter((t) => t.pnl > 0).length;
  const totalR = rs.reduce((a, b) => a + b, 0);
  return { n, winRate: Math.round((wins / n) * 100), avgR: r2(totalR / n), totalR: r2(totalR) };
}

// The conditions a trade can be sorted by. Each one maps to the filter that
// would avoid its losing side.
const LENSES = [
  {
    key: 'trend', title: 'Trend at entry',
    side: (t) => (t.ctx?.trendUp === undefined ? null : t.ctx.trendUp ? 'with' : 'against'),
    labels: { with: 'bought above the 200-bar average (with the trend)', against: 'bought below the 200-bar average (against the trend)' },
    bad: 'against', fix: { trendFilter: true }, undo: { trendFilter: false },
    fixText: 'only buy while price is above the 200-bar average',
  },
  {
    key: 'adx', title: 'Trend strength at entry',
    side: (t) => (t.ctx?.adx == null ? null : t.ctx.adx >= 20 ? 'trending' : 'ranging'),
    labels: { trending: 'bought while the market was trending (ADX 20+)', ranging: 'bought in a ranging market (ADX under 20)' },
    bad: 'ranging', fix: { minAdx: 20 }, undo: { minAdx: null },
    fixText: 'skip entries while ADX is under 20',
  },
  {
    key: 'rsi', title: 'RSI at entry',
    side: (t) => (t.ctx?.rsi == null ? null : t.ctx.rsi > 70 ? 'hot' : 'normal'),
    labels: { hot: 'bought with RSI above 70 (already stretched)', normal: 'bought with RSI at 70 or below' },
    bad: 'hot', fix: { maxEntryRsi: 70 }, undo: { maxEntryRsi: null },
    fixText: 'skip entries while RSI is above 70',
  },
];

/**
 * Read the trade log. Returns overall numbers, a per-condition breakdown, a
 * per-coin breakdown and plain-language findings.
 */
export function reviewTrades(closed = []) {
  const trades = closed.filter((t) => !t.manual);
  const overall = summarise(trades);
  const lenses = LENSES.map((L) => {
    const groups = {};
    for (const t of trades) { const s = L.side(t); if (s) (groups[s] ||= []).push(t); }
    const out = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, summarise(v)]));
    const bad = out[L.bad], good = Object.entries(out).find(([k]) => k !== L.bad)?.[1];
    const judged = bad && good && bad.n >= MIN_GROUP && good.n >= MIN_GROUP;
    const losing = judged && bad.avgR < 0 && bad.avgR <= good.avgR - GAP_R;
    return { key: L.key, title: L.title, groups: out, labels: L.labels, judged, losing, fixText: L.fixText };
  });
  const bySymbol = {};
  for (const t of trades) (bySymbol[t.symbol] ||= []).push(t);
  const coins = Object.entries(bySymbol).map(([symbol, v]) => ({ symbol, ...summarise(v) })).sort((a, b) => a.totalR - b.totalR);
  const exits = {};
  for (const t of trades) (exits[t.reason] ||= []).push(t);

  const findings = [];
  if (overall.n < MIN_TRADES) findings.push(`Only ${overall.n} closed trade${overall.n === 1 ? '' : 's'} so far — the review needs ${MIN_TRADES} before it changes anything.`);
  for (const l of lenses) {
    if (!l.judged) continue;
    const [bk, gk] = [LENSES.find((L) => L.key === l.key).bad, Object.keys(l.groups).find((k) => k !== LENSES.find((L) => L.key === l.key).bad)];
    const b = l.groups[bk], g = l.groups[gk];
    findings.push(`${l.labels[bk][0].toUpperCase()}${l.labels[bk].slice(1)}: ${b.n} trades, ${b.winRate}% won, average ${b.avgR >= 0 ? '+' : ''}${b.avgR}R — versus ${g.avgR >= 0 ? '+' : ''}${g.avgR}R when it ${l.labels[gk]} (${g.n} trades).${l.losing ? ' That gap is large enough to act on.' : ''}`);
  }
  const worst = coins.find((c) => c.n >= MIN_GROUP && c.avgR <= -0.4);
  if (worst) findings.push(`${worst.symbol} has lost on average ${worst.avgR}R over ${worst.n} trades.`);
  return { overall, lenses, coins, exits: Object.fromEntries(Object.entries(exits).map(([k, v]) => [k, summarise(v)])), findings };
}

/**
 * Decide what to change. Returns { cfgPatch, changes: [{ text, evidence }] }.
 * `history` is the changelog so far (to check whether earlier lessons helped).
 */
// Dropping a coin after a losing run was measured (2026-09-26, 4 timeframes,
// held-out data) to be noise: on 4h it benched six coins on 6-9 trades each and
// cost 6 points of return. It stays available but is off by default.
export function decideChanges(review, cfg, history = [], closed = [], { excludeCoins = false } = {}) {
  const patch = {};
  const changes = [];
  if (review.overall.n < MIN_TRADES) return { cfgPatch: patch, changes };

  // 1. Unlearn: a filter switched on earlier that made things worse is switched off.
  for (const h of history) {
    if (h.undone || !h.lens || !h.at) continue;
    const L = LENSES.find((x) => x.key === h.lens);
    if (!L || !isOn(cfg, L)) continue;
    const before = summarise(closed.filter((t) => !t.manual && t.exitAt < h.at));
    const after = summarise(closed.filter((t) => !t.manual && t.openedAt >= h.at));
    if (after.n >= MIN_GROUP * 2 && before.n >= MIN_GROUP && after.avgR <= before.avgR - GAP_R) {
      Object.assign(patch, L.undo);
      changes.push({ lens: L.key, undo: true, text: `Switched OFF "${L.fixText}" — since it was switched on, trades averaged ${after.avgR}R against ${before.avgR}R before.`, evidence: { before, after } });
    }
  }

  // 2. Learn: switch on the filter for a condition that keeps losing.
  for (const l of review.lenses) {
    const L = LENSES.find((x) => x.key === l.key);
    // A lesson that was unlearned once is not relearned: flipping a filter on
    // and off every few checks was measured to cost money.
    if (!l.losing || isOn(cfg, L) || changes.some((c) => c.lens === L.key) || history.some((h) => h.lens === L.key && (h.undo || h.undone))) continue;
    const b = l.groups[L.bad];
    Object.assign(patch, L.fix);
    changes.push({ lens: L.key, text: `Switched ON "${L.fixText}" — ${b.n} trades taken in that condition averaged ${b.avgR}R.`, evidence: l.groups });
  }

  // 3. Stop trading a coin that keeps losing (at most one per review).
  const worst = excludeCoins && review.coins.find((c) => c.n >= MIN_GROUP && c.avgR <= -0.4 && !(cfg.excluded || []).includes(c.symbol));
  const universeLeft = (cfg.universe || []).filter((s) => !(cfg.excluded || []).includes(s));
  if (worst && universeLeft.length > 3) {
    patch.excluded = [...(cfg.excluded || []), worst.symbol];
    changes.push({ text: `Stopped trading ${worst.symbol} — ${worst.n} trades, ${worst.winRate}% won, average ${worst.avgR}R.`, evidence: worst });
  }
  return { cfgPatch: patch, changes };
}

function isOn(cfg, L) {
  return Object.entries(L.fix).every(([k, v]) => cfg[k] === v);
}

/** The filters the review can control, in words — for the settings panel. */
export function activeLessons(cfg) {
  const on = LENSES.filter((L) => isOn(cfg, L)).map((L) => L.fixText);
  if (cfg.excluded?.length) on.push(`not trading ${cfg.excluded.join(', ')}`);
  return on;
}
