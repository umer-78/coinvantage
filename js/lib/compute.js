// Runs forecast/backtest jobs in a Web Worker when available, else on the main thread.
import { forecast } from './predict.js';
import { backtest, generateSignal } from './signals.js';
import { analyzeHistory } from './history.js';

let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker !== null) return worker;
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data.result);
    };
    worker.onerror = () => { worker = false; for (const [, p] of pending) p.fallback(); pending.clear(); };
  } catch {
    worker = false;
  }
  return worker;
}

function run(type, candles, opts) {
  const local = () => (type === 'forecast' ? forecast(candles, opts)
    : type === 'backtest' ? backtest(candles, opts)
      : type === 'history' ? analyzeHistory(candles, opts)
        : generateSignal(candles, opts));
  const w = getWorker();
  if (!w) return new Promise((resolve) => setTimeout(() => resolve(local()), 0));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, fallback: () => resolve(local()) });
    w.postMessage({ id, type, candles, opts });
  });
}

export const runForecast = (candles, opts) => run('forecast', candles, opts);
export const runBacktest = (candles, opts) => run('backtest', candles, opts);
export const runSignal = (candles, opts) => run('signal', candles, opts);
export const runHistory = (daily, opts) => run('history', daily, opts);
