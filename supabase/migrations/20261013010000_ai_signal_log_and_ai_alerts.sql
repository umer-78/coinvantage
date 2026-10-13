-- The AI signal's live record: one row per closed candle of a tracked coin,
-- written by the track-signals cron with what the signal said, never changed
-- afterwards except to grade it once its horizon has passed. Public to read,
-- like signal_log; only the server (service role) writes.
create table if not exists public.ai_signal_log (
  id bigint generated always as identity primary key,
  symbol text not null check (symbol ~ '^[A-Z0-9]{1,15}$'),
  "interval" text not null check ("interval" = any (array['15m', '1h', '4h', '1d'])),
  candle_time timestamptz not null,
  price numeric not null,
  action text not null check (action = any (array['buy', 'hold', 'sell', 'wait'])),
  entry numeric,
  stop numeric,
  target numeric,
  opened_at timestamptz,
  exit_price numeric,
  trade_pct numeric,
  horizon_bars integer not null check (horizon_bars > 0),
  horizon_at timestamptz not null,
  resolved boolean not null default false,
  resolved_at timestamptz,
  outcome_price numeric,
  fwd_up boolean,
  fwd_ret_pct numeric,
  created_at timestamptz not null default now(),
  unique (symbol, "interval", candle_time)
);
create index if not exists ai_signal_log_due on public.ai_signal_log (resolved, horizon_at);
alter table public.ai_signal_log enable row level security;
create policy "ai signal record is public" on public.ai_signal_log for select to anon, authenticated using (true);

-- AI signal alerts, in their own table so the existing alerts table and its
-- checks stay as they are. side: long = buys only, short = sells only, any.
create table if not exists public.ai_alerts (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  symbol text not null check (symbol ~ '^[A-Z0-9]{1,15}$'),
  "interval" text not null check ("interval" = any (array['15m', '1h', '4h', '1d'])),
  side text not null default 'any' check (side = any (array['long', 'short', 'any'])),
  channels text[] not null default array['telegram', 'email'] check (channels <@ array['telegram', 'email']),
  active boolean not null default true,
  repeat boolean not null default true,
  last_fired_at timestamptz,
  triggered_at timestamptz,
  triggered_price numeric,
  created_at timestamptz not null default now()
);
create index if not exists ai_alerts_user on public.ai_alerts (user_id);
create index if not exists ai_alerts_active on public.ai_alerts (active);
alter table public.ai_alerts enable row level security;
create policy "users read own ai alerts" on public.ai_alerts for select to authenticated using ((select auth.uid()) = user_id);
create policy "users create own ai alerts" on public.ai_alerts for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "users update own ai alerts" on public.ai_alerts for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "users delete own ai alerts" on public.ai_alerts for delete to authenticated using ((select auth.uid()) = user_id);

-- The same limit as price and signal alerts, counted across both tables.
create function public.enforce_ai_alert_limit() returns trigger language plpgsql security definer set search_path = '' as $fn$
declare
  active_count int;
  lim int;
begin
  select (select count(*) from public.alerts where user_id = new.user_id and active)
       + (select count(*) from public.ai_alerts where user_id = new.user_id and active)
    into active_count;
  lim := case when private.is_premium(new.user_id) then 50 else 3 end;
  if active_count >= lim then
    raise exception 'Alert limit reached (% active). Upgrade to premium for more alerts.', lim using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;
revoke execute on function public.enforce_ai_alert_limit() from public, anon, authenticated;
create trigger ai_alerts_limit before insert on public.ai_alerts for each row execute function public.enforce_ai_alert_limit();
