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

/**
 * Render an image with an optional outline that follows its alpha edge (die-cut sticker style).
 * outline: { on, w (1–12 → % of size), c (color) }. maxSide > 0 downsizes (for fast previews).
 */
export function renderWithOutline(img, outline, maxSide = 0) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const s = maxSide ? Math.min(1, maxSide / Math.max(iw, ih)) : 1;
  const w = Math.round(iw * s), h = Math.round(ih * s);
  if (!outline || !outline.on) {
    const c = makeCanvas(w, h);
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return c;
  }
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
