-- The learning job every minute instead of every five: each coin is back on
-- each chart about every 78 minutes (it was every 6.5 hours).
select cron.schedule('cv-learn', '* * * * *', $$ select private.call_cv('learn-pass') $$);
