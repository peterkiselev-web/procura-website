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

## Hosting note

On GitHub Pages the site is static, so the contact form has no server to post to. Enquiries need either this Node server or a form service.

## Venue waitlist (private invite links)

Venues that agree to move forward get a private link, `https://procuracharge.com/waitlist.html?t=<task id>&k=<code>`. The page checks the link, collects the venue's details and writes them into that venue's task in ClickUp. The code is cleared afterwards, so each link works once. The page is hidden from search engines and is not in the sitemap.

How it works:

1. When you invite a venue, create a task for it in the ClickUp **Venue Pipeline** list with status **Invited** and a random value in the **Invite code** field. Ask Claude to do this, or do it by hand.
2. The venue opens its link and submits the form. `netlify/functions/waitlist.js` checks the code against ClickUp, adds the details to the task description, fills in any matching custom fields, moves the task to **Waitlisted**, sets the due date to the first update reminder, assigns it and posts a comment.
3. Anything ClickUp rejects after the description is saved (a missing status, a field that can't be set) is noted in that comment rather than shown to the venue.

### One-time ClickUp setup

Statuses on the list: `Invited`, `Waitlisted`, `Signed`, `Machine ordered`, `Delivered`, `Installed`, `Dropped`. Only `Invited` and `Waitlisted` are used by the code. Set a different name for the second with `WAITLIST_STATUS`.

Custom fields on the list. The names must match exactly (case does not matter). Any field you leave out is skipped, because the full record is always in the task description.

| Field name | Type | Notes |
| --- | --- | --- |
| Invite code | Short text | **Required.** Without it every link is refused. |
| Business name | Short text | |
| Contact person | Short text | |
| Email | Email | |
| WhatsApp | Phone | |
| Address | Text | |
| Venue type | Dropdown | Options should match the list in `src/pages/waitlist.html`. |
| Opening hours | Short text | |
| Daily footfall | Dropdown | Options: Under 100 people, 100 to 500 people, 500 to 2,000 people, Over 2,000 people. |
| Update channel | Dropdown | Options: Email and WhatsApp, Email only, WhatsApp only. |
| Waitlisted on | Date | |

### Netlify settings

Under Site configuration > Environment variables, set `CLICKUP_TOKEN` and `CLICKUP_LIST_ID`. Optionally set `CLICKUP_ASSIGNEE_IDS`, `UPDATE_CADENCE_DAYS` and `WAITLIST_STATUS` (see `.env.example`). The token is a ClickUp personal API token (ClickUp > Settings > Apps). It has the same access as its owner, so keep it only in Netlify, and rotate it if it is ever exposed. A token from a separate ClickUp user who only has access to this Space limits the damage if it leaks.

### Trying it locally

```bash
node build.js
PORT=3100 node server.js
```

With no ClickUp settings the server uses a fake venue: open `http://127.0.0.1:3100/waitlist.html?t=demo&k=demo-invite-code-0000` and submissions go to `data/waitlist.log`. Set `CLICKUP_TOKEN` and `CLICKUP_LIST_ID` in `.env` to test against ClickUp for real. `npm test` runs the function's tests against a fake ClickUp.
