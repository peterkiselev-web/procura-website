-- Free power banks for the venue's staff (STAFF_CODES). Safe to run more than once, and safe on a live database:
-- it only adds an empty column and an index, so rentals that already exist and paying guests are not affected.

-- The staff member a rental is for (the name from STAFF_CODES), or null for a paying guest.
alter table public.rentals add column if not exists staff_name text;

-- One staff power bank out per name at a time. The server checks this first; the database makes sure of it,
-- so two taps at the same moment cannot both get one.
create unique index if not exists rentals_one_open_per_staff
  on public.rentals (staff_name)
  where staff_name is not null and status in ('paid', 'releasing', 'active');
