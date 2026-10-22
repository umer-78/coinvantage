// One check of an AI trading account, after its candles are read. The Trading
// page runs it while it is open; the server's scheduled trader runs it for
// every signed-in account whose AI is on, with the page closed
// (supabase/functions/cv/trader.ts, which uses a byte-identical copy). One
// copy of the steps means the account trades the same either way.
import { DEFAULT_CONFIG, PER_COIN_RULES, rulesForChart, replayAll, logCheck } from './autotrader.js';
import { reviewTrades, decideChanges } from './tradelearn.js';

// Saved settings used to include the strategy's own numbers (stop, target…),
// so a strategy update never reached anyone who had once pressed Save. Only
// the user's own choices — and, from v2, what the self-review learned — carry over.
export const USER_KEYS = ['startingBalance', 'riskPct', 'maxPositions', 'interval', 'universe', 'ownRulesOff', 'maxPositionPct', 'feePct', 'strategy', 'custom'];
// The trend filter is not carried over from a save: whether the self-review
// switched it is read from its lessons (rulesForChart), since a saved value
// cannot tell a learned setting from an old default.
export const LEARNED_KEYS = ['minAdx', 'maxEntryRsi', 'excluded'];

/** The account's settings, from what it saved. */
export function configFrom(saved) {
  const s = saved || {};
  const cfg = { ...DEFAULT_CONFIG, ...Object.fromEntries(Object.entries(s).filter(([k]) => USER_KEYS.includes(k) || (s.v === 2 && LEARNED_KEYS.includes(k)))), v: 2 };
  // Risk per trade above 5% is a setting that wipes an account out in a short
  // losing run; older saves allowed 10.
  cfg.riskPct = Math.min(5, Math.max(0.1, +cfg.riskPct || DEFAULT_CONFIG.riskPct));
  return cfg;
}

/**
 * Each coin's own rules: on for accounts running on the chart they were chosen
 * on, unless switched off. It follows the chart the account RUNS on, which only
 * changes on a Reset, not the chart picked in Settings.
 */
export const ownRulesOn = (cfg, state) => !cfg.ownRulesOff && cfg.strategy !== 'custom' && (state?.interval || cfg.interval) === PER_COIN_RULES.interval;

/** What the account trades: its settings, the chart's tested rules, the self-review's lessons, each coin's own rules. */
export function runConfig(cfg, state, lessons = []) {
  return { ...rulesForChart(cfg, state?.interval || cfg.interval, lessons), perCoin: ownRulesOn(cfg, state) ? PER_COIN_RULES.rules : null };
}

/**
 * Coins held but taken off the list. A position in one used to be skipped for
 * good, with no stop or target; it is still checked, for its exits only.
 */
export const heldOffList = (cfg, state) => Object.keys(state?.open || {}).filter((sym) => !cfg.universe.includes(sym));

/**
 * Held coins whose candles start after the last one the account traded on, and
 * how many to read for them. A coin held while nobody checked for longer than
 * the window a check reads (500 candles: 42 hours of 5m) had its stop and
 * target checked only from the first candle in that window: a QNT trade with
 * its stop 1.6% under the entry was closed 5.2% down. Its missing candles are
 * read back to the last one traded on, with the 240 before it the indicators need.
 */
export function backfillNeeds(state, bySymbol, stepMs, { now = Date.now(), max = 6000 } = {}) {
  const out = [];
  if (!(stepMs > 0)) return out;
  for (const sym of Object.keys(state?.open || {})) {
    const have = bySymbol[sym], cur = state.cursor?.[sym];
    if (!have?.length || !cur || have[0].t <= cur + stepMs) continue;
    out.push({ sym, need: Math.min(max, Math.ceil((now - cur) / stepMs) + 240) });
  }
  return out;
}

/**
 * The self-review: the trader reads its own trade log, finds conditions that
 * keep losing and switches on the filter that avoids them (or off, if a filter
 * made things worse). Changes `cfg` and `lessons` in place.
 */
export function reviewStep(state, cfg, lessons, { now = Date.now() } = {}) {
  const review = reviewTrades(state.closed);
  const { cfgPatch, changes } = decideChanges(review, rulesForChart(cfg, state.interval || cfg.interval, lessons), lessons, state.closed);
  if (changes.length) {
    Object.assign(cfg, cfgPatch);
    for (const c of changes) {
      lessons.push({ at: now, lens: c.lens || null, undo: !!c.undo, text: c.text });
      if (c.undo) for (const h of lessons) if (h.lens === c.lens && !h.undo && h.at < now) h.undone = true;
      logCheck(state, { kind: 'review', text: c.text });
    }
  }
  return { review, changes };
}

/**
 * One check, once the candles are read (closed candles only, by coin): every
 * coin advances together, candle by candle, as in the published test; one line
 * goes in the activity feed; then the self-review, unless switched off.
 * Changes `state`, `cfg` and `lessons` in place. `by` says who checked: 'page'
 * or 'cloud'.
 */
export function checkAccount(state, cfg, { bySymbol, failed = [], lessons = [], autoLearn = true, by = 'page', now = Date.now() } = {}) {
  const runCfg = runConfig(cfg, state, lessons);
  const held = heldOffList(cfg, state);
  const tradesBefore = state.closed.length;
  const openBefore = new Set(Object.values(state.open).map((p) => `${p.symbol}:${p.openedAt}`));
  const results = replayAll(state, { ...runCfg, excluded: [...(runCfg.excluded || []), ...held] }, bySymbol);
  let processed = 0;
  const scores = [];
  for (const [sym, res] of Object.entries(results)) {
    processed += res.processed;
    if (Number.isFinite(res.lastScore)) scores.push({ sym, score: res.lastScore });
  }
  const best = scores.sort((a, b) => b.score - a.score)[0];
  // buy signals the account could not take: no free slot, or all the cash in open trades
  const passedUp = Object.entries(results).filter(([, r]) => r.passed).map(([sym, r]) => ({ sym, why: r.passedWhy }));
  const opened = [...Object.values(state.open), ...state.closed.slice(tradesBefore)].filter((p) => !openBefore.has(`${p.symbol}:${p.openedAt}`)).length;
  const closed = state.closed.length - tradesBefore;
  logCheck(state, {
    kind: 'check', by, coins: cfg.universe.length - failed.length, candles: processed,
    passed: passedUp.length ? { syms: passedUp.map((x) => x.sym).slice(0, 8), n: passedUp.length, why: passedUp.some((x) => x.why === 'nocash') ? 'nocash' : 'full' } : null,
    opened, closed, best: best ? { sym: best.sym, score: Math.round(best.score) } : null, bar: runCfg.entryScore,
  });
  const { changes } = autoLearn ? reviewStep(state, cfg, lessons, { now }) : { changes: [] };
  return { results, processed, opened, closed, changes, runCfg };
}
