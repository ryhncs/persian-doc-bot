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

-- ---------------------------------------------------------------------------
-- Referrals and discount coupons. Safe to run again on an existing database.
--   referral_code          the user's invite code ("/start ref_<code>")
--   referred_by            who invited this user (set once, only while the user
--                          has no delivered request yet)
--   first_action_at        when the user's first billable request was delivered;
--                          the referral bonus is paid at that moment, never
--                          before
--   referral_qualified_at  when the invitee's bonus was paid
--   bonus_requests         extra free requests (spent after the weekly ones)
--   successful_referrals   invitees who completed a real request (lifetime)
--   referral_progress      successful referrals since the last coupon redemption;
--                          every 3rd one earns a coupon, redeeming resets it to 0
--   coupons_available      unused 20% discount coupons (they never expire)
--   coupons_redeemed       coupons already used on a purchase

-- Existing users count as "already active" (they can't be referred): this
-- backfill runs only the first time, when the column doesn't exist yet.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'users' and column_name = 'first_action_at'
  ) then
    alter table public.users add column first_action_at timestamptz;
    update public.users set first_action_at = now();
  end if;
end $$;

alter table public.users add column if not exists referral_code         text;
alter table public.users add column if not exists referred_by           bigint;
alter table public.users add column if not exists referral_qualified_at timestamptz;
alter table public.users add column if not exists bonus_requests        integer not null default 0;
alter table public.users add column if not exists successful_referrals  integer not null default 0;
alter table public.users add column if not exists referral_progress     integer not null default 0;
alter table public.users add column if not exists coupons_available     integer not null default 0;
alter table public.users add column if not exists coupons_redeemed      integer not null default 0;

create unique index if not exists users_referral_code_key on public.users (referral_code);
