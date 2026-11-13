// The plain-language guide to how CoinVantage learns and is tested. One copy,
// used by the Learn page in the app (js/views/learn.js) and by the page search
// engines read before the app runs (tools/build-pages.mjs). The figures in it
// are read from the measured records, never typed here.
import { FORECAST_TESTED } from './forecastview.js';
import { TESTED_ACCURACY } from './predict.js';
import { TESTED_COINS } from './autotrader.js';

const centred = Object.values(FORECAST_TESTED.centred);
const lo = Math.min(...centred.map((x) => x.band80)), hi = Math.max(...centred.map((x) => x.band80));
const tests = Math.round(centred.reduce((a, x) => a + x.tests, 0) / 1000) * 1000;

export const rangeLine = `Its price range is measured: the 80% range held ${lo === hi ? lo : `${lo}–${hi}`}% of the time across about ${tests.toLocaleString('en-US')} tests on ${TESTED_COINS.length} coins.`;
export const directionMeasured = `Across ${TESTED_ACCURACY.tests.toLocaleString('en-US')} direction tests the models were right ${TESTED_ACCURACY.all}% of the time, against ${TESTED_ACCURACY.allBaseline}% for simply always calling the more common outcome, so direction is never shown as a buy or sell call.`;

/** Sections of { h2, paras?, steps?, list? }; plain text, escaped where drawn. */
export const LEARN_GUIDE = [
  { h2: 'The learning loop', steps: [
    'Record. Live prices, volume and volatility come from public exchange feeds. Each indicator reading, forecast and trade is written down with the time it was made.',
    'Wait. Nothing is graded until the forecast horizon has passed, so the answer cannot leak into the call.',
    'Grade. The call is compared with what price actually did, and with a simple baseline, such as always calling the more common outcome.',
    'Re-weight. A method that beats the baseline over many calls gains weight; one that does not loses it, however clever it sounds.',
    'Repeat. The window moves forward and the grading never stops, so the record always includes the newest market.',
  ] },
  { h2: 'How signals are scored', paras: [
    'Each indicator reading (trend, momentum, RSI, MACD, Bollinger, Stoch RSI, volume, ADX) is stored with its score and then checked against the move that followed. A reading counts as useful only if it is right more often than the baseline over a large number of cases.',
    'This has produced uncomfortable results, and they are shown as they are: across 106 coins the strongest readings were followed by a rise least often, so the scanner describes how stretched a move is rather than predicting the next one.',
  ] },
  { h2: 'How the forecast is tested', paras: [
    'The forecast is a price range, not a single target. An 80% range should contain the later price about 80% of the time; if it held 95% of the time it would be too wide to be useful, and at 60% it would be overconfident.',
    `${rangeLine} Direction is graded separately. ${directionMeasured}`,
  ] },
  { h2: 'Walk-forward validation, in plain words', paras: [
    'Think of a practice exam and a real exam. The rules are chosen using only the history before a period, then run on that period, which they have never seen. Then the window moves forward and it happens again.',
    'Fees are charged on every trade, and a second run makes fills worse to stand in for spread and slippage. A result that only appears when the test can peek at the answers is not counted.',
  ] },
  { h2: 'What counts as evidence', list: [
    'The call was logged before its outcome was known.',
    'It was tested on data the method was not tuned on.',
    'It beat a plain baseline (always calling the more common outcome, or simply holding the coins).',
    'It held up over many cases and more than one period, not a lucky streak.',
    'For the AI trader: a new pick must pass in two runs in a row before it is traded.',
  ] },
  { h2: 'What is measured, and what is not', list: [
    'Measured: how often forecast ranges held; direction hit rate against a baseline; trading return after fees and modelled fill costs; worst drop; number of trades; what holding did.',
    'Not measured: news and events before they happen; how your own order would fill in a thin market; exchange outages; taxes; your own timing and discipline.',
  ] },
  { h2: 'What gets discarded or demoted', list: [
    'Direction calls that do not beat the baseline are never shown as buy or sell signals.',
    'Rule sets that lose to their baseline in the walk-forward test are not adopted, and one that passes once must pass again first.',
    'Charts that leave too little data to test on are dropped: the weekly chart is not offered to the trader for this reason.',
    'Models inside the forecast are weighted by their measured accuracy, so one that stops working fades out on its own.',
  ] },
  { h2: 'Feedback loops and changing markets', paras: [
    'Markets move between regimes: steady trends, choppy ranges, quiet spells and violent ones. A rule tuned to one regime can fail in the next, and a pattern that many traders act on tends to fade as they do. Neither can be tested away.',
    'So nothing here is treated as settled. The tests are repeated on new data, the live record keeps grading in the cloud, and when a method gets worse the page says so instead of quietly keeping its old figure. That is the point of measuring: it is how you find out a model has stopped working before you rely on it.',
  ] },
];
