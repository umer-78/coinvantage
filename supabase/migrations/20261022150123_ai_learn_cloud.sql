-- The AI's shared learning record, one row per chart, kept up by the learn-pass
-- job (supabase/functions/cv/learn.ts) every five minutes. Before this the
-- learning only ran in an open browser and was kept in that browser.
create table if not exists public.ai_learn (
  interval text primary key,
  ledger jsonb not null,
  summary jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.ai_learn enable row level security;

-- Anyone can read it: market calls and their scores, nothing about a person.
-- Only the service role writes. Pages read the summary; the ledger holds every
-- logged call (up to 2,000 a chart) and stays with the job.
create policy "ai_learn is readable by everyone" on public.ai_learn for select using (true);
revoke all on public.ai_learn from anon, authenticated;
grant select (interval, summary, updated_at) on public.ai_learn to anon, authenticated;

select cron.schedule('cv-learn', '3-59/5 * * * *', $$ select private.call_cv('learn-pass') $$);
