// Draws the app icon (an amber stopwatch on near-black) and writes the PNGs the web app manifest
// needs. No image libraries: pixels are shaded from distance functions and encoded with zlib.
// Run: node scripts/make-icons.mjs   (output goes to public/)

import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BG = [10, 10, 10];
const AMBER = [251, 191, 36];
const WHITE = [245, 245, 245];

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // no filter
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Distance from p to segment ab. */
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/**
 * Colour at a point in unit coordinates (0..1). `scale` shrinks the drawing towards the centre,
 * for maskable icons whose safe zone is the inner 80%.
 */
function shade(u, v, scale) {
  const x = (u - 0.5) / scale;
  const y = (v - 0.5) / scale;
  const r = Math.hypot(x, y - 0.04);
  const layers = [];
  // ring
  layers.push([Math.abs(r - 0.3) - 0.045, AMBER]);
  // crown button and its stem
  layers.push([segDist(x, y, 0, -0.33, 0, -0.39) - 0.035, AMBER]);
  layers.push([segDist(x, y, -0.07, -0.42, 0.07, -0.42) - 0.035, AMBER]);
  // hand, pointing to about 2 o'clock
  layers.push([segDist(x, y, 0, 0.04, 0.15, -0.1) - 0.03, WHITE]);
  layers.push([Math.hypot(x, y - 0.04) - 0.045, WHITE]);
  // sector ticks on the dial
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    layers.push([segDist(x, y, 0.2 * c, 0.04 + 0.2 * s, 0.23 * c, 0.04 + 0.23 * s) - 0.008, AMBER]);
  }
  return layers;
}

function render(size, { scale = 1, rounded = true } = {}) {
  const out = Buffer.alloc(size * size * 4);
  const aa = 1.5 / size; // anti-aliasing width in unit coordinates
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const u = (px + 0.5) / size;
      const v = (py + 0.5) / size;
      let col = [...BG];
      for (const [d, c] of shade(u, v, scale)) {
        const a = Math.max(0, Math.min(1, 0.5 - (d * scale) / aa));
        if (a > 0) col = col.map((ch, i) => ch + (c[i] - ch) * a);
      }
      // rounded square background (plain square for maskable: the platform crops it)
      let alpha = 1;
      if (rounded) {
        const q = 0.5 - 0.18;
        const dx = Math.max(Math.abs(u - 0.5) - q, 0);
        const dy = Math.max(Math.abs(v - 0.5) - q, 0);
        alpha = Math.max(0, Math.min(1, 0.5 - (Math.hypot(dx, dy) - 0.18) / aa));
      }
      const o = (py * size + px) * 4;
      out[o] = Math.round(col[0]);
      out[o + 1] = Math.round(col[1]);
      out[o + 2] = Math.round(col[2]);
      out[o + 3] = Math.round(alpha * 255);
    }
  }
  return png(size, out);
}

mkdirSync('public', { recursive: true });
const files = {
  'pwa-192x192.png': render(192),
  'pwa-512x512.png': render(512),
  'maskable-512x512.png': render(512, { scale: 0.8, rounded: false }),
  'apple-touch-icon-180x180.png': render(180, { rounded: false }),
  'favicon-48x48.png': render(48),
};
for (const [name, data] of Object.entries(files)) {
  writeFileSync(`public/${name}`, data);
  console.log(`public/${name}  ${data.length} bytes`);
}
