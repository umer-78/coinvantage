// Scheduled track record: logs the 4h signal + AI forecast for tracked coins, then scores
// earlier entries once their horizon has passed. Runs in small batches to stay within CPU limits.
import { admin, json, requireCron, klines, setting } from './lib.ts';
import { generateSignal } from './engine/signals.js';
import { forecast } from './engine/predict.js';

const DEFAULT = { symbols: ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'TRX', 'DOT', 'LTC'], interval: '4h', horizon: 6, per_batch: 3 };
const H4 = 4 * 3600e3;

export async function trackSignals(req: Request): Promise<Response> {
  await requireCron(req);
  const body = await req.json().catch(() => ({}));
  const cfg = { ...DEFAULT, ...((await setting('tracking')) || {}) } as typeof DEFAULT;
  const batches = Math.ceil(cfg.symbols.length / cfg.per_batch);
  const batch = Number.isInteger(body.batch) ? body.batch % batches : Math.floor(new Date().getUTCMinutes() / 15) % batches;
  const group = cfg.symbols.slice(batch * cfg.per_batch, (batch + 1) * cfg.per_batch);

  const logged: string[] = [];
  for (const symbol of group) {
    try {
      let candles = await klines(symbol, cfg.interval, 700);
      // only closed candles
      if (candles.length && candles[candles.length - 1].t + H4 > Date.now()) candles = candles.slice(0, -1);
      const last = candles[candles.length - 1];
      const sig = generateSignal(candles, { interval: cfg.interval });
      if (!sig.ok) continue;
      const fc = forecast(candles, { horizon: cfg.horizon, fast: true, intervalMs: H4 });
      const row = {
        symbol, interval: cfg.interval,
        candle_time: new Date(last.t).toISOString(),
        price: last.c, action: sig.action, score: sig.score,
        plan: sig.plan ? { side: sig.plan.side, entry: sig.plan.entry, stop: sig.plan.stopLoss, tp1: sig.plan.takeProfits[0], tp2: sig.plan.takeProfits[1] } : null,
        prob_up: fc.ok ? +fc.probUp.toFixed(4) : null,
        horizon_bars: cfg.horizon,
        horizon_at: new Date(last.t + H4 + cfg.horizon * H4).toISOString(),
        forecast_target: fc.ok ? fc.targetPrice : null,
        model_accuracy: fc.ok && fc.ensemble.accuracy !== null ? +fc.ensemble.accuracy.toFixed(4) : null,
      };
      const { error } = await admin.from('signal_log').upsert(row, { onConflict: 'symbol,interval,candle_time', ignoreDuplicates: true });
      if (error) throw error;
      logged.push(symbol);
    } catch (e) {
      console.error(symbol, e);
    }
  }

  // Score finished entries
  const { data: due } = await admin.from('signal_log').select('*').eq('resolved', false).lte('horizon_at', new Date().toISOString()).order('horizon_at').limit(12);
  let resolved = 0;
  for (const r of due || []) {
    try {
      const start = new Date(r.candle_time).getTime() + H4; // after the signal candle closed
      const end = new Date(r.horizon_at).getTime();
      const hourly = await klines(r.symbol, '1h', 1000, start, end - 1);
      if (!hourly.length) continue;
      const outcome = hourly[hourly.length - 1].c;
      const up = outcome > Number(r.price);
      const forecastCorrect = r.prob_up === null ? null : (Number(r.prob_up) >= 0.5) === up;
      let planResult = 'none', planReturn: number | null = null;
      if (r.plan) {
        const { side, entry, stop, tp1, tp2 } = r.plan;
        const long = side === 'long';
        const pctOf = (p: number) => (long ? p / entry - 1 : 1 - p / entry) * 100;
        planResult = 'expired';
        planReturn = pctOf(outcome);
        for (const c of hourly) {
          const hitStop = long ? c.l <= stop : c.h >= stop;
          const hitTp2 = long ? c.h >= tp2 : c.l <= tp2;
          const hitTp1 = long ? c.h >= tp1 : c.l <= tp1;
          if (hitStop) { planResult = 'stop'; planReturn = pctOf(stop); break; } // conservative: stop first if both in one candle
          if (hitTp2) { planResult = 'tp2'; planReturn = pctOf(tp2); break; }
          if (hitTp1 && planResult !== 'tp1') { planResult = 'tp1'; planReturn = pctOf(tp1); }
        }
      }
      await admin.from('signal_log').update({
        resolved: true, resolved_at: new Date().toISOString(), outcome_price: outcome,
        forecast_correct: forecastCorrect, plan_result: planResult, plan_return_pct: planReturn === null ? null : +planReturn.toFixed(3),
      }).eq('id', r.id);
      resolved++;
    } catch (e) {
      console.error('resolve', r.id, e);
    }
  }
  return json({ batch, logged, resolved });
}
