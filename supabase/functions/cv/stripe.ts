// Stripe webhook: activates Premium after a successful Checkout payment.
import { admin, secret, setting } from './lib.ts';

async function verify(payload: string, header: string, whsec: string) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = parts.t;
  const sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - Number(t)) > 600) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(whsec), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return sigs.includes(hex);
}

export async function stripeWebhook(req: Request): Promise<Response> {
  const whsec = await secret('stripe_webhook_secret');
  const payload = await req.text();
  if (!whsec || !(await verify(payload, req.headers.get('stripe-signature') || '', whsec))) return new Response('invalid signature', { status: 400 });
  const event = JSON.parse(payload);
  if (event.type === 'checkout.session.completed' && event.data.object.payment_status === 'paid') {
    const s = event.data.object;
    const userId = s.client_reference_id || s.metadata?.user_id;
    if (!userId) return new Response('no user', { status: 200 });
    const { data: dup } = await admin.from('subscriptions').select('id').eq('provider_ref', s.id).maybeSingle();
    if (dup) return new Response('ok');
    const premium = await setting<{ period_days: number }>('premium');
    const days = premium?.period_days || 30;
    const { data: p } = await admin.from('profiles').select('premium_until').eq('id', userId).single();
    const base = p?.premium_until && new Date(p.premium_until) > new Date() ? new Date(p.premium_until) : new Date();
    const until = new Date(base.getTime() + days * 864e5).toISOString();
    await admin.from('profiles').update({ premium_until: until }).eq('id', userId);
    await admin.from('subscriptions').insert({ user_id: userId, provider: 'stripe', provider_ref: s.id, plan: `${days} days`, amount: (s.amount_total || 0) / 100, currency: s.currency, premium_until: until });
  }
  return new Response('ok');
}
