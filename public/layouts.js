// Layout engine for the random collage. Pure placement maths: it gets sticker sizes and the page
// area, and returns where each sticker goes. It never touches the canvas or the DOM (except an
// offscreen canvas to rasterise the "fill a shape" mask).
//
// Coordinates are print pixels. Each sticker is approximated by a circle of radius r = (w + h) / 4
// for spacing, which works well for cut-out stickers; "packed" uses a slightly larger circle.

const rand = (a, b) => a + Math.random() * (b - a);
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const toRad = (d) => (d * Math.PI) / 180;

export const STYLES = ['scatter', 'pile', 'packed', 'grid', 'circle', 'shape'];
/** Styles whose sticker size is chosen automatically to fill the page / shape / grid. */
export const AUTO_SIZE_STYLES = new Set(['packed', 'grid', 'shape']);
/** Styles where the Overlap slider has an effect. */
export const OVERLAP_STYLES = new Set(['scatter', 'shape', 'circle']);

/** Half-extents of a w×h box rotated by angle (deg). */
function extents(w, h, angle) {
  const c = Math.abs(Math.cos(toRad(angle))), s = Math.abs(Math.sin(toRad(angle)));
  return { ex: (w * c + h * s) / 2, ey: (w * s + h * c) / 2 };
}
/** Allowed range for a centre so the (rotated) sticker stays inside the area — or, with bleed, just its centre. */
function range(lo, hi, e, bleed) {
  if (bleed) return [lo, hi];
  const a = lo + e, b = hi - e;
  return a <= b ? [a, b] : [(lo + hi) / 2, (lo + hi) / 2];
}

/**
 * @param {object} o
 * @param {string} o.style       one of STYLES
 * @param {{iw:number, ih:number, weight:number}[]} o.items  one entry per sticker copy
 * @param {{l:number,t:number,r:number,b:number}} o.area   page minus margins
 * @param {number} o.base        longest side (px) for weight 1 when not auto-sized
 * @param {number} o.variation   0..1 random size variation
 * @param {number} o.maxRot      degrees
 * @param {number} o.overlap     0 (keep apart) .. 1 (ignore spacing)
 * @param {boolean} o.bleed      let stickers run past the area edges
 * @param {boolean} o.outward    circle style: rotate stickers to point away from the centre
 * @param {string} o.shape       shape style: heart | star | circle | text
 * @param {string} o.shapeText   shape style: the letters to fill
 * @param {{x:number,y:number,hw:number,hh:number}[]} o.obstacles  bounding boxes to keep clear of (locked items, kept text)
 * @returns {{ placements: {idx:number, x:number, y:number, s:number, angle:number}[], skipped:number }}
 */
export function computeLayout(o) {
  const area = { ...o.area, w: o.area.r - o.area.l, h: o.area.b - o.area.t };
  // random size factor per copy, fixed for this run
  const items = o.items.map((it, idx) => ({ ...it, idx, vf: 1 + rand(-o.variation, o.variation) }));
  let base = o.base;
  if (AUTO_SIZE_STYLES.has(o.style)) {
    // choose a size so the stickers cover a target fraction of the available area
    const unit = items.reduce((sum, it) => sum + (it.weight * it.vf) ** 2 * (Math.min(it.iw, it.ih) / Math.max(it.iw, it.ih)), 0) || 1;
    if (o.style === 'packed') base = Math.sqrt((0.55 * area.w * area.h) / unit);
    if (o.style === 'shape') {
      o._mask = buildShapeMask(o.shape, o.shapeText, area);
      base = Math.sqrt((0.62 * (1 + 0.9 * o.overlap) * o._mask.area) / unit);
    }
  }
  const sized = items.map((it) => {
    const long = base * it.weight * it.vf;
    const s = long / Math.max(it.iw, it.ih);
    const w = it.iw * s, h = it.ih * s;
    return { ...it, s, w, h, r: (w + h) / 4 };
  });
  const fn = { scatter, pile, packed, grid, circle, shape }[o.style] || scatter;
  return fn(sized, area, o);
}

/** How far (px) a sticker centred at (x, y) with rotated half-extents ex, ey would reach into the
 *  obstacles' boxes — 0 when clear. Locked items are avoided strictly, whatever the Overlap setting. */
function obstacleIntrusion(obstacles, x, y, ex, ey) {
  let worst = 0;
  for (const ob of obstacles) {
    const ix = ex + ob.hw - Math.abs(x - ob.x), iy = ey + ob.hh - Math.abs(y - ob.y);
    if (ix > 0 && iy > 0) worst = Math.max(worst, Math.min(ix, iy));
  }
  return worst;
}

function finish(p, o, fallbackAngle) {
  return { idx: p.idx, x: p.x, y: p.y, s: p.s, angle: fallbackAngle ?? rand(-o.maxRot, o.maxRot) };
}

// ---- scatter: best-candidate sampling — each sticker goes where it's furthest from the others
function scatter(items, area, o) {
  const placed = [];
  const out = [];
  const K = o.overlap < 0.15 ? 90 : 45;
  for (const it of items.sort((a, b) => b.r - a.r)) {
    const angle = rand(-o.maxRot, o.maxRot);
    const { ex, ey } = extents(it.w, it.h, angle);
    const [x0, x1] = range(area.l, area.r, ex, o.bleed), [y0, y1] = range(area.t, area.b, ey, o.bleed);
    let best = null, bestScore = -Infinity;
    for (let k = 0; k < K; k++) {
      const x = rand(x0, x1), y = rand(y0, y1);
      let score = placed.length ? Infinity : 0; // finite, so the locked-item penalty below always counts
      for (const p of placed) score = Math.min(score, Math.hypot(p.x - x, p.y - y) - (p.r + it.r) * (1 - o.overlap));
      score -= 1e6 * obstacleIntrusion(o.obstacles, x, y, ex, ey); // covering a locked item is never preferred
      if (score > bestScore) { bestScore = score; best = { x, y }; }
      if (!placed.length && !o.obstacles.length) break;
    }
    placed.push({ ...best, r: it.r });
    out.push({ ...finish({ ...it, ...best }, o, angle) });
  }
  return { placements: shuffle(out), skipped: 0 };
}

// ---- pile: heaped around the middle, lots of overlap
function pile(items, area, o) {
  const cx = (area.l + area.r) / 2, cy = (area.t + area.b) / 2;
  const sx = area.w * 0.2, sy = area.h * 0.2;
  const out = items.map((it) => {
    const angle = rand(-o.maxRot, o.maxRot);
    const { ex, ey } = extents(it.w, it.h, angle);
    const [x0, x1] = range(area.l, area.r, ex, o.bleed), [y0, y1] = range(area.t, area.b, ey, o.bleed);
    let x = cx, y = cy, least = Infinity;
    for (let k = 0; k < (o.obstacles.length ? 30 : 1); k++) { // with locked items, take the spot that covers them least
      const px = Math.min(x1, Math.max(x0, cx + gauss() * sx)), py = Math.min(y1, Math.max(y0, cy + gauss() * sy));
      const hit = obstacleIntrusion(o.obstacles, px, py, ex, ey);
      if (hit < least) { least = hit; x = px; y = py; }
      if (hit === 0) break;
    }
    return finish({ ...it, x, y }, o, angle);
  });
  return { placements: shuffle(out), skipped: 0 };
}

/** Do two rotated rectangles overlap? Separating-axis test. A rect is { x, y, hw, hh, a (rad) }. */
function rectsOverlap(p, q, pad) {
  for (const r of [p, q]) {
    for (const ax of [[Math.cos(r.a), Math.sin(r.a)], [-Math.sin(r.a), Math.cos(r.a)]]) {
      const proj = (s) => Math.abs((s.hw + pad) * (Math.cos(s.a) * ax[0] + Math.sin(s.a) * ax[1]))
        + Math.abs((s.hh + pad) * (-Math.sin(s.a) * ax[0] + Math.cos(s.a) * ax[1]));
      const d = Math.abs((q.x - p.x) * ax[0] + (q.y - p.y) * ax[1]);
      if (d > proj(p) + proj(q)) return false; // found a gap along this axis
    }
  }
  return true;
}

// ---- packed: fill the area without overlaps; a sticker that doesn't fit is shrunk, then skipped
function packed(items, area, o) {
  // obstacles come in as circles; treat them as squares around the circle
  const placed = o.obstacles.map((p) => ({ x: p.x, y: p.y, hw: p.hw, hh: p.hh, a: 0, R: Math.hypot(p.hw, p.hh) }));
  const out = [];
  let skipped = 0;
  for (const orig of items.sort((a, b) => b.r - a.r)) {
    let it = { ...orig };
    let done = false;
    for (let attempt = 0; attempt < 7 && !done; attempt++) {
      const angle = rand(-o.maxRot, o.maxRot);
      const { ex, ey } = extents(it.w, it.h, angle);
      const [x0, x1] = range(area.l, area.r, ex, o.bleed), [y0, y1] = range(area.t, area.b, ey, o.bleed);
      const R = Math.hypot(it.w, it.h) / 2; // circle that fully contains the sticker
      const pad = Math.min(it.w, it.h) * 0.01; // a hair of space between neighbours
      let best = null, bestGap = Infinity;
      for (let k = 0; k < 260; k++) {
        const x = rand(x0, x1), y = rand(y0, y1);
        const me = { x, y, hw: it.w / 2, hh: it.h / 2, a: toRad(angle) };
        let ok = true, gap = Infinity;
        for (const p of placed) {
          const dist = Math.hypot(p.x - x, p.y - y);
          gap = Math.min(gap, dist - (p.R + R));
          if (dist < p.R + R && rectsOverlap(p, me, pad)) { ok = false; break; } // only test closely when circles touch
        }
        // valid spots don't overlap; among them prefer the snuggest one, which packs more in
        if (ok && (!best || gap < bestGap)) { bestGap = gap; best = { x, y }; }
      }
      if (best) {
        placed.push({ ...best, hw: it.w / 2, hh: it.h / 2, a: toRad(angle), R });
        out.push(finish({ ...it, ...best }, o, angle));
        done = true;
      } else {
        const f = 0.85; // shrink and try again
        it = { ...it, s: it.s * f, w: it.w * f, h: it.h * f, r: it.r * f };
      }
    }
    if (!done) skipped++;
  }
  return { placements: shuffle(out), skipped };
}

// ---- grid: tidy rows and columns; each sticker fits its cell
function grid(items, area, o) {
  const n = items.length;
  if (!n) return { placements: [], skipped: 0 };
  const cols = Math.max(1, Math.round(Math.sqrt((n * area.w) / area.h)));
  const rows = Math.ceil(n / cols);
  const cw = area.w / cols, ch = area.h / rows;
  const order = shuffle(items.slice());
  const out = order.map((it, i) => {
    const row = Math.floor(i / cols), col = i % cols;
    const inRow = row === rows - 1 ? n - row * cols : cols; // centre a short last row
    const offset = ((cols - inRow) * cw) / 2;
    const angle = rand(-o.maxRot, o.maxRot);
    const { ex, ey } = extents(it.iw, it.ih, angle); // rotated size at scale 1, so tilted stickers still fit their cell
    const fit = 0.9 * Math.min(1, it.weight * it.vf) * Math.min(cw / (2 * ex), ch / (2 * ey));
    return finish({ ...it, s: fit, x: area.l + offset + (col + 0.5) * cw, y: area.t + (row + 0.5) * ch }, o, angle);
  });
  return { placements: out, skipped: 0 };
}

// ---- circle / mandala: biggest in the middle, the rest on rings; then scaled to fit the area
function circle(items, area, o) {
  const list = items.sort((a, b) => b.r - a.r);
  if (!list.length) return { placements: [], skipped: 0 };
  const spacing = 1 - 0.45 * o.overlap; // more overlap → rings closer together
  const pts = [{ it: list[0], x: 0, y: 0, theta: -90 }];
  let i = 1;
  let outer = list[0].r * spacing; // how far from the centre the stickers placed so far reach
  while (i < list.length) {
    const size = list[i].r;                  // biggest sticker still to place sets this ring's width
    const ringR = outer + size * spacing;    // centre line of the new ring
    const fits = Math.max(3, Math.floor((2 * Math.PI * ringR) / (2 * size * spacing)));
    const count = Math.min(fits, list.length - i);
    const phase = rand(0, 360);
    for (let k = 0; k < count; k++, i++) {
      const theta = phase + (360 * k) / count;
      pts.push({ it: list[i], x: ringR * Math.cos(toRad(theta)), y: ringR * Math.sin(toRad(theta)), theta });
    }
    outer = ringR + size * spacing;
  }
  // decide angles first, so the fit below can use each sticker's real (rotated) extent
  for (const p of pts) {
    p.angle = o.outward && p !== pts[0] ? p.theta + 90 + rand(-o.maxRot, o.maxRot) * 0.2 : rand(-o.maxRot, o.maxRot);
    Object.assign(p, extents(p.it.w, p.it.h, p.angle));
  }
  // fit the whole arrangement into the area (positions and sizes scale together)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x - p.ex); maxX = Math.max(maxX, p.x + p.ex); minY = Math.min(minY, p.y - p.ey); maxY = Math.max(maxY, p.y + p.ey); }
  const f = Math.min(area.w / (maxX - minX || 1), area.h / (maxY - minY || 1));
  const cx = (area.l + area.r) / 2 - ((minX + maxX) / 2) * f, cy = (area.t + area.b) / 2 - ((minY + maxY) / 2) * f;
  const out = pts.map((p) => finish({ ...p.it, s: p.it.s * f, x: cx + p.x * f, y: cy + p.y * f }, o, p.angle));
  return { placements: out, skipped: 0 };
}

// ---- shape: like scatter, but sticker centres must fall inside a heart, star, circle or word
function shape(items, area, o) {
  const mask = o._mask;
  if (!mask.points.length) return scatter(items, area, o);
  const placed = [];
  const out = [];
  const K = o.overlap < 0.15 ? 120 : 60;
  for (const it of items.sort((a, b) => b.r - a.r)) {
    const angle = rand(-o.maxRot, o.maxRot);
    const { ex, ey } = extents(it.w, it.h, angle);
    let best = null, bestScore = -Infinity;
    for (let k = 0; k < K; k++) {
      const p = mask.points[Math.floor(Math.random() * mask.points.length)];
      const x = area.l + (p.x + Math.random()) / mask.scale, y = area.t + (p.y + Math.random()) / mask.scale;
      let score = placed.length ? Infinity : 0; // finite, so the locked-item penalty below always counts
      for (const q of placed) score = Math.min(score, Math.hypot(q.x - x, q.y - y) - (q.r + it.r) * (1 - o.overlap));
      score -= 1e6 * obstacleIntrusion(o.obstacles, x, y, ex, ey);
      if (score > bestScore) { bestScore = score; best = { x, y }; }
      if (!placed.length && !o.obstacles.length) break;
    }
    // stickers near the shape's edge are nudged inward so they stay within the margins
    const [x0, x1] = range(area.l, area.r, ex, o.bleed), [y0, y1] = range(area.t, area.b, ey, o.bleed);
    best.x = Math.min(x1, Math.max(x0, best.x)); best.y = Math.min(y1, Math.max(y0, best.y));
    placed.push({ ...best, r: it.r });
    out.push(finish({ ...it, ...best }, o, angle));
  }
  return { placements: shuffle(out), skipped: 0 };
}

/** Rasterise the chosen shape at low resolution; returns inside pixels, their scale and real area. */
export function buildShapeMask(kind, text, area) {
  const scale = 320 / Math.max(area.w, area.h);
  const mw = Math.max(8, Math.round(area.w * scale)), mh = Math.max(8, Math.round(area.h * scale));
  const c = document.createElement('canvas');
  c.width = mw; c.height = mh;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#000';
  const cx = mw / 2, cy = mh / 2;
  if (kind === 'text') {
    const t = (text || 'LOVE').trim().slice(0, 12) || 'LOVE';
    g.font = '900 100px "Arial Black", Impact, sans-serif';
    const tw = g.measureText(t).width || 1;
    const size = Math.min((mw * 0.96 * 100) / tw, mh / 0.8);
    g.font = `900 ${size}px "Arial Black", Impact, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(t, cx, cy + size * 0.04);
  } else if (kind === 'star') {
    const R = Math.min(mw, mh) / 2, r = R * 0.45;
    g.beginPath();
    for (let k = 0; k < 10; k++) {
      const a = toRad(-90 + k * 36), rr = k % 2 ? r : R;
      g.lineTo(cx + rr * Math.cos(a), cy + 0.06 * R + rr * Math.sin(a));
    }
    g.closePath(); g.fill();
  } else if (kind === 'circle') {
    g.beginPath(); g.arc(cx, cy, Math.min(mw, mh) / 2, 0, Math.PI * 2); g.fill();
  } else { // heart
    const pts = [];
    for (let k = 0; k <= 200; k++) {
      const t = (k / 200) * Math.PI * 2;
      pts.push([16 * Math.sin(t) ** 3, -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))]);
    }
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys);
    const f = Math.min(mw / bw, mh / bh);
    const ox = cx - ((Math.min(...xs) + Math.max(...xs)) / 2) * f, oy = cy - ((Math.min(...ys) + Math.max(...ys)) / 2) * f;
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(ox + x * f, oy + y * f) : g.moveTo(ox + x * f, oy + y * f)));
    g.fill();
  }
  const d = g.getImageData(0, 0, mw, mh).data;
  const points = [];
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) if (d[(y * mw + x) * 4 + 3] > 128) points.push({ x, y });
  return { points, scale, area: points.length / (scale * scale) };
}
