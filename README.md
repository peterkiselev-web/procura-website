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
