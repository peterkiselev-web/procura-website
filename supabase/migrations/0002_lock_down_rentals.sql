-- The rentals tables are only ever used by the server, through the service role key.
-- Row level security already stops the public (anon) and signed-in (authenticated) roles from reading any rows.
-- This also removes their access to the tables altogether, so the tables do not even show up in the public GraphQL schema.
-- The service role is not affected.
revoke all on table public.rentals from anon, authenticated;
revoke all on table public.stripe_events from anon, authenticated;
