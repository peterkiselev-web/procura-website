# Procura website: notes for Claude

Read this first. The full setup and history is in `README.md`, section "QR rental setup".

## What this is

- Static marketing site for Procura (power bank rental stations, UK), built by `node build.js` from `src/pages/*.html` into the repo root, deployed by Netlify from `main` to https://procuracharge.com.
- The QR rental system: a guest scans a code on a machine, opens `/rent?station=AJ1`, pays 3.00 GBP (Apple Pay, Google Pay or card via Stripe), and the server asks the machine (Bajie Charging API) to push out a power bank, watches for the return, and charges extra hours from the saved card, capped. **Live with real money since 16 Nov 2026** on machine AJ1 (Al Jawhara Garden, device `DTA59552`, opens in Arabic).
- Code: `lib/rental/` (all business logic in `service.js`, settings in `config.js`, prices in `pricing.js`), Netlify functions in `netlify/functions/`, page `src/pages/rent.html` with `js/rent.js`, database Supabase (`supabase/migrations/`).

## Adding a new machine (the usual request)

Follow README "Add a new machine (new location)" exactly. In short: no code change. Ask the owner for the station code, the supplier device id, the venue name and the language (en or ar), and the current `STATIONS` value from Netlify. Run `npm install --no-save qrcode@1.5.4 jsqr@1.4.0 pngjs@7.0.0`, then `node scripts/new-station.js --code ... --device ... --name ... --lang ... --current '...'`. Commit the QR files on a branch, open a pull request, merge after the preview passes. Give the owner the new `STATIONS` value and direct links (Netlify variables, then Trigger deploy), then check `https://procuracharge.com/api/rent/health?station=<CODE>&orders=1` yourself. If the machine is not reachable, the supplier must add it to the same API account.

## Commands

- `node build.js` builds the pages. It throws if a page contains an em dash or en dash.
- `node --test` runs every test (unit, service against fakes, and a real browser test with Playwright). All must pass before a push.
- `npm start` runs the site locally with fake Stripe and a fake machine (see README "Try it locally").

## Checking the live system (nothing is charged or released)

- `https://procuracharge.com/api/rent/health?station=AJ1&orders=1` : setup complete, machine online, supplier permissions.
- `...&stripe=1` : with test keys, creates and cancels the first-hour payment to prove Stripe accepts it. With live keys it does not run.
- Records: Supabase table `rentals` (each row has a `history` of every step) and `stripe_events`.

## Rules that matter

- Never put a key, password or secret in the repo or in chat. They live only in Netlify environment variables.
- A power bank is released only after Stripe confirms the payment (webhook, or the server reading the rental's own PaymentIntent). Never from the phone's word. Never twice. The one owner-approved exception: staff codes (`STAFF_CODES`, README "Free power banks for the venue's staff"), checked on the server, one per code at a time, at most `STAFF_MAX_OUT` per machine, never charged.
- Never bill beyond the caps (rent 20.00, fee 20.00, 40.00 in total).
- Stripe requests pin `Stripe-Version: 2026-09-30.endive` and use `allowed_payment_method_types: ["card"]`. `payment_method_types` is refused by that version. Read the breaking changes before changing the version.
- Stripe keys and the webhook must come from the same Stripe environment (ids of ours contain `K6YquxAygv`). Stripe "sandboxes" are separate accounts.
- The Stripe connection available to Claude is the live account and read only.
- Every production deploy costs 15 Netlify credits (Personal plan, 1,000 a month). Group changes into few merges.
- Work on a branch, open a pull request, wait for the Netlify preview to pass, then merge.

## House style for anything the owner reads

- No em dashes or en dashes, anywhere.
- Plain, short English. The owner prefers simple step by step instructions with direct links.
