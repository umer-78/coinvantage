-- Advisor fixes, 2026-09-12.
--
-- 1. Both foreign keys were unindexed, so deleting or updating a referenced row
--    meant a sequential scan of the child table.
create index if not exists posts_author_idx on public.posts (author);
create index if not exists subscriptions_user_id_idx on public.subscriptions (user_id);

-- 2. profiles had two permissive SELECT policies for the same role and action,
--    so Postgres evaluated both on every read. They are OR'd together anyway,
--    so one policy with the same condition is identical in effect and cheaper.
--    Old: "users read own profile"  -> auth.uid() = id
--         "admins read all profiles" -> private.is_admin(auth.uid())
drop policy if exists "users read own profile" on public.profiles;
drop policy if exists "admins read all profiles" on public.profiles;
create policy "read own profile, or any profile if admin"
  on public.profiles for select to authenticated
  using ((select auth.uid()) = id or private.is_admin((select auth.uid())));
