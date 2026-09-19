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
