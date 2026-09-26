// Rule-based analyst. Produces a markdown answer from the same context that
// is sent to the language model, so the assistant works even without an API key.

import { fmtNum as fmtUsd, upRateFor, SCORE_BUCKETS_TESTED } from './signals.js';
import { accuracyFor, TESTED_ACCURACY } from './predict.js';
import { fx } from '../api/fx.js';
import { isTickerMention } from './tickers.js';

// Every price the assistant quotes — levels, stops, targets, EMAs, Bollinger
// bands, ATR, forecast ranges — came out unconverted and labelled USD, while
// every other screen showed the chosen display currency. Someone on rupees was
// told "resistance 76,343 USD" next to a header reading Rs21,009,403. Wrapping
// the formatter converts all twenty-one call sites at once.
const fmtNum = (v) => (v === null || v === undefined || !Number.isFinite(v) ? fmtUsd(v) : fmtUsd(v * (fx.rate || 1)));

const DISCLAIMER = '_Signals are technical indicators, not financial advice. Always use a stop-loss and only risk what you can afford to lose._';

const money = (v) => Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });

function parseAccount(q) {
  const s = String(q || '').replace(/,/g, '');
  const m = /\$\s?(\d+(?:\.\d+)?)\s?(k)?/i.exec(s) || /(\d+(?:\.\d+)?)\s?(k)?\s?(usd|usdt|dollars?|bucks)/i.exec(s);
  if (!m) return null;
  let v = parseFloat(m[1]);
  if (m[2] && m[2].toLowerCase() === 'k') v *= 1000;
  return v > 0 ? v : null;
}

function pct(v) {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  return `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`;
}

// Tickers and names common enough that mentioning one makes the question
// single-coin. detectSymbol() does the real lookup; this only keeps the
// rule-based analyst from answering market-wide when a coin was clearly named.
const NAMES_A_COIN_G = /\b(btc|bitcoin|eth|ether|ethereum|bnb|sol|solana|xrp|ripple|ada|cardano|doge|dogecoin|trx|tron|avax|dot|polkadot|link|chainlink|matic|polygon|ltc|litecoin|shib|ton|near|atom|uni|xlm|bch|etc|fil|apt|arb|op|sui|pepe|hbar|icp|inj|tao|sei|rndr|aave|mkr|zec)\b/gi;
const NAMES_A_COIN = new RegExp(NAMES_A_COIN_G.source);
/** Coins named in the question, with everyday words ("near term") left out. */
export function namedCoins(q) {
  const text = String(q || '');
  return [...text.matchAll(NAMES_A_COIN_G)].filter((m) => isTickerMention(m[0], text, m.index)).map((m) => m[0].toUpperCase());
}

// "Which coin should I buy?" is a different question from "should I buy BTC?".
export function isMarketWide(q) {
  const s = (q || '').toLowerCase();
  if (/(which|what) (coin|crypto|one|token|altcoin)|best (coin|crypto|buy|pick|token)|top (coin|pick|buy)|what (should i|to) buy|anything (good|worth)|all (the|of the)? ?coins|every coin|whole market|scan the market|market overview|any (good )?(buy|opportunit)|recommend|picks?\b|where should i (put|invest)|shopping list/.test(s)) return true;
  // A buy/sell/timing question that names no coin is a question about the market.
  if (namedCoins(q).length || /\b(this coin|my)\b/.test(s)) return false;
  return /\b(buy|sell|short|long|invest|entry|exit|hold)\b/.test(s)
    && /\b(what|which|when|anything|something|now|today|this week|time ?frame|timeframe|short term|long term|how long)\b/.test(s);
}

// "compare BTC and ETH" / "BTC vs SOL" / "which is better, X or Y"
export function detectCompare(q) {
  const s = String(q || '');
  const named = namedCoins(s);
  const uniq = [...new Set(named)];
  const asksToCompare = /\b(compare|versus|vs\.?|better|stronger|which of|between)\b/i.test(s);
  return uniq.length >= 2 && (asksToCompare || uniq.length >= 2) ? uniq.slice(0, 4) : null;
}

function detectIntent(q) {
  const s = (q || '').toLowerCase();
  if (/(portfolio|wallet|holding|my coins|my bag)/.test(s)) return 'portfolio';
  if (detectCompare(q)) return 'compare';
  if (isMarketWide(s)) return 'market';
  // "How accurate are your predictions?" contains "predict", so it used to be
  // answered with a price forecast for the focused coin — the question about
  // the model answered with output from the model. Asking how well it works is
  // checked first now.
  if (/(backtest|win ?rate|accura|reliab|track record|history of signal|how good|does it work|trust)/.test(s)) return 'backtest';
  if (/(predict|forecast|future|will (it|the price|price|this)|go(ing)? (up|down)|next (hour|day|week|month)|tomorrow|pump|dump|target price|where .* (head|go)|up or down)/.test(s)) return 'forecast';
  if (/(position size|how much|\bsize\b|invest|risk|lot size|allocation|\$\s?\d|\d+\s?k?\s?(usd|usdt|dollars?|bucks))/.test(s)) return 'risk';
  if (/(exit|close|sell|take profit|tp\b|stop|get out)/.test(s)) return 'exit';
  if (/(entry|enter|buy|long|get in|good time|should i)/.test(s)) return 'entry';
  if (/(support|resistance|level)/.test(s)) return 'levels';
  if (/(indicator|rsi|macd|ema|bollinger|adx|stoch|supertrend|mfi|money flow|cci|williams|donchian|keltner)/.test(s)) return 'indicators';
  return 'summary';
}

function header(ctx) {
  const c = ctx.coin;
  if (!c) return '';
  return `**${c.name} (${c.symbol})** · ${fmtNum(c.price)} ${fx.code} · 24h ${pct(c.change24h)}${ctx.interval ? ` · ${ctx.interval} chart` : ''}`;
}

function signalLine(sig, interval = null) {
  const base = `**Chart reading: ${sig.text}** (indicator agreement ${sig.score > 0 ? '+' : ''}${sig.score}/100)`;
  const m = interval ? upRateFor(interval, sig.score) : null;
  // This used to read "Signal: Strong Buy (score +67/100)" with nothing after
  // it, which is the reading dressed as a recommendation. The measured record
  // for that band travels with it now.
  return m
    ? `${base}\n\n_Across ${SCORE_BUCKETS_TESTED.bars.toLocaleString()} tested bars, readings in this band were followed by a higher price ${m.upRatePct}% of the time — the score describes how extended a move is, not whether it will continue._`
    : base;
}

function mtfBlock(ctx) {
  if (!ctx.mtf) return '';
  const rows = Object.entries(ctx.mtf).filter(([, v]) => v).map(([iv, v]) => `${iv}: ${v.text} (${v.score > 0 ? '+' : ''}${v.score})`);
  if (!rows.length) return '';
  const conf = ctx.confluence ? `\n- **Overall confluence: ${ctx.confluence.text}** (${ctx.confluence.score > 0 ? '+' : ''}${ctx.confluence.score})` : '';
  return `\n**Timeframes**\n- ${rows.join('\n- ')}${conf}\n`;
}

function planBlock(plan) {
  if (!plan) return '';
  return `\n**${plan.title}**\n- Entry zone: ${fmtNum(plan.entryZone[0])} – ${fmtNum(plan.entryZone[1])}\n- Stop-loss: ${fmtNum(plan.stopLoss)} (${plan.riskPct}% risk)\n- Take-profit 1 / 2 / 3: ${plan.takeProfits.map(fmtNum).join(' / ')}\n- Reward-to-risk at TP2: ${plan.rewardRisk}:1\n`;
}

function forecastBlock(f, ctx) {
  if (!f) return '';
  const dirWord = f.direction === 'UP' ? 'higher' : f.direction === 'DOWN' ? 'lower' : 'roughly flat';
  const horizon = ctx.horizonText || `${f.horizonBars} candles`;
  const acc = f.validatedAccuracyPct !== null ? `${f.validatedAccuracyPct}% direction accuracy on recent unseen data (naive baseline ${f.baselineAccuracyPct}%)` : 'accuracy not measured';
  const lines = [
    `**AI forecast (next ${horizon}):** ${f.probUpPct}% chance of going up → leans **${dirWord}** · confidence ${f.confidence}`,
    `- Expected move: ${pct(f.expectedMovePct)} → target ≈ ${fmtNum(f.targetPrice)}`,
    `- Likely range (50%): ${fmtNum(f.likelyRange[0])} – ${fmtNum(f.likelyRange[1])}; wide range (80%): ${fmtNum(f.wideRange[0])} – ${fmtNum(f.wideRange[1])}`,
    `- Track record: ${acc}${f.accuracyWhenConfidentPct !== null ? `; ${f.accuracyWhenConfidentPct}% when the models agreed strongly` : ''}`,
  ];
  if (f.patternMatches?.length) {
    const ups = f.patternMatches.filter((m) => m.thenMovedPct > 0).length;
    lines.push(`- Chart pattern comparison: ${ups} of ${f.patternMatches.length} most similar past charts went up afterwards (e.g. ${f.patternMatches.slice(0, 3).map((m) => `${m.date}: ${m.similarityPct}% similar → ${pct(m.thenMovedPct)}`).join('; ')})`);
  }
  if (f.notes?.length) lines.push(`- Note: ${f.notes[0]}`);
  return `\n${lines.join('\n')}\n`;
}

// What the coin's own multi-year history says about a chart shaped like today's.
function historyBlock(h) {
  if (!h) return '';
  const dir = h.verdict === 'UP' ? 'higher' : h.verdict === 'DOWN' ? 'lower' : 'mixed';
  const lines = [
    `**Previous years (daily chart):** the last ${h.similarPastCases} times ${h.windowDays} days of price looked like today, price was ${dir} ${h.horizonDays} days later in **${h.wentUpAfter}** cases — median ${pct(h.medianMovePct)} (best ${pct(h.bestCasePct)}, worst ${pct(h.worstCasePct)}).`,
  ];
  if (h.examples?.length) lines.push(`- Closest matches (date the chart matched → move over the following ${h.horizonDays} days): ${h.examples.map((e) => `${e.date}, ${e.similarityPct}% similar → ${pct(e.thenMovedPct)}`).join('; ')}`);
  if (h.thisMonthHistoricalAvgPct !== null && h.thisMonthHistoricalAvgPct !== undefined) lines.push(`- Seasonality: this calendar month has averaged ${pct(h.thisMonthHistoricalAvgPct)} for this coin across its history.`);
  lines.push(h.methodAccuracyPct !== null && h.methodAccuracyPct !== undefined
    ? `- Honesty check: replayed through this coin's past, this comparison method called the ${h.horizonDays}-day direction right **${h.methodAccuracyPct}%** of the time${h.methodAccuracyPct < 55 ? ' — close to a coin flip, so use it as context, not a trigger' : ''}.`
    : '- Honesty check: too few past tests to score this method on this coin.');
  return `\n${lines.join('\n')}\n`;
}

// When the move peaks and when it turns — the half of the answer a direction
// probability leaves out.
function timingBlock(ctx) {
  const t = ctx.timing;
  if (!t) return '';
  const lines = [];
  // Prefer the sentence built with real durations ("about 6 hours") over bar counts.
  if (ctx.timingSentence) lines.push(`**Timing:** ${ctx.timingSentence.replace(/\*\*/g, '')}`);
  else if (t.direction === 'rise then fade') {
    lines.push(`**Timing:** strength typically runs about **${t.barsToPeak} candle${t.barsToPeak === 1 ? '' : 's'}**, topping near ${fmtNum(t.peakPrice)} (${pct(t.peakMovePct)})${t.barsUntilItTurnsDown ? `, then turning down around candle ${t.barsUntilItTurnsDown}` : ' and holding rather than reversing'}.`);
  } else if (t.direction === 'fall then bounce') {
    lines.push(`**Timing:** weakness typically runs about **${t.barsToTrough} candle${t.barsToTrough === 1 ? '' : 's'}** (${pct(t.troughMovePct)})${t.barsUntilBounce ? `, with a bounce starting around candle ${t.barsUntilBounce}` : ' with no clear bounce in this horizon'}.`);
  }
  if (t.peakPrice) lines.push(`- Expected high around ${fmtNum(t.peakPrice)} (${pct(t.peakMovePct)}); at the horizon ${pct(t.moveAtHorizonPct)}.`);
  if (t.pctOfPastCasesUpAtPeak !== null && t.pctOfPastCasesUpAtPeak !== undefined) lines.push(`- ${t.pctOfPastCasesUpAtPeak}% of the ${t.basedOnSimilarPastCharts} matched past charts were still up at that point.`);
  lines.push('- Timing is the least reliable part of a forecast — use it to plan an exit, not to skip the stop-loss.');
  return lines.length ? `\n${lines.join('\n')}\n` : '';
}

// Every coin, read on three timeframes at once: what to buy for the next few
// hours, the next few days and the next few weeks — and where to sell each one.
function frameLines(b, horizon) {
  const lines = [`  - **${b.coin}** (${b.name}) — ${b.verdict}, conviction ${b.conviction}/100, now ${fmtNum(b.price)}`];
  if (b.buyBetween) lines.push(`    - Buy between **${fmtNum(b.buyBetween[0])}** and **${fmtNum(b.buyBetween[1])}**; stop-loss **${fmtNum(b.stopLoss)}** (risk ${b.riskPct}%)`);
  else if (b.waitFor) lines.push(`    - No entry trigger yet — ${b.waitFor}`);
  if (b.sellTargets) lines.push(`    - Sell at **${b.sellTargets.map(fmtNum).join('** → **')}**`);
  if (b.holdForBars) lines.push(`    - Hold roughly **${b.holdForBars} candle${b.holdForBars === 1 ? '' : 's'}** of the ${horizon} view, topping near ${fmtNum(b.expectedPeakPrice)}${b.turnsDownAfterBars ? `, turning down around candle ${b.turnsDownAfterBars} — sell before that` : ''}`);
  if (b.topReason) lines.push(`    - ${b.topReason}`);
  return lines.join('\n');
}

function marketMultiBlock(m) {
  if (!m?.frames?.length) return '';
  const out = [`**Whole-market scan — ${m.scanned} coins, read on ${m.frames.length} timeframes**\n`];

  for (const fr of m.frames) {
    out.push(`\n### ${fr.label} — ${fr.interval} chart (${fr.horizonText} ahead)`);
    if (!fr.buys.length) {
      out.push(`  - Nothing clears the bar on this timeframe. ${fr.waitingCount} coins read as "no edge — wait", and sitting out is a position.`);
    } else {
      for (const b of fr.buys.slice(0, 4)) out.push(frameLines(b, fr.interval));
    }
  }

  if (m.agree.length) {
    out.push('\n### Strongest overall');
    for (const a of m.agree) {
      const where = a.frames.map((f) => `${f.label} (${f.interval})`).join(', ');
      const best = a.frames[0];
      out.push(`- **${a.coin}** — a buy on ${a.frames.length} of ${m.frames.length} timeframes: ${where}.${best.sellTargets ? ` First sell target ${fmtNum(best.sellTargets[0])}, stop ${fmtNum(best.stopLoss)}.` : ''}`);
    }
    out.push('_A coin that reads well on more than one timeframe is the safer call — one that only looks good on the 1h chart is a trade, not an investment._');
  }

  if (m.avoid.length) {
    out.push('\n### Avoid or sell now');
    for (const a of m.avoid) out.push(`- **${a.coin}** — ${a.verdict} on the ${a.interval} chart (conviction ${a.conviction}/100)${a.topReason ? `: ${a.topReason}` : ''}`);
  }

  out.push('\nEvery verdict weights each reading by how accurate it has actually been on past data, so one with no measured edge counts for nothing — which currently includes the chart score itself, measured across 244,000 bars as pointing the wrong way. Open **Market scan** for the same list with charts, or ask me about any single coin for the full breakdown.');
  return `${out.join('\n')}\n`;
}

// The whole-market answer: which coin, at what price, for how long, and where to sell.
function marketBlock(m) {
  if (!m) return '';
  const out = [`**Market scan — ${m.scanned} coins on the ${m.interval} chart**\n`];
  if (!m.buys.length) {
    out.push(`Nothing currently clears the bar to buy. ${m.waitingCount} coins came back as "no edge — wait", which is the honest answer more often than not. Sitting out is a position.`);
  } else {
    out.push('**Worth buying now**\n');
    m.buys.forEach((b, i) => {
      const lines = [`${i + 1}. **${b.coin}** (${b.name}) — ${b.verdict}, conviction ${b.conviction}/100, now ${fmtNum(b.price)}`];
      if (b.buyBetween) lines.push(`   - Buy between ${fmtNum(b.buyBetween[0])} and ${fmtNum(b.buyBetween[1])}; stop-loss ${fmtNum(b.stopLoss)} (risk ${b.riskPct}%)`);
      if (b.sellTargets) lines.push(`   - Sell targets: ${b.sellTargets.map(fmtNum).join(' → ')}`);
      if (b.holdForBars) lines.push(`   - Similar past setups kept rising for about ${b.holdForBars} candle${b.holdForBars === 1 ? '' : 's'}, topping near ${fmtNum(b.expectedPeakPrice)}${b.turnsDownAfterBars ? `, turning down around candle ${b.turnsDownAfterBars}` : ''}`);
      if (!b.buyBetween && b.waitFor) lines.push(`   - No entry trigger yet: ${b.waitFor}`);
      if (b.topReason) lines.push(`   - ${b.topReason}`);
      out.push(lines.join('\n'));
    });
  }
  if (m.avoid.length) {
    out.push(`\n**Avoid or sell**\n${m.avoid.map((a) => `- **${a.coin}** — ${a.verdict} (conviction ${a.conviction}/100)${a.topReason ? `: ${a.topReason}` : ''}`).join('\n')}`);
  }
  out.push(`\nHorizon for these calls is roughly **${m.horizonText}**. Each verdict blends the chart signal, the AI forecast and the move timing, weighted by how accurate each has been — so a reading with no measured edge barely counts.`);
  out.push('Ask me about any single coin for the full breakdown, or open **Market scan** for the same list with charts.');
  return `${out.join('\n')}\n`;
}

// Two or three coins, ranked against each other on the same evidence.
//
// The hard part of a comparison is not gathering the numbers, it is refusing to
// declare a winner when there isn't one. Every coin here is scored with the same
// blend the rest of the app uses, and when the spread between them is inside the
// noise the answer says they are level rather than manufacturing a ranking.
function compareBlock(rows, interval, horizon) {
  if (!rows?.length) return '';
  const ranked = [...rows].sort((a, b) => (b.conviction ?? 0) - (a.conviction ?? 0));
  const out = [`**${ranked.map((r) => r.coin).join(' vs ')}** — same test, same timeframe (${interval}), ranked on the evidence.\n`];

  out.push('| | ' + ranked.map((r) => `**${r.coin}**`).join(' | ') + ' |');
  out.push('|---|' + ranked.map(() => '---').join('|') + '|');
  const row = (label, get) => out.push(`| ${label} | ${ranked.map(get).join(' | ')} |`);
  row('Verdict', (r) => r.verdict || '—');
  row('Conviction', (r) => (r.conviction ?? '—') + '/100');
  row('Chart signal', (r) => `${r.signalText || '—'}${r.score !== null && r.score !== undefined ? ` (${r.score > 0 ? '+' : ''}${r.score})` : ''}`);
  row('Forecast', (r) => (r.probUpPct !== null && r.probUpPct !== undefined ? `${r.probUpPct}% up` : '—'));
  row('Measured accuracy', (r) => (r.accuracyPct !== null && r.accuracyPct !== undefined ? `${r.accuracyPct}%` : 'not measured'));
  row('24h', (r) => (r.change24h === null || r.change24h === undefined ? '—' : pct(r.change24h)));
  row('Buy between', (r) => (r.buyBetween ? `${fmtNum(r.buyBetween[0])} – ${fmtNum(r.buyBetween[1])}` : 'no entry yet'));
  row('Stop', (r) => (r.stopLoss ? fmtNum(r.stopLoss) : '—'));
  row('First target', (r) => (r.sellTargets ? fmtNum(r.sellTargets[0]) : '—'));

  const top = ranked[0], second = ranked[1];
  const gap = (top.conviction ?? 0) - (second?.conviction ?? 0);
  out.push('');
  if (!top.conviction || top.conviction < 25) {
    out.push(`**None of them is a buy right now.** The best of the three only scores ${top.conviction ?? 0}/100, which is not enough to act on. Waiting costs nothing.`);
  } else if (gap < 10) {
    out.push(`**Too close to call.** ${top.coin} edges ${second.coin} by ${gap} points, which is inside the noise of this method — treat them as level and pick on what you already hold or understand, not on this ranking.`);
  } else {
    out.push(`**${top.coin} is the stronger of the ${ranked.length}**, by ${gap} points of conviction over ${second.coin}. ${top.topReason || ''}`);
  }
  const weak = ranked.filter((r) => r.accuracyPct !== null && r.accuracyPct !== undefined && r.accuracyPct < 52);
  if (weak.length) out.push(`\nThe forecast has no measured edge on ${weak.map((r) => r.coin).join(' and ')} at this timeframe, so their rows lean on the chart signal alone.`);
  out.push(`\nHorizon for all of them is about ${horizon}.`);
  return `${out.join('\n')}\n`;
}

// Headlines are context for the reader, not a model input — say so plainly.
function newsBlock(ctx) {
  const n = ctx.news;
  if (!n?.length) return '';
  const when = (at) => {
    const h = Math.round((Date.now() - new Date(at).getTime()) / 3600e3);
    return h < 1 ? 'just now' : h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
  };
  return `\n**Recent headlines**\n${n.map((x) => `- ${x.title} _(${x.source}, ${when(x.at)})_`).join('\n')}\n- These are background. The forecast above is built from price data only, so its accuracy figure does not include news.\n`;
}

// The chart signal and the forecast are two independent readings, and they
// disagree often. Presenting a confident "Buy" plan while the model quietly
// puts the odds at 42% up is the single most misleading thing this app could
// do, so a conflict is stated first, in plain words, and the recommendation is
// downgraded to match.
export function conflictCheck(sig, forecast) {
  if (!sig?.ok || !forecast) return null;
  const side = sig.plan?.side ?? (sig.score > 0 ? 'long' : sig.score < 0 ? 'short' : null);
  if (!side) return null;
  const probUp = forecast.probUpPct;
  if (probUp === null || probUp === undefined) return null;

  // only a clear lean counts as disagreement — 49% vs 51% is noise
  const forecastSide = probUp >= 55 ? 'long' : probUp <= 45 ? 'short' : null;
  if (!forecastSide || forecastSide === side) return null;

  const acc = forecast.validatedAccuracyPct;
  const forecastIsWeak = acc === null || acc === undefined || acc < 52;
  return { side, forecastSide, probUp, acc, forecastIsWeak };
}

function conflictBlock(ctx) {
  const c = conflictCheck(ctx.signal, ctx.forecast);
  if (!c) return '';
  // The template reads "the next ${horizon}", so a fallback beginning with
  // "the" produced "the next the forecast horizon".
  const horizon = ctx.horizonText || `${ctx.forecast?.horizonBars ?? 'few'} candles`;
  // This block still called the chart score a "buy" or a "sell" after the rest
  // of the answer had stopped doing so — two sentences below a line saying the
  // score describes how extended a move is rather than where it goes next. Both
  // sides of the disagreement are now described the same way: as a lean.
  const signalWord = c.side === 'long' ? 'up' : 'down';
  const modelWord = c.forecastSide === 'long' ? 'up' : 'down';
  const lines = [
    `⚠️ **The two readings disagree — treat this as no clear edge.** The chart reading leans **${signalWord}**, but the AI forecast puts the next ${horizon} at **${c.probUp}% up**, which leans **${modelWord}**.`,
  ];
  lines.push(c.forecastIsWeak
    ? `On this coin and timeframe the forecast has ${c.acc === null || c.acc === undefined ? 'no measured accuracy yet' : `only scored ${c.acc}% on recent unseen data`}, so it is the weaker of the two — but it is still pointing the other way, and that is a reason to take a smaller position, not a bigger one.`
    : `The forecast scored ${c.acc}% on recent unseen data, so it is not noise. When a tested model contradicts the chart, waiting for them to agree is usually the better trade.`);
  lines.push('If you take the setup below anyway, use the stop-loss exactly as written and size it small.');
  return `\n${lines.join(' ')}\n`;
}

function reasonsBlock(sig, n = 4) {
  const b = sig.reasons.bullish.slice(0, n).map((r) => `- ✅ ${r}`);
  const s = sig.reasons.bearish.slice(0, n).map((r) => `- ⚠️ ${r}`);
  return `\n**Why**\n${[...b, ...s].join('\n')}\n`;
}

function sentimentLine(ctx) {
  if (!ctx.fearGreed) return '';
  const v = ctx.fearGreed.value;
  const note = v <= 25 ? 'extreme fear often marks good long-term accumulation zones, but trends can keep falling'
    : v >= 75 ? 'extreme greed often precedes pullbacks — be careful chasing'
    : 'sentiment is not at an extreme';
  return `\n**Market sentiment:** Fear & Greed ${v} (${ctx.fearGreed.classification}) — ${note}.\n`;
}

export function ruleBasedAnswer(question, ctx = {}) {
  let intent = detectIntent(question);
  // A market-wide question that arrived with one coin's analysis and no scan
  // (the page decided a coin was named) is answered about that coin, instead of
  // "ask again in a moment" — asking again gave the same non-answer.
  if (intent === 'market' && !ctx.marketFrames && !ctx.market && ctx.signal) intent = 'summary';
  const sig = ctx.signal;
  const out = [];

  if (intent === 'compare') {
    if (!ctx.compare?.length) {
      return `I need to pull each coin's chart to compare them — ask again in a moment.\n\n${DISCLAIMER}`;
    }
    out.push(compareBlock(ctx.compare, ctx.compareInterval || ctx.interval || '4h', ctx.horizonText || 'the next few days'));
    out.push(sentimentLine(ctx));
    out.push(DISCLAIMER);
    return out.filter((l) => l !== '').join('\n');
  }

  if (intent === 'market') {
    if (ctx.marketFrames) {
      out.push(marketMultiBlock(ctx.marketFrames));
      if (ctx.portfolio?.length) {
        out.push(`\n**You already hold:** ${ctx.portfolio.map((h) => `${h.symbol} (${pct(h.pnlPct)})`).join(', ')}. Ask "review my portfolio" for what to do with those.`);
      }
      out.push(sentimentLine(ctx));
      out.push(DISCLAIMER);
      return out.filter((l) => l !== '').join('\n');
    }
    if (!ctx.market) {
      return `I need to scan the market to answer that — ask again in a moment, or open the **Market scan** page for the ranked list.\n\n${DISCLAIMER}`;
    }
    out.push(marketBlock(ctx.market));
    if (ctx.portfolio?.length) {
      out.push(`\n**You already hold:** ${ctx.portfolio.map((h) => `${h.symbol} (${pct(h.pnlPct)})`).join(', ')}. Ask "review my portfolio" for what to do with those.`);
    }
    out.push(sentimentLine(ctx));
    out.push(DISCLAIMER);
    return out.filter((l) => l !== '').join('\n');
  }

  if (intent === 'portfolio') {
    const p = ctx.portfolio || [];
    if (!p.length) return `You haven't added any holdings yet. Open **Wallet** and add coins with the amount and your average buy price — I'll then flag which ones to hold, trim or exit.\n\n${DISCLAIMER}`;
    const total = p.reduce((s, h) => s + (h.value || 0), 0);
    out.push(`**Portfolio review** · total value ${fmtNum(total)} ${fx.code}\n`);
    for (const h of p) {
      const share = total ? ((h.value / total) * 100).toFixed(1) : '0';
      out.push(`- **${h.symbol}** — ${share}% of portfolio, P&L ${pct(h.pnlPct)}${h.advice ? ` → ${h.advice}` : ''}`);
    }
    const biggest = [...p].sort((a, b) => (b.value || 0) - (a.value || 0))[0];
    if (biggest && total && biggest.value / total > 0.6) {
      out.push(`\n⚠️ **Concentration risk:** ${biggest.symbol} is over 60% of your portfolio. Consider rebalancing so one coin can't wipe out most of your gains.`);
    }
    out.push(`\n${DISCLAIMER}`);
    return out.join('\n');
  }

  if (!sig?.ok && (ctx.marketFrames || ctx.market)) {
    const body = ctx.marketFrames ? marketMultiBlock(ctx.marketFrames) : marketBlock(ctx.market);
    return `${body}${sentimentLine(ctx)}\n${DISCLAIMER}`;
  }

  if (!sig?.ok) {
    return `Open a coin (for example **Bitcoin**) so I can read its chart, then ask me again. I can explain the signal, suggest entry and exit levels, size a position, or review your portfolio.\n\n${DISCLAIMER}`;
  }

  out.push(header(ctx));
  out.push('');

  switch (intent) {
    case 'forecast': {
      if (ctx.forecast) {
        out.push(forecastBlock(ctx.forecast, ctx));
        out.push(timingBlock(ctx));
        out.push(historyBlock(ctx.history));
        out.push(newsBlock(ctx));
        out.push(signalLine(sig, ctx.interval));
        out.push(`\nThe forecast blends 7 models — chart pattern matching against history, similar past moves, gradient-boosted trees, a neural network, logistic regression, nearest neighbours and a trend model — each weighted by how accurate it was on recent data it never saw. Treat it as a probability, not a promise, and combine it with the stop-loss levels below.`);
        out.push(`\n**Key levels:** resistance ${sig.levels.resistances.slice(0, 2).map(fmtNum).join(' / ') || '—'} · support ${sig.levels.supports.slice(0, 2).map(fmtNum).join(' / ') || '—'}`);
      } else {
        out.push('The AI forecast is still computing for this chart — ask again in a moment. Meanwhile, the technical signal:');
        out.push(signalLine(sig, ctx.interval));
        out.push(reasonsBlock(sig, 3));
      }
      break;
    }
    case 'entry': {
      out.push(signalLine(sig, ctx.interval));
      const conflict = conflictBlock(ctx);
      out.push(conflict);
      if (sig.plan?.side === 'long') {
        out.push(conflict
          ? `\nThe chart structure marks out an entry zone here, but the forecast disagrees — read the warning above.`
          : `\nThe chart structure marks out an entry zone, a stop and targets, set out below. That is geometry, not a recommendation: on the measured record a reading like this was not more likely than chance to be followed by a rise. If you trade it, the levels are where the structure sits.`);
        out.push(planBlock(sig.plan));
      } else if (sig.plan?.side === 'short') {
        out.push(`\nThe indicators are leaning down here, so the structure offers no upside entry — only levels to watch. Note that a low reading has not been a reliable sell signal either; both directions were tested and neither paid after costs.`);
        if (sig.waitFor?.length || sig.levels.supports.length) {
          out.push(`\nWatch for a reversal near support ${sig.levels.supports.slice(0, 2).map(fmtNum).join(' / ') || '—'} with RSI turning up and a MACD bullish crossover.`);
        }
      } else {
        out.push(`\n**No clear edge right now** — the market is mixed. Wait for one of these triggers:`);
        out.push(sig.waitFor.map((w) => `- ${w}`).join('\n'));
      }
      out.push(reasonsBlock(sig, 3));
      out.push(mtfBlock(ctx));
      if (ctx.forecast) out.push(`**AI forecast:** ${ctx.forecast.probUpPct}% chance up over the next ${ctx.horizonText || ctx.forecast.horizonBars + ' candles'} (confidence ${ctx.forecast.confidence}).`);
      break;
    }
    case 'exit': {
      out.push(signalLine(sig, ctx.interval));
      out.push(conflictBlock(ctx));
      if (sig.score <= -18) {
        out.push(`\nMomentum has turned against longs. If you hold ${ctx.coin?.symbol || 'this coin'}, **consider closing or reducing** the position, or at least tighten your stop.`);
      } else if ((sig.indicators.rsi ?? 50) > 72) {
        out.push(`\nThe trend is still up but RSI is overbought (${sig.indicators.rsi?.toFixed(0)}). A common approach is to **take partial profit** and trail the stop on the rest.`);
      } else {
        out.push(`\nNo exit signal yet — the structure still holds. Keep a stop in place.`);
      }
      out.push(timingBlock(ctx));
      const res = sig.levels.resistances.slice(0, 3).map(fmtNum).join(' / ');
      const sup = sig.levels.supports.slice(0, 2).map(fmtNum).join(' / ');
      out.push(`\n**Exit plan**\n- Take-profit targets (resistance): ${res || '—'}\n- Protective stop: below ${sup ? sup.split(' / ')[0] : fmtNum(sig.price - 1.5 * (sig.indicators.atr || 0))}${sig.indicators.ema50 ? `\n- Trend exit: daily close below the 50 EMA (${fmtNum(sig.indicators.ema50)})` : ''}`);
      if (sig.plan?.exitRules?.length) out.push(sig.plan.exitRules.map((r) => `- ${r}`).join('\n'));
      break;
    }
    case 'risk': {
      const account = parseAccount(question);
      const plan = sig.plan;
      const atrV = sig.indicators.atr || sig.price * 0.02;
      const sup = sig.levels.supports[0];
      let longStop = sig.price - 1.5 * atrV;
      if (sup && sig.price - (sup - 0.25 * atrV) <= 3 * atrV) longStop = Math.min(longStop, sup - 0.25 * atrV);
      if (plan?.side === 'long') longStop = plan.stopLoss;
      const stopDistPct = Math.max(0.2, +(((sig.price - longStop) / sig.price) * 100).toFixed(2));
      out.push(`**Position sizing** — risk a fixed 1–2% of your account per trade, not a fixed amount of coins.`);
      out.push(`\n- Suggested stop-loss for a buy: **${fmtNum(longStop)}** (${stopDistPct}% below price${plan?.side === 'long' ? ', from the trade plan' : ', 1.5× ATR / below support'})`);
      if (plan?.side === 'long') out.push(`- Take-profit targets: ${plan.takeProfits.map(fmtNum).join(' / ')}`);
      if (plan?.side === 'short') out.push(`- ⚠️ The current signal is **bearish** — waiting for a better entry is usually wiser than buying now.`);
      out.push(`\nFormula: *position size = (account × risk %) ÷ stop distance %*`);
      if (account) {
        const r1 = account * 0.01, r2 = account * 0.02;
        const p1 = Math.min(account, r1 / (stopDistPct / 100)), p2 = Math.min(account, r2 / (stopDistPct / 100));
        out.push(`\nFor a **$${money(account)}** account:\n- Careful (1% risk = $${money(r1)}): buy ≈ **$${money(p1)}** of ${ctx.coin?.symbol || 'the coin'} (≈ ${fmtNum(p1 / sig.price)} ${ctx.coin?.symbol || ''})\n- Aggressive (2% risk = $${money(r2)}): buy ≈ **$${money(p2)}** (≈ ${fmtNum(p2 / sig.price)} ${ctx.coin?.symbol || ''})`);
        out.push(`\nIf the stop is hit you lose about $${money(r1)}–$${money(r2)}, not your whole account. No leverage.`);
      } else {
        out.push(`\nTell me your account size (e.g. "I have $1,000") and I'll calculate the exact amount.`);
      }
      out.push(`\nVolatility (ATR) is ${sig.indicators.atrPct}% per candle — ${sig.indicators.atrPct > 4 ? 'high, so size smaller' : 'moderate'}.`);
      break;
    }
    case 'levels': {
      out.push(`**Key levels**\n- Resistance: ${sig.levels.resistances.map(fmtNum).join(' / ') || '—'}\n- Support: ${sig.levels.supports.map(fmtNum).join(' / ') || '—'}`);
      out.push(`\nLevels come from repeated swing highs and lows. A clean close through a level with above-average volume is more meaningful than a wick.`);
      break;
    }
    case 'indicators': {
      const i = sig.indicators;
      out.push(`**Indicator readout**\n- RSI(14): ${i.rsi?.toFixed(1) ?? '—'} ${i.rsi > 70 ? '(overbought)' : i.rsi < 30 ? '(oversold)' : ''}\n- MACD: ${i.macd?.toPrecision(4) ?? '—'} vs signal ${i.macdSignal?.toPrecision(4) ?? '—'} (histogram ${i.macdHist > 0 ? 'positive' : 'negative'})\n- EMA 20 / 50 / 200: ${fmtNum(i.ema20)} / ${fmtNum(i.ema50)} / ${fmtNum(i.ema200)}\n- Bollinger: ${fmtNum(i.bbLower)} – ${fmtNum(i.bbUpper)}\n- ADX: ${i.adx?.toFixed(0) ?? '—'} ${i.adx > 25 ? '(trending)' : '(ranging)'}\n- ATR: ${fmtNum(i.atr)} (${i.atrPct}%)\n- Volume vs 20-bar avg: ${i.volumeRatio ?? '—'}×${i.supertrendDir ? `\n- Supertrend: ${i.supertrendDir === 1 ? 'up' : 'down'} (flips at ${fmtNum(i.supertrend)})` : ''}${i.mfi !== null && i.mfi !== undefined ? `\n- Money Flow Index: ${i.mfi.toFixed(0)} ${i.mfi > 80 ? '(heavy buying)' : i.mfi < 20 ? '(heavy selling)' : ''}` : ''}${i.cci !== null && i.cci !== undefined ? `\n- CCI(20): ${i.cci.toFixed(0)} ${i.cci > 100 ? '(stretched up)' : i.cci < -100 ? '(stretched down)' : ''}` : ''}${i.willR !== null && i.willR !== undefined ? `\n- Williams %R: ${i.willR.toFixed(0)} ${i.willR > -20 ? '(near the top of its range)' : i.willR < -80 ? '(near the bottom of its range)' : ''}` : ''}${i.donchianHigh ? `\n- 20-bar breakout levels: ${fmtNum(i.donchianLow)} – ${fmtNum(i.donchianHigh)}` : ''}`);
      out.push('These readings describe the chart; none of them was measured to predict the next move on its own.');
      out.push(reasonsBlock(sig, 5));
      break;
    }
    case 'backtest': {
      const b = ctx.backtest;
      // The honest headline answer to "is this any good" is the walk-forward
      // measurement and the baseline it has to beat, not this one chart's
      // backtest. Lead with it, and say plainly when there is no edge.
      const a = ctx.interval ? accuracyFor(ctx.interval) : null;
      if (a) {
        out.push(`**Measured forecast accuracy on ${ctx.interval} charts: ${a.accuracyPct}%**, against ${a.baselinePct}% for always calling the more common direction over the same tests — ${a.beatsBaseline ? `an edge of ${a.edgePts} points` : `${Math.abs(a.edgePts)} points **worse** than that baseline, so it has no measured edge here`}.`);
      }
      out.push(`Across every timeframe tested the engine scored ${TESTED_ACCURACY.all}% against a ${TESTED_ACCURACY.allBaseline}% baseline, so overall it does **not** beat simply calling the more common direction. It is listed as having no edge on ${(TESTED_ACCURACY.noEdge || []).join(', ')}. ${TESTED_ACCURACY.caveat}`);
      if (!b?.ok) { out.push('\nNo backtest of the chart rules is available for this chart yet.'); break; }
      out.push(`**Backtest of these signal rules on this chart** (long-only, 0.1% fees)\n- Trades: ${b.tradeCount}\n- Win rate: ${b.winRate ?? '—'}%\n- Strategy return: ${pct(b.totalReturnPct)} vs buy & hold ${pct(b.buyHoldPct)}\n- Max drawdown: ${b.maxDrawdownPct}%\n- Profit factor: ${b.profitFactor ?? '—'}`);
      out.push(`\n${b.totalReturnPct > b.buyHoldPct ? 'The rules beat buy & hold on this sample.' : 'Buy & hold did better on this sample — treat signals as timing help, not a guarantee.'} Past results on one coin and timeframe don't predict future performance; test several before trusting them.`);
      break;
    }
    default: {
      out.push(signalLine(sig, ctx.interval));
      out.push(conflictBlock(ctx));
      const bias = sig.score >= 18 ? 'leaning up' : sig.score <= -18 ? 'leaning down' : 'range-bound / undecided';
      out.push(`\nOverall the indicators are **${bias}** — a description of where price sits, not a forecast of where it goes next.`);
      out.push(reasonsBlock(sig, 4));
      out.push(mtfBlock(ctx));
      if (ctx.forecast) out.push(forecastBlock(ctx.forecast, ctx));
      out.push(timingBlock(ctx));
      out.push(historyBlock(ctx.history));
      out.push(newsBlock(ctx));
      out.push(planBlock(sig.plan));
      if (!sig.plan && sig.waitFor.length) out.push(`**What to wait for**\n${sig.waitFor.map((w) => `- ${w}`).join('\n')}`);
      out.push(`\n**Key levels:** resistance ${sig.levels.resistances.slice(0, 2).map(fmtNum).join(' / ') || '—'} · support ${sig.levels.supports.slice(0, 2).map(fmtNum).join(' / ') || '—'}`);
    }
  }
  out.push(sentimentLine(ctx));
  out.push(DISCLAIMER);
  return out.filter((l) => l !== '').join('\n');
}

// System prompt for the built-in LLM. Small local models are accurate when
// they rephrase verified facts, so the prompt pins them to the supplied data.
export const AI_SYSTEM_PROMPT = `You are CoinVantage AI, a crypto market analyst inside a market-data website.
Answer the user's question using ONLY the FACTS and DATA provided in their message. They come from live exchange data, technical indicators, a backtested signal engine and a machine-learning forecast that was validated on unseen data.
Rules:
- Never invent prices, percentages or dates. Copy numbers exactly from the facts.
- Be direct: say whether the data leans up, down or sideways, give entry / stop-loss / take-profit levels when relevant, and mention the forecast's measured accuracy so the user knows how reliable it is.
- When marketByTimeframe or marketPicks is present the user asked about the WHOLE market, not one coin. Cover every timeframe you were given (short term, swing, position) and, under each, list the ranked coins with their buy zone, stop-loss, sell targets and how long the move is expected to last. Then name the coins that read as a buy on more than one timeframe, and the ones to avoid or sell. Never narrow a whole-market question down to a single coin.
- If the FACTS contain a line saying the two readings disagree, that warning must appear in your first two sentences and your verdict must be cautious. Never present a confident buy or sell when the chart signal and the forecast point opposite ways.
- When a comparison block is present the user asked to compare named coins: keep every coin in the answer, rank them on the conviction given, and if the top two are within 10 points say they are too close to call rather than picking one.
- recentHeadlines is background only. You may mention a headline, but never say it changed the forecast — the model reads price data, not news.
- When moveTiming is present, say how long the move is expected to last and roughly when it turns — that is usually what the user actually wants to know. Never state timing as a certainty.
- When multiYearHistory is present, use it: it says how this coin behaved the last times its chart looked like today (over years of daily data), what the median move afterwards was, and how often that comparison was right on this coin. Quote those numbers, and say plainly when the method's accuracy is near 50% that it is weak evidence.
- Keep it short: a one-line verdict, then 3-6 bullet points. Use **bold** for the verdict.
- The website only shows signals; it cannot place trades or bets. Recommend risking at most 1-2% of the account per trade and always using a stop-loss.
- End with: "Not financial advice."`;
