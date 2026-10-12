-- Personal history: what each user looked at, and every forecast they were shown,
-- scored later against what actually happened. Strictly per-user via RLS.

create table if not exists public.user_activity (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('view_coin','alert_created','alert_fired','forecast_seen','trade_link','signed_in')),
  symbol text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists user_activity_user_time on public.user_activity (user_id, created_at desc);
create index if not exists user_activity_user_symbol on public.user_activity (user_id, symbol);

-- Every forecast a signed-in user was actually shown, resolved once its horizon passes.
create table if not exists public.user_forecasts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  symbol text not null,
  interval text not null,
  shown_at timestamptz not null default now(),
  price numeric not null,
  prob_up numeric,
  target_price numeric,
  horizon_bars int,
  horizon_at timestamptz not null,
  model_accuracy numeric,
  resolved boolean not null default false,
  resolved_at timestamptz,
  outcome_price numeric,
  was_right boolean,
  unique (user_id, symbol, interval, horizon_at)
);
create index if not exists user_forecasts_user_time on public.user_forecasts (user_id, shown_at desc);
create index if not exists user_forecasts_due on public.user_forecasts (resolved, horizon_at) where resolved = false;

alter table public.user_activity enable row level security;
alter table public.user_forecasts enable row level security;

-- Each user sees and writes only their own rows. No policy lets anyone read another's.
drop policy if exists "own activity read" on public.user_activity;
create policy "own activity read" on public.user_activity
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "own activity insert" on public.user_activity;
create policy "own activity insert" on public.user_activity
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "own activity delete" on public.user_activity;
create policy "own activity delete" on public.user_activity
  for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "own forecasts read" on public.user_forecasts;
create policy "own forecasts read" on public.user_forecasts
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "own forecasts insert" on public.user_forecasts;
create policy "own forecasts insert" on public.user_forecasts
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "own forecasts delete" on public.user_forecasts;
create policy "own forecasts delete" on public.user_forecasts
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Keep it bounded: a user cannot flood the table, and old rows expire.
create or replace function private.cap_user_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.user_activity where user_id = new.user_id
      and created_at > now() - interval '1 hour') > 400 then
    raise exception 'Too much activity recorded this hour.';
  end if;
  return new;
end;
$$;
revoke execute on function private.cap_user_activity() from public, anon, authenticated;
drop trigger if exists cap_user_activity on public.user_activity;
create trigger cap_user_activity before insert on public.user_activity
  for each row execute function private.cap_user_activity();
