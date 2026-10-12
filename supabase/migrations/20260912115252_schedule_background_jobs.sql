create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function private.call_cv(job text, body jsonb default '{}'::jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare req_id bigint;
begin
  select net.http_post(
    url := 'https://cjpljmzustvgsmueqese.supabase.co/functions/v1/cv/' || job,
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := body,
    timeout_milliseconds := 55000
  ) into req_id;
  return req_id;
end;
$$;
revoke execute on function private.call_cv(text, jsonb) from public, anon, authenticated;

select cron.schedule('cv-alerts', '* * * * *', $$ select private.call_cv('alerts-check') $$);
select cron.schedule('cv-news', '7,27,47 * * * *', $$ select private.call_cv('news-fetch') $$);
-- track record: one batch of 3 coins every 15 min (all 12 coins covered each hour)
select cron.schedule('cv-track', '5,20,35,50 * * * *', $$ select private.call_cv('track-signals') $$);
-- housekeeping
select cron.schedule('cv-cleanup', '30 3 * * *', $$
  delete from public.auth_codes where expires_at < now() - interval '1 day';
  delete from public.rate_limits where window_start < now() - interval '1 day';
  delete from public.page_views where created_at < now() - interval '180 days';
$$);
