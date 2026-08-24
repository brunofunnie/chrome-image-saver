// Package the extension for the Chrome Web Store.
//
// Writes dist/image-saver-<version>.zip containing ONLY the files Chrome needs
// to run the extension. Everything else in the repo — the tests, the source
// artwork, the icon generator, this script, the docs — stays out. Anything
// shipped in the zip is publicly downloadable once the item is published, so
// the bundle is built from an explicit list rather than by excluding things.
//
// The file list is derived from manifest.json rather than hard-coded, and the
// build fails if a referenced file is missing or if a script is injected at
// runtime without being bundled.
//
// Uses only Node's built-in zlib: the ZIP writer is at the bottom of this file.
"use strict";
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const OUT_DIR = path.join(ROOT, "dist");

// Files that are needed at runtime but that the manifest cannot tell us about,
// because they're injected on demand rather than declared. Keyed by the file
// that does the injecting, so the check below can prove the list is complete.
const INJECTED_BY = ["background.js", "content.js"];

// Fixed ZIP timestamps, so the same inputs always produce a byte-identical
// archive (1980-01-01 00:00:00, the earliest the format can represent).
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

function fail(msg) {
  console.error("build failed: " + msg);
  process.exit(1);
}

function rel(p) {
  return path.relative(ROOT, p);
}

// ------------------------------------------------------- collect the file list

function readManifest() {
  const file = path.join(ROOT, "manifest.json");
  if (!fs.existsSync(file)) fail("manifest.json not found");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    fail("manifest.json is not valid JSON: " + e.message);
  }
}

// Every path the manifest points at.
function filesFromManifest(m) {
  const out = ["manifest.json"];
  const add = (p) => { if (p && out.indexOf(p) === -1) out.push(p); };

  if (m.background && m.background.service_worker) add(m.background.service_worker);
  for (const size of Object.keys(m.icons || {})) add(m.icons[size]);
  const actionIcon = (m.action && m.action.default_icon) || {};
  for (const size of Object.keys(actionIcon)) add(actionIcon[size]);
  if (m.action && m.action.default_popup) add(m.action.default_popup);
  for (const cs of m.content_scripts || []) {
    for (const f of cs.js || []) add(f);
    for (const f of cs.css || []) add(f);
  }
  for (const war of m.web_accessible_resources || []) {
    for (const f of war.resources || []) add(f);
  }
  return out;
}

// Scripts handed to chrome.scripting.executeScript are not in the manifest, so
// find them by looking at what the bundled code actually injects. A new
// injected file that nobody added to the bundle becomes a build error rather
// than an extension that breaks only at runtime.
function filesInjectedAtRuntime(sourceFiles) {
  const found = [];
  for (const name of sourceFiles) {
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, "utf8");
    const re = /files\s*:\s*\[([^\]]*)\]/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      for (const q of m[1].match(/["'][^"']+["']/g) || []) {
        const f = q.slice(1, -1);
        if (found.indexOf(f) === -1) found.push(f);
      }
    }
  }
  return found;
}

// ------------------------------------------------------------------ validation

function validate(m) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  if (m.version !== pkg.version) {
    fail(`version mismatch: manifest.json is ${m.version}, package.json is ${pkg.version}`);
  }
  if (!/^\d+(\.\d+){0,3}$/.test(m.version)) {
    fail(`manifest version "${m.version}" is not a valid Chrome version string`);
  }
  // The Web Store rejects a description longer than this.
  if (m.description && m.description.length > 132) {
    fail(`manifest description is ${m.description.length} chars (max 132)`);
  }
  if (!m.icons || !m.icons["128"]) {
    fail("manifest is missing the 128px icon, which the Web Store requires");
  }
  return pkg;
}

// ----------------------------------------------------------------------- build

const manifest = readManifest();
validate(manifest);

const files = filesFromManifest(manifest);
for (const f of filesInjectedAtRuntime(INJECTED_BY.filter((n) => files.indexOf(n) !== -1 || n === "background.js"))) {
  if (files.indexOf(f) === -1) files.push(f);
}

const missing = files.filter((f) => !fs.existsSync(path.join(ROOT, f)));
if (missing.length) fail("referenced but not on disk: " + missing.join(", "));

files.sort();

fs.mkdirSync(OUT_DIR, { recursive: true });
const zipName = `image-saver-${manifest.version}.zip`;
const zipPath = path.join(OUT_DIR, zipName);

const entries = files.map((name) => ({ name, data: fs.readFileSync(path.join(ROOT, name)) }));
const zip = makeZip(entries);
fs.writeFileSync(zipPath, zip);

const pad = Math.max(...entries.map((e) => e.name.length));
console.log(`Image Saver ${manifest.version} -> ${rel(zipPath)}\n`);
for (const e of entries) {
  console.log("  " + e.name.padEnd(pad) + "  " + String(e.data.length).padStart(7) + " bytes");
}
console.log(`\n  ${entries.length} files, ${zip.length} bytes zipped`);
console.log(`\nUpload ${rel(zipPath)} at https://chrome.google.com/webstore/devconsole`);

// -------------------------------------------------------------------- ZIP writer

// Minimal ZIP (deflate) writer.

function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = entry.data;
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    // A stored entry is smaller for data that doesn't compress (already-packed
    // PNGs, mostly), so keep whichever is shorter.
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const sum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);       // version needed
    local.writeUInt16LE(0, 6);        // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);       // extra length
    chunks.push(local, name, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);         // version made by
    dir.writeUInt16LE(20, 6);         // version needed
    dir.writeUInt16LE(0, 8);          // flags
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(sum, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30);         // extra
    dir.writeUInt16LE(0, 32);         // comment
    dir.writeUInt16LE(0, 34);         // disk number
    dir.writeUInt16LE(0, 36);         // internal attrs
    dir.writeUInt32LE(0x81a40000, 38); // external attrs: regular file, 0644
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);

    offset += local.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);                    // this disk
  end.writeUInt16LE(0, 6);                    // disk with central dir
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);                   // comment length

  return Buffer.concat([Buffer.concat(chunks), centralBuf, end]);
}
