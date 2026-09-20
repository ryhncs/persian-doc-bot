-- Run this once in the Supabase SQL editor (Project -> SQL Editor -> New query).
--
-- Per-user state for the free-tier limit and manual subscriptions.
--   weekly_request_count     premium requests used in the current window
--   week_reset_at            when the counter next resets (a rolling 7-day window
--                            that starts at the user's first premium request)
--   subscription_expires_at  unlimited use while this is in the future
--   payment_pending_at       set when the paywall is shown (and again on a
--                            rejection); a photo from a user with a recent value
--                            here is treated as a payment receipt
create table if not exists public.users (
  telegram_user_id        bigint primary key,
  weekly_request_count    integer     not null default 0,
  week_reset_at           timestamptz not null default (now() + interval '7 days'),
  subscription_expires_at timestamptz,
  payment_pending_at      timestamptz
);

-- The bot connects with the service_role key, which bypasses RLS. Enabling RLS
-- with no policies means the public anon/authenticated keys can read and write
-- nothing in this table.
alter table public.users enable row level security;
