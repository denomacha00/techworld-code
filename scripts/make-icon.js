// Generates resources/icon.png (128x128) — a rounded gradient tile with the Techword "T"
// mark and a cyan terminal-cursor accent. Dependency-free (Node zlib). Re-run:
//   node scripts/make-icon.js
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const W = 128, H = 128;
const buf = Buffer.alloc(W * H * 4); // RGBA, transparent

function blend(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= W || y >= H || a <= 0) { return; }
  const i = (y * W + x) * 4;
  const ia = a / 255, inv = 1 - ia;
  buf[i] = Math.round(r * ia + buf[i] * inv);
  buf[i + 1] = Math.round(g * ia + buf[i + 1] * inv);
  buf[i + 2] = Math.round(b * ia + buf[i + 2] * inv);
  buf[i + 3] = Math.min(255, Math.round(a + buf[i + 3] * inv));
}
function rrect(x0, y0, x1, y1, rad, color) {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) { blend(x, y, color[0], color[1], color[2], 255 * cover(x, y, x0, y0, x1, y1, rad)); }
  }
}
// Fractional coverage (2x2 supersample) for a rounded rectangle — gives smooth edges.
function cover(px, py, x0, y0, x1, y1, rad) {
  let hits = 0;
  for (const ox of [0.25, 0.75]) {
    for (const oy of [0.25, 0.75]) {
      if (insideRRect(px + ox, py + oy, x0, y0, x1, y1, rad)) { hits += 1; }
    }
  }
  return hits / 4;
}
function insideRRect(x, y, x0, y0, x1, y1, rad) {
  if (x < x0 || y < y0 || x > x1 || y > y1) { return false; }
  let cx = x, cy = y;
  if (x < x0 + rad) { cx = x0 + rad; } else if (x > x1 - rad) { cx = x1 - rad; }
  if (y < y0 + rad) { cy = y0 + rad; } else if (y > y1 - rad) { cy = y1 - rad; }
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= rad * rad;
}

// Diagonal gradient background inside a rounded tile.
const A = [0x7c, 0x5c, 0xff]; // #7C5CFF
const B = [0x3f, 0x22, 0x9e]; // #3F229E
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const t = (x + y) / (W + H);
    const r = Math.round(A[0] + (B[0] - A[0]) * t);
    const g = Math.round(A[1] + (B[1] - A[1]) * t);
    const b = Math.round(A[2] + (B[2] - A[2]) * t);
    blend(x, y, r, g, b, 255 * cover(x, y, 0, 0, W, H, 28));
  }
}

// White "T" mark (brand geometry from techword.svg), on the gradient.
const white = [255, 255, 255];
rrect(27, 33, 101, 50, 3, white);  // top bar
rrect(55, 50, 73, 97, 3, white);   // stem
rrect(47, 60, 81, 74, 3, white);   // crossbar

// Cyan terminal-cursor accent below the mark.
rrect(52, 104, 76, 111, 2, [0x22, 0xd3, 0xee]); // #22D3EE

// ---- PNG encode ----
let crcTable;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) { c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); }
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i += 1) { c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); }
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y += 1) {
  raw[y * (1 + W * 4)] = 0;
  buf.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);

const out = path.join(__dirname, '..', 'resources', 'icon.png');
fs.writeFileSync(out, png);
console.log(`Wrote ${out} (${png.length} bytes)`);
