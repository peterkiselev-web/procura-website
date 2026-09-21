// Builds the static pages. Each file in src/pages is a page body whose first line is a
// JSON comment with its settings. Shared chrome (head, header, menu, dock, footer) lives here.
// Run: node build.js
"use strict";
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "src", "pages");

// Live address. Used for canonical links, social previews and the sitemap.
const SITE = "https://procuracharge.com";

const NAV = [
  { href: "index.html", label: "Home" },
  { href: "machines.html", label: "Machines" },
  { href: "how-it-works.html", label: "How it works" },
  { href: "why-host.html", label: "Why host one" },
  { href: "about.html", label: "About" },
  { href: "contact.html", label: "Contact" },
];

const LEGAL =
  "Procura is a trading name of JUKIE Experiences Ltd, a private limited company registered in England and Wales, " +
  "company number 16203343. Registered office: 21 Royal Avenue, London, SW3 4QE.";


// Rental income estimator, dropped into any page body that contains @@ESTIMATOR@@.
// It shows gross rental income only. The host's split is agreed per location, so no percentage is shown.
const ESTIMATOR = `<div class="estimator" data-estimator>
      <div class="estimator__head">
        <span class="label">Illustration</span>
        <h3>What could a station take at your venue?</h3>
        <p class="muted">Move the sliders to see the rental income a station could bring in each month. Your share of it is set for your location.</p>
      </div>
      <div class="estimator__controls">
        <label class="range"><span>Rentals a day <b><output data-out="rentals">12</output></b></span><input type="range" min="1" max="60" value="12" data-in="rentals"></label>
        <label class="range"><span>Average rental length <b><output data-out="hours">1</output> hr</b></span><input type="range" min="1" max="4" step="1" value="1" data-in="hours"></label>
        <label class="range"><span>Days open a week <b><output data-out="days">7</output></b></span><input type="range" min="1" max="7" value="7" data-in="days"></label>
      </div>
      <div class="estimator__result">
        <span class="label">Rental income a month</span>
        <strong class="estimator__total" data-out="total" aria-live="polite">£1,092</strong>
        <p class="muted">At £3 an hour. An illustration only, since real numbers depend on your footfall. Your revenue share is agreed on a free consultation call.</p>
        <a class="btn" href="contact.html">Find out your split <span class="arrow" aria-hidden="true">&rarr;</span></a>
      </div>
    </div>`;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function head(meta) {
  return `<!doctype html>
<html lang="en-GB" class="no-js">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(meta.title)}</title>
<meta name="description" content="${esc(meta.description)}">
<meta name="theme-color" content="#0a0a0a">
<meta property="og:title" content="${esc(meta.title)}">
<meta property="og:description" content="${esc(meta.description)}">
<meta property="og:type" content="website">
<meta property="og:image" content="${SITE}/assets/img/station-graphite.jpg">
<meta property="og:url" content="${meta.url}">
<meta property="og:site_name" content="Procura">
<meta property="og:locale" content="en_GB">
<meta name="twitter:card" content="summary_large_image">
<link rel="canonical" href="${meta.url}">${meta.noindex ? '\n<meta name="robots" content="noindex">' : ""}
<link rel="icon" href="assets/img/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@300..700&family=Geist+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="css/style.css">
${meta.three ? `<link rel="modulepreload" href="https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js" crossorigin>
<link rel="preload" href="assets/models/procura-station.glb" as="fetch" crossorigin>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/"}}</script>` : ""}
</head>`;
}

function chrome(slug, meta) {
  const links = NAV.map((n) => `<a href="${n.href}"${n.href === slug ? ' aria-current="page"' : ""}>${n.label}</a>`).join("");
  const menuLinks = NAV.map((n, i) => `<li><a href="${n.href}"${n.href === slug ? ' aria-current="page"' : ""}><small>0${i + 1}</small>${n.label}</a></li>`).join("\n      ");
  return `<body${meta.loader ? ' class="is-loading"' : ""}>
<a class="skip" href="#main">Skip to content</a>
${meta.loader ? `<div class="loader" aria-hidden="true">
  <div class="loader__top"><span class="loader__count">00</span><span class="loader__brand">Procura</span></div>
  <div></div>
  <div class="loader__bottom"><span>Power bank stations<br>for UK venues</span><span class="loader__brand">London · 2026</span></div>
  <span class="loader__bar"></span>
</div>` : ""}
<div class="curtain" aria-hidden="true"></div>

<header class="header">
  <a class="logo" href="index.html" aria-label="Procura home">PROCURA</a>
  <nav class="header__nav" aria-label="Main">${links}</nav>
  <a class="header__cta" href="contact.html">Free consultation</a>
</header>

<nav class="menu" id="menu" aria-label="Site menu">
  <ol>
      ${menuLinks}
  </ol>
</nav>

<div class="dock">
  <button class="dock__menu" type="button" aria-controls="menu" aria-expanded="false" aria-label="Open menu"><i><b></b><b></b></i></button>
  <span class="dock__progress" aria-hidden="true">00%</span>
  <a class="dock__cta" href="contact.html">Book a free call</a>
</div>
`;
}

function footer() {
  const links = NAV.map((n) => `<li><a href="${n.href}">${n.label}</a></li>`).join("");
  return `
<footer class="footer">
  <div class="wrap">
    <p class="footer__big" aria-hidden="true">PROCURA</p>
    <div class="footer__cols">
      <div>
        <span class="label">Procura UK</span>
        <p class="muted">Power bank rental stations for gyms, hotels, cafés, bars and train stations. Free to host, with a share of every rental for you. Now opening in London.</p>
      </div>
      <div><span class="label">Pages</span><ul>${links}</ul></div>
      <div><span class="label">Talk to us</span><ul><li><a href="contact.html">Book a free consultation</a></li><li><a href="contact.html?type=question">Ask a question</a></li><li><a href="index.html#faq">FAQs</a></li></ul></div>
      <div><span class="label">Legal</span><ul><li><a href="privacy.html">Privacy notice</a></li></ul></div>
    </div>
    <div class="footer__legal">
      <p>${LEGAL}</p>
      <p>&copy; ${new Date().getFullYear()} JUKIE Experiences Ltd</p>
    </div>
  </div>
</footer>
`;
}

function scripts(meta) {
  return `<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/ScrollTrigger.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/lenis@1.1.13/dist/lenis.min.js"></script>
<script src="js/main.js"></script>
${meta.three ? '<script type="module" src="js/station.js"></script>' : ""}
</body>
</html>
`;
}

let count = 0;
for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith(".html"))) {
  const raw = fs.readFileSync(path.join(SRC, file), "utf8");
  const m = raw.match(/^<!--\s*(\{[\s\S]*?\})\s*-->\n/);
  if (!m) throw new Error(`${file}: missing settings comment on line 1`);
  const meta = JSON.parse(m[1]);
  meta.url = SITE + (file === "index.html" ? "/" : "/" + file);
  const body = raw.slice(m[0].length).split("@@ESTIMATOR@@").join(ESTIMATOR);
  const html = head(meta) + "\n" + chrome(file, meta) + '\n<main id="main">\n' + body + "\n</main>\n" + footer() + scripts(meta);
  if (/\u2014|\u2013/.test(html)) throw new Error(`${file}: contains an em or en dash`);
  fs.writeFileSync(path.join(__dirname, file), html);
  count++;
}
// Search engine files
const pages = fs.readdirSync(SRC).filter((f) => f.endsWith(".html") && f !== "thanks.html");
const today = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(__dirname, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  pages.map((f) => `  <url><loc>${SITE}${f === "index.html" ? "/" : "/" + f}</loc><lastmod>${today}</lastmod></url>`).join("\n") +
  `\n</urlset>\n`);
fs.writeFileSync(path.join(__dirname, "robots.txt"), `User-agent: *\nAllow: /\nDisallow: /src/\n\nSitemap: ${SITE}/sitemap.xml\n`);

console.log(`Built ${count} pages, sitemap.xml and robots.txt.`);
