alter table public.signal_log add column if not exists plan_v smallint not null default 1;
-- rows without a plan have nothing to re-score
update public.signal_log set plan_v = 2 where plan is null;
comment on column public.signal_log.plan_v is '1 = plan scored by the old rule; 2 = scored the way the plan says to manage it (engine/planscore.js)';
