// Draws the app icons (PNG) with no dependencies: shapes are rasterised with 3×3 supersampling and
// written as PNG with Node's zlib. Run:  node scripts/make-icons.mjs
// Output: public/icons/icon-192.png, icon-512.png, maskable-512.png, apple-touch-icon.png (180)
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(OUT, { recursive: true });

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const BLUE = hex('#2f6fde'), PAGE = hex('#fffdf8'), WHITE = hex('#ffffff'), SHADOW = [20, 40, 90];
const CORAL = hex('#e4572e'), SUN = hex('#f2c14e'), TEAL = hex('#17bebb');

// shapes in a unit square (0..1); each returns true when the point is inside
const roundRect = (x0, y0, x1, y1, r) => (x, y) => {
  const dx = Math.max(x0 + r - x, 0, x - (x1 - r)), dy = Math.max(y0 + r - y, 0, y - (y1 - r));
  return x >= x0 && x <= x1 && y >= y0 && y <= y1 && dx * dx + dy * dy <= r * r;
};
const rotated = (cx, cy, deg, shape) => {
  const a = (-deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return (x, y) => shape(cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c);
};
const circle = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const star = (cx, cy, R, ri) => (x, y) => { // 5-point star via polygon test
  const pts = [];
  for (let k = 0; k < 10; k++) { const a = (-90 + k * 36) * Math.PI / 180, rr = k % 2 ? ri : R; pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]); }
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const grow = (shapeAt, d) => (x, y) => { // outline: the shape tested at offsets around two circles (smooth edge)
  if (shapeAt(x, y)) return true;
  for (const rr of [d, d * 0.5]) for (let k = 0; k < 28; k++) { const a = (k / 28) * Math.PI * 2; if (shapeAt(x + Math.cos(a) * rr, y + Math.sin(a) * rr)) return true; }
  return false;
};
const shifted = (shape, dx, dy) => (x, y) => shape(x - dx, y - dy);

/** Layers drawn back to front: [shape, rgb, alpha]. `inset` shrinks the artwork (maskable icons). */
function layers(inset, fullBleed) {
  const m = (v) => inset + v * (1 - 2 * inset); // map artwork coords into the safe zone
  const L = [];
  L.push([fullBleed ? () => true : roundRect(0, 0, 1, 1, 0.22), BLUE, 1]);
  const page = rotated(m(0.5), m(0.52), -6, roundRect(m(0.2), m(0.16), m(0.8), m(0.88), 0.02 * (1 - 2 * inset)));
  L.push([(x, y) => page(x - 0.012, y - 0.02), SHADOW, 0.35]);
  L.push([page, PAGE, 1]);
  const s = 1 - 2 * inset;
  const c1 = circle(m(0.4), m(0.42), 0.13 * s), c2 = star(m(0.62), m(0.55), 0.15 * s, 0.065 * s);
  const c3 = rotated(m(0.43), m(0.69), 12, roundRect(m(0.33), m(0.62), m(0.55), m(0.77), 0.03 * s));
  for (const [shape, col] of [[c3, TEAL], [c1, CORAL], [c2, SUN]]) {
    const border = grow(shape, 0.022 * s);
    L.push([shifted(border, 0.006 * s, 0.012 * s), SHADOW, 0.22]); // soft lift off the page
    L.push([border, WHITE, 1]); // die-cut white border
    L.push([shape, col, 1]);
  }
  return L;
}

function render(size, { inset = 0, fullBleed = false } = {}) {
  const L = layers(inset, fullBleed);
  const px = Buffer.alloc(size * size * 4);
  const SS = 3;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const u = (x + (sx + 0.5) / SS) / size, v = (y + (sy + 0.5) / SS) / size;
      let cr = 0, cg = 0, cb = 0, ca = 0; // composite layers ("over"), premultiplied
      for (const [shape, col, al] of L) {
        if (!shape(u, v)) continue;
        cr = col[0] * al + cr * (1 - al); cg = col[1] * al + cg * (1 - al); cb = col[2] * al + cb * (1 - al); ca = al + ca * (1 - al);
      }
      r += cr; g += cg; b += cb; a += ca;
    }
    const n = SS * SS, i = (y * size + x) * 4;
    a /= n;
    px[i] = a ? Math.round(r / n / a) : 0; px[i + 1] = a ? Math.round(g / n / a) : 0; px[i + 2] = a ? Math.round(b / n / a) : 0;
    px[i + 3] = Math.round(a * 255);
  }
  return png(size, size, px);
}

// ---- minimal PNG encoder (RGBA, filter 0)
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

writeFileSync(join(OUT, 'icon-192.png'), render(192));
writeFileSync(join(OUT, 'icon-512.png'), render(512));
writeFileSync(join(OUT, 'maskable-512.png'), render(512, { inset: 0.1, fullBleed: true })); // artwork inside the 80% safe zone
writeFileSync(join(OUT, 'apple-touch-icon.png'), render(180, { fullBleed: true })); // iOS rounds the corners itself
console.log('icons written to', OUT);
