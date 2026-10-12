-- Two scheduled jobs as they actually run, recorded so a database built from
-- these files matches the live one. Both were set up or changed on the live
-- database without a migration. Scheduling under an existing name replaces that
-- job, so applying this to the live database changes nothing.
--
-- Nightly cleanup: page views go after 30 days, as the privacy policy says (the
-- original schedule kept them for 180), and personal activity and forecast logs
-- after 180.
select cron.schedule('cv-cleanup', '30 3 * * *', $$
  delete from public.auth_codes where expires_at < now() - interval '1 day';
  delete from public.rate_limits where window_start < now() - interval '1 day';
  delete from public.page_views where created_at < now() - interval '30 days';
  delete from public.user_activity where created_at < now() - interval '180 days';
  delete from public.user_forecasts where horizon_at < now() - interval '180 days';
$$);

-- Morning watchlist digest (/cv/watchlist-digest), 08:00 UTC.
select cron.schedule('cv-digest', '0 8 * * *', $$ select private.call_cv('watchlist-digest') $$);
