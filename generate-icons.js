// Standalone script to generate the extension icons as PNGs.
//
// Source of truth is docs/image-saver.png (the full-resolution artwork). This
// script pads it to a square, downscales it to 16/48/128 and writes
// icons/icon{16,48,128}.png.
//
// Uses only Node's built-in zlib, so there are no image dependencies: the PNG
// decoder, the box-filter resampler and the PNG encoder all live here.
"use strict";
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "docs", "image-saver.png");
const SIZES = [16, 48, 128];

// ---------------------------------------------------------------- PNG common

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

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// --------------------------------------------------------------- PNG decoding

// Reverse the per-scanline filters defined by the PNG spec (§9.2). `bpp` is the
// byte count of one pixel, used as the distance to the "left" neighbour.
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = pos;
    pos += stride;
    const cur = y * stride;
    const prev = (y - 1) * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[line + i];
      const a = i >= bpp ? out[cur + i - bpp] : 0;       // left
      const b = y > 0 ? out[prev + i] : 0;               // up
      const c = y > 0 && i >= bpp ? out[prev + i - bpp] : 0; // up-left
      let v;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error("unsupported PNG filter type " + filter);
      }
      out[cur + i] = v & 0xff;
    }
  }
  return out;
}

// Decode an 8-bit, non-interlaced PNG (grayscale, RGB, gray+alpha or RGBA) into
// { width, height, rgba }. That covers the artwork; anything else throws with a
// clear message rather than producing a wrong icon.
function decodePNG(buf) {
  if (!buf.slice(0, 8).equals(PNG_SIG)) throw new Error("not a PNG file");
  let pos = 8;
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    pos += 12 + len; // length + type + data + crc
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data); // image data may be split across several chunks
    } else if (type === "IEND") {
      break;
    }
  }
  if (depth !== 8) throw new Error("only 8-bit PNGs are supported (got " + depth + ")");
  if (interlace !== 0) throw new Error("interlaced PNGs are not supported");
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error("unsupported PNG color type " + colorType);

  const pixels = unfilter(zlib.inflateSync(Buffer.concat(idat)), width, height, channels);

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    const s = i * channels, d = i * 4;
    let r, g, b, a;
    if (channels === 1) { r = g = b = pixels[s]; a = 255; }
    else if (channels === 2) { r = g = b = pixels[s]; a = pixels[s + 1]; }
    else if (channels === 3) { r = pixels[s]; g = pixels[s + 1]; b = pixels[s + 2]; a = 255; }
    else { r = pixels[s]; g = pixels[s + 1]; b = pixels[s + 2]; a = pixels[s + 3]; }
    rgba[d] = r; rgba[d + 1] = g; rgba[d + 2] = b; rgba[d + 3] = a;
  }
  return { width, height, rgba };
}

// --------------------------------------------------------------- PNG encoding

function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // scanlines with filter byte 0
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    PNG_SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ resampling

// Centre the image on a transparent square canvas. Padding (rather than
// cropping) keeps the artwork's rounded corners intact when the source isn't
// perfectly square.
function padToSquare(img) {
  const size = Math.max(img.width, img.height);
  if (size === img.width && size === img.height) return img;
  const out = Buffer.alloc(size * size * 4); // zero == fully transparent
  const offX = Math.floor((size - img.width) / 2);
  const offY = Math.floor((size - img.height) / 2);
  for (let y = 0; y < img.height; y++) {
    const from = y * img.width * 4;
    const to = ((y + offY) * size + offX) * 4;
    img.rgba.copy(out, to, from, from + img.width * 4);
  }
  return { width: size, height: size, rgba: out };
}

// Box filter (area average). For the large reductions we do here it beats
// nearest/bilinear, because every source pixel contributes to the result.
// Colour is averaged premultiplied by alpha, otherwise fully transparent pixels
// would drag their (arbitrary) RGB into the edges and produce dark fringes.
function resizeBox(img, size) {
  const out = Buffer.alloc(size * size * 4);
  const scaleX = img.width / size;
  const scaleY = img.height / size;
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.max(y0 + 1, Math.ceil((y + 1) * scaleY));
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.max(x0 + 1, Math.ceil((x + 1) * scaleX));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1 && sy < img.height; sy++) {
        for (let sx = x0; sx < x1 && sx < img.width; sx++) {
          const i = (sy * img.width + sx) * 4;
          const av = img.rgba[i + 3] / 255;
          r += img.rgba[i] * av;
          g += img.rgba[i + 1] * av;
          b += img.rgba[i + 2] * av;
          a += img.rgba[i + 3];
          n++;
        }
      }
      const d = (y * size + x) * 4;
      if (!n) continue;
      const alpha = a / n;
      const un = alpha > 0 ? 255 / alpha : 0; // undo the premultiply
      out[d] = Math.round(Math.min(255, (r / n) * un));
      out[d + 1] = Math.round(Math.min(255, (g / n) * un));
      out[d + 2] = Math.round(Math.min(255, (b / n) * un));
      out[d + 3] = Math.round(alpha);
    }
  }
  return { width: size, height: size, rgba: out };
}

// ------------------------------------------------------------------------ main

if (!fs.existsSync(SRC)) {
  console.error("missing source artwork: " + path.relative(__dirname, SRC));
  process.exit(1);
}

const source = padToSquare(decodePNG(fs.readFileSync(SRC)));
console.log(`source ${path.relative(__dirname, SRC)} -> ${source.width}x${source.height} (squared)`);

const outDir = path.join(__dirname, "icons");
fs.mkdirSync(outDir, { recursive: true });
for (const s of SIZES) {
  const icon = resizeBox(source, s);
  const file = path.join(outDir, `icon${s}.png`);
  fs.writeFileSync(file, encodePNG(s, s, icon.rgba));
  console.log(`wrote icons/icon${s}.png (${fs.statSync(file).size} bytes)`);
}
