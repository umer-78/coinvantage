-- The AI trader runs in the cloud: every five minutes the trader-run job
-- (supabase/functions/cv/trader.ts) checks each account whose AI is on, with
-- the Trading page closed. These two functions are its only way into the
-- accounts, and only the service role may call them.

-- The accounts whose AI is running, with a fingerprint of the account as read.
create or replace function public.cv_trader_accounts()
returns table (user_id uuid, cfg jsonb, state jsonb, lessons jsonb, auto_learn jsonb, state_md5 text)
language sql stable security definer set search_path = '' as $$
  select d.user_id, d.trading -> 'traderCfg', d.trading -> 'traderState', d.trading -> 'traderLessons', d.trading -> 'traderAutoLearn',
         md5(coalesce(d.trading -> 'traderState', 'null'::jsonb)::text)
  from public.user_data d
  where d.trading -> 'aiSession' ->> 'status' = 'running' and d.trading ? 'traderState'
$$;
revoke all on function public.cv_trader_accounts() from public, anon, authenticated;
grant execute on function public.cv_trader_accounts() to service_role;

-- Save a check, unless the account changed after it was read (a page saved
-- it): then nothing is written and the next run starts from that copy.
create or replace function public.cv_save_trader(p_user uuid, p_was text, p_trading jsonb)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if jsonb_typeof(p_trading) <> 'object' then return false; end if;
  update public.user_data d set trading = d.trading || p_trading
   where d.user_id = p_user and md5(coalesce(d.trading -> 'traderState', 'null'::jsonb)::text) = p_was;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;
revoke all on function public.cv_save_trader(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.cv_save_trader(uuid, text, jsonb) to service_role;
