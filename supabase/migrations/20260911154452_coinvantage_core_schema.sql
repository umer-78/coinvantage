-- ============================================================ CoinVantage core schema
-- Admin allow-list (who becomes admin on sign-up). Service-role only.
create table public.admin_emails (email text primary key);
alter table public.admin_emails enable row level security;

-- Public/app settings (premium price, bot username, payment text...). Readable by everyone when is_public.
create table public.app_settings (
  key text primary key,
  value jsonb not null,
  is_public boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
create policy "public settings are readable" on public.app_settings for select to anon, authenticated using (is_public);

-- Profiles
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text check (char_length(display_name) <= 60),
  is_admin boolean not null default false,
  premium_until timestamptz,
  telegram_chat_id bigint,
  telegram_username text,
  telegram_link_code text unique,
  telegram_link_expires timestamptz,
  email_verified boolean not null default false,
  email_alerts boolean not null default false,
  currency text not null default 'USD' check (char_length(currency) <= 5),
  lang text not null default 'en' check (lang in ('en', 'ur')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "users read own profile" on public.profiles for select to authenticated using ((select auth.uid()) = id);
create policy "users update own profile" on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
-- Only harmless columns are user-editable; admin/premium/telegram/verification columns are changed by edge functions.
revoke update on public.profiles from authenticated, anon;
grant update (display_name, email_alerts, currency, lang) on public.profiles to authenticated;

-- Helper checks (security definer so they can be used inside RLS policies)
create or replace function public.is_admin(uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = uid), false);
$$;
create or replace function public.is_premium(uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.premium_until > now() or p.is_admin from public.profiles p where p.id = uid), false);
$$;
revoke execute on function public.is_admin(uuid) from public, anon;
revoke execute on function public.is_premium(uuid) from public, anon;
grant execute on function public.is_admin(uuid) to authenticated, service_role;
grant execute on function public.is_premium(uuid) to authenticated, service_role;

create policy "admins read all profiles" on public.profiles for select to authenticated using (public.is_admin((select auth.uid())));

-- Create a profile for every new auth user
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, display_name, is_admin)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)),
    exists (select 1 from public.admin_emails a where lower(a.email) = lower(new.email))
  );
  insert into public.user_data (user_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

-- Cloud sync of per-user app state
create table public.user_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  watchlist jsonb not null default '[]'::jsonb,
  holdings jsonb not null default '[]'::jsonb,
  wallets jsonb not null default '[]'::jsonb,
  drawings jsonb not null default '{}'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint user_data_size check (pg_column_size(watchlist) + pg_column_size(holdings) + pg_column_size(wallets) + pg_column_size(drawings) + pg_column_size(settings) < 200000)
);
alter table public.user_data enable row level security;
create policy "users read own data" on public.user_data for select to authenticated using ((select auth.uid()) = user_id);
create policy "users insert own data" on public.user_data for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "users update own data" on public.user_data for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Server-side price alerts (Telegram / email)
create table public.alerts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  symbol text not null check (symbol ~ '^[A-Z0-9]{1,15}$'),
  direction text not null check (direction in ('above', 'below')),
  price numeric not null check (price > 0),
  note text check (char_length(note) <= 140),
  channels text[] not null default array['telegram']::text[] check (channels <@ array['telegram', 'email', 'browser']::text[]),
  active boolean not null default true,
  triggered_at timestamptz,
  triggered_price numeric,
  created_at timestamptz not null default now()
);
create index alerts_active_idx on public.alerts (symbol) where active;
create index alerts_user_idx on public.alerts (user_id);
alter table public.alerts enable row level security;
create policy "users read own alerts" on public.alerts for select to authenticated using ((select auth.uid()) = user_id);
create policy "users create own alerts" on public.alerts for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "users update own alerts" on public.alerts for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "users delete own alerts" on public.alerts for delete to authenticated using ((select auth.uid()) = user_id);

-- Free vs premium alert limits
create or replace function public.enforce_alert_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  active_count int;
  lim int;
begin
  select count(*) into active_count from public.alerts where user_id = new.user_id and active;
  lim := case when public.is_premium(new.user_id) then 50 else 3 end;
  if active_count >= lim then
    raise exception 'Alert limit reached (% active). Upgrade to premium for more alerts.', lim using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger alerts_limit before insert on public.alerts for each row execute function public.enforce_alert_limit();

-- Public signal & forecast track record (written by the scheduled edge function)
create table public.signal_log (
  id bigint generated always as identity primary key,
  symbol text not null,
  interval text not null,
  created_at timestamptz not null default now(),
  candle_time timestamptz not null,
  price numeric not null,
  action text not null,
  score int not null,
  plan jsonb,
  prob_up numeric,
  horizon_bars int,
  horizon_at timestamptz,
  forecast_target numeric,
  model_accuracy numeric,
  resolved boolean not null default false,
  resolved_at timestamptz,
  outcome_price numeric,
  forecast_correct boolean,
  plan_result text check (plan_result in ('tp1', 'tp2', 'stop', 'expired', 'none')),
  plan_return_pct numeric,
  unique (symbol, interval, candle_time)
);
create index signal_log_created_idx on public.signal_log (created_at desc);
create index signal_log_unresolved_idx on public.signal_log (horizon_at) where not resolved;
alter table public.signal_log enable row level security;
create policy "track record is public" on public.signal_log for select to anon, authenticated using (true);

-- Admin posts: VIP signals, analysis, announcements
create table public.posts (
  id bigint generated always as identity primary key,
  author uuid references auth.users(id) on delete set null default auth.uid(),
  kind text not null default 'signal' check (kind in ('signal', 'analysis', 'announcement')),
  title text not null check (char_length(title) between 3 and 140),
  body text check (char_length(body) <= 5000),
  symbol text check (symbol ~ '^[A-Z0-9]{1,15}$'),
  side text check (side in ('long', 'short')),
  entry numeric,
  stop_loss numeric,
  targets numeric[],
  premium_only boolean not null default false,
  status text not null default 'open' check (status in ('open', 'hit_target', 'stopped', 'closed')),
  result_pct numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index posts_created_idx on public.posts (created_at desc);
alter table public.posts enable row level security;
create policy "admins manage posts" on public.posts for all to authenticated using (public.is_admin((select auth.uid()))) with check (public.is_admin((select auth.uid())));

-- Posts are read through this function: premium details are hidden from free users.
create or replace function public.get_posts(max_rows int default 30)
returns table (id bigint, kind text, title text, body text, symbol text, side text, entry numeric, stop_loss numeric, targets numeric[], premium_only boolean, locked boolean, status text, result_pct numeric, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select p.id, p.kind, p.title,
    case when p.premium_only and not public.is_premium((select auth.uid())) then null else p.body end,
    p.symbol, p.side,
    case when p.premium_only and not public.is_premium((select auth.uid())) then null else p.entry end,
    case when p.premium_only and not public.is_premium((select auth.uid())) then null else p.stop_loss end,
    case when p.premium_only and not public.is_premium((select auth.uid())) then null else p.targets end,
    p.premium_only,
    (p.premium_only and not public.is_premium((select auth.uid()))) as locked,
    p.status, p.result_pct, p.created_at
  from public.posts p
  order by p.created_at desc
  limit least(greatest(max_rows, 1), 100);
$$;
grant execute on function public.get_posts(int) to anon, authenticated;

-- News cache (filled by the scheduled RSS function)
create table public.news (
  id text primary key,
  source text not null,
  title text not null,
  link text not null,
  summary text,
  image text,
  coins text[] not null default '{}',
  published_at timestamptz not null,
  fetched_at timestamptz not null default now()
);
create index news_published_idx on public.news (published_at desc);
create index news_coins_idx on public.news using gin (coins);
alter table public.news enable row level security;
create policy "news is public" on public.news for select to anon, authenticated using (true);

-- Privacy-friendly page view analytics (no IPs stored)
create table public.page_views (
  id bigint generated always as identity primary key,
  path text not null check (char_length(path) <= 120),
  referrer text check (char_length(referrer) <= 200),
  lang text check (char_length(lang) <= 12),
  device text check (device in ('mobile', 'desktop', 'tablet')),
  session_id text check (char_length(session_id) <= 40),
  created_at timestamptz not null default now()
);
create index page_views_created_idx on public.page_views (created_at desc);
alter table public.page_views enable row level security;
create policy "anyone can record a page view" on public.page_views for insert to anon, authenticated with check (true);
create policy "admins read page views" on public.page_views for select to authenticated using (public.is_admin((select auth.uid())));

-- Payments / premium history
create table public.subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  provider text not null check (provider in ('stripe', 'manual')),
  provider_ref text,
  plan text,
  amount numeric,
  currency text,
  premium_until timestamptz,
  note text,
  created_at timestamptz not null default now()
);
alter table public.subscriptions enable row level security;
create policy "users read own payments" on public.subscriptions for select to authenticated using ((select auth.uid()) = user_id or public.is_admin((select auth.uid())));

-- Short-lived verification / reset codes and sign-up rate limiting (service-role only)
create table public.auth_codes (
  id bigint generated always as identity primary key,
  email text not null,
  purpose text not null check (purpose in ('verify', 'reset')),
  code_hash text not null,
  attempts int not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.auth_codes enable row level security;
create table public.rate_limits (
  key text primary key,
  window_start timestamptz not null default now(),
  hits int not null default 0
);
alter table public.rate_limits enable row level security;

-- Secret access for edge functions only (values live in Supabase Vault)
create or replace function public.get_app_secret(secret_name text) returns text
language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = secret_name limit 1;
$$;
revoke execute on function public.get_app_secret(text) from public, anon, authenticated;
grant execute on function public.get_app_secret(text) to service_role;

create or replace function public.set_app_secret(secret_name text, secret_value text) returns void
language plpgsql security definer set search_path = '' as $$
declare existing uuid;
begin
  select id into existing from vault.secrets where name = secret_name;
  if existing is null then
    perform vault.create_secret(secret_value, secret_name);
  else
    perform vault.update_secret(existing, secret_value, secret_name);
  end if;
end;
$$;
revoke execute on function public.set_app_secret(text, text) from public, anon, authenticated;
grant execute on function public.set_app_secret(text, text) to service_role;

-- updated_at maintenance
create or replace function public.touch_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end; $$;
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
create trigger posts_touch before update on public.posts for each row execute function public.touch_updated_at();
create trigger user_data_touch before update on public.user_data for each row execute function public.touch_updated_at();

-- Default public settings
insert into public.app_settings (key, value) values
  ('premium', '{"enabled": true, "price": 19, "currency": "USD", "period_days": 30, "stripe_enabled": false, "manual_payment_text": "Contact us to activate Premium with a bank transfer or local payment method.", "perks": ["VIP trade signals with entry, stop-loss and targets", "Up to 50 Telegram & email price alerts", "Priority access to new AI features"]}'),
  ('telegram', '{"bot_username": null}'),
  ('site', '{"announcement": null}');
