// Scheduled AI trader (cron every five minutes). Each signed-in account whose
// AI is on is checked here, with the Trading page closed, by the steps the page
// runs (engine/traderrun.js), on the same exchanges' candles (candles.ts). The
// page shows the account from the cloud, so it keeps trading with every
// browser closed. Before this the account only moved while the page was open
// (and caught up when it was next opened).
import { admin, json, requireCron } from './lib.ts';
import { configFrom, runConfig, heldOffList, backfillNeeds, checkAccount } from './engine/traderrun.js';
import { candlesFor, STEP_MS, type Candle } from './candles.ts';

const BACKFILL_MAX = 6000;

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

type Row = { user_id: string; cfg: Record<string, unknown> | null; state: Record<string, any> | null; lessons: unknown; auto_learn: unknown; state_md5: string };

async function checkOne(row: Row, now: number, dry: boolean) {
  const state = row.state;
  if (!state || typeof state !== 'object' || !state.open || !Array.isArray(state.closed)) return { skipped: 'not started' };
  const cfg = configFrom(row.cfg);
  if (!state.interval) state.interval = cfg.interval;
  const lessons = Array.isArray(row.lessons) ? row.lessons : [];
  const iv = runConfig(cfg, state, lessons).interval;
  const step = STEP_MS[iv];
  if (!step) return { skipped: `no ${iv} chart` };
  // nothing new: the last check (here or on a page) came after the newest candle closed
  const lastCheck = [...(state.log || [])].reverse().find((e: { kind?: string }) => e.kind === 'check')?.t || 0;
  if (lastCheck >= Math.floor(now / step) * step + 30e3) return { skipped: 'no new candle' };

  const syms = [...new Set([...cfg.universe, ...heldOffList(cfg, state)])] as string[];
  const bySymbol: Record<string, Candle[]> = {};
  const failed: string[] = [];
  const closedOnly = (c: Candle[]) => (c.length && c[c.length - 1].t + step > now ? c.slice(0, -1) : c);
  await pool(syms, 8, async (sym) => {
    const r = await candlesFor(sym, iv, 500).catch(() => null);
    if (r?.candles.length) bySymbol[sym] = closedOnly(r.candles);
    else failed.push(sym);
  });
  if (!Object.keys(bySymbol).length) return { skipped: 'no candles read' };
  for (const { sym, need } of backfillNeeds(state, bySymbol, step, { now, max: BACKFILL_MAX })) {
    const r = await candlesFor(sym, iv, need).catch(() => null);
    if (r && r.candles.length > bySymbol[sym].length) bySymbol[sym] = closedOnly(r.candles);
  }

  const check = checkAccount(state, cfg, { bySymbol, failed, lessons, autoLearn: row.auto_learn !== false, by: 'cloud', now });
  const result = { interval: iv, coins: Object.keys(bySymbol).length, failed: failed.length, candles: check.processed, opened: check.opened, closed: check.closed };
  // a dry run reports what the check did and saves nothing
  if (dry) return { ...result, dry: true, failedCoins: failed, balance: state.balance, open: Object.keys(state.open) };
  const patch: Record<string, unknown> = { traderState: state };
  if (check.changes.length) { patch.traderCfg = cfg; patch.traderLessons = lessons.slice(-50); }
  // saved only if no page saved the account meanwhile; the next run starts from that copy
  const { data: saved, error } = await admin.rpc('cv_save_trader', { p_user: row.user_id, p_was: row.state_md5, p_trading: patch });
  if (error) throw error;
  return { ...result, saved };
}

export async function traderRun(req: Request): Promise<Response> {
  await requireCron(req);
  const body = await req.json().catch(() => ({}));
  const dry = body?.dry === true;
  const { data: rows, error } = await admin.rpc('cv_trader_accounts');
  if (error) throw error;
  const now = Date.now();
  const out = [];
  for (const row of (rows || []) as Row[]) {
    try {
      out.push({ user: row.user_id.slice(0, 8), ...(await checkOne(row, now, dry)) });
    } catch (e) {
      console.error('trader', row.user_id, e);
      out.push({ user: row.user_id.slice(0, 8), error: String(e) });
    }
  }
  return json({ accounts: out });
}
