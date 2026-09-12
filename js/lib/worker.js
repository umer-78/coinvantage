// Web Worker: runs the heavy AI forecast / backtest off the main thread.
import { forecast } from './predict.js';
import { backtest, generateSignal } from './signals.js';
import { analyzeHistory } from './history.js';

self.onmessage = (e) => {
  const { id, type, candles, opts } = e.data;
  try {
    let result;
    if (type === 'forecast') result = forecast(candles, opts);
    else if (type === 'backtest') result = backtest(candles, opts);
    else if (type === 'signal') result = generateSignal(candles, opts);
    else if (type === 'history') result = analyzeHistory(candles, opts);
    else throw new Error('unknown job');
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
