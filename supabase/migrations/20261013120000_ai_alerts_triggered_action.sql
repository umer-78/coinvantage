-- Which way an AI-signal alert fired, so the site can say BUY or SELL for an
-- alert set to "any" (Telegram and e-mail already say it in the message).
alter table public.ai_alerts add column if not exists triggered_action text check (triggered_action in ('buy','sell'));
