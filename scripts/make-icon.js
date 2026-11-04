'use strict';

// Builds build/icon.png + icon.iconset + icon.icns from build/icon-master.png.
// Master is the ArtCraft-style teal + engraved tiger (square RGB). We apply a
// macOS squircle alpha mask, then resize with `sips` and pack with `iconutil`.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const MASTER = path.join(BUILD, 'icon-master.png');
const OUT_PNG = path.join(BUILD, 'icon.png');
const ICONSET = path.join(BUILD, 'icon.iconset');

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

function readPng(file) {
  const data = fs.readFileSync(file);
  if (data.compare(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 0, 8, 0, 8) !== 0) {
    throw new Error(`not a PNG: ${file}`);
  }
  let i = 8;
  let w;
  let h;
  let depth;
  let color;
  let idat = Buffer.alloc(0);
  while (i < data.length) {
    const ln = data.readUInt32BE(i);
    const typ = data.slice(i + 4, i + 8).toString('ascii');
    const body = data.slice(i + 8, i + 8 + ln);
    i += 12 + ln;
    if (typ === 'IHDR') {
      w = body.readUInt32BE(0);
      h = body.readUInt32BE(4);
      depth = body[8];
      color = body[9];
    } else if (typ === 'IDAT') {
      idat = Buffer.concat([idat, body]);
    } else if (typ === 'IEND') break;
  }
  if (depth !== 8 || (color !== 2 && color !== 6)) {
    throw new Error(`need 8-bit RGB/RGBA PNG, got depth=${depth} color=${color}`);
  }
  const bpp = color === 6 ? 4 : 3;
  const raw = zlib.inflateSync(idat);
  const stride = w * bpp + 1;
  const prev = Buffer.alloc(w * bpp);
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const filt = raw[y * stride];
    const row = Buffer.from(raw.slice(y * stride + 1, (y + 1) * stride));
    if (filt === 1) {
      for (let x = bpp; x < row.length; x++) row[x] = (row[x] + row[x - bpp]) & 255;
    } else if (filt === 2) {
      for (let x = 0; x < row.length; x++) row[x] = (row[x] + prev[x]) & 255;
    } else if (filt === 3) {
      for (let x = 0; x < row.length; x++) {
        const a = x >= bpp ? row[x - bpp] : 0;
        row[x] = (row[x] + ((a + prev[x]) >> 1)) & 255;
      }
    } else if (filt === 4) {
      for (let x = 0; x < row.length; x++) {
        const a = x >= bpp ? row[x - bpp] : 0;
        const b = prev[x];
        const c = x >= bpp ? prev[x - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        row[x] = (row[x] + pr) & 255;
      }
    } else if (filt !== 0) {
      throw new Error(`unsupported PNG filter ${filt}`);
    }
    row.copy(prev);
    for (let x = 0; x < w; x++) {
      const si = x * bpp;
      const di = (y * w + x) * 4;
      px[di] = row[si];
      px[di + 1] = row[si + 1];
      px[di + 2] = row[si + 2];
      px[di + 3] = bpp === 4 ? row[si + 3] : 255;
    }
  }
  return { w, h, px };
}

function writePng(file, w, h, px) {
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
}

function applySquircleMask(w, h, px) {
  const cx = w / 2;
  const cy = h / 2;
  const radius = w * 0.22;
  const inset = w * 0.02;
  const half = w / 2 - inset;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = Math.max(Math.abs(x - cx) - (half - radius), 0);
      const dy = Math.max(Math.abs(y - cy) - (half - radius), 0);
      const d = Math.hypot(dx, dy) - radius;
      const cover = Math.max(0, Math.min(1, 1 - d));
      const i = (y * w + x) * 4;
      px[i + 3] = Math.round(px[i + 3] * cover);
    }
  }
}

if (!fs.existsSync(MASTER)) {
  console.error(`missing ${MASTER} — drop the square tiger master PNG there first`);
  process.exit(1);
}

const { w, h, px } = readPng(MASTER);
if (w !== h) throw new Error(`master must be square, got ${w}x${h}`);
applySquircleMask(w, h, px);
writePng(OUT_PNG, w, h, px);
console.log(`wrote ${OUT_PNG}`);

fs.rmSync(ICONSET, { recursive: true, force: true });
fs.mkdirSync(ICONSET, { recursive: true });

const sizes = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_64x64.png', 64], // nonstandard but kept for prior iconset
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

for (const [name, pxSize] of sizes) {
  const dest = path.join(ICONSET, name);
  execFileSync('sips', ['-z', String(pxSize), String(pxSize), OUT_PNG, '--out', dest], {
    stdio: 'pipe',
  });
}

const icns = path.join(BUILD, 'icon.icns');
execFileSync('iconutil', ['-c', 'icns', ICONSET, '-o', icns], { stdio: 'pipe' });
console.log(`wrote ${icns}`);
