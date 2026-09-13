// Runs every minute (pg_cron): checks active price alerts and sends Telegram / e-mail messages.
import { admin, json, requireCron, prices, sendTelegram, sendEmail, setting, escHtml, fmtPrice, klines } from './lib.ts';
import { generateSignal } from './engine/signals.js';

const INTERVAL_MS: Record<string, number> = { '15m': 9e5, '1h': 36e5, '4h': 144e5, '1d': 864e5 };

export async function alertsCheck(req: Request): Promise<Response> {
  await requireCron(req);
  const { data: all, error } = await admin.from('alerts')
    .select('id,user_id,symbol,direction,price,note,channels,kind,interval,min_score,side,repeat,last_fired_at')
    .eq('active', true).limit(5000);
  if (error) throw error;
  if (!all?.length) return json({ checked: 0, triggered: 0 });

  const alerts = all.filter((a) => (a.kind ?? 'price') === 'price');
  const signalAlerts = all.filter((a) => a.kind === 'signal');
  const signalResult = await checkSignalAlerts(signalAlerts);
  if (!alerts.length) return json({ checked: all.length, triggered: 0, ...signalResult });

  const symbols = [...new Set(alerts.map((a) => a.symbol))];
  const px = await prices(symbols);
  const hits = alerts.filter((a) => {
    const p = px[a.symbol];
    if (!p) return false;
    return a.direction === 'above' ? p >= Number(a.price) : p <= Number(a.price);
  });
  if (!hits.length) return json({ checked: alerts.length, triggered: 0 });

  const site = await setting<{ url?: string }>('site');
  const sent: unknown[] = [];
  for (const a of hits) {
    const now = px[a.symbol];
    // claim the alert first so a slow send can never double-fire
    const { data: claimed } = await admin.from('alerts')
      .update({ active: false, triggered_at: new Date().toISOString(), triggered_price: now })
      .eq('id', a.id).eq('active', true).select('id');
    if (!claimed?.length) continue;
    const { data: p } = await admin.from('profiles').select('telegram_chat_id,email,email_verified,email_alerts').eq('id', a.user_id).single();
    const link = site?.url ? `\n<a href="${escHtml(site.url)}#/coin/${a.symbol}">Open ${a.symbol} chart</a>` : '';
    const text = `🔔 <b>${a.symbol} is ${a.direction} $${fmtPrice(Number(a.price))}</b>\nNow: $${fmtPrice(now)}${a.note ? `\nNote: ${escHtml(a.note)}` : ''}${link}\n\n<i>Not financial advice.</i>`;
    if (p?.telegram_chat_id && a.channels.includes('telegram')) sent.push(await sendTelegram(p.telegram_chat_id, text));
    if (p?.email && p.email_verified && p.email_alerts && a.channels.includes('email')) {
      sent.push(await sendEmail(p.email, `${a.symbol} is ${a.direction} $${fmtPrice(Number(a.price))}`,
        `<div style="font-family:system-ui,sans-serif"><h2>🔔 ${a.symbol} price alert</h2><p>${a.symbol} is now <b>$${fmtPrice(now)}</b> (${a.direction} your $${fmtPrice(Number(a.price))} alert).</p>${a.note ? `<p>Note: ${escHtml(a.note)}</p>` : ''}${site?.url ? `<p><a href="${escHtml(site.url)}#/coin/${a.symbol}">Open the chart</a></p>` : ''}<p style="color:#888">Not financial advice.</p></div>`));
    }
  }
  return json({ checked: all.length, triggered: hits.length, sent: sent.length, ...signalResult });
}

/**
 * Signal alerts. A signal only changes when a candle closes, so these are
 * evaluated in the first minutes after each close rather than every minute —
 * that keeps a once-a-minute cron from hammering the exchange all day.
 *
 * The alert carries the whole plan (entry, stop, targets) so the reader can act
 * on it wherever they trade. Nothing here places an order.
 */
async function checkSignalAlerts(alerts: Record<string, unknown>[]) {
  if (!alerts.length) return { signalsChecked: 0, signalsFired: 0 };
  const now = Date.now();

  const due = alerts.filter((a) => {
    const step = INTERVAL_MS[a.interval as string];
    if (!step) return false;
    // within 3 minutes of this interval's candle close
    if (now % step > 18e4) return false;
    // one candle of cooldown so a persistent signal does not repeat every close
    const last = a.last_fired_at ? new Date(a.last_fired_at as string).getTime() : 0;
    return now - last >= step;
  });
  if (!due.length) return { signalsChecked: alerts.length, signalsFired: 0 };

  const site = await setting<{ url?: string }>('site');
  const cache = new Map<string, ReturnType<typeof generateSignal>>();
  let fired = 0;

  for (const a of due) {
    const key = `${a.symbol}:${a.interval}`;
    let sig = cache.get(key);
    if (!sig) {
      try {
        let candles = await klines(a.symbol as string, a.interval as string, 500);
        // drop the candle that is still forming — a signal on an open candle is not real yet
        const step = INTERVAL_MS[a.interval as string];
        if (candles.length && candles[candles.length - 1].t + step > now) candles = candles.slice(0, -1);
        sig = generateSignal(candles, { interval: a.interval });
        cache.set(key, sig);
      } catch { continue; }
    }
    if (!sig?.ok || !sig.plan) continue;

    const minScore = Number(a.min_score ?? 25);
    const want = (a.side as string) ?? 'any';
    const isLong = sig.plan.side === 'long';
    if (want !== 'any' && want !== sig.plan.side) continue;
    if (Math.abs(sig.score) < minScore) continue;

    const { data: claimed } = await admin.from('alerts')
      .update({
        last_fired_at: new Date().toISOString(),
        triggered_at: new Date().toISOString(),
        triggered_price: sig.price,
        active: a.repeat === false ? false : true,
      })
      .eq('id', a.id).eq('active', true).select('id');
    if (!claimed?.length) continue;

    const { data: p } = await admin.from('profiles').select('telegram_chat_id,email,email_verified,email_alerts').eq('id', a.user_id).single();
    const tps = (sig.plan.takeProfits as number[]).map((v) => `$${fmtPrice(v)}`).join(' → ');
    const head = `${isLong ? '🟢' : '🔴'} <b>${a.symbol} — ${escHtml(sig.text)}</b> on the ${escHtml(String(a.interval))} chart`;
    const plan = [
      `Now: $${fmtPrice(sig.price)}  ·  score ${sig.score > 0 ? '+' : ''}${sig.score}/100`,
      `Entry: $${fmtPrice(sig.plan.entryZone[0])} – $${fmtPrice(sig.plan.entryZone[1])}`,
      `Stop-loss: $${fmtPrice(sig.plan.stopLoss)} (${sig.plan.riskPct}% risk)`,
      `Targets: ${tps}`,
    ].join('\n');
    const link = site?.url ? `\n<a href="${escHtml(site.url)}#/coin/${a.symbol}">Open the ${a.symbol} chart</a>` : '';
    const text = `${head}\n${plan}${a.note ? `\nNote: ${escHtml(String(a.note))}` : ''}${link}\n\n<i>Set the stop-loss when you place the order. This app never trades for you. Not financial advice.</i>`;

    if (p?.telegram_chat_id && (a.channels as string[]).includes('telegram')) await sendTelegram(p.telegram_chat_id, text);
    if (p?.email && p.email_verified && p.email_alerts && (a.channels as string[]).includes('email')) {
      await sendEmail(p.email, `${a.symbol}: ${sig.text} (${a.interval})`,
        `<div style="font-family:system-ui,sans-serif"><h2>${isLong ? '🟢' : '🔴'} ${a.symbol} — ${escHtml(sig.text)}</h2>
         <p>On the ${escHtml(String(a.interval))} chart, score ${sig.score > 0 ? '+' : ''}${sig.score}/100. Price now <b>$${fmtPrice(sig.price)}</b>.</p>
         <ul><li>Entry $${fmtPrice(sig.plan.entryZone[0])} – $${fmtPrice(sig.plan.entryZone[1])}</li>
         <li>Stop-loss <b>$${fmtPrice(sig.plan.stopLoss)}</b> (${sig.plan.riskPct}% risk)</li>
         <li>Targets ${tps}</li></ul>
         ${site?.url ? `<p><a href="${escHtml(site.url)}#/coin/${a.symbol}">Open the chart</a></p>` : ''}
         <p style="color:#888">Set the stop-loss when you place the order. This app never trades for you. Not financial advice.</p></div>`);
    }
    fired++;
  }
  return { signalsChecked: alerts.length, signalsFired: fired };
}

/**
 * The daily watchlist digest.
 *
 * One message a day instead of a stream of alerts: what moved, what the engine
 * says now, and which setups are worth a look. Runs on the server so it arrives
 * whether or not anyone has the site open. Sent only to people who asked for it
 * and who have a channel linked.
 */
export async function watchlistDigest(req: Request): Promise<Response> {
  await requireCron(req);

  const { data: rows, error } = await admin
    .from('user_data')
    .select('user_id,watchlist,settings')
    .not('watchlist', 'is', null)
    .limit(2000);
  if (error) throw error;
  if (!rows?.length) return json({ users: 0, sent: 0 });

  const site = await setting<{ url?: string }>('site');
  // one read per coin, shared across every subscriber
  const cache = new Map<string, { price: number; changePct: number; text: string; score: number } | null>();

  const read = async (symbol: string) => {
    if (cache.has(symbol)) return cache.get(symbol);
    try {
      let candles = await klines(symbol, '4h', 400);
      if (candles.length && candles[candles.length - 1].t + 144e5 > Date.now()) candles = candles.slice(0, -1);
      const sig = generateSignal(candles, { interval: '4h' });
      const last = candles[candles.length - 1];
      const dayAgo = candles[Math.max(0, candles.length - 7)];
      const out = sig.ok
        ? { price: sig.price, changePct: ((last.c / dayAgo.c) - 1) * 100, text: sig.text, score: sig.score }
        : null;
      cache.set(symbol, out);
      return out;
    } catch { cache.set(symbol, null); return null; }
  };

  let sent = 0, considered = 0;
  for (const r of rows) {
    const wl: string[] = Array.isArray(r.watchlist) ? r.watchlist.slice(0, 12) : [];
    if (!wl.length) continue;
    const prefs = (r.settings || {}) as Record<string, unknown>;
    if (prefs.digest === false) continue;
    considered++;

    const { data: p } = await admin.from('profiles').select('telegram_chat_id,email,email_verified,email_alerts').eq('id', r.user_id).single();
    const hasChannel = p?.telegram_chat_id || (p?.email && p.email_verified && p.email_alerts);
    if (!hasChannel) continue;

    const reads: string[] = [];
    const movers: { sym: string; chg: number }[] = [];
    for (const sym of wl) {
      const d = await read(String(sym).toUpperCase());
      if (!d) continue;
      movers.push({ sym: String(sym).toUpperCase(), chg: d.changePct });
      reads.push(`${d.score > 0 ? '🟢' : d.score < 0 ? '🔴' : '⚪️'} <b>${escHtml(String(sym).toUpperCase())}</b> $${fmtPrice(d.price)} (${d.changePct >= 0 ? '+' : ''}${d.changePct.toFixed(1)}% 24h) — ${escHtml(d.text)}`);
    }
    if (!reads.length) continue;

    movers.sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg));
    const top = movers[0];
    const head = `📋 <b>Your watchlist today</b>\nBiggest move: <b>${escHtml(top.sym)}</b> ${top.chg >= 0 ? '+' : ''}${top.chg.toFixed(1)}%`;
    const link = site?.url ? `\n\n<a href="${escHtml(site.url)}#/advice">See what to buy →</a>` : '';
    const text = `${head}\n\n${reads.join('\n')}${link}\n\n<i>Readings from the 4h chart. Not financial advice.</i>`;

    if (p?.telegram_chat_id) await sendTelegram(p.telegram_chat_id, text);
    if (p?.email && p.email_verified && p.email_alerts) {
      await sendEmail(p.email, `Your watchlist: ${top.sym} ${top.chg >= 0 ? '+' : ''}${top.chg.toFixed(1)}%`,
        `<div style="font-family:system-ui,sans-serif"><h2>📋 Your watchlist today</h2>
         <ul>${reads.map((l) => `<li>${l}</li>`).join('')}</ul>
         ${site?.url ? `<p><a href="${escHtml(site.url)}#/advice">See what to buy</a></p>` : ''}
         <p style="color:#888">Readings from the 4h chart. Not financial advice.</p></div>`);
    }
    sent++;
  }
  return json({ users: considered, sent });
}

