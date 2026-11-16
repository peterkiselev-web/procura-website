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

**Status: live, taking real payments since 16 Nov 2026.** On machine AJ1 (Al Jawhara Garden) a full rental has run end to end, first in Stripe test mode and then with real money: pay with Apple Pay, payment confirmed, power bank out about 13 seconds after paying, put back, return noticed within seconds, settled at 3.00 GBP. Everything is also tested against fakes of Stripe and of the supplier (`lib/rental/stripe-fake.js`, `lib/rental/supplier-fake.js`), in unit tests and in a real browser (`npm test`). Not yet seen for real: an extra-hour charge on return, the cut-off fee, a declined later charge, and a release the machine refuses (all covered by the automated tests). Nothing takes a payment until everything is set up: with any setting missing the page answers "not configured" and the admin page says what is missing.

### Start here in a new session

For a new person or a new Claude session picking this up: read this section of the README first.

- **Build and test:** `node build.js` (throws on em dashes or en dashes in pages), `node --test` (all must pass before a push), `npm start` (local, with fakes).
- **Check the live system** (nothing is charged or released): `https://procuracharge.com/api/rent/health?station=AJ1&orders=1`, plus `&stripe=1` with test keys. Every rental's steps are in the Supabase table `rentals`, column `history`.
- **Rules:**
  - Never put a key, password or secret in the repo or a chat; they live only in Netlify variables.
  - Release only after Stripe confirms the payment, never on the phone's word, never twice.
  - Never bill past the caps.
  - Stripe keys and webhook must come from the same Stripe environment.
  - The pinned Stripe version (`2026-09-30.endive`) refuses `payment_method_types`.
- **Working:** branch, pull request, wait for the Netlify preview, merge. Each production deploy costs 15 Netlify credits, so group changes.
- **Writing for the owner:** no em dashes or en dashes; plain, short, step by step, with direct links.

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

### Set it up from scratch (what actually worked, 16 Nov 2026)

Values come from the service named; only the variable names are written here. Never put a key, password or secret in this repository or in a chat.

**Accounts**
- **Netlify**: the site deploys from `main`. Use the **Personal plan or above**: every production deploy costs 15 credits, and the free plan's 300 a month ran out after about 20 deploys, after which production silently stopped updating while previews still built.
- **Supabase**: project `qxjpbuomytximctqfhmd`. A new project needs `supabase/migrations/0001_rentals.sql` then `0002_lock_down_rentals.sql` run in its SQL editor. The free plan pauses after a week without use and has no backups.
- **Stripe**: account `acct_1UYBX3K6YquxAygv` (Procuracharge). Apple Pay and Google Pay are registered for `procuracharge.com` in live mode (Settings, Payments, Payment method domains), which also covers test mode.
- **Bajie Charging** (the supplier): API account details come from the supplier. The account needs permission for the order calls (`/rent/order/detail`, `/rent/order/close`), not only "eject": check with `/api/rent/health?station=AJ1&orders=1`.

**Stripe, the trap to avoid.** Keys and webhook must be in the **same environment**. Stripe also offers separate "sandboxes", which are different accounts: on 15 to 16 Nov a webhook was made in a sandbox while the keys came from another environment, so Stripe never delivered to it. Every Stripe id carries the account's code: anything of ours should contain `K6YquxAygv` (for example `pk_live_51UYBX3K6YquxAygv...`, `we_...K6YquxAygv...`). For the live setup:
1. In Stripe with **live** mode showing (no "Sandbox" or "Test mode" bar), API keys, **Create restricted key**, with **Write** on: Customers, PaymentIntents, SetupIntents, PaymentMethods, Charges and Refunds. Everything else None. Copy it (`rk_live_...`) and the publishable key (`pk_live_...`).
2. Workbench, Webhooks, **Add destination**: Your account, **Snapshot** payload (not Thin), events `payment_intent.succeeded` and `charge.dispute.created`, type Webhook endpoint, URL `https://procuracharge.com/api/stripe/webhook`. Copy its signing secret (`whsec_...`). The webhook is a backup: rentals also confirm by asking Stripe directly.

**Netlify environment variables** (Site configuration, Environment variables; mark the secret ones as secret; check the Production value when a variable has per-context values):

| Variable | Value |
| --- | --- |
| `STRIPE_SECRET_KEY` | the `rk_live_` restricted key (`rk_test_` for testing) |
| `STRIPE_PUBLISHABLE_KEY` | `pk_live_...` (or `pk_test_...`) from the same environment |
| `STRIPE_WEBHOOK_SECRET` | the `whsec_` of the webhook in that same environment |
| `ALLOW_LIVE_PAYMENTS` | `yes` with live keys (a live key without it is refused) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | from Supabase, Project settings, API |
| `BAJIE_BASE_URL`, `BAJIE_USERNAME`, `BAJIE_PASSWORD` | from the supplier |
| `BAJIE_AUTH_MODE` | `basic_plain` (worked) |
| `BAJIE_TIME_ZONE` | `Asia/Shanghai` (the supplier's times are China time with no offset) |
| `BAJIE_CALLBACK_SECRET_PATH` | a long random string (24+ characters) |
| `STATIONS` | `{"AJ1":{"deviceId":"DTA59552","name":"Al Jawhara Garden","lang":"ar"}}` |
| `SITE_URL` | `https://procuracharge.com` |
| `ADMIN_PASSWORD` | 12 or more characters |
| `RENTALS_ENABLED` | `yes`, or `no` to stop new rentals at once |

Then **Trigger deploy, Deploy site** (variables only take effect on a deploy), and run the setup checks below. With test keys, also run `?stripe=1`. Then rent one for real.

### Earlier setup notes, in this order

1. **Database.** The Supabase project `qxjpbuomytximctqfhmd` (restored on 14 Nov 2026, with `0001_rentals.sql` and `0002_lock_down_rentals.sql` applied). For a new project, run both migrations in its SQL editor. Copy the project URL and the `service_role` key (Project settings, API) into `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. The tables have row level security on and no policies, so the public key cannot read them.
2. **Stripe, test mode first.** Create a new restricted key (not the supplier's full key) with write access to PaymentIntents, SetupIntents, Customers, PaymentMethods and Refunds. Set `STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY` (test values). Add a webhook endpoint for `https://procuracharge.com/api/stripe/webhook` with the events `payment_intent.succeeded` and `charge.dispute.created`, and put its signing secret in `STRIPE_WEBHOOK_SECRET`.
3. **Apple Pay.** In Stripe (live mode), go to Settings, Payments, Payment method domains, and add `procuracharge.com`. Registering in live mode also covers test mode, and no verification file is needed: Stripe handles Apple's merchant validation. Done on 15 Nov 2026 (Apple Pay and Google Pay show as active). Apple Pay only shows on an iPhone or Mac with a card in Wallet, most reliably in Safari.
4. **Receipts.** Stripe emails the receipt to the address typed on the page. In test mode Stripe does not send emails. To see them, check them in live mode, or in Stripe Settings, Emails.
5. **Supplier.** Set `BAJIE_USERNAME`, `BAJIE_PASSWORD`, `BAJIE_BASE_URL`, and **`BAJIE_AUTH_MODE`** (there is deliberately no default, see the open questions). Set `BAJIE_CALLBACK_SECRET_PATH` to a long random string. Set `STATIONS`, for example `AJ1=DTA59552`.
6. **Site.** Set `SITE_URL=https://procuracharge.com` and `ADMIN_PASSWORD` (12 characters or more). Add the other values from `.env.example` only if you want to change a default.
7. **Deploy.** Environment variables take effect on the next deploy. The scheduled job only runs on the published production deploy, not on previews. In Netlify, Logs, Functions, `rent-cron` should show a run every minute. If Netlify only allows a coarser schedule, rentals still work, because the page's own status checks move a release along and the job catches the rest, but returns will be noticed later.
8. **Check** the page at `https://procuracharge.com/rent?station=AJ1` and the admin at `/admin`, run the setup checks below, then the real-machine tests.

### Setup checks (nothing is charged, nothing is released)

Open these in a browser. Each answers in plain JSON.

| Address | What it proves |
| --- | --- |
| `/api/rent/health` | Every setting is present (`"ready": true`), or which are missing |
| `/api/rent/health?station=AJ1` | The supplier answers, and what it says about the machine: online, signal, each power bank's charge |
| `...&orders=1` | The supplier account may use the order calls the rentals need (`detail` confirms a release and spots a return). It asks about a made-up order number, so nothing can be released or closed. `"answered": true` with "order does not exist" means allowed |
| `...&stripe=1` | Stripe accepts the first-hour payment exactly as a customer's phone starts it: it is created with no card and no customer, then cancelled at once. Sandbox keys only; with live keys it does not run |

**Stripe API version.** Every request sends `Stripe-Version: 2026-09-30.endive` (`lib/rental/stripe.js`), so the sandbox and the live account behave the same whatever their own default version is. That version removed `payment_method_types` from Payment Intents; the code uses its replacement, `allowed_payment_method_types`. On 15 Nov 2026 every rental attempt failed with "We couldn't start the payment" because the old parameter was still sent. Before moving to a newer Stripe version, read its breaking changes and run `?stripe=1`. The page loads Stripe.js from `js.stripe.com/v3`, which still accepts `paymentMethodTypes`; a move to a newer Stripe.js needs `allowedPaymentMethodTypes` instead.

**Netlify credits.** Netlify charges credits for each production deploy (15 each), and the free plan's monthly allowance runs out after about 20. When credits run out, previews still build but production silently stops updating. The team moved to the Personal plan on 15 Nov 2026 for this reason. Group changes into fewer merges.

### Try it locally with no accounts

```
SUPPLIER_MODE=fake RENTAL_STORE=memory STRIPE_FAKE=yes \
STRIPE_SECRET_KEY=rk_test_fake STRIPE_PUBLISHABLE_KEY=pk_test_fake STRIPE_WEBHOOK_SECRET=whsec_test_fake \
STATIONS=AJ1=DTA59552 SITE_URL=http://localhost:3000 ADMIN_PASSWORD=local-test-password npm start
```

Open `http://localhost:3000/rent?station=AJ1`. The page uses a stand-in for Stripe.js (card `4000 0000 0000 9995` is declined, anything else pays). Controls, all under `/__dev/` and only present while the fakes are on: `POST /__dev/supplier/return?tradeNo=...&minutes=130` plays a return, `POST /__dev/supplier/machine?deviceId=DTA59552&online=0` switches the machine off, `...&neverRelease=1` makes a release fail, `GET /__dev/rentals` lists everything. The fakes are refused on Netlify (production, previews and branch deploys alike), so they cannot be left on by mistake. `npm test` also drives the page in a real browser if Playwright is installed.

### How a rental runs

`created` (payment started) > `paid` (verified webhook received) > `releasing` (machine asked once) > `active` (supplier confirms a borrow time) > `returned` (supplier shows a return time) > `settled`. Other end states: `release_failed_refunded`, `expired_charged`, `payment_failed`. Two internal states are added so retries are safe: `refunding` and `expired`. One more, `abandoned`, is for a payment that was started and never made.

- The page asks for nothing before paying: no email, no tick box. The payment form opens with Apple Pay first and already selected (Google Pay on Android phones, where Stripe offers it), then card. The consent wording sits directly above the pay button and is recorded with each rental; Stripe's own consent paragraphs are hidden (`terms: never`) because ours covers them. The payment page loads only its own script and Stripe.js, with no site animations, fonts or footer links. After the power bank is out, an optional box lets the customer have Stripe email a receipt (the rental's later charges then send receipts too).
- The page loads Stripe as soon as it opens and fetches the prices while the machine check runs alongside, so the form shows quickly. The server always checks the machine again before it creates a payment.
- English and Arabic: a switch at the top, the phone's language, or the station setting picks one. Arabic lays the page out right to left, translates every message, shows the consent wording in Arabic (that is what gets recorded), and Stripe's card form follows. To open AJ1 in Arabic by default, set `STATIONS` to `{"AJ1":{"deviceId":"DTA59552","name":"Al Jawhara Garden","lang":"ar"}}`. The Arabic wording was written without a native-speaker review: have one check it, especially the consent sentence. The full terms page is English only.
- A power bank is released only once Stripe confirms the payment, at most once per rental. Two independent routes confirm it: the signature-verified `payment_intent.succeeded` webhook, and the server asking Stripe directly for the rental's own PaymentIntent while the page waits (every 2 seconds, for 10 minutes) and from the scheduled job (for 3 minutes). The direct check accepts only this rental's first-hour payment, succeeded, for the full amount, and never takes the phone's word. Added on 16 Nov 2026 after a payment went through with no webhook delivered. Whichever route comes first wins. The step `paid > releasing` can be won by only one caller, so a repeated webhook, or one sent under a new event id, cannot release twice. If the order result is unknown (a timeout), it is never asked for again: the 60 second rule ends it with a refund.
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

### What the real supplier sends (seen on AJ1, 16 Nov 2026)

- Cabinet query: the online flag is `online` (the documentation says `isOnline`); both are read. Battery `vol` is a percentage.
- Order detail: `borrowTime` and `returnTime` look like `2026-11-16T09:31:39`, China time with no offset (hence `BAJIE_TIME_ZONE=Asia/Shanghai`). `borrowTime` is filled as soon as the power bank is pushed out. After a return, `borrowStatus` was `3`. Other fields: `orderId`, `batteryId`, `borrowSlot`, `returnSlot`, `price`, `priceMinute`, `deposit`, `dailyMaxPrice`, `orderType` (`OpenAccount`).
- Callback: a form body `status=1&tradeNo=...` when the power bank is out and `status=2&tradeNo=...` when it is returned. Treated as a hint only.
- The machine's own card reader also charges into the same Stripe account (metadata `origin: pos`, a 20.00 hold then the rent captured). Those payments are the supplier's system and are ignored here.

### Problems already met, and the fix

| What you see | Cause | Fix |
| --- | --- | --- |
| "We couldn't start the payment" every time | Stripe API 2026-09-30.endive removed `payment_method_types` | Fixed in code (`allowed_payment_method_types`, version pinned). Run `?stripe=1` |
| Paid, page stuck on "Confirming your payment" | Webhook not delivered (it was in another Stripe environment) | Fixed in code: the server now asks Stripe directly. Still put the webhook in the same environment as the keys |
| Merged code never appears on the live site | Netlify credits used up | Upgrade the Netlify plan, then trigger a deploy |
| Times in the admin list 8 hours out | Supplier times are China time | `BAJIE_TIME_ZONE=Asia/Shanghai` |
| Machine shown offline although it is on | Supplier field `online`, not `isOnline` | Fixed in code |

### Going live

Done on 16 Nov 2026. To do it again: create live Stripe keys and a live webhook (see "Set it up from scratch"), set them, set `ALLOW_LIVE_PAYMENTS=yes`, and redeploy. While testing with test keys, any customer who scans gets a free rental, so set `RENTALS_ENABLED=no` except while you test. A live key without `ALLOW_LIVE_PAYMENTS=yes` is refused. To stop rentals quickly at any time, set `RENTALS_ENABLED=no` and redeploy: the page says the machine is unavailable and nothing can start (rentals already out carry on normally).

### Running it

- `/admin` (user `admin`, password `ADMIN_PASSWORD`) lists what needs attention (failed payments, refunds not completed, stale rentals, anything flagged), open rentals, failed payments, refunds and recent rentals. Each row has the supplier order number and a link to the Stripe payment. A failed payment is not chased automatically: the amount owed is shown and the customer's email is there for you to follow up.
- Changing a price or the cut-off means changing the setting and redeploying. The terms page is rebuilt from the same settings on every deploy, and so is the wording the customer agrees to, which is stored with each rental.

### Needs a human check before launch

- **Legal wording.** The terms page, the consent text next to the pay button, and the "If you rent a power bank" section of the privacy notice are plain-English drafts. Have someone qualified review them. In particular think about consumer cancellation rights for an immediately delivered service, whether the non-return fee is enforceable as written, how long to keep rental and payment records, and tax wording.
- **Stripe fraud and disputes.** Off-session charges for fees can be disputed. Stripe sends `charge.dispute.created`, which flags the rental in the admin list. Evidence is the consent text, the time of consent, the supplier order and the timestamps, all of which are stored.
- **The service role key and the supplier login token are as powerful as admin logins.** They are only in server environment variables. Rotate them if they are ever exposed.
