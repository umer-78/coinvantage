// Answers to questions that are not about a chart: greetings, "what is RSI?",
// "how does the forecast work?", "is this coin a scam?". These used to fall
// through to the chart reading for whichever coin was in focus, so "hello" got
// a page of Bitcoin indicators and "what is RSI?" got today's RSI value with no
// explanation. Each definition says how CoinVantage itself uses the term.

import { TESTED_ACCURACY } from './predict.js';
import { SCORE_BUCKETS_TESTED } from './signals.js';

const DISCLAIMER = '_Not financial advice. Always use a stop-loss and only risk what you can afford to lose._';

// Order matters only for display; matching runs over every entry.
export const GLOSSARY = [
  { id: 'rsi', title: 'RSI (Relative Strength Index)', re: /\b(rsi|relative strength)\b/i,
    text: 'Compares the size of recent up-moves with recent down-moves over 14 candles, on a 0–100 scale. Above 70 is called overbought and below 30 oversold — that says a move is stretched, not that it must turn: in a strong trend RSI can stay above 70 for weeks.' },
  { id: 'stochrsi', title: 'Stochastic RSI', re: /\bstoch(astic)?( ?rsi)?\b/i,
    text: 'Shows where RSI sits within its own range of the last 14 candles, from 0 to 100. It turns faster than RSI, so it gives earlier but noisier readings.' },
  { id: 'macd', title: 'MACD', re: /\bmacd\b/i,
    text: 'The gap between a fast (12-candle) and a slow (26-candle) exponential moving average, with a 9-candle signal line. MACD crossing above its signal line means momentum is turning up; crossing below, turning down. The histogram is the distance between the two.' },
  { id: 'ema', title: 'EMA (exponential moving average)', re: /\b(ema|sma|moving averages?|golden cross|death cross)\b/i,
    text: 'An average of recent closing prices that gives more weight to the newest candles. CoinVantage uses the 20, 50 and 200 EMA: price above the 200 EMA is the usual definition of a long-term uptrend, and the 50 crossing above the 200 is the "golden cross" (below it, the "death cross").' },
  { id: 'bollinger', title: 'Bollinger Bands', re: /\bbollinger\b/i,
    text: 'A 20-candle average with bands two standard deviations above and below it. Price at the upper band is stretched up, at the lower band stretched down. Bands squeezing together mean volatility is unusually low, which often comes before a larger move in either direction.' },
  { id: 'atr', title: 'ATR (Average True Range)', re: /\b(atr|average true range)\b/i,
    text: 'The average size of one candle\'s full move over the last 14 candles, gaps included. CoinVantage spaces stop-losses with it: a stop closer than about one ATR tends to be hit by ordinary noise.' },
  { id: 'volatility', title: 'Volatility', re: /\b(volatil(e|ity)|fluctuat(e|es|ion|ions|ing)|price swings?)\b/i,
    text: 'How far and how fast a price swings. Crypto is far more volatile than shares — daily moves of 5–10% are common for smaller coins. CoinVantage measures it with ATR and the forecast\'s 50% and 80% ranges, and spaces stop-losses wider on more volatile charts so normal swings don\'t trigger them.' },
  { id: 'adx', title: 'ADX (Average Directional Index)', re: /\b(adx|directional (index|movement))\b|[+−-]di\b/i,
    text: 'Trend strength from 0 to 100 over 14 candles, whatever the direction. Under 20 the market is ranging; above 25 it is trending. +DI above −DI says the trend is up, −DI above +DI says down.' },
  { id: 'supertrend', title: 'Supertrend', re: /\bsuper ?trend\b/i,
    text: 'A line set three ATRs (10-candle) away from price that sits below price in an uptrend and above it in a downtrend. When price closes through it the line flips sides, so its level is often used as a trailing stop.' },
  { id: 'mfi', title: 'Money Flow Index', re: /\b(mfi|money flow)\b/i,
    text: 'RSI weighted by volume, over 14 candles. Above 80 means heavy buying, below 20 heavy selling.' },
  { id: 'cci', title: 'CCI (Commodity Channel Index)', re: /\b(cci|commodity channel)\b/i,
    text: 'How far price is from its 20-candle average, measured in typical deviations. Above +100 is stretched up, below −100 stretched down.' },
  { id: 'willr', title: 'Williams %R', re: /\bwilliams\b|%r\b/i,
    text: 'Where the close sits within the high–low range of the last 14 candles, from 0 (at the top) to −100 (at the bottom).' },
  { id: 'donchian', title: 'Donchian channel', re: /\b(donchian|breakout levels?)\b/i,
    text: 'The highest high and lowest low of the last 20 candles. A close above the top or below the bottom is a breakout.' },
  { id: 'levels', title: 'Support and resistance', re: /\b(support|resistance)\b/i,
    text: 'Support is a price area where falls have repeatedly stopped; resistance is where rises have stopped. CoinVantage finds them from swing highs and lows in the last 300 candles. Treat them as zones rather than exact prices — and a level that breaks often swaps roles.' },
  { id: 'stop', title: 'Stop-loss', re: /\b(stop[- ]?loss(es)?|stops?)\b/i,
    text: 'A price at which you sell to cap the loss if the trade goes wrong. Put it where the trade idea is proven wrong — trade plans here use a multiple of ATR or just beyond the nearest support — then size the position so that being stopped out costs only 1–2% of your account.' },
  { id: 'tp', title: 'Take-profit', re: /\b(take[- ]?profits?|tp ?[123]?|profit targets?)\b/i,
    text: 'A price at which you sell some or all of a position to lock in a gain. Trade plans here give up to three targets; a common approach is to sell part at the first and move the stop to the entry price, so the rest can no longer lose money.' },
  { id: 'r', title: 'R and risk : reward', re: /\b(r[- ]?multiples?|risk[ /:-]*(to[ -])?reward|reward[ /:-]*(to[ -])?risk|\d(\.\d)?r\b|what is (an? )?r\b)/i,
    text: 'R is the amount a trade risks: the distance from entry to stop-loss. A trade that gained 2R made twice what it risked; one stopped out lost 1R. Risk : reward compares the stop distance with the target distance — 1 : 2 means the target is twice as far away as the stop.' },
  { id: 'size', title: 'Position size', re: /\bposition siz(e|ing)\b/i,
    text: 'How much to buy so that hitting the stop-loss costs a fixed share of your account: size = (account × risk %) ÷ stop distance %. With $1,000, 1% risk and a stop 5% away, that is $200 of the coin. The Tools page has the calculator.' },
  { id: 'drawdown', title: 'Drawdown', re: /\b(max(imum)? )?draw ?downs?\b/i,
    text: 'The fall from an account\'s (or price\'s) highest point to the lowest point after it, in percent. Maximum drawdown is the worst such fall over a period — a measure of how painful a strategy was to hold.' },
  { id: 'winrate', title: 'Win rate and profit factor', re: /\b(win ?rate|profit factor|hit rate)\b/i,
    text: 'Win rate is the share of trades that made money; on its own it says little, because a 35% win rate is profitable when winners are three times the size of losers. Profit factor is gross profit ÷ gross loss: above 1 the strategy made money.' },
  { id: 'funding', title: 'Funding rate', re: /\bfunding( rates?)?\b/i,
    text: 'On perpetual futures, longs and shorts pay each other every few hours (usually 8) to keep the contract near the spot price. Positive funding means longs pay shorts, so the crowd leans long; unusually high funding often comes before a sharp shake-out. The Futures page shows it per coin.' },
  { id: 'oi', title: 'Open interest', re: /\bopen interest\b|\boi\b/i,
    text: 'The total value of futures contracts still open. Rising open interest with a rising price means new money is entering; falling open interest means positions are being closed. Shown on the Futures page.' },
  { id: 'liquidation', title: 'Liquidation', re: /\bliquidat(ion|ions|ed|e)\b|\bliqs?\b/i,
    text: 'When a leveraged position\'s losses use up its margin, the exchange closes it by force. Waves of liquidations push price further in the same direction for a short time. The Futures page streams them live.' },
  { id: 'leverage', title: 'Leverage, long and short', re: /\b(leverage|margin trading|shorting|going (long|short)|(longs?|shorts?)(?![- ]?(term|run)))\b/i,
    text: 'A long profits if the price rises; a short profits if it falls. Leverage borrows to make a position bigger than your money: at 10× a 10% move against you wipes the position out. The trade plans here assume no leverage.' },
  { id: 'dca', title: 'DCA (dollar-cost averaging)', re: /\b(dca|dollar[- ]cost averag(e|ing))\b/i,
    text: 'Buying a fixed amount on a schedule — say $50 a week — whatever the price, so you never have to time the market. The Tools page shows what regular buying would have done on past prices.' },
  { id: 'mcap', title: 'Market cap', re: /\b(market ?cap(italization|italisation)?|mcap)\b/i,
    text: 'Price × the number of coins in circulation. It ranks coins by size. A low price per coin does not make a coin cheap — a $0.01 coin with 100 billion coins in circulation is worth more than a $100 coin with 5 million.' },
  { id: 'volume', title: 'Volume', re: /\bvolumes?\b/i,
    text: 'The value traded in a period. Moves on high volume are more trustworthy than moves on thin volume; the indicator readout compares the latest candle\'s volume with its 20-candle average.' },
  { id: 'fng', title: 'Fear & Greed index', re: /\bfear (and|&) greed\b|\bfear ?greed\b/i,
    text: 'A 0–100 gauge of crypto market mood published by alternative.me, built from volatility, momentum and volume, social media and Bitcoin\'s share of the market. Extremes are contrarian context — extreme greed has often come before pullbacks and extreme fear before bounces — but not reliably enough to trade on alone.' },
  { id: 'score', title: 'Chart score (indicator agreement)', re: /\b(indicator agreement|chart score|signal score|the score|score)\b/i,
    text: `A number from −100 to +100 that adds up how far the indicators on one chart lean up or down. It describes where price sits, not where it goes next: across ${SCORE_BUCKETS_TESTED.bars.toLocaleString('en-US')} tested candles on ${SCORE_BUCKETS_TESTED.coins} coins, high readings were not followed by more rises than low ones. That is why the verdict weights every reading by how accurate it has actually been.` },
  { id: 'verdict', title: 'Verdict and conviction', re: /\b(verdict|conviction|accumulate|no edge)\b/i,
    text: 'The verdict (BUY, ACCUMULATE, WAIT or AVOID; for coins you hold, ADD, HOLD, TRIM or SELL) combines the chart, the forecast and history, each weighted by its measured accuracy. Conviction (0–100) is how strongly they agree after that weighting. A reading with no proven edge counts for nothing, so WAIT is the most common answer — and a fair one.' },
  { id: 'forecastterms', title: 'Backtest, walk-forward and baseline', re: /\b(backtests?|backtesting|walk[- ]forward|baseline|out[- ]of[- ]sample|unseen data|overfit(ting)?)\b/i,
    text: 'A backtest replays a rule on past prices. The forecast here is tested walk-forward: trained only on data from before each test point, then scored on what happened next. The baseline is always calling the more common direction — a forecast that cannot beat it has no edge, however good its accuracy sounds.' },
  { id: 'candle', title: 'Candles and timeframes', re: /\b(candles?(sticks?)?|time ?frames?|interval)\b/i,
    text: 'Each candle shows the open, high, low and close for one period — from 1 second to 1 week on the coin page. The timeframe changes the answer: a 15-minute chart can be falling inside a daily uptrend, which is why readings are shown on four timeframes.' },
  { id: 'spread', title: 'Fees, spread and slippage', re: /\b(spread|slippage|trading fees?|maker|taker)\b/i,
    text: 'The spread is the gap between the best buy and sell price; slippage is getting a worse price than expected on a fast market or a large order. Together with fees (about 0.1% a side on major exchanges) they are why very small moves cannot be traded at a profit.' },
  { id: 'orders', title: 'Market and limit orders', re: /\b(limit orders?|market orders?|stop[- ]limit|oco)\b/i,
    text: 'A market order fills immediately at the best price available; a limit order waits until the price reaches yours and may never fill. A stop order turns into a market order when its trigger price is hit — that is how a stop-loss is placed on an exchange.' },
  { id: 'stable', title: 'Stablecoin', re: /\bstable ?coins?\b/i,
    text: 'A token designed to stay worth $1, such as USDT or USDC. The scanner leaves them out because they barely move.' },
  { id: 'halving', title: 'Bitcoin halving', re: /\bhalving\b/i,
    text: 'Every 210,000 blocks — about four years — the reward for mining a Bitcoin block halves; the last halving was in April 2024. Past halvings were followed by bull markets, but four examples are far too few to treat that as a rule.' },
  { id: 'cycle', title: 'Bull and bear market', re: /\b(bull(ish)?|bear(ish)?) (market|run|trap)s?\b|\bbull run\b/i,
    text: 'A bull market is a long stretch of rising prices; a bear market a long fall, usually defined as 20% or more from the top. A bull or bear trap is a breakout that quickly reverses and catches traders on the wrong side.' },
  { id: 'altcoin', title: 'Altcoin', re: /\balt ?coins?\b|\balts\b/i,
    text: 'Any coin other than Bitcoin. Altcoins usually move more than Bitcoin in both directions and tend to fall harder when the whole market drops.' },
  { id: 'whale', title: 'Whale', re: /\bwhales?\b/i,
    text: 'An account holding enough of a coin that its trades can move the price. Large transfers to exchanges are watched because they can come before selling.' },
  { id: 'fomo', title: 'FOMO and FUD', re: /\b(fomo|fud)\b/i,
    text: 'FOMO (fear of missing out) is buying because price is already flying; FUD (fear, uncertainty and doubt) is selling on scary news. Both are emotions working against a plan — the stop-loss and position size are there so you decide before the trade, not during it.' },
  { id: 'demo', title: 'Demo (paper) trading', re: /\b(demo|paper)\s+trad(e|ing)\b|\bsimulated (money|trading)\b/i,
    text: 'Trading with simulated money at live prices. On the Trading page you can run a demo account yourself or let the AI trade one, with fees counted as if it were real, and see whether a strategy works before risking anything.' },
];

const DEFINE_CUE = /\b(what('?s| is| are| does| do)|explain|define|definition|meaning|means?|stands? for|tell me about|teach me|how (do(es)? (i|you)|to) (use|read|calculate)|difference between)\b/i;
// "What is BTC's RSI?" or "what's the RSI now" asks for today's reading, which
// the chart answer gives; only the bare term is a request for a definition.
const READING_CUE = /\b(current(ly)?|now|today|right now|this (coin|chart)|on (the|this|my) chart|reading|readings|value|levels)\b/i;

/** Glossary entries the question asks about, at most three. */
export function termsIn(q) {
  const s = String(q || '');
  return GLOSSARY.filter((g) => g.re.test(s)).slice(0, 3);
}

function definitionAnswer(q, { coinNamed }) {
  const s = String(q || '').trim();
  const terms = termsIn(s);
  if (!terms.length) return null;
  const bare = s.replace(/[?.!]+$/, '').trim();
  const justTheTerm = terms.some((g) => bare.replace(g.re, '').trim().length <= 3);
  if (!justTheTerm && !DEFINE_CUE.test(s)) return null;
  if (coinNamed || READING_CUE.test(s)) return null;
  // "what's the RSI" without "mean"/"indicator" is a request for the reading
  if (/\bwhat('?s| is| are) (the|its)\b/i.test(s) && !/\b(mean|meaning|indicator|index|difference|explain)\b/i.test(s)) return null;
  const body = terms.map((g) => `**${g.title}** — ${g.text}`).join('\n\n');
  return `${body}\n\nAsk me about a coin — for example *"What is ETH's RSI?"* — to see the current reading.`;
}

const GREETING = /^(hi+|hello+|hey+|hiya|yo|howdy|hola|salam|salaam|assalam[ou]? ?alaikum|as-?salamu alaykum|good (morning|afternoon|evening|day)|greetings|what'?s up|wassup|sup)\b/i;
const THANKS = /^(thanks?( you)?( so much| a lot)?|thank u|thx|ty|cheers|great|nice|cool|ok(ay)?|got it|perfect|awesome|appreciate it|understood)\b/i;
// Words that can follow a greeting without making it a question.
const FILLER = /^(there|all|guys|everyone|friend|buddy|bro|mate|bot|assistant|coin ?vantage|ai|again|sir|team|man)$/i;
const HELP = /^(help|menu|commands|start|\?)$|\bwhat (can|do) you (do|help with|answer|know)\b|\bwho (are|r) (you|u)\b|\bwhat (are|r) (you|u)\b|\bhow (do|can|should) i use (you|this|the assistant)\b|\bwhat (can|should) i ask\b/i;
const METHOD = /\bhow (does|do|is|are|did) (the |your |this |its |it'?s )?(forecast|prediction|predictions|model|models|ai|assistant|score|signals?|engine|analyst|verdict|scanner|scan|you|it)\b.*\b(work|works|calculated|computed|made|built|decided?|predict|forecast|know|trained|learn|chosen)\b|\bhow (do|does) (you|it|the ai|the model) (work|predict|decide|forecast|know|learn)\b|\bwhat (data|models?|sources?|indicators?) (do|does|did) (you|it|the forecast|the ai|the model|this site) use\b|\bwhere (does|do) (the |your )?(data|prices?|numbers?) come from\b|\b(are|r) (you|u) (chat ?gpt|gpt|claude|gemini|an? (ai|llm|bot|robot|human|person|real person))\b|\bwhich (ai|model|llm) (are you|is this|do you use)\b/i;
const LEGIT = /\b(scam|scams|scammy|legit|legitimate|rug ?pull(ed)?|rugged|ponzi|pyramid scheme|fraud(ulent)?|shady)\b|\bis (this|the) (site|app|website|platform|service) (safe|real|trustworthy|reliable)\b|\bis coin ?vantage (safe|real|trustworthy|reliable)\b|\bcan i trust (this site|this app|the site|the app|coin ?vantage|you)\b/i;
// "Is this breakout legit?" is about a chart, not about fraud.
const CHART_WORDS = /\b(breakout|signal|setup|pump|move|rally|bounce|trend|pattern|dip|drop|candle|reading|forecast|prediction)\b/i;
const THIS_COIN = /\b(this|that|the) (coin|token|project)\b/i;

const wordsOf = (t) => t.replace(/[^\p{L}\p{N}' ]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
// The text after a leading greeting or "thanks", or null when there was none.
function afterLead(re, q) {
  const m = re.exec(q);
  return m ? q.slice(m[0].length).replace(/^[\s,!.:;-]+/, '') : null;
}

function greetingAnswer(symbol) {
  const sym = symbol || 'BTC';
  return `Hi! I read live charts for any coin and tell you what the evidence says — and how reliable that evidence has been. Try:

- *Will ${sym} go up or down this week?* — forecast with its measured accuracy
- *When should I take profit on ${sym}?* — exit levels and a stop-loss
- *I have $1,000 — how much ${sym} should I buy?* — position size from the stop
- *Compare BTC, ETH and SOL* — side by side on the same test
- *What should I buy right now?* — scans the market on three timeframes
- *Review my portfolio* — hold, trim or exit for each coin you added in Wallet
- *What is RSI?* — plain-English explanations of trading terms

I can't place trades, and nothing here is financial advice.`;
}

function methodAnswer() {
  const t = TESTED_ACCURACY;
  return `**How the assistant answers**

1. **Live data** — candles from Binance (Gate.io, HTX or OKX for coins Binance doesn't list), coin list and market caps from CoinGecko, futures funding and open interest from Binance, Bybit or OKX, and the Fear & Greed index from alternative.me.
2. **Chart reading** — RSI, MACD, EMAs, Bollinger Bands, ADX, ATR, Supertrend and more on four timeframes, summed into a score from −100 to +100. Support and resistance come from recent swing highs and lows.
3. **Forecast** — seven models (chart-pattern matching against history, similar past moves, gradient-boosted trees, a neural network, logistic regression, nearest neighbours and a trend model), each weighted by how accurate it was on recent data it never saw. It gives a direction lean plus 50% and 80% price ranges.
4. **History** — what this coin did after the times its chart looked like today, across years of daily data.
5. **Verdict** — every reading is weighted by its measured accuracy, so one with no proven edge counts for nothing.

The wording comes from a rule-based analyst built into the page, or from a language model that runs on your own device if you turn one on (or your own AI service if you connect one). Your questions are not sent to CoinVantage or to ChatGPT.

**Honest limits:** across every timeframe tested the forecast was right ${t.all}% of the time, against ${t.allBaseline}% for always calling the more common direction — so it does **not** beat that baseline yet. Use it for ranges, levels and stop-losses, not as a crystal ball. Every figure is on the [Track record](#/track) page and on each coin page.`;
}

function siteLegitAnswer() {
  return `**What CoinVantage is, plainly**

- A market-data and analysis site. It never takes deposits, never holds your coins and never connects to an exchange account, so it cannot move or lose your money.
- **Trading** runs on simulated money. The real-trade journal only records trades you place yourself on your own exchange — it never places an order or holds a key.
- The analysis is free. Premium is an optional paid plan for alerts and tracking that run on a server while your browser is closed.
- The forecast's accuracy is measured on data it never saw and published, including where it does **not** beat a simple baseline — see [Track record](#/track).
- An account is optional; it only syncs your watchlist, portfolio, trades and alerts between your devices.

Treat every signal here as one input, not an instruction. Anyone promising guaranteed returns — in this site's name or any other — is running a scam.`;
}

function coinLegitAnswer(sym) {
  const name = sym || 'a coin';
  const major = sym === 'BTC' || sym === 'ETH'
    ? `\n\n${sym === 'BTC' ? 'Bitcoin' : 'Ethereum'} is one of the two largest and longest-running crypto networks and trades on every major exchange; its main risk is price swings, not the project vanishing.`
    : '';
  return `**Charts can't tell you whether ${name} is a scam** — indicators show how a price has moved, not whether a project is honest.${major}

What to check yourself:
- **Age and listings** — how long it has traded, and whether large regulated exchanges list it. Delistings are a warning.
- **Liquidity** — daily volume against market cap. Thin trading makes the price easy to push around and the coin hard to sell.
- **Who holds it** — a few wallets owning most of the supply, or large token unlocks coming up, can mean heavy selling.
- **The pitch** — guaranteed returns, pressure to buy fast, or being paid to recruit others are classic signs of fraud.
- **Contract and team** — for tokens, an audited contract and a public team lower the risk; an anonymous team or a contract that can mint or freeze coins raises it.

${sym ? `The [${sym} page](#/coin/${sym}) shows its market cap and volume, and **Exchanges** shows where it trades.` : 'Each coin page shows market cap and volume, and **Exchanges** shows where a coin trades.'} Never send coins to anyone who promises to multiply them.`;
}

/**
 * A complete answer for a question that is not about a chart, or null when the
 * question needs the coin's data. `symbol` is the coin in focus; `named` lists
 * coins the question mentions.
 */
export function conversationalAnswer(question, { symbol = null, named = [] } = {}) {
  let q = String(question || '').trim();
  if (!q) return null;
  // "hi" or "hi there!" is a greeting; "hi, what is RSI?" is a question
  // with a greeting in front, answered as the question.
  const afterHi = afterLead(GREETING, q);
  if (afterHi !== null) {
    if (wordsOf(afterHi).every((w) => FILLER.test(w)) || /^\?*$/.test(afterHi)) return greetingAnswer(symbol);
    q = afterHi;
  }
  const afterThanks = afterLead(THANKS, q);
  if (afterThanks !== null) {
    if (wordsOf(afterThanks).every((w) => FILLER.test(w))) return 'Glad to help. Ask about another coin any time — and keep a stop-loss on every trade.';
    q = afterThanks.replace(/^(and|but|so|also)\b[\s,]*/i, '');
  }
  if (HELP.test(q)) return greetingAnswer(symbol);
  if (LEGIT.test(q) && !CHART_WORDS.test(q)) {
    const coin = named[0] || (THIS_COIN.test(q) ? symbol : null);
    if (!coin && !/\b(coin|token|project|crypto|altcoin|memecoin|meme coin)s?\b/i.test(q)) return `${siteLegitAnswer()}\n\n${DISCLAIMER}`;
    return `${coinLegitAnswer(coin)}\n\n${DISCLAIMER}`;
  }
  if (METHOD.test(q)) return `${methodAnswer()}\n\n${DISCLAIMER}`;
  return definitionAnswer(q, { coinNamed: named.length > 0 });
}
