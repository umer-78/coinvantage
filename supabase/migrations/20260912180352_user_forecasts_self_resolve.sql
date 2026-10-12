-- A user's personal forecast log is scored in their own browser from public
-- candle data. Only the outcome columns may be written, and only once — the
-- prediction itself (price, prob_up, horizon) stays immutable, so a row can
-- never be edited after the fact to look better than it was.
drop policy if exists "own forecasts resolve" on public.user_forecasts;
create policy "own forecasts resolve" on public.user_forecasts
  for update to authenticated
  using ((select auth.uid()) = user_id and resolved = false)
  with check ((select auth.uid()) = user_id);

create or replace function private.freeze_forecast_prediction() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.symbol is distinct from old.symbol
     or new.interval is distinct from old.interval
     or new.price is distinct from old.price
     or new.prob_up is distinct from old.prob_up
     or new.target_price is distinct from old.target_price
     or new.horizon_at is distinct from old.horizon_at
     or new.shown_at is distinct from old.shown_at then
    raise exception 'The prediction is immutable; only the outcome can be filled in.';
  end if;
  -- the verdict is derived here, never taken from the client
  new.was_right := case
    when new.outcome_price is null or new.prob_up is null then null
    else (new.prob_up >= 0.5) = (new.outcome_price > new.price)
  end;
  new.resolved_at := now();
  return new;
end;
$$;
revoke execute on function private.freeze_forecast_prediction() from public, anon, authenticated;
drop trigger if exists freeze_forecast_prediction on public.user_forecasts;
create trigger freeze_forecast_prediction before update on public.user_forecasts
  for each row execute function private.freeze_forecast_prediction();
