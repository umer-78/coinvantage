// Account actions: sign-up (no confirmation e-mail needed), e-mail verification & password
// reset codes (when e-mail is configured), Telegram linking, Stripe checkout.
import {
  admin, json, HttpError, requireUser, getProfile, rateLimit, clientIp, secret, setting,
  sendEmail, sendTelegram, sha256Hex, randomCode, escHtml, SUPABASE_URL,
} from './lib.ts';

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[a-z]{2,24}$/i;

async function codeHash(email: string, code: string) {
  return sha256Hex(`${email.toLowerCase()}:${code}:${(await secret('cron_secret')) || ''}`);
}

export async function account(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || '');

  switch (action) {
    case 'signup': {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const name = String(body.display_name || '').trim().slice(0, 60);
      if (!EMAIL_RE.test(email)) throw new HttpError('Please enter a valid e-mail address.');
      if (password.length < 8) throw new HttpError('Password must be at least 8 characters.');
      await rateLimit(`signup:${clientIp(req)}`, 5, 3600);
      await rateLimit('signup:global', 300, 3600);
      const { error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { display_name: name || email.split('@')[0] },
      });
      if (error) {
        if (/already|registered|exists/i.test(error.message)) throw new HttpError('An account with this e-mail already exists. Try signing in.', 409);
        throw new HttpError(error.message, 400);
      }
      return json({ ok: true });
    }

    case 'email-status': {
      const hasEmail = !!(await secret('resend_api_key'));
      return json({ emailEnabled: hasEmail });
    }

    case 'send-code': {
      const purpose = body.purpose === 'reset' ? 'reset' : 'verify';
      let email = String(body.email || '').trim().toLowerCase();
      if (purpose === 'verify') {
        const user = await requireUser(req);
        email = user.email!.toLowerCase();
      }
      if (!EMAIL_RE.test(email)) throw new HttpError('Please enter a valid e-mail address.');
      if (!(await secret('resend_api_key'))) throw new HttpError('E-mail sending is not set up on this site yet. Contact the site admin.', 503);
      await rateLimit(`code:${email}`, 3, 900);
      await rateLimit(`code-ip:${clientIp(req)}`, 10, 3600);
      // Don't reveal whether an account exists for password resets.
      if (purpose === 'reset') {
        const { data } = await admin.from('profiles').select('id').eq('email', email).maybeSingle();
        if (!data) return json({ ok: true });
      }
      const code = randomCode(6);
      await admin.from('auth_codes').insert({ email, purpose, code_hash: await codeHash(email, code), expires_at: new Date(Date.now() + 15 * 60e3).toISOString() });
      const title = purpose === 'verify' ? 'Verify your e-mail' : 'Reset your password';
      await sendEmail(email, `${title} — code ${code}`, `<div style="font-family:system-ui,sans-serif"><h2>${title}</h2><p>Your CoinVantage code is:</p><p style="font-size:28px;font-weight:800;letter-spacing:4px">${code}</p><p>It expires in 15 minutes. If you didn't request this, ignore this e-mail.</p></div>`);
      return json({ ok: true });
    }

    case 'verify-email': {
      const user = await requireUser(req);
      await checkCode(user.email!, 'verify', String(body.code || ''));
      await admin.from('profiles').update({ email_verified: true }).eq('id', user.id);
      return json({ ok: true });
    }

    case 'reset-password': {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (password.length < 8) throw new HttpError('Password must be at least 8 characters.');
      await rateLimit(`reset:${clientIp(req)}`, 10, 3600);
      await checkCode(email, 'reset', String(body.code || ''));
      const { data: prof } = await admin.from('profiles').select('id').eq('email', email).maybeSingle();
      if (!prof) throw new HttpError('Invalid code.', 400);
      const { error } = await admin.auth.admin.updateUserById(prof.id, { password });
      if (error) throw new HttpError(error.message, 400);
      return json({ ok: true });
    }

    case 'telegram-link': {
      const user = await requireUser(req);
      const tg = await setting<{ bot_username: string | null }>('telegram');
      if (!tg?.bot_username || !(await secret('telegram_bot_token'))) throw new HttpError('Telegram alerts are not set up on this site yet.', 503);
      const code = randomCode(10, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789');
      await admin.from('profiles').update({ telegram_link_code: code, telegram_link_expires: new Date(Date.now() + 20 * 60e3).toISOString() }).eq('id', user.id);
      return json({ ok: true, bot: tg.bot_username, url: `https://t.me/${tg.bot_username}?start=${code}`, code });
    }

    case 'telegram-unlink': {
      const user = await requireUser(req);
      await admin.from('profiles').update({ telegram_chat_id: null, telegram_username: null }).eq('id', user.id);
      return json({ ok: true });
    }

    case 'test-alert': {
      const user = await requireUser(req);
      await rateLimit(`test:${user.id}`, 5, 600);
      const p = await getProfile(user.id);
      const results: Record<string, unknown> = {};
      if (p?.telegram_chat_id) results.telegram = await sendTelegram(p.telegram_chat_id, '✅ <b>CoinVantage test alert</b>\nYour Telegram alerts are working.');
      if (p?.email_verified && p?.email_alerts) results.email = await sendEmail(p.email, 'CoinVantage test alert', '<p>✅ Your e-mail alerts are working.</p>');
      if (!Object.keys(results).length) throw new HttpError('Link Telegram or verify your e-mail first.');
      return json({ ok: true, results });
    }

    case 'checkout': {
      const user = await requireUser(req);
      const premium = await setting<{ price: number; currency: string; period_days: number; stripe_enabled: boolean }>('premium');
      const key = await secret('stripe_secret_key');
      if (!premium?.stripe_enabled || !key) throw new HttpError('Online card payments are not enabled. Use the manual payment option.', 503);
      const origin = String(body.return_url || '').startsWith('http') ? String(body.return_url).split('#')[0] : '';
      if (!origin) throw new HttpError('Missing return URL');
      const form = new URLSearchParams({
        mode: 'payment',
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]': (premium.currency || 'USD').toLowerCase(),
        'line_items[0][price_data][unit_amount]': String(Math.round((premium.price || 19) * 100)),
        'line_items[0][price_data][product_data][name]': `CoinVantage Premium — ${premium.period_days || 30} days`,
        client_reference_id: user.id,
        customer_email: user.email || '',
        success_url: `${origin}#/account?paid=1`,
        cancel_url: `${origin}#/premium`,
        'metadata[user_id]': user.id,
      });
      const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded' }, body: form,
      });
      const session = await r.json();
      if (!r.ok) throw new HttpError(session.error?.message || 'Stripe error', 502);
      return json({ ok: true, url: session.url });
    }

    case 'delete-account': {
      const user = await requireUser(req);
      const { error } = await admin.auth.admin.deleteUser(user.id);
      if (error) throw new HttpError(error.message, 400);
      return json({ ok: true });
    }

    default:
      throw new HttpError('Unknown action', 400);
  }
}

async function checkCode(email: string, purpose: string, code: string) {
  if (!/^\d{6}$/.test(code)) throw new HttpError('Enter the 6-digit code.');
  const { data: rows } = await admin.from('auth_codes').select('*').eq('email', email.toLowerCase()).eq('purpose', purpose)
    .gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1);
  const row = rows?.[0];
  if (!row || row.attempts >= 5) throw new HttpError('Code expired. Request a new one.', 400);
  if (row.code_hash !== (await codeHash(email, code))) {
    await admin.from('auth_codes').update({ attempts: row.attempts + 1 }).eq('id', row.id);
    throw new HttpError('Wrong code.', 400);
  }
  await admin.from('auth_codes').delete().eq('email', email.toLowerCase()).eq('purpose', purpose);
}

// referenced to keep the import used in some bundlers
void escHtml; void SUPABASE_URL;
