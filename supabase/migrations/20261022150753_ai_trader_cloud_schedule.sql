-- The cloud trader's schedule: a minute past each five, so the candle that
-- just closed is on the exchanges.
select cron.schedule('cv-trader', '1-59/5 * * * *', $$ select private.call_cv('trader-run') $$);
