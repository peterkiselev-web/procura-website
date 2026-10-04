// Builds the static pages. Each file in src/pages is a page body whose first line is a
// JSON comment with its settings. Shared chrome (head, header, menu, dock, footer) lives here.
// Run: node build.js
//
// Settings a page can use in its first-line comment:
//   title, description   required. Keep titles under 65 characters and descriptions under 165.
//   crumb                short name for the breadcrumb (defaults to the nav label or the title)
//   faq                  true to publish the page's <details> questions as FAQ structured data
//   article, published   true plus a YYYY-MM-DD date for guides (adds Article structured data)
//   noindex              keeps the page out of search engines and the sitemap
//   three, loader, script  page-specific scripts and effects
"use strict";
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "src", "pages");

// Live address. Used for canonical links, social previews, structured data and the sitemap.
const SITE = "https://procuracharge.com";

// Pages are served at clean addresses (/machines, not /machines.html). The canonical links, the sitemap,
// the structured data and every internal link use that one form, so search engines see a single address per page.
const urlFor = (file) => (file === "index.html" ? "/" : "/" + file.replace(/\.html$/, ""));

const NAV = [
  { file: "index.html", label: "Home" },
  { file: "machines.html", label: "Machines" },
  { file: "how-it-works.html", label: "How it works" },
  { file: "why-host.html", label: "Why host one" },
  { file: "faq.html", label: "FAQs" },
  { file: "about.html", label: "About" },
  { file: "contact.html", label: "Contact" },
];

const VENUE_PAGES = [
  { file: "power-bank-rental-stations-for-bars-and-pubs.html", label: "Bars and pubs" },
  { file: "power-bank-rental-stations-for-restaurants-and-cafes.html", label: "Restaurants and cafés" },
  { file: "power-bank-rental-stations-for-gyms.html", label: "Gyms and leisure centres" },
  { file: "power-bank-rental-stations-for-hotels.html", label: "Hotels" },
];

const GUIDE_PAGES = [
  { file: "are-power-bank-rental-stations-worth-it.html", label: "Are power bank rental stations worth it?" },
  { file: "how-to-choose-a-power-bank-rental-provider.html", label: "How to choose a rental provider" },
];

const LEGAL =
  "Procura is a trading name of JUKIE Experiences Ltd, a private limited company registered in England and Wales, " +
  "company number 16203343. Registered office: 21 Royal Avenue, London, SW3 4QE.";

const OG_IMAGE = SITE + "/assets/img/station-graphite.jpg";
const OG_IMAGE_ALT = "The Procura counter station in matte graphite, with a screen on top and twelve power bank slots";


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

// Closing call to action, dropped into any page body that contains @@CTA@@.
const CTA = `<section class="section cta-band">
  <div class="glow" style="left:-30vw;right:auto;top:0"></div>
  <div class="wrap">
    <span class="label">Next step</span>
    <h2 data-split>Start with<br>a free call</h2>
    <p class="lede muted">Contact us for more, and our team will get back to you. Or book a free consultation call now and find out the revenue share split for your venue.</p>
    <div class="btn-row">
      <a class="btn" href="contact.html">Book a free consultation call <span class="arrow" aria-hidden="true">&rarr;</span></a>
      <a class="btn btn--ghost" href="contact.html?type=question">Contact us for more</a>
    </div>
  </div>
</section>`;

// Links to the venue pages and guides, dropped into any page body that contains @@RELATED@@.
// One list here means every page links to the others without anyone keeping the links in step by hand.
function related(currentFile) {
  const list = (pages) => pages.filter((p) => p.file !== currentFile)
    .map((p) => `<li><a href="${urlFor(p.file)}">${p.label} <span aria-hidden="true">&rarr;</span></a></li>`).join("");
  const guides = list(GUIDE_PAGES) + (currentFile === "faq.html" ? "" : `<li><a href="/faq">Power bank rental station FAQs <span aria-hidden="true">&rarr;</span></a></li>`);
  return `<section class="section section--tight is-bone related">
  <div class="wrap grid-2">
    <div>
      <span class="label">Find out more</span>
      <h2 data-split>Hosting for your type of venue</h2>
    </div>
    <div class="related__lists">
      <div><h3>Power bank rental stations for</h3><ul>${list(VENUE_PAGES)}</ul></div>
      <div><h3>Guides and answers</h3><ul>${guides}</ul></div>
    </div>
  </div>
</section>`;
}


const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Plain text from an HTML fragment, for structured data.
function plain(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/&rarr;/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

// Questions and answers from the page's visible <details> blocks, so the markup and the page cannot drift apart.
function faqFrom(body) {
  const re = /<details>\s*<summary>([\s\S]*?)<span class="plus"[^>]*><\/span><\/summary>\s*<div class="faq__a"><div>([\s\S]*?)<\/div><\/div>\s*<\/details>/g;
  const out = [];
  let m;
  while ((m = re.exec(body))) out.push({ q: plain(m[1]), a: plain(m[2]) });
  return out;
}

const ORG_ID = SITE + "/#organization";
const SITE_ID = SITE + "/#website";

function structuredData(file, meta, body) {
  const graph = [
    {
      "@type": "Organization", "@id": ORG_ID, name: "Procura", legalName: "JUKIE Experiences Ltd", url: SITE + "/",
      logo: { "@type": "ImageObject", url: SITE + "/assets/img/favicon.svg" },
      image: OG_IMAGE,
      description: "Procura installs, runs and insures power bank rental stations in UK venues for free, and pays hosts a share of every rental.",
      foundingDate: "2025",
      areaServed: [{ "@type": "City", name: "London" }, { "@type": "Country", name: "United Kingdom" }],
      contactPoint: { "@type": "ContactPoint", contactType: "sales", url: SITE + "/contact", areaServed: "GB", availableLanguage: "English" },
    },
    { "@type": "WebSite", "@id": SITE_ID, url: SITE + "/", name: "Procura", inLanguage: "en-GB", publisher: { "@id": ORG_ID } },
  ];
  const pageId = meta.url + "#webpage";
  if (meta.article) {
    graph.push({
      "@type": "Article", "@id": meta.url + "#article", headline: meta.title.replace(/\s*\|\s*Procura$/, ""), description: meta.description,
      datePublished: meta.published, dateModified: meta.published, image: OG_IMAGE, inLanguage: "en-GB",
      author: { "@id": ORG_ID }, publisher: { "@id": ORG_ID }, mainEntityOfPage: { "@id": pageId },
    });
  }
  graph.push({
    "@type": "WebPage", "@id": pageId, url: meta.url, name: meta.title, description: meta.description, inLanguage: "en-GB",
    isPartOf: { "@id": SITE_ID }, about: { "@id": ORG_ID }, primaryImageOfPage: { "@type": "ImageObject", url: OG_IMAGE },
  });
  if (file !== "index.html") {
    const nav = NAV.find((n) => n.file === file);
    const crumb = meta.crumb || (nav && nav.label) || meta.title.replace(/\s*\|\s*Procura$/, "");
    graph.push({
      "@type": "BreadcrumbList", "@id": meta.url + "#breadcrumb",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: SITE + "/" },
        { "@type": "ListItem", position: 2, name: crumb, item: meta.url },
      ],
    });
  }
  if (meta.faq) {
    const items = faqFrom(body);
    if (!items.length) throw new Error(`${file}: "faq" is set but no <details> questions were found`);
    graph.push({
      "@type": "FAQPage", "@id": meta.url + "#faq", url: meta.url, isPartOf: { "@id": pageId },
      mainEntity: items.map((i) => ({ "@type": "Question", name: i.q, acceptedAnswer: { "@type": "Answer", text: i.a } })),
    });
  }
  const json = JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${json}</script>`;
}

function head(meta, file, body) {
  const t = esc(meta.title), d = esc(meta.description);
  return `<!doctype html>
<html lang="en-GB" class="no-js">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${t}</title>
<meta name="description" content="${d}">
<meta name="robots" content="${meta.noindex ? "noindex" : "index, follow, max-image-preview:large"}">
<meta name="theme-color" content="#0a0a0a">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:type" content="${meta.article ? "article" : "website"}">
<meta property="og:image" content="${OG_IMAGE}">
<meta property="og:image:alt" content="${esc(OG_IMAGE_ALT)}">
<meta property="og:url" content="${meta.url}">
<meta property="og:site_name" content="Procura">
<meta property="og:locale" content="en_GB">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${OG_IMAGE}">
${meta.noindex ? "" : `<link rel="canonical" href="${meta.url}">\n`}<link rel="icon" href="assets/img/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@300..700&family=Geist+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="css/style.css">
${meta.three ? `<link rel="modulepreload" href="https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js" crossorigin>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/"}}</script>
` : ""}${meta.noindex ? "" : structuredData(file, meta, body) + "\n"}</head>`;
}

function chrome(slug, meta) {
  const links = NAV.map((n) => `<a href="${urlFor(n.file)}"${n.file === slug ? ' aria-current="page"' : ""}>${n.label}</a>`).join("");
  const menuLinks = NAV.map((n, i) => `<li><a href="${urlFor(n.file)}"${n.file === slug ? ' aria-current="page"' : ""}><small>0${i + 1}</small>${n.label}</a></li>`).join("\n      ");
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
  const links = NAV.map((n) => `<li><a href="${urlFor(n.file)}">${n.label}</a></li>`).join("");
  const venues = VENUE_PAGES.map((p) => `<li><a href="${urlFor(p.file)}">${p.label}</a></li>`).join("");
  const guides = GUIDE_PAGES.map((p) => `<li><a href="${urlFor(p.file)}">${p.label}</a></li>`).join("");
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
      <div><span class="label">Hosting for</span><ul>${venues}</ul></div>
      <div><span class="label">Guides</span><ul>${guides}<li><a href="contact.html?type=question">Ask a question</a></li></ul></div>
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
  // integrity hashes pin these exact files: if a CDN ever served altered code, the browser refuses it.
  return `<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js" integrity="sha384-g4NTh/Iv5PPU4xPyhEWqPcwtNXOvdaDI8LLnyYfyNZOjKJeYQyjzQ9X5275eBjpt" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/ScrollTrigger.min.js" integrity="sha384-Z3REaz79l2IaAZqJsSABtTbhjgOUYyV3p90XNnAPCSHg3EMTz1fouunq9WZRtj3d" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<script src="https://cdn.jsdelivr.net/npm/lenis@1.1.13/dist/lenis.min.js" integrity="sha384-B2WBjDzEjJpYvhmi2UyEn7rektqkf5suS6sNoyyrf0EBAwBHdkiXxIlU0V5Ru2ed" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<script src="js/main.js"></script>
${meta.three ? '<script type="module" src="js/station.js"></script>' : ""}${meta.script ? `\n<script src="js/${meta.script}"></script>` : ""}
</body>
</html>
`;
}

// Internal links are written as "contact.html" in the source pages. On the live site they are "/contact".
// Assets get a leading slash so they load from any address.
function cleanLinks(html) {
  return html
    .replace(/href="index\.html(#[^"]*)?"/g, (m, hash) => `href="/${hash || ""}"`)
    .replace(/href="([a-z0-9-]+)\.html([?#][^"]*)?"/g, (m, name, rest) => `href="/${name}${rest || ""}"`)
    .replace(/\b(src|href|poster)="(assets|css|js)\//g, '$1="/$2/');
}

let count = 0;
const hidden = new Set(); // pages marked noindex are left out of the sitemap
const files = fs.readdirSync(SRC).filter((f) => f.endsWith(".html"));
for (const file of files) {
  const raw = fs.readFileSync(path.join(SRC, file), "utf8");
  const m = raw.match(/^<!--\s*(\{[\s\S]*?\})\s*-->\n/);
  if (!m) throw new Error(`${file}: missing settings comment on line 1`);
  const meta = JSON.parse(m[1]);
  meta.url = SITE + urlFor(file);
  if (meta.article && !/^\d{4}-\d{2}-\d{2}$/.test(meta.published || "")) throw new Error(`${file}: "article" needs "published": "YYYY-MM-DD"`);
  if (meta.noindex) hidden.add(file);
  const body = raw.slice(m[0].length).split("@@ESTIMATOR@@").join(ESTIMATOR).split("@@RELATED@@").join(related(file)).split("@@CTA@@").join(CTA);
  const html = cleanLinks(head(meta, file, body) + "\n" + chrome(file, meta) + '\n<main id="main">\n' + body + "\n</main>\n" + footer() + scripts(meta));
  if (/—|–/.test(html)) throw new Error(`${file}: contains an em or en dash`);
  fs.writeFileSync(path.join(__dirname, file), html);
  count++;
}

// Search engine files
const pages = files.filter((f) => !hidden.has(f));
fs.writeFileSync(path.join(__dirname, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  pages.map((f) => `  <url><loc>${SITE}${urlFor(f)}</loc></url>`).join("\n") +
  `\n</urlset>\n`);
fs.writeFileSync(path.join(__dirname, "robots.txt"), `User-agent: *\nAllow: /\nDisallow: /src/\n\nSitemap: ${SITE}/sitemap.xml\n`);

console.log(`Built ${count} pages, sitemap.xml and robots.txt.`);
