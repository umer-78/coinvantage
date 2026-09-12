// Shared helpers for CoinVantage edge functions.
import { createClient } from 'npm:@supabase/supabase-js@2.116.0';

export const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
export const admin = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });

export class HttpError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export function handle(fn: (req: Request) => Promise<Response>) {
  return async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
    try {
      return await fn(req);
    } catch (err) {
      const e = err as HttpError;
      if (!e.status || e.status >= 500) console.error(err);
      return json({ error: e.message || 'Server error' }, e.status || 500);
    }
  };
}

const secretCache = new Map<string, { v: string | null; at: number }>();
export async function secret(name: string): Promise<string | null> {
  const hit = secretCache.get(name);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  const { data, error } = await admin.rpc('get_app_secret', { secret_name: name });
  if (error) throw error;
  secretCache.set(name, { v: data ?? null, at: Date.now() });
  return data ?? null;
}

export async function requireCron(req: Request) {
  const expected = await secret('cron_secret');
  if (!expected || req.headers.get('x-cron-secret') !== expected) throw new HttpError('Forbidden', 403);
}

export async function getUser(req: Request) {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error) return null;
  return data.user ?? null;
}

export async function requireUser(req: Request) {
  const user = await getUser(req);
  if (!user) throw new HttpError('Please sign in first.', 401);
  return user;
}

export async function getProfile(userId: string) {
  const { data } = await admin.from('profiles').select('*').eq('id', userId).single();
  return data;
}

export async function setting<T = Record<string, unknown>>(key: string): Promise<T | null> {
  const { data } = await admin.from('app_settings').select('value').eq('key', key).maybeSingle();
  return (data?.value as T) ?? null;
}

// Fixed-window rate limit backed by the rate_limits table.
export async function rateLimit(key: string, limit: number, windowSec: number) {
  const now = new Date();
  const { data } = await admin.from('rate_limits').select('*').eq('key', key).maybeSingle();
  if (!data || now.getTime() - new Date(data.window_start).getTime() > windowSec * 1000) {
    await admin.from('rate_limits').upsert({ key, window_start: now.toISOString(), hits: 1 });
    return;
  }
  if (data.hits >= limit) throw new HttpError('Too many attempts. Please wait a while and try again.', 429);
  await admin.from('rate_limits').update({ hits: data.hits + 1 }).eq('key', key);
}

export const clientIp = (req: Request) =>
  (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('cf-connecting-ip') || 'unknown';

export const escHtml = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export function fmtPrice(v: number) {
  const a = Math.abs(v);
  const dp = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 6 : 8;
  return Number(v.toFixed(dp)).toLocaleString('en-US', { maximumFractionDigits: dp });
}

// ------------------------------------------------------------------ messaging
export async function sendTelegram(chatId: number | string, text: string, extra: Record<string, unknown> = {}) {
  const token = await secret('telegram_bot_token');
  if (!token) return { ok: false, error: 'Telegram bot not configured' };
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }),
  });
  return await r.json();
}

export async function telegramApi(method: string, payload: Record<string, unknown>, token?: string) {
  const t = token || (await secret('telegram_bot_token'));
  if (!t) throw new HttpError('Telegram bot token is not set', 400);
  const r = await fetch(`https://api.telegram.org/bot${t}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  return await r.json();
}

export async function sendEmail(to: string, subject: string, html: string) {
  const key = await secret('resend_api_key');
  if (!key) return { ok: false, error: 'Email not configured' };
  const from = (await secret('resend_from')) || 'CoinVantage <onboarding@resend.dev>';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok, ...body };
}

// ------------------------------------------------------------------ market data
const BINANCE = ['https://data-api.binance.vision', 'https://api.binance.com'];

export async function fetchJson(url: string, timeout = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0 CoinVantage' } });
    if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

export async function binance(path: string) {
  let last: unknown;
  for (const b of BINANCE) {
    try { return await fetchJson(b + path); } catch (e) { last = e; }
  }
  throw last;
}

// Latest USDT prices for the given base symbols (Binance, OKX fallback).
export async function prices(symbols: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    const all = await binance('/api/v3/ticker/price') as { symbol: string; price: string }[];
    const wanted = new Set(symbols.map((s) => `${s}USDT`));
    for (const r of all) if (wanted.has(r.symbol)) out[r.symbol.slice(0, -4)] = +r.price;
  } catch { /* fall back below */ }
  await Promise.all(symbols.filter((s) => !(s in out)).map(async (s) => {
    try {
      const r = await fetchJson(`https://www.okx.com/api/v5/market/ticker?instId=${s}-USDT`);
      if (r.data?.[0]?.last) out[s] = +r.data[0].last;
    } catch { /* unavailable */ }
  }));
  return out;
}

export async function klines(symbol: string, interval: string, limit = 500, startTime?: number, endTime?: number) {
  const q = `/api/v3/klines?symbol=${symbol}USDT&interval=${interval}&limit=${limit}${startTime ? `&startTime=${startTime}` : ''}${endTime ? `&endTime=${endTime}` : ''}`;
  const rows = await binance(q) as unknown[][];
  return rows.map((k) => ({ t: k[0] as number, o: +(k[1] as string), h: +(k[2] as string), l: +(k[3] as string), c: +(k[4] as string), v: +(k[5] as string) }));
}

export async function sha256Hex(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomCode(len = 6, alphabet = '0123456789') {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}
