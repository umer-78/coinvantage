// Your own history: what you looked at, and every forecast you were shown.
//
// This is a personal record, kept per account and readable only by that account
// (row-level security enforces it). The prediction half of each forecast row is
// written before the outcome is known and is immutable afterwards — the database
// refuses any update that touches it, and derives the right/wrong verdict itself.
// That is what makes "your forecast hit rate" mean something.
import { sb, auth } from './backend.js';

const ok = () => !!auth.user;

/** Fire-and-forget: never blocks or breaks the page. */
export async function logActivity(kind, symbol = null, meta = {}) {
  if (!ok()) return;
  try {
    const client = await sb();
    if (!client) return;
    await client.from('user_activity').insert({ user_id: auth.user.id, kind, symbol, meta });
  } catch { /* the record is a convenience, never load-bearing */ }
}

// One row per coin+interval+horizon: revisiting the same page does not pad the stats.
const seen = new Set();
export async function logForecastShown({ symbol, interval, price, probUp, targetPrice, horizonBars, horizonAt, modelAccuracy }) {
  if (!ok() || !Number.isFinite(price) || !horizonAt) return;
  const key = `${symbol}:${interval}:${horizonAt}`;
  if (seen.has(key)) return;
  seen.add(key);
  try {
    const client = await sb();
    if (!client) return;
    await client.from('user_forecasts').insert({
      user_id: auth.user.id, symbol, interval, price,
      prob_up: probUp ?? null, target_price: targetPrice ?? null,
      horizon_bars: horizonBars ?? null, horizon_at: new Date(horizonAt).toISOString(),
      model_accuracy: modelAccuracy ?? null,
    });
  } catch { /* duplicate or offline — nothing to do */ }
}

export async function myActivity(limit = 60) {
  if (!ok()) return [];
  const client = await sb();
  if (!client) return [];
  const { data } = await client.from('user_activity').select('*').order('created_at', { ascending: false }).limit(limit);
  return data || [];
}

export async function myForecasts(limit = 100) {
  if (!ok()) return [];
  const client = await sb();
  if (!client) return [];
  const { data } = await client.from('user_forecasts').select('*').order('shown_at', { ascending: false }).limit(limit);
  return data || [];
}

/**
 * Fill in the outcome for forecasts whose horizon has passed, using the public
 * close at that time. The database derives right/wrong itself.
 */
export async function resolveDueForecasts(getCloseAt) {
  if (!ok()) return 0;
  const client = await sb();
  if (!client) return 0;
  const { data: due } = await client.from('user_forecasts').select('*')
    .eq('resolved', false).lte('horizon_at', new Date().toISOString()).limit(20);
  let n = 0;
  for (const row of due || []) {
    try {
      const close = await getCloseAt(row.symbol, row.interval, new Date(row.horizon_at).getTime());
      if (!Number.isFinite(close)) continue;
      await client.from('user_forecasts').update({ resolved: true, outcome_price: close }).eq('id', row.id);
      n++;
    } catch { /* try again next time */ }
  }
  return n;
}

export function forecastScore(rows) {
  const done = rows.filter((r) => r.resolved && r.was_right !== null);
  const right = done.filter((r) => r.was_right).length;
  return {
    shown: rows.length,
    resolved: done.length,
    right,
    accuracy: done.length ? (right / done.length) * 100 : null,
    open: rows.filter((r) => !r.resolved).length,
  };
}

export async function clearMyActivity() {
  if (!ok()) return;
  const client = await sb();
  await client?.from('user_activity').delete().eq('user_id', auth.user.id);
}
