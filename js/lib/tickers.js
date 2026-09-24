// Deciding whether a word in a question is a coin.
//
// Several tickers are also ordinary words: "near term", "a link", "dot com",
// "etc.", "op-ed". Read naively, "what about the near term for BTC?" became a
// BTC-versus-NEAR comparison. Those words now count as coins only when written
// in capitals (NEAR, $link) or next to a trading word ("is link a good buy").

export const AMBIGUOUS_TICKERS = new Set(['near', 'link', 'dot', 'uni', 'ton', 'atom', 'op', 'etc', 'fil', 'apt', 'arb', 'sei', 'tao', 'inj', 'ada', 'sol']);
const TRADE_WORD = /^(buy|buying|sell|selling|price|prices|coin|coins|token|tokens|chart|charts|worth|good|bullish|bearish|pump|dump|hold|holding|signal|signals|forecast|invest|investing|long|short|entry|exit|vs|versus|compare|crypto|usdt|usd|rally|crash|moon|analysis|analyse|analyze|stake|staking)$/;

/**
 * True when `word`, found at `index` in `text`, should be read as a coin.
 * Unambiguous tickers always are; ambiguous ones need capitals, a $, or a
 * trading word within two words before or three after.
 */
export function isTickerMention(word, text, index) {
  const lower = word.replace(/^\$/, '').toLowerCase();
  if (!AMBIGUOUS_TICKERS.has(lower)) return true;
  if (word.startsWith('$') || (word === word.toUpperCase() && /[A-Z]/.test(word))) return true;
  const before = text.slice(0, index).toLowerCase().split(/[^a-z$]+/).filter(Boolean).slice(-3);
  const after = text.slice(index + word.length).toLowerCase().split(/[^a-z$]+/).filter(Boolean).slice(0, 3);
  return [...before, ...after].some((w) => TRADE_WORD.test(w));
}
