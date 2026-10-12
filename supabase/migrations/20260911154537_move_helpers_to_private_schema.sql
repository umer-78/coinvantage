create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

create or replace function private.is_admin(uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = uid), false);
$$;
create or replace function private.is_premium(uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.premium_until > now() or p.is_admin from public.profiles p where p.id = uid), false);
$$;
revoke execute on function private.is_admin(uuid) from public, anon;
revoke execute on function private.is_premium(uuid) from public, anon;
grant execute on function private.is_admin(uuid) to authenticated, service_role;
grant execute on function private.is_premium(uuid) to authenticated, service_role;

-- re-point policies
drop policy "admins read all profiles" on public.profiles;
create policy "admins read all profiles" on public.profiles for select to authenticated using (private.is_admin((select auth.uid())));
drop policy "admins manage posts" on public.posts;
create policy "admins manage posts" on public.posts for all to authenticated using (private.is_admin((select auth.uid()))) with check (private.is_admin((select auth.uid())));
drop policy "admins read page views" on public.page_views;
create policy "admins read page views" on public.page_views for select to authenticated using (private.is_admin((select auth.uid())));
drop policy "users read own payments" on public.subscriptions;
create policy "users read own payments" on public.subscriptions for select to authenticated using ((select auth.uid()) = user_id or private.is_admin((select auth.uid())));

create or replace function public.enforce_alert_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  active_count int;
  lim int;
begin
  select count(*) into active_count from public.alerts where user_id = new.user_id and active;
  lim := case when private.is_premium(new.user_id) then 50 else 3 end;
  if active_count >= lim then
    raise exception 'Alert limit reached (% active). Upgrade to premium for more alerts.', lim using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create or replace function public.get_posts(max_rows int default 30)
returns table (id bigint, kind text, title text, body text, symbol text, side text, entry numeric, stop_loss numeric, targets numeric[], premium_only boolean, locked boolean, status text, result_pct numeric, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  with me as (select private.is_premium((select auth.uid())) as prem)
  select p.id, p.kind, p.title,
    case when p.premium_only and not me.prem then null else p.body end,
    p.symbol, p.side,
    case when p.premium_only and not me.prem then null else p.entry end,
    case when p.premium_only and not me.prem then null else p.stop_loss end,
    case when p.premium_only and not me.prem then null else p.targets end,
    p.premium_only,
    (p.premium_only and not me.prem) as locked,
    p.status, p.result_pct, p.created_at
  from public.posts p, me
  order by p.created_at desc
  limit least(greatest(max_rows, 1), 100);
$$;
grant usage on schema private to anon;
grant execute on function private.is_premium(uuid) to anon;
grant execute on function public.get_posts(int) to anon, authenticated;

drop function public.is_admin(uuid);
drop function public.is_premium(uuid);

-- trigger-only functions must not be callable over the API
revoke execute on function public.enforce_alert_limit() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.touch_updated_at() from public, anon, authenticated;
