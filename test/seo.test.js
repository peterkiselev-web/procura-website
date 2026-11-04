"use strict";
// Checks the built site for the SEO basics, so a later edit cannot quietly undo them.
// It rebuilds first, then reads the generated HTML, sitemap and robots.txt.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
execFileSync("node", ["build.js"], { cwd: ROOT, stdio: "ignore" });

const SITE = "https://procuracharge.com";
const pages = fs.readdirSync(path.join(ROOT, "src", "pages")).filter((f) => f.endsWith(".html")).map((file) => {
  const src = fs.readFileSync(path.join(ROOT, "src", "pages", file), "utf8");
  const meta = JSON.parse(src.match(/^<!--\s*(\{.*\})\s*-->/)[1]);
  const html = fs.readFileSync(path.join(ROOT, file), "utf8");
  const urlPath = file === "index.html" ? "/" : "/" + file.replace(/\.html$/, "");
  return { file, meta, html, urlPath, url: SITE + urlPath };
});
const indexable = pages.filter((p) => !p.meta.noindex);
const hidden = pages.filter((p) => p.meta.noindex);

const attr = (html, re) => (html.match(re) || [])[1];
const graph = (p) => {
  const m = p.html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  return m ? JSON.parse(m[1])["@graph"] : null;
};

test("every indexable page has a distinct, well-sized title and description", () => {
  const titles = new Set(), descs = new Set();
  for (const p of indexable) {
    const title = attr(p.html, /<title>([^<]*)<\/title>/);
    const desc = attr(p.html, /<meta name="description" content="([^"]*)"/);
    assert.ok(title && title.length >= 20 && title.length <= 65, `${p.file}: title length ${title && title.length}: ${title}`);
    assert.ok(desc && desc.length >= 70 && desc.length <= 165, `${p.file}: description length ${desc && desc.length}`);
    assert.ok(!titles.has(title), `${p.file}: duplicate title`);
    assert.ok(!descs.has(desc), `${p.file}: duplicate description`);
    titles.add(title); descs.add(desc);
  }
});

test("every page has exactly one H1", () => {
  for (const p of pages) assert.equal((p.html.match(/<h1[\s>]/g) || []).length, 1, `${p.file}: H1 count`);
});

test("canonical, og:url and the sitemap all use the same clean address", () => {
  const sitemap = fs.readFileSync(path.join(ROOT, "sitemap.xml"), "utf8");
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual([...locs].sort(), indexable.map((p) => p.url).sort(), "sitemap lists exactly the indexable pages");
  for (const p of indexable) {
    assert.equal(attr(p.html, /<link rel="canonical" href="([^"]+)"/), p.url, `${p.file}: canonical`);
    assert.equal(attr(p.html, /<meta property="og:url" content="([^"]+)"/), p.url, `${p.file}: og:url`);
    assert.ok(!/\.html$/.test(p.url), `${p.file}: address should not end in .html`);
    assert.match(p.html, /<meta name="robots" content="index, follow/, `${p.file}: robots`);
  }
});

test("private and utility pages stay out of search", () => {
  assert.ok(hidden.map((p) => p.file).includes("waitlist.html"));
  for (const p of hidden) {
    assert.match(p.html, /<meta name="robots" content="noindex">/, `${p.file}: noindex`);
    assert.ok(!/rel="canonical"/.test(p.html), `${p.file}: noindex pages need no canonical`);
    assert.ok(!graph(p), `${p.file}: no structured data`);
  }
  const robots = fs.readFileSync(path.join(ROOT, "robots.txt"), "utf8");
  assert.match(robots, new RegExp(`Sitemap: ${SITE}/sitemap.xml`));
});

test("structured data is valid JSON and describes the organisation, site and page", () => {
  for (const p of indexable) {
    const g = graph(p);
    assert.ok(g, `${p.file}: has JSON-LD`);
    const types = g.map((n) => n["@type"]);
    for (const t of ["Organization", "WebSite", "WebPage"]) assert.ok(types.includes(t), `${p.file}: ${t}`);
    if (p.file !== "index.html") assert.ok(types.includes("BreadcrumbList"), `${p.file}: breadcrumbs`);
    assert.equal(types.includes("Article"), !!p.meta.article, `${p.file}: Article only on guides`);
    assert.equal(types.includes("FAQPage"), !!p.meta.faq, `${p.file}: FAQPage only where flagged`);
    const org = g.find((n) => n["@type"] === "Organization");
    assert.equal(org.legalName, "JUKIE Experiences Ltd");
    assert.ok(!/—|–/.test(JSON.stringify(g)), `${p.file}: no em or en dashes`);
  }
});

test("FAQ structured data matches the questions people can see on the page", () => {
  for (const p of indexable.filter((x) => x.meta.faq)) {
    const faq = graph(p).find((n) => n["@type"] === "FAQPage");
    const visible = (p.html.match(/<details>/g) || []).length;
    assert.equal(faq.mainEntity.length, visible, `${p.file}: ${faq.mainEntity.length} in schema, ${visible} on page`);
    for (const q of faq.mainEntity) {
      assert.ok(p.html.includes(q.name), `${p.file}: question not on page: ${q.name}`);
      assert.ok(q.acceptedAnswer.text.length > 20, `${p.file}: empty answer for ${q.name}`);
    }
  }
  const faqPage = pages.find((p) => p.file === "faq.html");
  assert.ok(graph(faqPage).find((n) => n["@type"] === "FAQPage").mainEntity.length >= 20, "the FAQ page has at least 20 questions");
});

test("guides carry a publish date", () => {
  for (const p of indexable.filter((x) => x.meta.article)) {
    const a = graph(p).find((n) => n["@type"] === "Article");
    assert.match(a.datePublished, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(a.headline && !/\| Procura/.test(a.headline));
  }
});

test("every internal link and asset points at something that exists", () => {
  const pagePaths = new Set(pages.map((p) => p.urlPath));
  for (const p of pages) {
    assert.ok(!/href="[a-z0-9-]+\.html/.test(p.html), `${p.file}: a link still ends in .html`);
    const targets = [...p.html.matchAll(/(?:href|src|poster)="(\/[^"#?]*)([?#][^"]*)?"/g)];
    for (const [, target, rest] of targets) {
      if (target === "/") continue;
      const ok = path.extname(target) ? fs.existsSync(path.join(ROOT, target)) : pagePaths.has(target);
      assert.ok(ok, `${p.file}: broken link ${target}`);
      if (rest && rest.startsWith("#") && target !== p.urlPath) {
        const dest = pages.find((x) => x.urlPath === target);
        assert.ok(dest && dest.html.includes(`id="${rest.slice(1)}"`), `${p.file}: missing anchor ${target}${rest}`);
      }
    }
  }
  const home = pages.find((p) => p.file === "index.html");
  assert.ok(home.html.includes('id="faq"'));
});

test("every page links to the venue pages and guides", () => {
  const must = ["/faq", "/power-bank-rental-stations-for-bars-and-pubs", "/are-power-bank-rental-stations-worth-it", "/how-to-choose-a-power-bank-rental-provider"];
  for (const p of indexable) for (const m of must) {
    if (p.urlPath !== m) assert.ok(p.html.includes(`href="${m}"`), `${p.file}: no link to ${m}`);
  }
});

test("every image has alt text", () => {
  for (const p of pages) for (const img of p.html.match(/<img\b[^>]*>/g) || []) assert.match(img, /\balt="[^"]+"/, `${p.file}: ${img}`);
});

test("the site does not promise an installation time it cannot keep", () => {
  for (const p of pages) assert.ok(!/within two weeks|about two weeks|install[^.<]{0,50}in two weeks/i.test(p.html), `${p.file}: stale install-time claim`);
});

test("the content security policy still matches the inline import map", () => {
  const home = pages.find((p) => p.file === "index.html").html;
  const map = home.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1];
  const hash = "sha256-" + crypto.createHash("sha256").update(map).digest("base64");
  for (const f of ["netlify.toml", "server.js"]) assert.ok(fs.readFileSync(path.join(ROOT, f), "utf8").includes(hash), `${f} is missing ${hash}`);
});

test("the 3D model is no longer preloaded", () => {
  for (const p of pages) assert.ok(!/rel="preload"[^>]*\.glb/.test(p.html), `${p.file}: preloads the 5.6 MB model`);
});

// ---- link previews: what a text message, WhatsApp, Slack or social post shows when a link is shared

// Width and height of a JPEG, read from its header.
function jpegSize(file) {
  const b = fs.readFileSync(file);
  assert.equal(b[0], 0xff); assert.equal(b[1], 0xd8, `${file} is not a JPEG`);
  let i = 2;
  while (i < b.length) {
    assert.equal(b[i], 0xff);
    const marker = b[i + 1], len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  throw new Error("no size found");
}

test("every public page carries the full set of link preview tags", () => {
  const need = ["og:title", "og:description", "og:type", "og:image", "og:image:secure_url", "og:image:type", "og:image:width", "og:image:height", "og:image:alt", "og:url", "og:site_name", "og:locale"];
  for (const p of indexable) {
    for (const prop of need) assert.match(p.html, new RegExp(`<meta property="${prop}" content="[^"]+"`), `${p.file}: missing ${prop}`);
    for (const name of ["twitter:card", "twitter:title", "twitter:description", "twitter:image", "twitter:image:alt"]) {
      assert.match(p.html, new RegExp(`<meta name="${name}" content="[^"]+"`), `${p.file}: missing ${name}`);
    }
    assert.equal(attr(p.html, /<meta name="twitter:card" content="([^"]+)"/), "summary_large_image");
    assert.match(p.html, /<link rel="apple-touch-icon" href="\/assets\/img\/apple-touch-icon\.png">/, `${p.file}: no touch icon`);
  }
});

test("the preview image is a real landscape picture of the right size, at an absolute address", () => {
  for (const p of indexable) {
    const src = attr(p.html, /<meta property="og:image" content="([^"]+)"/);
    assert.equal(src, `${SITE}/assets/img/share-preview.jpg`, `${p.file}: og:image`);
    assert.equal(attr(p.html, /<meta name="twitter:image" content="([^"]+)"/), src, `${p.file}: twitter:image should match`);
  }
  const file = path.join(ROOT, "assets", "img", "share-preview.jpg");
  const { width, height } = jpegSize(file);
  assert.deepEqual([width, height], [1200, 630], "the image should be 1200 x 630");
  assert.ok(fs.statSync(file).size < 300 * 1024, "the image should be under 300 KB so every app will load it");
  const home = pages.find((p) => p.file === "index.html").html;
  assert.equal(attr(home, /<meta property="og:image:width" content="(\d+)"/), "1200");
  assert.equal(attr(home, /<meta property="og:image:height" content="(\d+)"/), "630");
  const icon = fs.readFileSync(path.join(ROOT, "assets", "img", "apple-touch-icon.png"));
  assert.equal(icon.readUInt32BE(16), 180); assert.equal(icon.readUInt32BE(20), 180);
});

test("the link preview wording chosen on 8 October is kept exactly", () => {
  const home = pages.find((p) => p.file === "index.html").html;
  assert.equal(attr(home, /<meta property="og:title" content="([^"]+)"/), "Procura | Free, fully bespoke power bank stations for UK venues");
  assert.equal(attr(home, /<meta property="og:description" content="([^"]+)"/), "Free power bank stations for UK venues. We develop and build our own machines, so every station is made bespoke to your brand, from the body colour to the screen. We install it, run it, insure it, and pay you a share of every rental.");
  const machines = pages.find((p) => p.file === "machines.html").html;
  assert.match(attr(machines, /<meta property="og:description" content="([^"]+)"/), /^The Procura range: a 12-slot counter station.*built bespoke to your brand before it ships\. Free to host\.$/);
});

test("the preview tags are in the page source itself, not added by JavaScript", () => {
  for (const f of ["main.js", "station.js", "waitlist.js"]) {
    const js = fs.readFileSync(path.join(ROOT, "js", f), "utf8");
    assert.ok(!/og:image|property=["']og:|createElement\(["']meta["']\)/.test(js), `js/${f} must not touch the preview tags`);
  }
});

test("the footer on every public page links to the FAQs, the venue pages and the partner pages", () => {
  for (const p of indexable) {
    const footer = p.html.slice(p.html.indexOf('<footer class="footer">'));
    for (const href of ["/faq", "/power-bank-rental-stations-for-hotels", "/are-power-bank-rental-stations-worth-it", "/referral", "/partnerships", "/franchise", "/privacy", "/contact"]) {
      assert.ok(footer.includes(`href="${href}"`), `${p.file}: the footer has no link to ${href}`);
    }
  }
});

test("machine names and slot counts agree everywhere: Floor 24 and Tower 48", () => {
  for (const p of pages) {
    assert.ok(!/Floor 20|Tower 40|\b20-slot|\b40-slot|\b20 slots|\b40 slots|\btwenty banks|\bforty banks/i.test(p.html), `${p.file}: still uses the old Floor 20 / Tower 40 wording`);
  }
  const m = pages.find((p) => p.file === "machines.html").html;
  assert.match(m, /Procura Floor 24/); assert.match(m, /Procura Tower 48/);
  assert.match(m, /<th scope="row">Slots<\/th><td>24<\/td>/); assert.match(m, /<th scope="row">Slots<\/th><td>48<\/td>/);
  assert.match(m, /<td>12, or 24 stacked<\/td><td>24<\/td><td>48<\/td>/, "the comparison table");
  assert.match(attr(m, /<meta name="description" content="([^"]+)"/), /24-slot floor kiosk.*48-slot tower/, "search listing");
  assert.match(attr(m, /<meta property="og:description" content="([^"]+)"/), /24-slot floor kiosk.*48-slot Tower/, "link preview");
  const home = pages.find((p) => p.file === "index.html").html;
  assert.match(home, /<span class="chip">24 slots<\/span>/); assert.match(home, /<span class="chip">48 slots<\/span>/);
  assert.match(home, /<h3>Procura Floor 24<\/h3>/); assert.match(home, /<h3>Procura Tower 48<\/h3>/);
  // the picture descriptions must not state a slot count the photos do not show
  for (const img of m.match(/<img\b[^>]*kiosk(20|40)\.webp[^>]*>/g)) assert.ok(!/\b(ten|twenty|forty) slots/i.test(img), `alt text states a count: ${img}`);
});
