// The assistant's answer about the user's own AI trading account: built from
// the account itself, with the same rules and tested numbers the Trading page
// shows. The chat used to know nothing about it, so "how is my AI trader
// doing?" was answered with a market analysis of whatever coin was in focus.
import { stats, rulesForChart, rulesInWords, expectedYield, CHART_TESTED, PER_COIN_RULES, DEFAULT_CONFIG } from './autotrader.js';

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
].join('|'), 'i');

const pct = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v)}%`;
const day = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * null unless the question is about the AI trader. Otherwise { text, data }:
 * text is the answer in markdown, data the same facts for a language model.
 * `saved` is the Trading page's stored settings, `fmt` formats money.
 */
export function traderAnswer(question, { state = null, saved = {}, lessons = [], symbol = null, fmt = (v) => `$${Number(v).toFixed(2)}` } = {}) {
  if (!TRADER_Q.test(String(question || ''))) return null;
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
    lines.push(`- What to expect: tested on ${y.coins} coins over ${tested.from} → ${tested.to}, rules picked on earlier data each time, at ${y.risk}% a trade it made ${pct(y.ret)} per ${y.block} on average (${pct(y.lo)} in the worst of ${y.periods} periods, ${pct(y.hi)} in the best, a worst drop near ${y.dd}%) against ${pct(y.hold)} for holding the same coins.${y.capsDiffer ? ' Your caps on open trades or on one coin differ from the test\'s, so treat it as rougher.' : ''}${perCoin ? ` With each coin's own rules, ${pct(PER_COIN_RULES.tested.own.ret)} against ${pct(PER_COIN_RULES.tested.hold)} for holding over ${PER_COIN_RULES.tested.from} → ${PER_COIN_RULES.tested.to}.` : ''} Settings on the Trading page shows this for every risk level.`);
    data.tested = { perPeriodPct: y.ret, worstPeriodPct: y.lo, bestPeriodPct: y.hi, worstDropPct: y.dd, riskPct: y.risk, holdingPct: y.hold, period: y.block };
  } else if (s.strategy === 'custom' || !tested) {
    lines.push(`- What to expect: nothing measured — ${s.strategy === 'custom' ? 'your own rules' : `the ${interval} chart`} ${s.strategy === 'custom' ? 'have' : 'has'} no published test. "Test these settings" in Settings on the Trading page replays them on recent candles.`);
  }
  lines.push('', '_Simulated money: it places no orders. A tested result is not a promise. Not financial advice._');
  return { text: lines.join('\n'), data: { aiTrader: data } };
}
