-- Saves only what changed on one device. `p_cols` replaces whole columns;
-- `p_trading` replaces only the trading keys it names, so two devices saving at
-- the same moment never overwrite each other's other keys. Runs as the caller,
-- so the table's own-row policies still decide what it may touch.
create or replace function public.sync_user_data(p_cols jsonb default '{}'::jsonb, p_trading jsonb default '{}'::jsonb)
returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  saved_at timestamptz;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  insert into public.user_data (user_id) values (uid) on conflict (user_id) do nothing;
  update public.user_data d set
    watchlist = case when jsonb_typeof(p_cols -> 'watchlist') = 'array' then p_cols -> 'watchlist' else d.watchlist end,
    holdings  = case when jsonb_typeof(p_cols -> 'holdings')  = 'array' then p_cols -> 'holdings'  else d.holdings end,
    wallets   = case when jsonb_typeof(p_cols -> 'wallets')   = 'array' then p_cols -> 'wallets'   else d.wallets end,
    drawings  = case when jsonb_typeof(p_cols -> 'drawings')  = 'object' then p_cols -> 'drawings' else d.drawings end,
    settings  = case when jsonb_typeof(p_cols -> 'settings')  = 'object' then p_cols -> 'settings' else d.settings end,
    trading   = case when jsonb_typeof(p_trading) = 'object' then d.trading || p_trading else d.trading end
  where d.user_id = uid
  returning d.updated_at into saved_at;
  return saved_at;
end;
$$;

revoke all on function public.sync_user_data(jsonb, jsonb) from public, anon;
grant execute on function public.sync_user_data(jsonb, jsonb) to authenticated;
