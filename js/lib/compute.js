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

// The same job on the same candles gives the same answer. Keep the last few,
// and let a second ask for a job still running share it, so reopening a coin
// (or two panels asking at once) does not train every model again. Each caller
// gets its own copy, so one cannot change another's result.
const memo = new Map();
const MEMO_MAX = 24;
const keyOf = (type, candles, opts) => {
  const n = candles?.length || 0;
  if (!n) return null;
  const a = candles[0], z = candles[n - 1];
  return `${type}|${n}|${a.t}|${z.t}|${z.o}|${z.h}|${z.l}|${z.c}|${z.v}|${JSON.stringify(opts ?? null)}`;
};
const copy = (r) => (typeof structuredClone === 'function' ? structuredClone(r) : r);
function cached(type, candles, opts) {
  const k = keyOf(type, candles, opts);
  if (!k) return run(type, candles, opts);
  let p = memo.get(k);
  if (p) memo.delete(k); // most recently used goes last
  else {
    p = run(type, candles, opts);
    p.catch(() => memo.delete(k));
  }
  memo.set(k, p);
  while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
  return p.then(copy);
}

export const runForecast = (candles, opts) => cached('forecast', candles, opts);
export const runBacktest = (candles, opts) => cached('backtest', candles, opts);
export const runSignal = (candles, opts) => cached('signal', candles, opts);
export const runHistory = (daily, opts) => cached('history', daily, opts);
