// Standalone script to generate the extension icons as PNGs.
// Draws: green rounded square background + white download arrow.
// Uses only Node's built-in zlib to encode the PNG.
"use strict";
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

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

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // scanlines with filter byte 0
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.slice(y * w * 4, (y + 1) * w * 4).forEach((v, i) => {
      raw[y * (w * 4 + 1) + 1 + i] = v;
    });
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Rounded-square + arrow drawing.
function makeIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const rounded = size * 0.18;
  const bg = [22, 163, 74, 255]; // green #16a34a
  const white = [255, 255, 255, 255];

  const inRounded = (x, y) => {
    const r = rounded;
    const inside =
      x >= 0 && x < size && y >= 0 && y < size &&
      ((x + r >= r && x < size - r) ||
       (x >= r && x <= size * 0.5) || (x >= size * 0.5 && x < size - r) &&
        (x >= r && x < size - r)) &&
      y >= r && y < size - r;
    return inside;
  };

  // corner radius helper: circular check in each corner
  const dx = (v, c) => {
    if (v < c + r && v > c) return c + r - v; // approximation
    return 0;
  };

  const r = rounded;
  const corners = [];
  const near = (v, c, lim) => v >= c - lim && v <= c + lim;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // rounded quad check
      const inRect = x >= r && x < size - r && y >= r && y < size - r;
      // corner circles
      const ctl = (x - r) * (x - r) + (y - r) * (y - r) <= r * r; // top-left
      const ctr = (x - (size - 1 - r)) * (x - (size - 1 - r)) + (y - r) * (y - r) <= r * r;
      const cbl = (x - r) * (x - r) + (y - (size - 1 - r)) * (y - (size - 1 - r)) <= r * r;
      const cbr = (x - (size - 1 - r)) * (x - (size - 1 - r)) + (y - (size - 1 - r)) * (y - (size - 1 - r)) <= r * r;
      const inside = inRect || ctl || ctr || cbl || cbr;

      px[i] = bg[0];
      px[i + 1] = bg[1];
      px[i + 2] = bg[2];
      px[i + 3] = inside ? bg[3] : 0;

      // Draw a white download arrow, centered.
      const u = x / size;
      const v = y / size;
      const cx = size / 2;
      let shaft = false, triangle = false, arrow = false;

      // triangle (downward chevron) around center-bottom
      const ty0 = 0.52, ty1 = 0.66; // y0 to y1
      if (v >= ty0 && v <= ty1) {
        const t = (v - ty0) / (ty1 - ty0);
        const half = 0.16 * (1 - t); // narrows toward bottom => big top width
        // Actually widen from top: top width 0.30 narrowing to 0
        const hw = 0.30 * (1 - t);
        if (Math.abs(u - 0.5) <= hw) triangle = true;
      }
      // vertical shaft above triangle
      if (u >= 0.5 - 0.07 && u <= 0.5 + 0.07 && v >= 0.30 && v <= 0.52) shaft = true;

      arrow = shaft || triangle;
      if (arrow && inside) {
        px[i] = white[0];
        px[i + 1] = white[1];
        px[i + 2] = white[2];
        px[i + 3] = 255;
      }
    }
  }
  return encodePNG(size, size, px);
}

const outDir = path.join(__dirname, "icons");
fs.mkdirSync(outDir, { recursive: true });
for (const s of [16, 48, 128]) {
  fs.writeFileSync(path.join(outDir, `icon${s}.png`), makeIcon(s));
  console.log(`wrote icons/icon${s}.png`);
}