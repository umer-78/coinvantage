// Scheduled track record: logs the 4h signal + AI forecast for tracked coins, then scores
// earlier entries once their horizon has passed. Runs in small batches to stay within CPU limits.
import { admin, json, requireCron, klines, setting } from './lib.ts';
import { generateSignal } from './engine/signals.js';
import { forecast } from './engine/predict.js';
import { scorePlan } from './engine/planscore.js';
import { aiSignalRow } from './engine/autotrader.js';

// Candle lengths, so the horizon is computed from the interval being logged
// rather than from a constant. The old code hardcoded four hours: the interval
// was already overridable from app_settings, so changing it would have written
// horizons that were wrong by the ratio between the two timeframes, and scored
// every row at the wrong moment.
const IV_MS: Record<string, number> = { '15m': 9e5, '1h': 36e5, '4h': 4 * 3600e3, '1d': 864e5 };

// 4h was the only timeframe ever logged — and it is the one the offline
// geometry test scored NEGATIVE (-0.047R per trade). Tracking the daily chart
// as well means the public record covers a timeframe measured positive
// (+0.058R) rather than only the worst one. Both are overridable from
// app_settings without a redeploy.
const DEFAULT = {
  symbols: ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'TRX', 'DOT', 'LTC'],
  plans: [{ interval: '4h', horizon: 6 }, { interval: '1d', horizon: 7 }],
  per_batch: 3,
};

export async function trackSignals(req: Request): Promise<Response> {
  await requireCron(req);
  const body = await req.json().catch(() => ({}));
  const cfg = { ...DEFAULT, ...((await setting('tracking')) || {}) } as typeof DEFAULT;
  const batches = Math.ceil(cfg.symbols.length / cfg.per_batch);
  const batch = Number.isInteger(body.batch) ? body.batch % batches : Math.floor(new Date().getUTCMinutes() / 15) % batches;
  const group = cfg.symbols.slice(batch * cfg.per_batch, (batch + 1) * cfg.per_batch);

  // Older settings rows may still carry a single { interval, horizon }.
  const plans = Array.isArray(cfg.plans) && cfg.plans.length
    ? cfg.plans
    : [{ interval: (cfg as Record<string, unknown>).interval as string || '4h', horizon: (cfg as Record<string, unknown>).horizon as number || 6 }];

  const logged: string[] = [];
  for (const plan of plans) {
    const ms = IV_MS[plan.interval];
    if (!ms) { console.error('unknown interval', plan.interval); continue; }
    for (const symbol of group) {
      try {
        let candles = await klines(symbol, plan.interval, 700);
        // only closed candles
        if (candles.length && candles[candles.length - 1].t + ms > Date.now()) candles = candles.slice(0, -1);
        const last = candles[candles.length - 1];
        if (!last) continue;
        // The AI signal's live record: what the chart's tested rules did on this
        // closed candle, written once and never changed (engine/autotrader.js).
        try {
          const ai = aiSignalRow(candles, plan.interval, symbol, { horizonBars: plan.horizon, intervalMs: ms });
          if (ai) {
            const { error: aiErr } = await admin.from('ai_signal_log').upsert(ai, { onConflict: 'symbol,interval,candle_time', ignoreDuplicates: true });
            if (aiErr) throw aiErr;
          }
        } catch (e) {
          console.error('ai log', symbol, plan.interval, e);
        }
        const sig = generateSignal(candles, { interval: plan.interval });
        if (!sig.ok) continue;
        const fc = forecast(candles, { horizon: plan.horizon, fast: true, intervalMs: ms });
        const row = {
          symbol, interval: plan.interval,
          candle_time: new Date(last.t).toISOString(),
          price: last.c, action: sig.action, score: sig.score,
          plan: sig.plan ? { side: sig.plan.side, entry: sig.plan.entry, stop: sig.plan.stopLoss, tp1: sig.plan.takeProfits[0], tp2: sig.plan.takeProfits[1] } : null,
          prob_up: fc.ok ? +fc.probUp.toFixed(4) : null,
          horizon_bars: plan.horizon,
          horizon_at: new Date(last.t + ms + plan.horizon * ms).toISOString(),
          forecast_target: fc.ok ? fc.targetPrice : null,
          model_accuracy: fc.ok && fc.ensemble.accuracy !== null ? +fc.ensemble.accuracy.toFixed(4) : null,
        };
        const { error } = await admin.from('signal_log').upsert(row, { onConflict: 'symbol,interval,candle_time', ignoreDuplicates: true });
        if (error) throw error;
        logged.push(`${symbol}:${plan.interval}`);
      } catch (e) {
        console.error(symbol, plan.interval, e);
      }
    }
  }

  // Score finished entries
  const { data: due } = await admin.from('signal_log').select('*').eq('resolved', false).lte('horizon_at', new Date().toISOString()).order('horizon_at').limit(12);
  let resolved = 0;
  for (const r of due || []) {
    try {
      // after the logged candle closed — measured in that row's own interval,
      // not in a constant four hours
      const start = new Date(r.candle_time).getTime() + (IV_MS[r.interval] || IV_MS['4h']);
      const end = new Date(r.horizon_at).getTime();
      const hourly = await klines(r.symbol, '1h', 1000, start, end - 1);
      if (!hourly.length) continue;
      const outcome = hourly[hourly.length - 1].c;
      const up = outcome > Number(r.price);
      const forecastCorrect = r.prob_up === null ? null : (Number(r.prob_up) >= 0.5) === up;
      // scored the way the plan says to manage it (engine/planscore.js)
      const scored = r.plan ? scorePlan(r.plan, hourly, outcome) : { result: 'none', returnPct: null };
      const planResult = scored.result, planReturn = scored.returnPct;
      await admin.from('signal_log').update({
        resolved: true, resolved_at: new Date().toISOString(), outcome_price: outcome,
        forecast_correct: forecastCorrect, plan_result: planResult, plan_return_pct: planReturn === null ? null : +planReturn.toFixed(3),
        plan_v: 2,
      }).eq('id', r.id);
      resolved++;
    } catch (e) {
      console.error('resolve', r.id, e);
    }
  }

  // Grade the AI signal's rows once their horizon has passed: was the price
  // higher that many candles later? The same question its published record
  // answers (CHART_TESTED[chart].signals), asked of candles no test has seen.
  const { data: aiDue } = await admin.from('ai_signal_log').select('id,symbol,interval,candle_time,horizon_at,price')
    .eq('resolved', false).lte('horizon_at', new Date().toISOString()).order('horizon_at').limit(12);
  let aiResolved = 0;
  for (const r of aiDue || []) {
    try {
      const start = new Date(r.candle_time).getTime() + (IV_MS[r.interval] || IV_MS['4h']);
      const hourly = await klines(r.symbol, '1h', 1000, start, new Date(r.horizon_at).getTime() - 1);
      if (!hourly.length) continue;
      const outcome = hourly[hourly.length - 1].c;
      await admin.from('ai_signal_log').update({
        resolved: true, resolved_at: new Date().toISOString(), outcome_price: outcome,
        fwd_up: outcome > Number(r.price), fwd_ret_pct: +((outcome / Number(r.price) - 1) * 100).toFixed(3),
      }).eq('id', r.id);
      aiResolved++;
    } catch (e) {
      console.error('ai resolve', r.id, e);
    }
  }

  // Plans resolved before the scoring followed the plan's own management rule
  // (plan_v 1) are re-scored a few per run, newest first, from the same hourly
  // candles, until none are left.
  const { data: old } = await admin.from('signal_log').select('id,symbol,interval,candle_time,horizon_at,plan')
    .eq('resolved', true).eq('plan_v', 1).not('plan', 'is', null).order('horizon_at', { ascending: false }).limit(6);
  let rescored = 0;
  for (const r of old || []) {
    try {
      const start = new Date(r.candle_time).getTime() + (IV_MS[r.interval] || IV_MS['4h']);
      const hourly = await klines(r.symbol, '1h', 1000, start, new Date(r.horizon_at).getTime() - 1);
      if (!hourly.length) continue;
      const s = scorePlan(r.plan, hourly, hourly[hourly.length - 1].c);
      await admin.from('signal_log').update({ plan_result: s.result, plan_return_pct: s.returnPct === null ? null : +s.returnPct.toFixed(3), plan_v: 2 }).eq('id', r.id);
      rescored++;
    } catch (e) {
      console.error('rescore', r.id, e);
    }
  }
  return json({ batch, logged, resolved, rescored, aiResolved });
}
