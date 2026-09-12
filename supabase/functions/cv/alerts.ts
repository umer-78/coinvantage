// Runs every minute (pg_cron): checks active price alerts and sends Telegram / e-mail messages.
import { admin, json, requireCron, prices, sendTelegram, sendEmail, setting, escHtml, fmtPrice } from './lib.ts';

export async function alertsCheck(req: Request): Promise<Response> {
  await requireCron(req);
  const { data: alerts, error } = await admin.from('alerts').select('id,user_id,symbol,direction,price,note,channels').eq('active', true).limit(5000);
  if (error) throw error;
  if (!alerts?.length) return json({ checked: 0, triggered: 0 });

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
  return json({ checked: alerts.length, triggered: hits.length, sent: sent.length });
}
