'use strict';

// Generates build/icon.png (1024x1024) — a dark rounded square with a ring and
// a filled centre, matching the tray glyph. No image libraries: raw PNG via zlib.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 1024;
const px = Buffer.alloc(S * S * 4);

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const cx = S / 2;
const cy = S / 2;
const radius = S * 0.22; // rounded square corner radius
const inset = S * 0.04;
const half = S / 2 - inset;

function roundedSquareDist(x, y) {
  const dx = Math.max(Math.abs(x - cx) - (half - radius), 0);
  const dy = Math.max(Math.abs(y - cy) - (half - radius), 0);
  return Math.hypot(dx, dy) - radius;
}

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const d = roundedSquareDist(x, y);
    const bgAlpha = Math.max(0, Math.min(1, 1 - d)); // antialias the edge

    // ring + dot
    const r = Math.hypot(x - cx, y - cy);
    const ring = r < S * 0.30 && r > S * 0.235 ? 1 : 0;
    const dot = r < S * 0.105 ? 1 : 0;
    const glyph = Math.max(ring, dot);

    // vertical gradient backdrop
    const t = y / S;
    const bg = [22 - 8 * t, 26 - 8 * t, 34 - 6 * t];
    const fg = [126, 226, 168]; // accent green, same as the listening dot

    const mix = glyph;
    const col = [0, 1, 2].map((i) => Math.round(bg[i] * (1 - mix) + fg[i] * mix));

    const i = (y * S + x) * 4;
    px[i] = col[0];
    px[i + 1] = col[1];
    px[i + 2] = col[2];
    px[i + 3] = Math.round(255 * bgAlpha);
  }
}

// raw scanlines with filter byte 0
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${(png.length / 1024).toFixed(0)} KB)`);
