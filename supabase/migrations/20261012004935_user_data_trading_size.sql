-- The trading accounts sit outside the row's original size limit. A full AI
-- account with a long trade log stays far below this; it only stops a client
-- from storing an unbounded blob.
alter table public.user_data add constraint user_data_trading_size check (pg_column_size(trading) < 3000000);
