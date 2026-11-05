// The assistant's answer about the user's own AI trading account: built from
// the account itself, with the same rules and tested numbers the Trading page
// shows. The chat used to know nothing about it, so "how is my AI trader
// doing?" was answered with a market analysis of whatever coin was in focus.
import { stats, rulesForChart, rulesInWords, expectedYield, settingsWarnings, bestTestedChart, CHART_TESTED, PER_COIN_RULES, DEFAULT_CONFIG } from './autotrader.js';

export const TRADER_Q = new RegExp([
  String.raw`\b(ai|auto|robo|bot)[ -]?trad(er|ers|ing|e)\b`, // AI trader, auto-trading, bot trade
  String.raw`\btrading (bot|robot|account|ai)\b`,
  String.raw`\bmy (ai|bot|trading) (account|trader|trades|bot)\b`,
  String.raw`\b(ai|bot)('s)? (account|trades|rules|profit|performance|balance|positions?)\b`,
  // "what rules does the AI use", "how much profit did the AI make"
  String.raw`\b(rules?|profit|money|trades|positions?|balance)\b[^?.!]*\b(does|did|is|has) the (ai|bot) (use|make|made|making|trade|traded|trading|hold|holding|have|had|earn|earned|lose|lost)\b`,
  // "does the AI have any open positions?"
  String.raw`\b(does|did|is) the (ai|bot) (have|hold|holding|own)\b[^?.!]*\b(positions?|trades|coins)\b`,
  // "what yield will my settings get?", "expected return of the bot"
  String.raw`\b(yield|expected (return|profit))\b[^?.!]*\b(ai|bot|settings)\b`,
  String.raw`\b(ai|bot|settings)\b[^?.!]*\b(yield|expected (return|profit))\b`,
  // "why is my AI losing?", "is the bot making money", "how do I make the AI profitable"
  String.raw`\b(ai|bot|trader)\b[^?.!]*\b(los(e|es|ing|t)|loss(es)?|profitable|making money|make money|winning)\b`,
  String.raw`\b(los(e|es|ing|t)|loss(es)?|profitable|making money)\b[^?.!]*\b(ai|bot|trader)\b`,
  // "which chart/settings should the AI use", "best setup for the trader"
  String.raw`\b(best|better|right|which)\b[^?.!]*\b(setup|settings|chart|timeframe|risk)\b[^?.!]*\b(ai|bot|trader|trading)\b`,
  String.raw`\b(ai|bot|trader)\b[^?.!]*\b(best|better|right|which)\b[^?.!]*\b(setup|settings|chart|timeframe|risk)\b`,
].join('|'), 'i');

/**
 * A follow-up to a question about the AI trader ("why?", "what should I
 * change?", "and on 4h?"): short, and leaning on what was just asked. The
 * assistant answers it about the account instead of starting a coin analysis.
 */
export const FOLLOW_UP = /^(and\b|so\b|but\b|why|how come|what (should|can|do) i|should i|how (do|can) i|then\b|what about|is (that|it|this)|explain|tell me more|more\b|ok(ay)?\b|and now)/i;
export const isTraderFollowUp = (question, previous) => Boolean(previous && TRADER_Q.test(previous) && String(question).trim().split(/\s+/).length <= 9 && FOLLOW_UP.test(String(question).trim()));
const WHY = /\b(why|how come|reason|explain|los(e|es|ing|t)|loss(es)?|what (should|can|do) i|should i|improve|better|best|fix|change|profitable|make money)\b/i;
// asking what to do rather than why: the answer is the steps, not the diagnosis again
const CHANGE = /\b(what (should|can|do) i (do|change)|change|improve|fix|make (it|the (ai|bot|trader)) (profitable|better|make money)|what to do|how (do|can) i (make|get|stop))\b/i;

const pct = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`;
const day = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * null unless the question is about the AI trader. Otherwise { text, data }:
 * text is the answer in markdown, data the same facts for a language model.
 * `saved` is the Trading page's stored settings, `fmt` formats money.
 */
export function traderAnswer(question, { state = null, saved = {}, lessons = [], symbol = null, fmt = (v) => `$${Number(v).toFixed(2)}`, followUp = false, latest = null } = {}) {
  if (!followUp && !TRADER_Q.test(String(question || ''))) return null;
  const s = saved || {};
  const interval = state?.interval || s.interval || DEFAULT_CONFIG.interval;
  const base = { ...DEFAULT_CONFIG, ...Object.fromEntries(Object.entries(s).filter(([k]) => ['universe', 'minAdx', 'maxEntryRsi', 'excluded', 'strategy', 'custom'].includes(k))) };
  const rules = rulesForChart(base, interval, lessons);
  const perCoin = !s.ownRulesOff && s.strategy !== 'custom' && interval === PER_COIN_RULES.interval;
  const tested = CHART_TESTED[interval];
  const traded = tested && (tested.adopt ? tested.own : tested.standard);
  const lines = [];
  const data = { chart: interval, rules: rulesInWords(rules) };

  if (!state) {
    lines.push(`**Your AI trader has not started yet.** Open **[Trading](#/trader)** and press Start: it trades simulated money on the ${interval} chart, with no orders sent anywhere.`);
  } else {
    const st = stats(state);
    lines.push(`**Your AI trader** — simulated money on the ${interval} chart, since ${day(st.since)}.`);
    lines.push(`- Account: ${fmt(st.equity)} from ${fmt(st.startingBalance)} (${pct(st.returnPct)}), counting open positions at the price they were bought at.`);
    lines.push(st.trades
      ? `- ${st.trades} trade${st.trades === 1 ? '' : 's'} closed: ${st.wins} won (${st.winRate}%), fees ${fmt(st.feesPaid)}, worst drop ${st.maxDrawdownPct}%.`
      : '- No trades closed yet.');
    const open = Object.values(state.open || {});
    if (open.length) lines.push(`- Open now: ${open.slice(0, 5).map((p) => `${p.symbol} bought ${day(p.openedAt)} at ${fmt(p.entry)} (stop ${fmt(p.stop)}${p.tp ? `, target ${fmt(p.tp)}` : ', trailing stop'})`).join('; ')}${open.length > 5 ? `; and ${open.length - 5} more` : ''}.`);
    Object.assign(data, { equity: st.equity, startingBalance: st.startingBalance, returnPct: st.returnPct, closedTrades: st.trades, wins: st.wins, winRatePct: st.winRate, feesPaid: st.feesPaid, worstDropPct: st.maxDrawdownPct, open: open.map((p) => ({ coin: p.symbol, entry: p.entry, stop: p.stop, target: p.tp })) });
  }

  lines.push(`- ${s.strategy === 'custom' ? 'Your own rules (no published test)' : 'Rules on this chart'}: ${rulesInWords(rules)}${perCoin ? ' On the daily chart each coin with rules of its own trades those instead.' : ''}`);
  if (symbol) {
    const own = perCoin && PER_COIN_RULES.rules[symbol];
    const done = (state?.closed || []).filter((t) => t.symbol === symbol);
    const pnl = done.reduce((a, t) => a + (t.pnl || 0), 0);
    lines.push(`- ${symbol}: ${own ? `trades its own rules — ${rulesInWords({ ...rules, ...own })}` : 'trades the rules above'}${done.length ? ` It has closed ${done.length} ${symbol} trade${done.length === 1 ? '' : 's'} for ${pnl >= 0 ? '+' : '−'}${fmt(Math.abs(pnl))}.` : ''}`);
    data.coin = { symbol, ownRules: !!own, closedTrades: done.length, pnl: +pnl.toFixed(2) };
  }
  const last = [...(lessons || [])].reverse().find((l) => l.text);
  if (last) lines.push(`- Last change by its self-review (${day(last.at)}): ${last.text}`);
  // what to expect: the walk-forward test of these rules at the saved risk
  const y = traded && expectedYield({ ...base, ...Object.fromEntries(Object.entries(s).filter(([k]) => ['riskPct', 'maxPositions', 'maxPositionPct'].includes(k))), interval });
  if (y) {
    lines.push(`- What to expect: tested on ${y.coins} coins over ${tested.from} → ${tested.to}, ${tested.adopt ? 'rules picked on earlier data each time' : 'the standard rules, in three periods back to back'}, at ${y.risk}% a trade it made ${pct(y.ret)} per ${y.block} on average (${pct(y.lo)} in the worst of ${y.periods} periods, ${pct(y.hi)} in the best, a worst drop near ${y.dd}%) against ${pct(y.hold)} for holding the same coins${y.holdDrop ? ` (worst drop ${y.holdDrop}%)` : ''}.${y.capsDiffer ? ' Your caps on open trades or on one coin differ from the test\'s, so treat it as rougher.' : ''}${perCoin ? ` With each coin's own rules, ${pct(PER_COIN_RULES.tested.own.ret)} against ${pct(PER_COIN_RULES.tested.hold)} for holding over ${PER_COIN_RULES.tested.from} → ${PER_COIN_RULES.tested.to}.` : ''} Settings on the Trading page shows this for every risk level.`);
    data.tested = { perPeriodPct: y.ret, worstPeriodPct: y.lo, bestPeriodPct: y.hi, worstDropPct: y.dd, riskPct: y.risk, holdingPct: y.hold, holdingWorstDropPct: y.holdDrop, period: y.block };
  } else if (s.strategy === 'custom' || !tested) {
    lines.push(`- What to expect: nothing measured — ${s.strategy === 'custom' ? 'your own rules' : `the ${interval} chart`} ${s.strategy === 'custom' ? 'have' : 'has'} no published test. "Test these settings" in Settings on the Trading page replays them on recent candles.`);
  }
  // Why it stands where it does, and what the tests say would do better: asked
  // for, or the account is down. A follow-up ("why?") gets this alone, not the
  // account again; "what should I change?" gets the steps.
  const NOTE = '_Simulated money: it places no orders. A tested result is not a promise. Not financial advice._';
  const asked = String(latest ?? question ?? '');
  const st = state ? stats(state) : null;
  const cfg = { ...DEFAULT_CONFIG, ...s, interval };
  const warnings = settingsWarnings(cfg);
  const best = bestTestedChart();
  const closed = state?.closed || [];
  if (CHANGE.test(asked)) {
    const steps = changeSteps({ cfg, base, s, interval, best, closed, started: Boolean(st) });
    data.change = steps.map((x) => x.replace(/\*\*/g, ''));
    const out = [st ? '**What to change**' : '**Before you start: what to change**', ...steps.map((x, i) => `${i + 1}. ${x}`)];
    if (followUp) return { text: [...out, '', NOTE].join('\n'), data: { aiTrader: data } };
    lines.push('', ...out);
  } else if (WHY.test(String(question || '')) || (st && st.returnPct < 0)) {
    const why = [];
    const by = {};
    for (const t of closed) by[t.reason || 'other'] = (by[t.reason || 'other'] || 0) + 1;
    const losses = closed.filter((t) => t.pnl < 0), wins = closed.filter((t) => t.pnl > 0);
    const avg = (xs) => (xs.length ? xs.reduce((a, t) => a + (t.pnlPct || 0), 0) / xs.length : null);
    why.push(st ? `**Why it is ${st.returnPct < 0 ? `down (${pct(st.returnPct)})` : `at ${pct(st.returnPct)}`}, and what would do better**` : '**Before you start: what the tests say about these settings**');
    if (!st) why.push('- It has not traded yet, so there are no trades of its own to explain.');
    else if (closed.length) why.push(`- How its ${closed.length} closed trade${closed.length === 1 ? '' : 's'} ended: ${Object.entries(by).map(([r, n]) => `${n} by ${r}`).join(', ')}.${losses.length ? ` Losing trades averaged ${pct(avg(losses))}` : ''}${wins.length ? `${losses.length ? ',' : ''} winning ones ${pct(avg(wins))}` : ''}${losses.length || wins.length ? '.' : ''}${closed.length < 20 ? ` ${closed.length} trades are too few to judge the rules by: the tests behind them took 100 or more.` : ''}`);
    else why.push('- No trade has closed yet: the change is in the open positions, valued at the latest prices.');
    for (const w of warnings.slice(0, 4)) why.push(`- ${w}`);
    if (best && best.iv !== interval) why.push(`- What tested best: the **${best.iv}** chart with the tested rules, ${pct(best.net)} per ${best.block} after real-fill costs (about ${pct(best.month)} a month), worst drop ${best.dd}%. To switch: Trading → Settings → **Use the best tested setup**${st ? ' (it starts a fresh account on that chart)' : ''}.`);
    else if (best) why.push(`- ${st ? 'This is' : 'These settings use'} the chart that tested best: ${pct(best.net)} per ${best.block} after real-fill costs.`);
    if (best && best.hold > best.ret) why.push(`- In the same test, simply holding the coins made more (${pct(best.hold)} a period) with deeper drops: the trader's measured advantage is falling less, not earning more.`);
    if (!warnings.length && best?.iv === interval && st) why.push('- Nothing in the settings stands out against the tests: a run of losses on a tested setup is within what the tests saw (the worst of their periods is under What to expect).');
    data.why = { exits: by, closedTrades: closed.length, best: best ? { chart: best.iv, netPerPeriodPct: best.net, perMonthPct: best.month, period: best.block } : null, warnings };
    if (followUp) return { text: [...why, '', NOTE].join('\n'), data: { aiTrader: data } };
    lines.push('', ...why);
  }
  lines.push('', NOTE);
  return { text: lines.join('\n'), data: { aiTrader: data } };
}

/**
 * What to change, as steps, each with the measured number behind it: the
 * chart that tested best, the tested risk, caps the cash can fund, and how
 * long to leave it before judging. Settings with nothing wrong give fewer.
 */
function changeSteps({ cfg, base, s, interval, best, closed, started }) {
  const steps = [];
  if (best && best.iv !== interval) {
    const here = CHART_TESTED[interval];
    const r = here && (here.adopt ? here.own : here.standard);
    steps.push(`**Chart:** switch to **${best.iv}** — Trading → Settings → **Use the best tested setup**${started ? ' (it starts a fresh account)' : ''}. It tested at ${pct(best.net)} per ${best.block} after real-fill costs (about ${pct(best.month)} a month)${r ? `; ${interval} tested at ${pct(r.ret - (here.fillCost ?? 0))} per ${here.block}, both at the tested 1.5% a trade` : `; ${interval} has no published test`}.`);
  }
  const risk = cfg.riskPct ?? DEFAULT_CONFIG.riskPct;
  if (risk > 2) {
    const y = expectedYield({ ...base, ...Object.fromEntries(Object.entries(s).filter(([k]) => ['riskPct', 'maxPositions', 'maxPositionPct'].includes(k))), interval });
    const at = (rk) => y?.levels?.find((l) => l.risk === rk);
    const now = at(risk), tested = at(1.5);
    steps.push(`**Risk:** lower it from ${risk}% to 1.5% a trade, the level the tests are quoted at${now && tested ? `: on ${interval} the worst test period was ${pct(now.lo)} at ${risk}% against ${pct(tested.lo)} at 1.5%, and the worst drop ${now.dd}% against ${tested.dd}%` : ''}. Ten losses in a row, which happens, cost about ${Math.round((1 - (1 - risk / 100) ** 10) * 100)}% at ${risk}%.`);
  }
  const share = cfg.maxPositionPct ?? 25;
  const funded = Math.floor(100 / share);
  if ((cfg.maxPositions ?? 5) > funded + 1) steps.push(`**Open trades:** set Max open trades to ${funded}, or Max in one coin to ${Math.floor(100 / cfg.maxPositions)}%, so every trade it is allowed can be paid for (now ${cfg.maxPositions} allowed, cash for about ${funded}). The tests used 5 at 25% each.`);
  if (cfg.strategy === 'custom') steps.push('**Rules:** your own rules have no published test: use "Test these settings" in Settings, or switch back to the tested rules.');
  steps.push(`**Then leave it:** judge it after 100 or more closed trades, as the tests were${closed.length ? ` — it has ${closed.length} so far, which say almost nothing about the rules` : ''}. Changing settings after every loss resets the record.`);
  return steps;
}
