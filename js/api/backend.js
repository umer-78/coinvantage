// Optional backend (Supabase): accounts, cloud sync, server-side alerts,
// premium, admin, the public track record and cached news.
// The site works without it — every call degrades gracefully.
import { CONFIG } from '../config.js';

let clientPromise = null;
export const auth = new EventTarget();
auth.user = null;
auth.profile = null;

export const backendEnabled = () => !!(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_KEY);

export async function sb() {
  if (!backendEnabled()) return null;
  if (!clientPromise) {
    clientPromise = (async () => {
      const { createClient } = await import(/* @vite-ignore */ CONFIG.SUPABASE_JS);
      const client = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'cv-auth' },
      });
      client.auth.onAuthStateChange(async (_e, session) => {
        auth.user = session?.user ?? null;
        auth.profile = auth.user ? await loadProfile(client) : null;
        auth.dispatchEvent(new CustomEvent('change'));
      });
      const { data } = await client.auth.getSession();
      auth.user = data.session?.user ?? null;
      if (auth.user) auth.profile = await loadProfile(client);
      auth.dispatchEvent(new CustomEvent('change'));
      return client;
    })().catch((e) => { console.warn('backend unavailable', e); clientPromise = null; return null; });
  }
  return clientPromise;
}

async function loadProfile(client) {
  const { data } = await client.from('profiles').select('*').eq('id', (await client.auth.getUser()).data.user.id).maybeSingle();
  return data;
}

export const isPremium = () => !!(auth.profile && (auth.profile.is_admin || (auth.profile.premium_until && new Date(auth.profile.premium_until) > new Date())));
export const isAdmin = () => !!auth.profile?.is_admin;

export async function refreshProfile() {
  const client = await sb();
  if (!client || !auth.user) return null;
  auth.profile = await loadProfile(client);
  auth.dispatchEvent(new CustomEvent('change'));
  return auth.profile;
}

// ---------------------------------------------------------------- edge function calls
export async function callFn(route, body = {}) {
  const client = await sb();
  if (!client) throw new Error('Backend not configured');
  const { data: { session } } = await client.auth.getSession();
  const res = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/cv/${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: CONFIG.SUPABASE_KEY,
      ...(session?.access_token ? { authorization: `Bearer ${session.access_token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `Request failed (${res.status})`);
  return out;
}

// ---------------------------------------------------------------- auth
export async function signUp(email, password, displayName) {
  await callFn('account', { action: 'signup', email, password, display_name: displayName });
  return signIn(email, password);
}

export async function signIn(email, password) {
  const client = await sb();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message === 'Invalid login credentials' ? 'Wrong e-mail or password.' : error.message);
  await refreshProfile();
  return true;
}

export async function signOut() {
  const client = await sb();
  await client?.auth.signOut();
  auth.user = null; auth.profile = null;
  auth.dispatchEvent(new CustomEvent('change'));
}

export async function updateProfile(patch) {
  const client = await sb();
  if (!client || !auth.user) return;
  await client.from('profiles').update(patch).eq('id', auth.user.id);
  await refreshProfile();
}

// ---------------------------------------------------------------- cloud sync
export async function pullUserData() {
  const client = await sb();
  if (!client || !auth.user) return null;
  const { data } = await client.from('user_data').select('*').eq('user_id', auth.user.id).maybeSingle();
  return data;
}

export async function pushUserData(patch) {
  const client = await sb();
  if (!client || !auth.user) return;
  await client.from('user_data').upsert({ user_id: auth.user.id, ...patch, updated_at: new Date().toISOString() });
}

// ---------------------------------------------------------------- password recovery
//
// Two routes exist because one of them needs a key the site owner may never set:
//  - the app's own 6-digit code flow, which needs an e-mail provider key;
//  - Supabase's built-in auth mailer, which needs nothing at all.
// The second is the fallback, so "Forgot password?" always does something.

/** Sends a recovery link using Supabase's own mailer. No provider key needed. */
export async function sendResetLink(email, redirectTo) {
  const client = await sb();
  if (!client) throw new Error('The account backend is not connected on this deployment.');
  const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) throw new Error(error.message);
}

/**
 * The link lands back here as `#access_token=…&type=recovery`. The client is
 * created with detectSessionInUrl off (it would fight this app's hash router),
 * so the fragment is read and exchanged by hand, then wiped from the address
 * bar — a recovery token sitting in the URL is a token in the browser history.
 */
export async function consumeRecoveryLink() {
  const raw = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  if (!raw.includes('access_token=') || !raw.includes('type=recovery')) return false;
  const p = new URLSearchParams(raw);
  const access_token = p.get('access_token');
  const refresh_token = p.get('refresh_token');
  history.replaceState(null, '', `${location.pathname}${location.search}#/account`);
  if (!access_token || !refresh_token) return false;
  const client = await sb();
  const { error } = await client.auth.setSession({ access_token, refresh_token });
  if (error) throw new Error(error.message);
  return true;
}

// ---------------------------------------------------------------- alerts (server side)
export async function serverAlerts() {
  const client = await sb();
  if (!client || !auth.user) return [];
  const { data } = await client.from('alerts').select('*').order('created_at', { ascending: false }).limit(100);
  return data || [];
}

export async function createServerAlert(alert) {
  const client = await sb();
  const { error } = await client.from('alerts').insert({ ...alert, user_id: auth.user.id });
  if (error) throw new Error(error.message.includes('Alert limit') ? error.message : 'Could not save the alert.');
}

export async function deleteServerAlert(id) {
  const client = await sb();
  await client.from('alerts').delete().eq('id', id);
}

// ---------------------------------------------------------------- content
export async function getPosts(limit = 30) {
  const client = await sb();
  if (!client) return [];
  const { data } = await client.rpc('get_posts', { max_rows: limit });
  return data || [];
}

export async function savePost(post) {
  const client = await sb();
  const { error } = post.id
    ? await client.from('posts').update(post).eq('id', post.id)
    : await client.from('posts').insert(post);
  if (error) throw new Error(error.message);
}

export async function deletePost(id) {
  const client = await sb();
  await client.from('posts').delete().eq('id', id);
}

export async function getNews({ coin = null, limit = 40 } = {}) {
  const client = await sb();
  if (!client) return [];
  let q = client.from('news').select('*').order('published_at', { ascending: false }).limit(limit);
  if (coin) q = q.contains('coins', [coin]);
  const { data } = await q;
  return data || [];
}

export async function getTrackRecord({ symbol = null, limit = 300 } = {}) {
  const client = await sb();
  if (!client) return [];
  let q = client.from('signal_log').select('*').order('candle_time', { ascending: false }).limit(limit);
  if (symbol) q = q.eq('symbol', symbol);
  const { data } = await q;
  return data || [];
}

export async function getAppSettings() {
  const client = await sb();
  if (!client) return {};
  const { data } = await client.from('app_settings').select('key,value');
  return Object.fromEntries((data || []).map((r) => [r.key, r.value]));
}

// ---------------------------------------------------------------- analytics
let viewQueued = false;
export async function trackPageView(path) {
  if (!CONFIG.ANALYTICS || viewQueued) return;
  viewQueued = true;
  setTimeout(() => { viewQueued = false; }, 800);
  try {
    const client = await sb();
    if (!client) return;
    let sid = sessionStorage.getItem('cv-sid');
    if (!sid) { sid = Math.random().toString(36).slice(2, 14); sessionStorage.setItem('cv-sid', sid); }
    const w = window.innerWidth;
    await client.from('page_views').insert({
      path: path.slice(0, 120),
      referrer: (document.referrer || '').slice(0, 200) || null,
      lang: navigator.language?.slice(0, 12) || null,
      device: w < 768 ? 'mobile' : w < 1100 ? 'tablet' : 'desktop',
      session_id: sid,
    });
  } catch { /* analytics must never break the page */ }
}
