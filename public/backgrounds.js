// Page backgrounds: solid colour, gradient, paper texture or an image. Painting happens in print
// pixels (the caller sets up any zoom), so the same function draws the on-screen page and the export.
// Textures are generated procedurally from a fixed seed — no image files, nothing downloaded, and the
// same texture every time (so an export matches what you saw).

export const DEFAULT_BACKGROUND = {
  type: 'solid',          // solid | gradient | texture | image
  color2: '#f3d6c6',      // gradient end colour (the start colour is the page colour)
  gradDir: 'v',           // v (top→bottom) | h (left→right) | d (diagonal) | r (radial)
  texture: 'paper',       // paper | linen | canvas | watercolor
  texStrength: 50,        // 0–100
  imageUrl: null,
  imageName: '',
  imageFit: 'cover',      // cover | contain | tile
  imageOpacity: 100,      // 0–100
};

const TILE = 512;
const tiles = new Map();

/** Small deterministic random generator, so textures look the same every time. */
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seamless grey tile; it darkens the page colour through "multiply", so light = no change. */
export function textureTile(kind) {
  if (tiles.has(kind)) return tiles.get(kind);
  const c = document.createElement('canvas');
  c.width = c.height = TILE;
  const g = c.getContext('2d');
  const rnd = mulberry32({ paper: 11, linen: 23, canvas: 37, watercolor: 51 }[kind] || 7);
  const img = g.createImageData(TILE, TILE), d = img.data;
  const set = (i, v) => { d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; };

  if (kind === 'linen' || kind === 'canvas') {
    // woven threads: periodic stripes in both directions (periods divide the tile, so it's seamless)
    const period = kind === 'linen' ? 4 : 8;
    const rowJitter = Array.from({ length: TILE }, () => rnd() * 18);
    const colJitter = Array.from({ length: TILE }, () => rnd() * 18);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const tx = Math.cos((2 * Math.PI * x) / period), ty = Math.cos((2 * Math.PI * y) / period);
      let v;
      if (kind === 'canvas') { // over/under weave: alternate which thread is on top
        const over = (Math.floor(x / period) + Math.floor(y / period)) % 2 === 0;
        v = 236 - (over ? 10 * (1 - tx) : 10 * (1 - ty)) - rowJitter[y] * 0.4 - colJitter[x] * 0.4;
      } else {
        v = 244 - 6 * (1 - tx) - 6 * (1 - ty) - rowJitter[y] * 0.5 - colJitter[x] * 0.5;
      }
      set((y * TILE + x) * 4, v + (rnd() - 0.5) * 8);
    }
    g.putImageData(img, 0, 0);
  } else {
    // paper: fine grain; watercolour: grain plus large soft blooms
    for (let i = 0; i < d.length; i += 4) set(i, 246 + (rnd() - 0.5) * (kind === 'paper' ? 22 : 10));
    g.putImageData(img, 0, 0);
    if (kind === 'paper') { // faint fibres
      g.globalAlpha = 0.06; g.strokeStyle = '#000'; g.lineWidth = 1;
      for (let k = 0; k < 260; k++) {
        const x = rnd() * TILE, y = rnd() * TILE, a = rnd() * Math.PI, l = 6 + rnd() * 26;
        for (const [ox, oy] of wraps(x, y, l)) {
          g.beginPath(); g.moveTo(ox, oy); g.quadraticCurveTo(ox + Math.cos(a) * l * 0.5 + rnd() * 4, oy + Math.sin(a) * l * 0.5, ox + Math.cos(a) * l, oy + Math.sin(a) * l); g.stroke();
        }
      }
    } else { // watercolour blooms, drawn at each wrap position so the tile stays seamless
      g.filter = 'blur(18px)';
      for (let k = 0; k < 26; k++) {
        const x = rnd() * TILE, y = rnd() * TILE, r = 40 + rnd() * 120;
        g.globalAlpha = 0.025 + rnd() * 0.05; // soft, overlapping blooms
        g.fillStyle = '#000';
        for (const [ox, oy] of wraps(x, y, r + 40)) { g.beginPath(); g.arc(ox, oy, r, 0, Math.PI * 2); g.fill(); }
      }
      g.filter = 'none';
    }
    g.globalAlpha = 1;
  }
  tiles.set(kind, c);
  return c;
}
/** Positions to draw something at so it wraps around the tile edges. */
function wraps(x, y, reach) {
  const xs = [x], ys = [y];
  if (x < reach) xs.push(x + TILE); if (x > TILE - reach) xs.push(x - TILE);
  if (y < reach) ys.push(y + TILE); if (y > TILE - reach) ys.push(y - TILE);
  return xs.flatMap((px) => ys.map((py) => [px, py]));
}

/**
 * Paint the page background into ctx, in print pixels (0,0)–(W,H).
 * color: the page colour (solid colour, gradient start, texture base, colour behind an image).
 * opts.image: the loaded background image (if type is image); opts.texScale: texture scale.
 */
export function paintBackground(ctx, bg, color, W, H, opts = {}) {
  const b = { ...DEFAULT_BACKGROUND, ...(bg || {}) };
  ctx.save();
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, W, H);
  if (b.type === 'gradient') {
    let gr;
    if (b.gradDir === 'r') gr = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.hypot(W, H) / 2);
    else if (b.gradDir === 'h') gr = ctx.createLinearGradient(0, 0, W, 0);
    else if (b.gradDir === 'd') gr = ctx.createLinearGradient(0, 0, W, H);
    else gr = ctx.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, color);
    gr.addColorStop(1, b.color2);
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, W, H);
  } else if (b.type === 'texture') {
    const pattern = ctx.createPattern(textureTile(b.texture), 'repeat');
    const s = opts.texScale || 1;
    if (pattern.setTransform) pattern.setTransform(new DOMMatrix([s, 0, 0, s, 0, 0]));
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = Math.max(0, Math.min(1, b.texStrength / 100)); // 100 = the texture at full depth
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, W, H);
  } else if (b.type === 'image' && opts.image) {
    const img = opts.image, iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    ctx.globalAlpha = b.imageOpacity / 100;
    ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
    if (b.imageFit === 'tile') {
      const pattern = ctx.createPattern(img, 'repeat');
      const s = opts.texScale || 1;
      if (pattern.setTransform) pattern.setTransform(new DOMMatrix([s, 0, 0, s, 0, 0]));
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, W, H);
    } else {
      const s = b.imageFit === 'contain' ? Math.min(W / iw, H / ih) : Math.max(W / iw, H / ih);
      const w = iw * s, h = ih * s;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
    }
  }
  ctx.restore();
}
