// Runs forecast/backtest jobs in a Web Worker when available, else on the main thread.
import { forecast } from './predict.js';
import { backtest, generateSignal } from './signals.js';
import { analyzeHistory } from './history.js';

// A few workers, so a scan of many coins trains several forecasts at once
// instead of one after another (one core is left for the page itself).
const POOL = Math.max(1, Math.min(3, ((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2) - 1));
let pool = null; // [{ w, pending: Map }] once started; false when workers cannot run here
let seq = 0;

function getPool() {
  if (pool !== null) return pool;
  try {
    pool = [];
    for (let i = 0; i < POOL; i++) {
      const slot = { w: new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }), pending: new Map() };
      slot.w.onmessage = (e) => {
        const p = slot.pending.get(e.data.id);
        if (!p) return;
        slot.pending.delete(e.data.id);
        if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data.result);
      };
      // a worker that dies hands its jobs to the page and leaves the pool
      slot.w.onerror = () => {
        for (const [, p] of slot.pending) p.fallback();
        slot.pending.clear();
        pool = pool && pool.filter((x) => x !== slot);
        if (pool && !pool.length) pool = false;
      };
      pool.push(slot);
    }
  } catch {
    pool = false;
  }
  return pool;
}

function run(type, candles, opts) {
  const local = () => (type === 'forecast' ? forecast(candles, opts)
    : type === 'backtest' ? backtest(candles, opts)
      : type === 'history' ? analyzeHistory(candles, opts)
        : generateSignal(candles, opts));
  const slots = getPool();
  if (!slots || !slots.length) return new Promise((resolve) => setTimeout(() => resolve(local()), 0));
  // the least busy worker takes the job
  const slot = slots.reduce((a, b) => (b.pending.size < a.pending.size ? b : a));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    slot.pending.set(id, { resolve, reject, fallback: () => resolve(local()) });
    slot.w.postMessage({ id, type, candles, opts });
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
