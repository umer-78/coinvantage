// Scheduled AI learning (cron every five minutes): one chart and a few coins a
// run, in turn (learnjob.js), into the shared record in ai_learn, one row per
// chart. The pages read that row's summary, so the AI keeps learning with every
// browser closed and every device shows the same record.
import { admin, json, requireCron, klines, setting } from './lib.ts';
import { forecast } from './engine/predict.js';
import { learnRun, slotFor, candlesToRead, LEARN_COINS, LEARN_INTERVAL_MS } from './learnjob.js';

export async function learnPass(req: Request): Promise<Response> {
  await requireCron(req);
  const body = await req.json().catch(() => ({}));
  const cfg = { per_batch: 6, ...((await setting('learning')) || {}) } as { per_batch: number; coins?: string[] };
  const coins = Array.isArray(cfg.coins) && cfg.coins.length ? cfg.coins : LEARN_COINS;
  const plan = slotFor(Date.now(), { coins, perBatch: cfg.per_batch });
  const interval: string = typeof body.interval === 'string' && LEARN_INTERVAL_MS[body.interval] ? body.interval : plan.interval;
  const symbols: string[] = Array.isArray(body.symbols) ? body.symbols.filter((s: unknown) => typeof s === 'string' && coins.includes(s)) : plan.symbols;
  const ms = LEARN_INTERVAL_MS[interval];

  const { data: row, error } = await admin.from('ai_learn').select('ledger').eq('interval', interval).maybeSingle();
  if (error) throw error;

  const inputs: { symbol: string; candles: { t: number; o: number; h: number; l: number; c: number; v: number }[] }[] = [];
  const failed: string[] = [];
  for (const symbol of symbols) {
    try {
      let candles = await klines(encodeURIComponent(symbol), interval, candlesToRead(interval));
      // only closed candles
      if (candles.length && candles[candles.length - 1].t + ms > Date.now()) candles = candles.slice(0, -1);
      inputs.push({ symbol, candles });
    } catch (e) {
      failed.push(symbol);
      console.error('learn candles', symbol, interval, e);
    }
  }

  const r = learnRun(row?.ledger ?? null, interval, inputs, { forecast });
  const { error: upErr } = await admin.from('ai_learn')
    .upsert({ interval, ledger: r.ledger, summary: r.summary, updated_at: new Date().toISOString() }, { onConflict: 'interval' });
  if (upErr) throw upErr;
  return json({ interval, symbols, failed, logged: r.logged, scored: r.scored, expired: r.expired, changes: r.changes.map((c) => c.text) });
}
