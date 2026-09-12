// Admin panel backend. Every action requires a signed-in admin.
import { admin, json, HttpError, requireUser, getProfile, secret, setting, telegramApi, SUPABASE_URL } from './lib.ts';

const SECRET_NAMES = ['telegram_bot_token', 'resend_api_key', 'resend_from', 'stripe_secret_key', 'stripe_webhook_secret'];
const SETTING_KEYS = ['premium', 'site', 'tracking'];

export async function adminApi(req: Request): Promise<Response> {
  const user = await requireUser(req);
  const me = await getProfile(user.id);
  if (!me?.is_admin) throw new HttpError('Admins only', 403);
  const body = await req.json().catch(() => ({}));

  switch (body.action) {
    case 'stats': {
      const since = new Date(Date.now() - 30 * 864e5).toISOString();
      const nowIso = new Date().toISOString();
      const count = async (table: string, build: (q: any) => any = (q) => q) => {
        const { count } = await build(admin.from(table).select('*', { count: 'exact', head: true }));
        return count ?? 0;
      };
      const [users, premium, telegram, activeAlerts, triggered, posts, news, signals] = await Promise.all([
        count('profiles'),
        count('profiles', (q) => q.gt('premium_until', nowIso)),
        count('profiles', (q) => q.not('telegram_chat_id', 'is', null)),
        count('alerts', (q) => q.eq('active', true)),
        count('alerts', (q) => q.not('triggered_at', 'is', null)),
        count('posts'),
        count('news'),
        count('signal_log'),
      ]);
      const { data: views } = await admin.from('page_views').select('path,created_at,device,session_id').gte('created_at', since).limit(50000);
      const byDay: Record<string, number> = {}, byPath: Record<string, number> = {}, byDevice: Record<string, number> = {};
      const sessions = new Set<string>();
      for (const v of views || []) {
        const d = v.created_at.slice(0, 10);
        byDay[d] = (byDay[d] || 0) + 1;
        const p = v.path.split('/').slice(0, 2).join('/') || '/';
        byPath[p] = (byPath[p] || 0) + 1;
        byDevice[v.device || 'unknown'] = (byDevice[v.device || 'unknown'] || 0) + 1;
        if (v.session_id) sessions.add(v.session_id);
      }
      const { data: recentUsers } = await admin.from('profiles').select('email,display_name,created_at,premium_until,is_admin,telegram_chat_id').order('created_at', { ascending: false }).limit(8);
      return json({ users, premium, telegram, activeAlerts, triggered, posts, news, signals, views: views?.length || 0, visitors: sessions.size, byDay, byPath, byDevice, recentUsers });
    }

    case 'users': {
      const q = String(body.q || '').trim();
      let query = admin.from('profiles').select('id,email,display_name,created_at,premium_until,is_admin,telegram_chat_id,email_verified').order('created_at', { ascending: false }).limit(50);
      if (q) query = query.ilike('email', `%${q.replace(/[%_]/g, '')}%`);
      const { data, error } = await query;
      if (error) throw error;
      return json({ users: data });
    }

    case 'grant-premium': {
      const email = String(body.email || '').trim().toLowerCase();
      const days = Math.max(1, Math.min(3650, Number(body.days) || 30));
      const { data: p } = await admin.from('profiles').select('id,premium_until').eq('email', email).maybeSingle();
      if (!p) throw new HttpError('No user with that e-mail', 404);
      const base = p.premium_until && new Date(p.premium_until) > new Date() ? new Date(p.premium_until) : new Date();
      const until = new Date(base.getTime() + days * 864e5).toISOString();
      await admin.from('profiles').update({ premium_until: until }).eq('id', p.id);
      await admin.from('subscriptions').insert({ user_id: p.id, provider: 'manual', plan: `${days} days`, premium_until: until, note: String(body.note || '').slice(0, 200) || `Granted by ${me.email}` });
      return json({ ok: true, premium_until: until });
    }

    case 'revoke-premium': {
      const email = String(body.email || '').trim().toLowerCase();
      const { error } = await admin.from('profiles').update({ premium_until: null }).eq('email', email);
      if (error) throw error;
      return json({ ok: true });
    }

    case 'set-admin': {
      const email = String(body.email || '').trim().toLowerCase();
      if (email === me.email && !body.value) throw new HttpError("You can't remove your own admin access.");
      await admin.from('profiles').update({ is_admin: !!body.value }).eq('email', email);
      if (body.value) await admin.from('admin_emails').upsert({ email }); else await admin.from('admin_emails').delete().eq('email', email);
      return json({ ok: true });
    }

    case 'set-password': {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (password.length < 8) throw new HttpError('Password must be at least 8 characters.');
      const { data: p } = await admin.from('profiles').select('id').eq('email', email).maybeSingle();
      if (!p) throw new HttpError('No user with that e-mail', 404);
      const { error } = await admin.auth.admin.updateUserById(p.id, { password });
      if (error) throw new HttpError(error.message);
      return json({ ok: true });
    }

    case 'save-setting': {
      if (!SETTING_KEYS.includes(body.key)) throw new HttpError('Unknown setting');
      if (typeof body.value !== 'object' || JSON.stringify(body.value).length > 20000) throw new HttpError('Invalid value');
      const current = (await setting(body.key)) || {};
      const { error } = await admin.from('app_settings').upsert({ key: body.key, value: { ...current, ...body.value }, is_public: true, updated_at: new Date().toISOString() });
      if (error) throw error;
      return json({ ok: true });
    }

    case 'secrets-status': {
      const status: Record<string, boolean> = {};
      for (const n of SECRET_NAMES) status[n] = !!(await secret(n));
      const tg = await setting<{ bot_username: string | null }>('telegram');
      return json({ status, telegramBot: tg?.bot_username || null, webhookUrl: `${SUPABASE_URL}/functions/v1/cv/stripe` });
    }

    case 'set-secret': {
      const name = String(body.name || '');
      const value = String(body.value || '').trim();
      if (!SECRET_NAMES.includes(name)) throw new HttpError('Unknown secret');
      if (!value || value.length > 500) throw new HttpError('Enter a value');
      if (name === 'telegram_bot_token') {
        const meInfo = await telegramApi('getMe', {}, value);
        if (!meInfo.ok) throw new HttpError('Telegram rejected that bot token. Copy it again from @BotFather.');
        const hook = await telegramApi('setWebhook', {
          url: `${SUPABASE_URL}/functions/v1/cv/telegram`,
          secret_token: await secret('telegram_webhook_secret'),
          allowed_updates: ['message'],
          drop_pending_updates: true,
        }, value);
        if (!hook.ok) throw new HttpError(`Could not set the Telegram webhook: ${hook.description}`);
        await telegramApi('setMyCommands', { commands: [
          { command: 'price', description: 'Live price, e.g. /price BTC' },
          { command: 'signal', description: 'Technical signal, e.g. /signal ETH' },
          { command: 'alerts', description: 'Your active price alerts' },
          { command: 'unlink', description: 'Stop alerts in this chat' },
        ] }, value);
        await admin.from('app_settings').upsert({ key: 'telegram', value: { bot_username: meInfo.result.username }, is_public: true });
      }
      const { error } = await admin.rpc('set_app_secret', { secret_name: name, secret_value: value });
      if (error) throw error;
      return json({ ok: true });
    }

    case 'run-job': {
      const job = { news: 'news-fetch', signals: 'track-signals', alerts: 'alerts-check' }[String(body.job)];
      if (!job) throw new HttpError('Unknown job');
      const r = await fetch(`${SUPABASE_URL}/functions/v1/cv/${job}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-cron-secret': (await secret('cron_secret')) || '' },
        body: JSON.stringify(body.batch !== undefined ? { batch: body.batch } : {}),
      });
      return json({ ok: r.ok, result: await r.json().catch(() => null) });
    }

    default:
      throw new HttpError('Unknown action');
  }
}
