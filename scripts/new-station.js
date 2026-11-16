#!/usr/bin/env node
"use strict";
// Adds a new machine (station): makes its QR code, checks the code reads back to the right address, and prints
// the STATIONS setting to put in Netlify. See README "Add a new machine".
//
//   npm install --no-save qrcode@1.5.4 jsqr@1.4.0 pngjs@7.0.0     (once; nothing is added to package.json)
//   node scripts/new-station.js --code SOH1 --device DTA12345 --name "Soho Gym" --lang en
//
// --code    what goes in the QR address, 1 to 16 letters, digits, - or _ (printed codes never need to change:
//           if a machine is swapped, only the device id in STATIONS changes)
// --device  the machine's id in the supplier's system (on the machine, or from the supplier), e.g. DTA59552
// --name    shown to the customer on the page, e.g. "Al Jawhara Garden"
// --lang    en or ar: the language the page opens in (optional, default en)
// --current the current STATIONS value, to print the combined value to paste (optional)
//
// Writes assets/qr/rent-<CODE>.svg (for printing, any size) and assets/qr/rent-<CODE>.png (for screens).
// Uses the same settings as the AJ1 code (error correction Q, 4 module margin), which survives smudges.

const fs = require("fs");
const path = require("path");

const SITE = "https://procuracharge.com";
const STATION_CODE = /^[A-Z0-9_-]{1,16}$/;
const DEVICE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([a-z]+)(?:=(.*))?$/);
    if (!m) continue;
    out[m[1]] = m[2] !== undefined ? m[2] : argv[++i];
  }
  return out;
}

function need(mod) {
  try { return require(mod); } catch (e) {
    console.error(`Missing the "${mod}" package. Run this first, then try again:\n  npm install --no-save qrcode@1.5.4 jsqr@1.4.0 pngjs@7.0.0`);
    process.exit(1);
  }
}

async function main() {
  const a = args(process.argv.slice(2));
  const code = String(a.code || "").toUpperCase();
  const device = String(a.device || "");
  const name = String(a.name || "").trim();
  const lang = a.lang ? String(a.lang).toLowerCase() : "en";
  const problems = [];
  if (!STATION_CODE.test(code)) problems.push("--code must be 1 to 16 letters, digits, - or _ (for example SOH1)");
  if (!DEVICE_ID.test(device)) problems.push("--device must be the machine's id from the supplier (for example DTA59552)");
  if (!name || name.length > 80) problems.push("--name must be the venue name customers will see (up to 80 characters)");
  if (lang !== "en" && lang !== "ar") problems.push("--lang must be en or ar");
  let current = {};
  if (a.current) {
    try { current = JSON.parse(a.current); } catch (e) { problems.push("--current must be the current STATIONS value, in JSON"); }
    if (current && current[code]) problems.push(`station ${code} is already in --current: pick another code`);
  }
  if (problems.length) { console.error("Not done:\n- " + problems.join("\n- ")); process.exit(1); }

  const QR = need("qrcode");
  const jsQR = need("jsqr");
  const { PNG } = need("pngjs");
  const url = `${SITE}/rent?station=${encodeURIComponent(code)}`;
  const opts = { errorCorrectionLevel: "Q", margin: 4 };
  const dir = path.join(__dirname, "..", "assets", "qr");
  fs.mkdirSync(dir, { recursive: true });
  const svgFile = path.join(dir, `rent-${code}.svg`);
  const pngFile = path.join(dir, `rent-${code}.png`);
  if (fs.existsSync(svgFile) || fs.existsSync(pngFile)) { console.error(`Not done: assets/qr/rent-${code}.* already exists. Pick another code.`); process.exit(1); }

  fs.writeFileSync(svgFile, await QR.toString(url, { ...opts, type: "svg" }));
  await QR.toFile(pngFile, url, { ...opts, type: "png", width: 1200 });

  // Read the PNG back like a phone would, and refuse to finish if it says anything else.
  const png = PNG.sync.read(fs.readFileSync(pngFile));
  const read = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  if (!read || read.data !== url) {
    fs.rmSync(svgFile, { force: true }); fs.rmSync(pngFile, { force: true });
    console.error(`Not done: the QR code did not read back as ${url}`);
    process.exit(1);
  }

  const entry = { deviceId: device, name, ...(lang === "ar" ? { lang: "ar" } : {}) };
  console.log(`QR code made and checked: it opens ${url}`);
  console.log(`  print:   assets/qr/rent-${code}.svg`);
  console.log(`  screens: assets/qr/rent-${code}.png`);
  console.log("");
  console.log("Add this machine to the STATIONS setting in Netlify:");
  console.log(`  "${code}": ${JSON.stringify(entry)}`);
  if (a.current) {
    console.log("");
    console.log("The whole new STATIONS value to paste:");
    console.log("  " + JSON.stringify({ ...current, [code]: entry }));
  }
  console.log("");
  console.log(`Then deploy, and check https://procuracharge.com/api/rent/health?station=${code}&orders=1`);
}

main().catch((e) => { console.error("Not done: " + (e && e.message)); process.exit(1); });
