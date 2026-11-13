-- Procura QR rental: rentals and Stripe event ids.
-- Run in the Supabase SQL editor (or `supabase db push`). Safe to run once on a new project.
-- Row level security is switched on with no policies, so the public (anon) key cannot read or write anything.
-- Only the server, using the service role key, can touch these tables.

create table if not exists public.rentals (
  id                        text primary key,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  station                   text not null,
  device_id                 text not null,
  status                    text not null,
  access_hash               text not null,            -- sha256 of the token the customer's browser holds
  email                     text,
  stripe_customer_id        text,
  stripe_payment_intent_id  text unique,
  stripe_payment_method_id  text,
  consent_text              text,                     -- the exact wording the customer saw
  consent_version           text,
  consent_at                timestamptz,
  trade_no                  text unique,              -- supplier order number
  paid_pence                integer not null default 0,
  paid_at                   timestamptz,
  release_requested_at      timestamptz,
  released_at               timestamptz,              -- our clock, when the release was confirmed
  borrow_time               timestamptz,              -- supplier clock, used for billing
  return_time               timestamptz,              -- supplier clock, used for billing
  cutoff_at                 timestamptz,
  rent_pence                integer,                  -- total rent worked out at return or cut-off
  fee_pence                 integer not null default 0,
  due_pence                 integer,                  -- still to charge at return or cut-off
  charged_extra_pence       integer not null default 0,
  settle_pi_id              text,
  settle_attempts           integer not null default 0,
  key_epoch                 integer not null default 0,  -- moves the Stripe idempotency key only after a checked server error
  next_attempt_at           timestamptz,
  refund_id                 text,
  refunded_pence            integer not null default 0,
  supplier_closed_at        timestamptz,
  close_attempts            integer not null default 0,
  close_error               text,
  last_error                text,
  last_detail               jsonb,                    -- the supplier's last order detail, kept to learn what their codes mean
  last_polled_at            timestamptz,
  flags                     jsonb not null default '[]'::jsonb,
  history                   jsonb not null default '[]'::jsonb
);

create index if not exists rentals_status_idx on public.rentals (status);
create index if not exists rentals_created_idx on public.rentals (created_at desc);

create table if not exists public.stripe_events (
  id          text primary key,                       -- the Stripe event id: one row means one event handled
  type        text,
  status      text not null default 'processing',
  created_at  timestamptz not null default now()
);

alter table public.rentals enable row level security;
alter table public.stripe_events enable row level security;
