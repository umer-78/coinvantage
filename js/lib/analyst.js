// Rule-based analyst. Produces a markdown answer from the same context that
// is sent to the language model, so the assistant works even without an API key.

import { fmtNum } from './signals.js';

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

function detectIntent(q) {
  const s = (q || '').toLowerCase();
  if (/(portfolio|wallet|holding|my coins|my bag)/.test(s)) return 'portfolio';
  if (/(predict|forecast|future|will (it|the price|price|this)|go(ing)? (up|down)|next (hour|day|week|month)|tomorrow|pump|dump|target price|where .* (head|go)|up or down)/.test(s)) return 'forecast';
  if (/(backtest|win ?rate|accura|reliab|track record|history of signal)/.test(s)) return 'backtest';
  if (/(position size|how much|\bsize\b|invest|risk|lot size|allocation|\$\s?\d|\d+\s?k?\s?(usd|usdt|dollars?|bucks))/.test(s)) return 'risk';
  if (/(exit|close|sell|take profit|tp\b|stop|get out)/.test(s)) return 'exit';
  if (/(entry|enter|buy|long|get in|good time|should i)/.test(s)) return 'entry';
  if (/(support|resistance|level)/.test(s)) return 'levels';
  if (/(indicator|rsi|macd|ema|bollinger|adx|stoch)/.test(s)) return 'indicators';
  return 'summary';
}

function header(ctx) {
  const c = ctx.coin;
  if (!c) return '';
  return `**${c.name} (${c.symbol})** · ${fmtNum(c.price)} USD · 24h ${pct(c.change24h)}${ctx.interval ? ` · ${ctx.interval} chart` : ''}`;
}

function signalLine(sig) {
  return `**Signal: ${sig.text}** (score ${sig.score > 0 ? '+' : ''}${sig.score}/100)`;
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
  const intent = detectIntent(question);
  const sig = ctx.signal;
  const out = [];

  if (intent === 'portfolio') {
    const p = ctx.portfolio || [];
    if (!p.length) return `You haven't added any holdings yet. Open **Wallet** and add coins with the amount and your average buy price — I'll then flag which ones to hold, trim or exit.\n\n${DISCLAIMER}`;
    const total = p.reduce((s, h) => s + (h.value || 0), 0);
    out.push(`**Portfolio review** · total value ${fmtNum(total)} USD\n`);
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

  if (!sig?.ok) {
    return `Open a coin (for example **Bitcoin**) so I can read its chart, then ask me again. I can explain the signal, suggest entry and exit levels, size a position, or review your portfolio.\n\n${DISCLAIMER}`;
  }

  out.push(header(ctx));
  out.push('');

  switch (intent) {
    case 'forecast': {
      if (ctx.forecast) {
        out.push(forecastBlock(ctx.forecast, ctx));
        out.push(historyBlock(ctx.history));
        out.push(signalLine(sig));
        out.push(`\nThe forecast blends 7 models — chart pattern matching against history, similar past moves, gradient-boosted trees, a neural network, logistic regression, nearest neighbours and a trend model — each weighted by how accurate it was on recent data it never saw. Treat it as a probability, not a promise, and combine it with the stop-loss levels below.`);
        out.push(`\n**Key levels:** resistance ${sig.levels.resistances.slice(0, 2).map(fmtNum).join(' / ') || '—'} · support ${sig.levels.supports.slice(0, 2).map(fmtNum).join(' / ') || '—'}`);
      } else {
        out.push('The AI forecast is still computing for this chart — ask again in a moment. Meanwhile, the technical signal:');
        out.push(signalLine(sig));
        out.push(reasonsBlock(sig, 3));
      }
      break;
    }
    case 'entry': {
      out.push(signalLine(sig));
      if (sig.plan?.side === 'long') {
        out.push(`\nConditions currently favour a **long entry**. Prefer entering inside the zone rather than chasing green candles.`);
        out.push(planBlock(sig.plan));
      } else if (sig.plan?.side === 'short') {
        out.push(`\n**Not a good time to buy.** The setup is bearish — waiting usually beats catching a falling knife.`);
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
      out.push(signalLine(sig));
      if (sig.score <= -18) {
        out.push(`\nMomentum has turned against longs. If you hold ${ctx.coin?.symbol || 'this coin'}, **consider closing or reducing** the position, or at least tighten your stop.`);
      } else if ((sig.indicators.rsi ?? 50) > 72) {
        out.push(`\nThe trend is still up but RSI is overbought (${sig.indicators.rsi?.toFixed(0)}). A common approach is to **take partial profit** and trail the stop on the rest.`);
      } else {
        out.push(`\nNo exit signal yet — the structure still holds. Keep a stop in place.`);
      }
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
      out.push(`**Indicator readout**\n- RSI(14): ${i.rsi?.toFixed(1) ?? '—'} ${i.rsi > 70 ? '(overbought)' : i.rsi < 30 ? '(oversold)' : ''}\n- MACD: ${i.macd?.toPrecision(4) ?? '—'} vs signal ${i.macdSignal?.toPrecision(4) ?? '—'} (histogram ${i.macdHist > 0 ? 'positive' : 'negative'})\n- EMA 20 / 50 / 200: ${fmtNum(i.ema20)} / ${fmtNum(i.ema50)} / ${fmtNum(i.ema200)}\n- Bollinger: ${fmtNum(i.bbLower)} – ${fmtNum(i.bbUpper)}\n- ADX: ${i.adx?.toFixed(0) ?? '—'} ${i.adx > 25 ? '(trending)' : '(ranging)'}\n- ATR: ${fmtNum(i.atr)} (${i.atrPct}%)\n- Volume vs 20-bar avg: ${i.volumeRatio ?? '—'}×`);
      out.push(reasonsBlock(sig, 5));
      break;
    }
    case 'backtest': {
      const b = ctx.backtest;
      if (!b?.ok) { out.push('No backtest available for this chart yet.'); break; }
      out.push(`**Backtest of these signal rules on this chart** (long-only, 0.1% fees)\n- Trades: ${b.tradeCount}\n- Win rate: ${b.winRate ?? '—'}%\n- Strategy return: ${pct(b.totalReturnPct)} vs buy & hold ${pct(b.buyHoldPct)}\n- Max drawdown: ${b.maxDrawdownPct}%\n- Profit factor: ${b.profitFactor ?? '—'}`);
      out.push(`\n${b.totalReturnPct > b.buyHoldPct ? 'The rules beat buy & hold on this sample.' : 'Buy & hold did better on this sample — treat signals as timing help, not a guarantee.'} Past results on one coin and timeframe don't predict future performance; test several before trusting them.`);
      break;
    }
    default: {
      out.push(signalLine(sig));
      const bias = sig.score >= 18 ? 'bullish' : sig.score <= -18 ? 'bearish' : 'range-bound / undecided';
      out.push(`\nOverall the chart is **${bias}**.`);
      out.push(reasonsBlock(sig, 4));
      out.push(mtfBlock(ctx));
      if (ctx.forecast) out.push(forecastBlock(ctx.forecast, ctx));
      out.push(historyBlock(ctx.history));
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
- When multiYearHistory is present, use it: it says how this coin behaved the last times its chart looked like today (over years of daily data), what the median move afterwards was, and how often that comparison was right on this coin. Quote those numbers, and say plainly when the method's accuracy is near 50% that it is weak evidence.
- Keep it short: a one-line verdict, then 3-6 bullet points. Use **bold** for the verdict.
- The website only shows signals; it cannot place trades or bets. Recommend risking at most 1-2% of the account per trade and always using a stop-loss.
- End with: "Not financial advice."`;
