-- Signal alerts: tell me the moment the engine's buy (or sell) condition triggers,
-- with the entry, stop and targets in the message. The app still never places an
-- order — the alert is the hand-off to wherever the user actually trades.
alter table public.alerts
  add column if not exists kind text not null default 'price',
  add column if not exists interval text,
  add column if not exists min_score integer,
  add column if not exists side text,
  add column if not exists repeat boolean not null default true,
  add column if not exists last_fired_at timestamptz;

alter table public.alerts alter column price drop not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'alerts_kind_check') then
    alter table public.alerts add constraint alerts_kind_check check (kind in ('price','signal'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'alerts_shape_check') then
    alter table public.alerts add constraint alerts_shape_check check (
      (kind = 'price'  and price is not null and direction in ('above','below'))
      or
      (kind = 'signal' and interval in ('15m','1h','4h','1d')
                       and coalesce(min_score, 25) between 10 and 100
                       and coalesce(side, 'any') in ('long','short','any'))
    );
  end if;
end $$;

-- direction is only meaningful for price alerts
alter table public.alerts alter column direction drop not null;

create index if not exists alerts_signal_idx on public.alerts (kind, active, interval) where active;

comment on column public.alerts.kind is 'price = fires at a level; signal = fires when the signal engine turns bullish/bearish';
comment on column public.alerts.repeat is 'signal alerts re-arm after firing (with a one-candle cooldown) instead of switching off';
