-- Trading accounts (AI, practice and real) follow a signed-in user across devices.
-- Additive: older clients never send this column, and an upsert only writes the
-- columns it sends, so they cannot clear it. Row-level policies on user_data
-- (each user reads and writes only their own row) already cover it.
alter table public.user_data add column if not exists trading jsonb not null default '{}'::jsonb;
