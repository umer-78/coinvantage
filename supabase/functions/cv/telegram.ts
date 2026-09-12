// Telegram bot webhook: account linking, prices, signals and alert list.
import { admin, secret, sendTelegram, klines, prices, escHtml, fmtPrice, setting } from './lib.ts';
import { generateSignal } from './engine/signals.js';

const HELP = `<b>CoinVantage bot</b>
/price BTC — live price
/signal ETH — technical signal (4h chart)
/alerts — your active price alerts
/unlink — stop alerts on this chat
/help — this message

Link your account from the website: Account → Telegram alerts.
<i>Signals are not financial advice.</i>`;

export async function telegramBot(req: Request): Promise<Response> {
  const expected = await secret('telegram_webhook_secret');
  if (!expected || req.headers.get('x-telegram-bot-api-secret-token') !== expected) return new Response('forbidden', { status: 403 });
  const update = await req.json().catch(() => null);
  const msg = update?.message;
  if (!msg?.text || !msg.chat?.id) return new Response('ok');
  const chatId = msg.chat.id;
  const [cmdRaw, ...args] = String(msg.text).trim().split(/\s+/);
  const cmd = cmdRaw.split('@')[0].toLowerCase();

  try {
    if (cmd === '/start' && args[0]) {
      const code = args[0].toUpperCase().replace(/[^A-Z0-9]/g, '');
      const { data: prof } = await admin.from('profiles').select('id,display_name,telegram_link_expires')
        .eq('telegram_link_code', code).maybeSingle();
      if (!prof || !prof.telegram_link_expires || new Date(prof.telegram_link_expires) < new Date()) {
        await sendTelegram(chatId, '⚠️ That link has expired. Open the website and press “Connect Telegram” again.');
      } else {
        await admin.from('profiles').update({ telegram_chat_id: chatId, telegram_username: msg.from?.username || null, telegram_link_code: null, telegram_link_expires: null }).eq('id', prof.id);
        await sendTelegram(chatId, `✅ Connected! Hi ${escHtml(prof.display_name || '')} — price alerts you create on the website will arrive here.\n\n${HELP}`);
      }
    } else if (cmd === '/start' || cmd === '/help') {
      await sendTelegram(chatId, HELP);
    } else if (cmd === '/price') {
      const sym = (args[0] || 'BTC').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const px = await prices([sym]);
      await sendTelegram(chatId, px[sym] ? `<b>${sym}</b>: $${fmtPrice(px[sym])}` : `Couldn't find a USDT price for ${escHtml(sym)}.`);
    } else if (cmd === '/signal') {
      const sym = (args[0] || 'BTC').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const candles = await klines(sym, '4h', 400);
      const s = generateSignal(candles, { interval: '4h' });
      if (!s.ok) { await sendTelegram(chatId, `Not enough data for ${escHtml(sym)}.`); return new Response('ok'); }
      const site = await setting<{ url?: string }>('site');
      let text = `<b>${sym} · 4h signal: ${s.text}</b> (score ${s.score > 0 ? '+' : ''}${s.score})\nPrice: $${fmtPrice(s.price)}\n`;
      if (s.plan) text += `\n${escHtml(s.plan.title)}\nEntry: ${fmtPrice(s.plan.entryZone[0])} – ${fmtPrice(s.plan.entryZone[1])}\nStop-loss: ${fmtPrice(s.plan.stopLoss)}\nTargets: ${s.plan.takeProfits.map(fmtPrice).join(' / ')}\n`;
      else if (s.waitFor.length) text += `\nNo trade yet. ${escHtml(s.waitFor[0])}\n`;
      text += `\n${s.reasons.bullish.slice(0, 2).map((r: string) => `✅ ${escHtml(r)}`).join('\n')}\n${s.reasons.bearish.slice(0, 2).map((r: string) => `⚠️ ${escHtml(r)}`).join('\n')}`;
      if (site?.url) text += `\n\n<a href="${escHtml(site.url)}#/coin/${sym}">Full chart & AI forecast</a>`;
      text += '\n<i>Not financial advice.</i>';
      await sendTelegram(chatId, text);
    } else if (cmd === '/alerts') {
      const { data: prof } = await admin.from('profiles').select('id').eq('telegram_chat_id', chatId).maybeSingle();
      if (!prof) { await sendTelegram(chatId, 'This chat is not linked to an account yet.'); return new Response('ok'); }
      const { data: alerts } = await admin.from('alerts').select('symbol,direction,price').eq('user_id', prof.id).eq('active', true).limit(50);
      await sendTelegram(chatId, alerts?.length ? `<b>Active alerts</b>\n${alerts.map((a) => `• ${a.symbol} ${a.direction} $${fmtPrice(Number(a.price))}`).join('\n')}` : 'You have no active alerts. Create them on the website.');
    } else if (cmd === '/unlink' || cmd === '/stop') {
      await admin.from('profiles').update({ telegram_chat_id: null, telegram_username: null }).eq('telegram_chat_id', chatId);
      await sendTelegram(chatId, 'Unlinked. You will no longer receive alerts here.');
    } else {
      await sendTelegram(chatId, HELP);
    }
  } catch (err) {
    console.error(err);
    await sendTelegram(chatId, 'Sorry, something went wrong. Please try again in a moment.');
  }
  return new Response('ok');
}
