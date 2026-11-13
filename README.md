# Procura website

Website for Procura, which places free power bank rental stations in UK venues and pays hosts a share of every rental. Procura is a trading name of JUKIE Experiences Ltd, company number 16203343.

## Run it locally

```bash
node build.js
PORT=3100 node server.js
```

Then open http://127.0.0.1:3100. The server also receives contact form enquiries at `POST /api/contact` and saves them to `data/enquiries.log`.

## Editing

Page content lives in `src/pages/`. Shared parts (header, menu, footer, legal line) are in `build.js`. Edit those, then run `node build.js` to regenerate the HTML files in the root.

## Page settings and SEO checks

The first line of each file in `src/pages/` holds that page's settings: `title` and `description` (required), plus `crumb`, `faq`, `article` with `published`, `noindex`, `three`, `loader` and `script` where needed. Pages are served at clean addresses such as `/faq`, and `build.js` writes the canonical links, sitemap, structured data and internal links in that form. A page with `faq` set publishes its visible `<details>` questions as FAQ structured data. Put `@@RELATED@@` and `@@CTA@@` in a page body for the shared link block and closing call to action.

`npm test` rebuilds the site and checks titles, descriptions, canonicals, structured data, the sitemap, internal links, image alt text and the content security policy hash.

## Hosting note

On GitHub Pages the site is static, so the contact form has no server to post to. Enquiries need either this Node server or a form service.

## Venue waitlist (private invite links)

Invited venues get a private link, `https://procuracharge.com/waitlist.html?t=<task id>&k=<code>`. The page checks the link and writes the venue's details into that venue's task in ClickUp. Each link works once. The page is hidden from search engines and left out of the sitemap. The sales process itself is documented in ClickUp, not in this repository.

`netlify/functions/waitlist.js` checks the code, adds the submitted details to the task, moves it to **Waitlisted**, sets a due date, assigns it and posts a comment. Anything ClickUp rejects after the details are saved is noted in that comment rather than shown to the venue.

### What the ClickUp list needs

The list needs the statuses **Invited** and **Waitlisted** (rename the second with `WAITLIST_STATUS`), and a custom field called **Invite code** (short text). Without that field every link is refused.

Other custom fields are optional. The names must match exactly (case does not matter), and any field that is missing is skipped, because the full record is always written to the task description as well.

| Field name | Type |
| --- | --- |
| Business name | Short text |
| Contact person | Short text |
| Email | Email |
| WhatsApp | Phone |
| Address | Text |
| Venue type | Dropdown |
| Opening hours | Short text |
| Daily footfall | Dropdown |
| Update channel | Dropdown |
| Waitlisted on | Date |

### Netlify settings

Under Site configuration > Environment variables, set `CLICKUP_TOKEN` and `CLICKUP_LIST_ID`. Optionally set `CLICKUP_ASSIGNEE_IDS`, `UPDATE_CADENCE_DAYS` and `WAITLIST_STATUS` (see `.env.example`). The token is a ClickUp personal API token. It has the same access as its owner, so keep it only in Netlify, never in this repository, and rotate it if it is ever exposed.

### Trying it locally

```bash
node build.js
PORT=3100 node server.js
```

With no ClickUp settings the server uses a fake venue: open `http://127.0.0.1:3100/waitlist.html?t=demo&k=demo-invite-code-0000` and submissions go to `data/waitlist.log`. Set `CLICKUP_TOKEN` and `CLICKUP_LIST_ID` in `.env` to test against ClickUp for real. `npm test` runs the function's tests against a fake ClickUp.

## QR rental setup

A guest scans a QR code on a machine, which opens `/rent?station=AJ1`. They pay 3.00 GBP with Apple Pay, Google Pay or a card (Stripe). The server then asks the machine to release a power bank (Bajie Charging open API), watches for the return, and charges any extra from the saved card, capped. This follows `PROCURA_QR_RENTAL_BUILD_SPEC.pdf`, section by section.

**What has and has not been proven.** Everything below has been run against fakes of Stripe and of the supplier (`lib/rental/stripe-fake.js`, `lib/rental/supplier-fake.js`), in unit tests and in a real browser (`npm test`). Nothing has been run against the real Stripe, the real Bajie API or a real machine, because there are no keys yet. Treat it as built and tested against our understanding of those services, not as known to work with them. The real-machine tests in spec section 11 are the proof. Nothing takes a payment until you have set everything up: with any setting missing the page answers "not configured" and the admin page says what is missing.

### Where things are

| What | Where |
| --- | --- |
| Customer page and script | `src/pages/rent.html`, `js/rent.js` (built to `rent.html`) |
| Terms page | `src/pages/rental-terms.html`. The prices in it are filled in at build time from the same settings the server charges from |
| API the page calls | `netlify/functions/rent.js` at `/api/rent/station`, `/start`, `/status` |
| Stripe webhook | `netlify/functions/stripe-webhook.js` at `/api/stripe/webhook` |
| Supplier callback | `netlify/functions/bajie-callback.js` at `/api/bajie/callback/<secret>/<rentalId>` |
| Scheduled job, every minute | `netlify/functions/rent-cron.js` |
| Admin list | `netlify/functions/admin.js` at `/admin` |
| The rules (all the business logic) | `lib/rental/service.js`, with pricing in `pricing.js` and every setting in `config.js` |
| Database | `supabase/migrations/0001_rentals.sql` |

### Set it up, in this order

1. **Database.** The existing Supabase project (`qxjpbuomytximctqfhmd`) is **paused**. Restore it in the Supabase dashboard, or create a new one, then run `supabase/migrations/0001_rentals.sql` in its SQL editor. Copy the project URL and the `service_role` key (Project settings, API) into `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. The tables have row level security on and no policies, so the public key cannot read them.
2. **Stripe, test mode first.** Create a new restricted key (not the supplier's full key) with write access to PaymentIntents, SetupIntents, Customers, PaymentMethods and Refunds. Set `STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY` (test values). Add a webhook endpoint for `https://procuracharge.com/api/stripe/webhook` with the events `payment_intent.succeeded` and `charge.dispute.created`, and put its signing secret in `STRIPE_WEBHOOK_SECRET`.
3. **Apple Pay.** In Stripe, register `procuracharge.com` under Settings, Payment methods, Payment method domains (test and live). Stripe gives you a domain association file: save it in this repo at `.well-known/apple-developer-merchantid-domain-association` (no extension) so it is served at `https://procuracharge.com/.well-known/apple-developer-merchantid-domain-association`. Apple Pay only shows on a real iPhone or Mac with a card in Wallet, over https.
4. **Receipts.** Stripe emails the receipt to the address typed on the page. In test mode Stripe does not send emails. To see them, check them in live mode, or in Stripe Settings, Emails.
5. **Supplier.** Set `BAJIE_USERNAME`, `BAJIE_PASSWORD`, `BAJIE_BASE_URL`, and **`BAJIE_AUTH_MODE`** (there is deliberately no default, see the open questions). Set `BAJIE_CALLBACK_SECRET_PATH` to a long random string. Set `STATIONS`, for example `AJ1=DTA59552`.
6. **Site.** Set `SITE_URL=https://procuracharge.com` and `ADMIN_PASSWORD` (12 characters or more). Add the other values from `.env.example` only if you want to change a default.
7. **Deploy.** Environment variables take effect on the next deploy. The scheduled job only runs on the published production deploy, not on previews. In Netlify, Logs, Functions, `rent-cron` should show a run every minute. If Netlify only allows a coarser schedule, rentals still work, because the page's own status checks move a release along and the job catches the rest, but returns will be noticed later.
8. **Check** the page at `https://procuracharge.com/rent?station=AJ1` and the admin at `/admin`. Then run the real-machine tests below.

### Try it locally with no accounts

```
SUPPLIER_MODE=fake RENTAL_STORE=memory STRIPE_FAKE=yes \
STRIPE_SECRET_KEY=rk_test_fake STRIPE_PUBLISHABLE_KEY=pk_test_fake STRIPE_WEBHOOK_SECRET=whsec_test_fake \
STATIONS=AJ1=DTA59552 SITE_URL=http://localhost:3000 ADMIN_PASSWORD=local-test-password npm start
```

Open `http://localhost:3000/rent?station=AJ1`. The page uses a stand-in for Stripe.js (card `4000 0000 0000 9995` is declined, anything else pays). Controls, all under `/__dev/` and only present while the fakes are on: `POST /__dev/supplier/return?tradeNo=...&minutes=130` plays a return, `POST /__dev/supplier/machine?deviceId=DTA59552&online=0` switches the machine off, `...&neverRelease=1` makes a release fail, `GET /__dev/rentals` lists everything. The fakes are refused on Netlify (production, previews and branch deploys alike), so they cannot be left on by mistake. `npm test` also drives the page in a real browser if Playwright is installed.

### How a rental runs

`created` (payment started) > `paid` (verified webhook received) > `releasing` (machine asked once) > `active` (supplier confirms a borrow time) > `returned` (supplier shows a return time) > `settled`. Other end states: `release_failed_refunded`, `expired_charged`, `payment_failed`. Two internal states are added so retries are safe: `refunding` and `expired`. One more, `abandoned`, is for a payment that was started and never made.

- A power bank is released only from the signature-verified `payment_intent.succeeded` webhook, and at most once per rental. The step `paid > releasing` can be won by only one caller, so a repeated webhook, or one sent under a new event id, cannot release twice. If the order result is unknown (a timeout), it is never asked for again: the 60 second rule ends it with a refund.
- If nothing confirms the release in 60 seconds, the 3.00 is refunded and the supplier order is closed. The customer's page says so.
- The supplier's callback and any event are hints only. Every change is based on a fresh `GET /rent/order/detail`.
- Billing uses the supplier's own `returnTime` minus `borrowTime`, so our clock and time zones do not matter. Any started hour counts. The extra is charged once, on return. A power bank returned after the cut-off is treated as not returned.
- At the cut-off the rent still owed plus the non-return fee are charged once, the order is closed, and nothing more is ever charged. The cut-off is counted on our clock from the moment the release was confirmed.
- A declined later charge is retried up to 3 times, an hour apart, then the rental shows as `payment failed` in the admin list. A card that needs the customer to authenticate is not retried.
- Every charge and refund has an idempotency key, so a retry after a timeout cannot charge twice. If Stripe answers with a server error, which it may remember against the key, the code first checks whether the money moved before using a new key.
- If a customer's payment arrives but the webhook never does, the scheduled job refunds it after 30 minutes and flags it. It does not release a power bank from anything but the webhook.
- If the supplier cannot be reached at the cut-off, nothing is charged until the order can be checked. The admin list flags it.
- The total can never go past the rent cap plus the fee, enforced again at the point of charging.

### The open questions in spec section 12

Nothing is guessed. Each one is a setting or is recorded so you can answer it from real data:

| Question | What the code does | Where to change it |
| --- | --- | --- |
| 1. What `borrowStatus` and `paymentStatus` mean | Not used for any decision. The supplier's latest values are stored and shown on each rental in the admin list | Nowhere to change yet. Read the values during the real-machine tests and report them |
| 2. What the callback sends and expects back | Treated as a hint. The first few bodies received are kept in the rental's notes (admin list). The reply is `BAJIE_CALLBACK_ACK` | `BAJIE_CALLBACK_ACK` |
| 3. Whether the supplier charges for API orders, and whether an order closes itself | We always call close (5.6) after settling. A failure to close is recorded and retried, and never undoes a settlement | Nothing needed unless they say closing is wrong |
| 4. Machine number or QR content as `deviceId` | Whatever you put as the value in `STATIONS` | `STATIONS` |
| 5. Event notifications | Not built, as instructed. Return detection is polling only | Later |
| 6. Basic Auth with plain or hashed password, or a token | `BAJIE_AUTH_MODE` must be set (`basic_plain`, `basic_sha256` or `token`). With `token` the header and prefix are `BAJIE_TOKEN_HEADER` and `BAJIE_TOKEN_PREFIX` | `BAJIE_AUTH_MODE` and friends |
| 7. A test environment or a way to fail a release | Not available to us. Use the supplier's help for real-machine test 4 | Nothing |

Other values the spec does not give, set to a sensible default and easy to change: the battery charge counted as "enough" (`RENTAL_MIN_BATTERY_VOL`, 30, and the unit of `vol` is unconfirmed), the format and time zone of the supplier's times (`BAJIE_TIME_ZONE`), and the Apple Pay payment sheet options (`STRIPE_APPLE_PAY_OPTIONS_JSON`, empty). Spec section 4 says to check Stripe's current docs on saving an Apple Pay card for later merchant-initiated charges. The docs I could reach confirmed the deferred Payment Element with `setup_future_usage: off_session` (which is what is built) but not the exact Apple Pay sheet options, so that option is left for you to set from the docs once you are testing on a real iPhone.

### Test on the real machine (spec section 11)

All in Stripe test mode, with `ALLOW_LIVE_PAYMENTS` unset. Stripe's test cards (from its Testing page): `4242 4242 4242 4242` pays, `4000 0000 0000 9995` is declined on the first payment (use it to see the page keep the same rental and let the customer try another card), and `4000 0027 6000 3184` always asks for authentication.

1. Return after 5 minutes: 3.00 total, nothing extra.
2. Return after 70 minutes: 3.00 at the start, 3.00 on return.
3. Pay while the machine is switched off: the page shows unavailable and no payment can start.
4. Pay, then make the release fail (ask the supplier how): automatic refund and a message on the page.
5. Leave one out past the cut-off. Set `RENTAL_CUTOFF_MINUTES_OVERRIDE` (for example 90) and redeploy. The rent owed plus the fee are charged and the rental closes. Clear the setting afterwards.
6. A card that cannot be charged later. Use `4000 0027 6000 3184`: complete Stripe's test 3D Secure screen on the first payment, and the later charge is refused because that card needs the customer present. The rental shows as payment failed in the admin list, flagged `needs_customer_authentication`, and is not retried. A plain card decline on the later charge (which is retried up to 3 times) cannot be produced from a normal first payment with Stripe's test cards, so that path is covered only by the automated tests against the fake. If you want to see it for real, ask Stripe support for a test card that succeeds once and then declines.

Also check on a real phone, in test mode: Apple Pay and Google Pay appear and complete a payment, the browser console shows no Content Security Policy errors from Stripe (the policy in `netlify.toml` and `server.js` was written from Stripe's documented hosts, and has not been seen working with the real Stripe.js), and the receipt email arrives in live mode.

### Going live

When the six tests pass: create live Stripe keys and a live webhook, set them, set `ALLOW_LIVE_PAYMENTS=yes`, register the domain for Apple Pay in live mode, and redeploy. A live key without `ALLOW_LIVE_PAYMENTS=yes` is refused. To stop rentals quickly at any time, set `RENTALS_ENABLED=no` and redeploy: the page says the machine is unavailable and nothing can start (rentals already out carry on normally).

### Running it

- `/admin` (user `admin`, password `ADMIN_PASSWORD`) lists what needs attention (failed payments, refunds not completed, stale rentals, anything flagged), open rentals, failed payments, refunds and recent rentals. Each row has the supplier order number and a link to the Stripe payment. A failed payment is not chased automatically: the amount owed is shown and the customer's email is there for you to follow up.
- Changing a price or the cut-off means changing the setting and redeploying. The terms page is rebuilt from the same settings on every deploy, and so is the wording the customer agrees to, which is stored with each rental.

### Needs a human check before launch

- **Legal wording.** The terms page, the consent text next to the pay button, and the "If you rent a power bank" section of the privacy notice are plain-English drafts. Have someone qualified review them. In particular think about consumer cancellation rights for an immediately delivered service, whether the non-return fee is enforceable as written, how long to keep rental and payment records, and tax wording.
- **Stripe fraud and disputes.** Off-session charges for fees can be disputed. Stripe sends `charge.dispute.created`, which flags the rental in the admin list. Evidence is the consent text, the time of consent, the supplier order and the timestamps, all of which are stored.
- **The service role key and the supplier login token are as powerful as admin logins.** They are only in server environment variables. Rotate them if they are ever exposed.
