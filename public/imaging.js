// Pixel-level image helpers: color-key background removal, trimming, outlines, DPI metadata.

function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

/**
 * Make pixels similar to the color at (px,py) transparent.
 * tolerance: RGB distance (0–441). Pixels a bit beyond tolerance get partial alpha for a soft edge.
 * contiguous: only remove the region connected to the clicked pixel (like a magic wand).
 */
export function removeColorAt(canvas, px, py, tolerance, contiguous) {
  const { width: w, height: h } = canvas;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  px = Math.max(0, Math.min(w - 1, px)); py = Math.max(0, Math.min(h - 1, py));
  const i0 = (py * w + px) * 4;
  const tr = d[i0], tg = d[i0 + 1], tb = d[i0 + 2];
  const soft = tolerance * 0.5;
  const dist = (i) => Math.hypot(d[i] - tr, d[i + 1] - tg, d[i + 2] - tb);
  const apply = (i, dd) => {
    if (dd <= tolerance) d[i + 3] = 0;
    else if (dd <= tolerance + soft) d[i + 3] = Math.min(d[i + 3], Math.round(255 * ((dd - tolerance) / soft)));
  };

  if (!contiguous) {
    for (let i = 0; i < d.length; i += 4) apply(i, dist(i));
  } else {
    const visited = new Uint8Array(w * h);
    const stack = [py * w + px];
    visited[py * w + px] = 1;
    while (stack.length) {
      const p = stack.pop();
      const i = p * 4;
      const dd = dist(i);
      apply(i, dd);
      if (dd > tolerance) continue; // soft-edge pixels don't spread the fill
      const x = p % w, y = (p - x) / w;
      if (x > 0 && !visited[p - 1]) { visited[p - 1] = 1; stack.push(p - 1); }
      if (x < w - 1 && !visited[p + 1]) { visited[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && !visited[p - w]) { visited[p - w] = 1; stack.push(p - w); }
      if (y < h - 1 && !visited[p + w]) { visited[p + w] = 1; stack.push(p + w); }
    }
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

/** Crop away fully transparent borders. Returns a new canvas (or the same one if nothing to trim). */
export function trimTransparent(canvas) {
  const { width: w, height: h } = canvas;
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (d[row + x * 4 + 3] > 8) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return canvas; // fully transparent — leave as is
  if (minX === 0 && minY === 0 && maxX === w - 1 && maxY === h - 1) return canvas;
  const out = makeCanvas(maxX - minX + 1, maxY - minY + 1);
  out.getContext('2d').drawImage(canvas, -minX, -minY);
  out.trimOffset = { x: minX, y: minY }; // lets the editor keep its view steady after trimming
  return out;
}

// ---------------------------------------------------------------- sticker "look" (non-destructive)
// A sticker's look is applied on top of its edit steps every time it's rendered, so it can be
// changed at any time: colour → shape mask → edge clean-up → outline. (The drop shadow is drawn
// by the canvas on the print instead, so its direction stays fixed when a sticker is rotated.)

export const DEFAULT_ADJUST = { brightness: 0, contrast: 0, saturation: 0, bw: false, tint: '#e8a33d', tintAmt: 0 };
export const DEFAULT_MASK = { shape: 'none', radius: 15 };
export const DEFAULT_EDGES = { smooth: 0, shrink: 0, feather: 0, specks: false };
export const DEFAULT_SHADOW = { on: false, dist: 2, blur: 3, opacity: 35, angle: 45 }; // angle: direction the shadow falls (0 = right, 90 = down)

const adjustActive = (a) => !!a && (a.brightness || a.contrast || a.saturation || a.bw || a.tintAmt);
const maskActive = (m) => !!m && m.shape && m.shape !== 'none';
const edgesActive = (e) => !!e && (e.smooth || e.shrink || e.feather || e.specks);
/** Does this look change the pixels (so the finished sticker must be rendered and stored)? */
export const lookNeedsRender = (look) => !!(look.outline?.on || adjustActive(look.adjust) || maskActive(look.mask) || edgesActive(look.edges));

/**
 * Render a sticker with its look. look = { outline, adjust, mask, edges }.
 * maxSide > 0 renders a smaller preview. opts.trim crops away transparent borders left by a shape
 * mask (used for the finished sticker, not the editor preview, which must keep its geometry).
 */
export function renderSticker(img, look = {}, maxSide = 0, opts = {}) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const s = maxSide ? Math.min(1, maxSide / Math.max(iw, ih)) : 1;
  let c = makeCanvas(Math.round(iw * s), Math.round(ih * s));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  if (adjustActive(look.adjust)) adjustColors(c, look.adjust);
  if (maskActive(look.mask)) applyShapeMask(c, look.mask);
  if (edgesActive(look.edges)) refineEdges(c, look.edges);
  if (opts.trim && (maskActive(look.mask) || edgesActive(look.edges))) c = trimTransparent(c);
  return look.outline?.on ? addOutline(c, look.outline) : c;
}

/** Brightness / contrast / saturation (−100…100), black & white, and a colour tint (0…100). */
export function adjustColors(canvas, a) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const im = ctx.getImageData(0, 0, canvas.width, canvas.height), d = im.data;
  const bright = (a.brightness || 0) * 1.28;                     // ± up to 128 levels
  const C = (a.contrast || 0) * 1.28;                            // ± up to 128 (≈3× contrast at +100)
  const cf = (259 * (C + 255)) / (255 * (259 - C));
  const sat = a.bw ? 0 : 1 + (a.saturation || 0) / 100;
  const t = (a.tintAmt || 0) / 100;
  const tc = hexToRgb(a.tint || '#e8a33d');
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    let r = d[i] + bright, g = d[i + 1] + bright, b = d[i + 2] + bright;
    r = cf * (r - 128) + 128; g = cf * (g - 128) + 128; b = cf * (b - 128) + 128;
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    r = y + (r - y) * sat; g = y + (g - y) * sat; b = y + (b - y) * sat;
    if (t) { // colourise: keep the brightness, take the hue from the tint colour
      const l = Math.max(0, Math.min(255, y)) / 255;
      r = r * (1 - t) + tc[0] * l * t; g = g * (1 - t) + tc[1] * l * t; b = b * (1 - t) + tc[2] * l * t;
    }
    d[i] = r < 0 ? 0 : r > 255 ? 255 : r;
    d[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
    d[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
  }
  ctx.putImageData(im, 0, 0);
}
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0xe8a33d;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Trace a shape fitted inside w×h (the rounded rectangle and oval use the whole image). */
export function shapePath(ctx, shape, w, h, radiusPct = 15) {
  const cx = w / 2, cy = h / 2, m = Math.min(w, h);
  ctx.beginPath();
  if (shape === 'circle') ctx.arc(cx, cy, m / 2, 0, Math.PI * 2);
  else if (shape === 'oval') ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
  else if (shape === 'rounded') {
    const r = Math.max(0, Math.min(m / 2, (radiusPct / 100) * m));
    ctx.moveTo(r, 0); ctx.arcTo(w, 0, w, h, r); ctx.arcTo(w, h, 0, h, r); ctx.arcTo(0, h, 0, 0, r); ctx.arcTo(0, 0, w, 0, r);
  } else if (shape === 'star') {
    const R = m / 2, ri = R * 0.45;
    for (let k = 0; k < 10; k++) {
      const a = (-90 + k * 36) * Math.PI / 180, rr = k % 2 ? ri : R;
      ctx.lineTo(cx + rr * Math.cos(a), cy + 0.06 * R + rr * Math.sin(a));
    }
  } else if (shape === 'heart') {
    const pts = [];
    for (let k = 0; k <= 160; k++) {
      const t = (k / 160) * Math.PI * 2;
      pts.push([16 * Math.sin(t) ** 3, -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))]);
    }
    // fit the curve's bounding box inside w×h and centre it
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const f = Math.min(w / (x1 - x0), h / (y1 - y0));
    const ox = cx - ((x0 + x1) / 2) * f, oy = cy - ((y0 + y1) / 2) * f;
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(ox + x * f, oy + y * f) : ctx.moveTo(ox + x * f, oy + y * f)));
  }
  ctx.closePath();
}

/** Keep only the part of the image inside the chosen shape. */
export function applyShapeMask(canvas, mask) {
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  shapePath(ctx, mask.shape, canvas.width, canvas.height, mask.radius);
  ctx.fillStyle = '#000';
  ctx.fill();
  ctx.restore();
}

/**
 * Clean up a cut-out's edge (sliders 0–10):
 *   smooth  – round off jagged, pixelated edges
 *   shrink  – pull the edge inward to drop a leftover halo of background colour
 *   feather – fade the edge softly
 *   specks  – remove small floating bits left behind by background removal
 * Works on the alpha channel only and never grows the shape, so no dark fringe appears.
 */
export function refineEdges(canvas, e) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const im = ctx.getImageData(0, 0, w, h), d = im.data;
  const n = w * h;
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) alpha[i] = d[i * 4 + 3] / 255;
  if (e.specks) removeSpecks(alpha, w, h);
  const strength = Math.max(e.smooth || 0, e.shrink || 0, e.feather || 0);
  if (strength) {
    const radius = Math.max(1, Math.round(Math.max(w, h) * 0.0018 * strength));
    const b = boxBlur(boxBlur(alpha, w, h, radius), w, h, radius); // ≈ gaussian
    const width = 0.04 + (e.feather || 0) * 0.09;          // softness of the new edge
    const shift = (e.shrink || 0) * 0.04;                  // how far inward the edge moves
    const lo = 0.5 + shift;                                // edge sits at or inside the original
    for (let i = 0; i < n; i++) {
      const v = (b[i] - lo) / width;
      alpha[i] = Math.min(alpha[i], v <= 0 ? 0 : v >= 1 ? 1 : v);
    }
  }
  for (let i = 0; i < n; i++) d[i * 4 + 3] = Math.round(alpha[i] * 255);
  ctx.putImageData(im, 0, 0);
}

/** Separable box blur of a single channel. */
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), k = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))] * (x < 0 || x >= w ? 0 : 1);
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * k;
      const add = x + r + 1, rem = x - r;
      if (add < w) acc += src[row + add];
      if (rem >= 0) acc -= src[row + rem];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = 0; y <= r && y < h; y++) acc += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc * k;
      const add = y + r + 1, rem = y - r;
      if (add < h) acc += tmp[add * w + x];
      if (rem >= 0) acc -= tmp[rem * w + x];
    }
  }
  return out;
}

/** Drop opaque islands much smaller than the main subject (stray bits of background). */
function removeSpecks(alpha, w, h) {
  const n = w * h, label = new Int32Array(n), sizes = [0];
  const stack = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (label[i] || alpha[i] < 0.25) continue;
    const id = sizes.length;
    let top = 0, size = 0;
    stack[top++] = i; label[i] = id;
    while (top) {
      const p = stack[--top]; size++;
      const x = p % w;
      if (x > 0 && !label[p - 1] && alpha[p - 1] >= 0.25) { label[p - 1] = id; stack[top++] = p - 1; }
      if (x < w - 1 && !label[p + 1] && alpha[p + 1] >= 0.25) { label[p + 1] = id; stack[top++] = p + 1; }
      if (p >= w && !label[p - w] && alpha[p - w] >= 0.25) { label[p - w] = id; stack[top++] = p - w; }
      if (p < n - w && !label[p + w] && alpha[p + w] >= 0.25) { label[p + w] = id; stack[top++] = p + w; }
    }
    sizes.push(size);
  }
  const biggest = Math.max(0, ...sizes);
  const keep = Math.max(16, biggest * 0.02); // islands under 2% of the main part go
  for (let i = 0; i < n; i++) {
    if (label[i]) { if (sizes[label[i]] < keep) alpha[i] = 0; }
    else if (alpha[i] < 0.25) {
      // faint pixels next to nothing solid are haze; leave faint pixels touching the subject (soft edges)
      const x = i % w;
      const near = (x > 0 && label[i - 1] && sizes[label[i - 1]] >= keep) || (x < w - 1 && label[i + 1] && sizes[label[i + 1]] >= keep)
        || (i >= w && label[i - w] && sizes[label[i - w]] >= keep) || (i < n - w && label[i + w] && sizes[label[i + w]] >= keep);
      if (!near) alpha[i] = 0;
    }
  }
}

/** Kept for older callers: render with only an outline. */
export function renderWithOutline(img, outline, maxSide = 0) {
  return renderSticker(img, { outline }, maxSide);
}

/**
 * Add an outline that follows the alpha edge (die-cut sticker style).
 * outline: { on, w (1–12 → % of size), c (color) }.
 */
export function addOutline(src, outline) {
  const img = src, w = src.width, h = src.height;
  const t = Math.max(1, Math.round(outline.w * 0.006 * Math.max(w, h)));
  const c = makeCanvas(w + 2 * t, h + 2 * t);
  const sil = makeCanvas(c.width, c.height);
  const sctx = sil.getContext('2d');
  // Dilate the alpha mask by stamping the image around circles of decreasing radius.
  const steps = Math.max(24, Math.min(64, Math.round(t * 1.5)));
  for (const r of [t, t * 0.66, t * 0.33]) {
    for (let k = 0; k < steps; k++) {
      const a = (2 * Math.PI * k) / steps;
      sctx.drawImage(img, t + Math.cos(a) * r, t + Math.sin(a) * r, w, h);
    }
  }
  sctx.drawImage(img, t, t, w, h);
  sctx.globalCompositeOperation = 'source-in';
  sctx.fillStyle = outline.c;
  sctx.fillRect(0, 0, sil.width, sil.height);

  const ctx = c.getContext('2d');
  ctx.drawImage(sil, 0, 0);
  ctx.drawImage(img, t, t, w, h);
  return c;
}

// ---- DPI metadata (so printers know the intended physical size) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export async function insertDpiMetadata(blob, dpi, format) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  if (format === 'png') {
    // Insert a pHYs chunk right after IHDR (signature 8 bytes + IHDR chunk 25 bytes).
    const ppm = Math.round(dpi / 0.0254);
    const chunk = new Uint8Array(21);
    const dv = new DataView(chunk.buffer);
    dv.setUint32(0, 9);
    chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
    dv.setUint32(8, ppm); dv.setUint32(12, ppm); chunk[16] = 1; // unit: metre
    dv.setUint32(17, crc32(chunk.subarray(4, 17)));
    const out = new Uint8Array(buf.length + chunk.length);
    out.set(buf.subarray(0, 33)); out.set(chunk, 33); out.set(buf.subarray(33), 33 + chunk.length);
    return new Blob([out], { type: 'image/png' });
  }
  // JPEG: patch the JFIF APP0 density fields if present.
  if (buf[2] === 0xff && buf[3] === 0xe0 && String.fromCharCode(...buf.subarray(6, 10)) === 'JFIF') {
    buf[13] = 1; // dots per inch
    buf[14] = dpi >> 8; buf[15] = dpi & 0xff;
    buf[16] = dpi >> 8; buf[17] = dpi & 0xff;
  }
  return new Blob([buf], { type: 'image/jpeg' });
}
