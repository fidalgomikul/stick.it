/* stick.it — collage print maker.
 * Libraries (global): fabric (canvas editing), Cropper (cropping).
 * Background removal (optional): @imgly/background-removal, loaded on demand.
 */
import {
  removeColorAt, trimTransparent, renderSticker, lookNeedsRender, insertDpiMetadata,
  DEFAULT_ADJUST, DEFAULT_MASK, DEFAULT_EDGES, DEFAULT_SHADOW,
} from './imaging.js';
import {
  encodeProjectFile, decodeProjectFile, saveProject, loadProject, listProjects, deleteProject, duplicateProject,
  saveCollection, listCollections, loadCollection, renameCollection, deleteCollection, getSetting, setSetting,
} from './project.js';
import { computeLayout, AUTO_SIZE_STYLES, OVERLAP_STYLES } from './layouts.js';
import { DEFAULT_BACKGROUND, paintBackground } from './backgrounds.js';
import { jpegToPdf } from './pdf.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const MAX_SOURCE_SIDE = 3000;        // uploaded images are capped to this (px, longest side)
const PREVIEW_SIDE = 1100;           // editor preview resolution
const BG_REMOVAL_URL = 'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm';

const SIZE_PRESETS = [
  { label: 'A5 — 14.8 × 21 cm', w: 14.8, h: 21, unit: 'cm' },
  { label: 'A4 — 21 × 29.7 cm', w: 21, h: 29.7, unit: 'cm' },
  { label: 'A3 — 29.7 × 42 cm', w: 29.7, h: 42, unit: 'cm' },
  { label: 'A2 — 42 × 59.4 cm', w: 42, h: 59.4, unit: 'cm' },
  { label: '13 × 18 cm', w: 13, h: 18, unit: 'cm' },
  { label: '20 × 25 cm', w: 20, h: 25, unit: 'cm' },
  { label: '30 × 40 cm', w: 30, h: 40, unit: 'cm' },
  { label: '40 × 50 cm', w: 40, h: 50, unit: 'cm' },
  { label: '50 × 70 cm', w: 50, h: 70, unit: 'cm' },
  { label: '5 × 7 in', w: 5, h: 7, unit: 'in' },
  { label: '8 × 10 in', w: 8, h: 10, unit: 'in' },
  { label: '11 × 14 in', w: 11, h: 14, unit: 'in' },
  { label: '16 × 20 in', w: 16, h: 20, unit: 'in' },
  { label: '18 × 24 in', w: 18, h: 24, unit: 'in' },
];
const DEFAULT_PRESET = 6; // 30 × 40 cm

// ---------------------------------------------------------------- helpers
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load image'));
    img.src = src;
  });
}
function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function canvasToBlob(c, type = 'image/png', quality) {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Encoding failed'))), type, quality));
}
async function canvasToUrl(c) { return registerBlob(await canvasToBlob(c)); }

// Every image the project keeps (sticker originals and edit steps) is registered here,
// so it can be saved once under a stable key.
// crypto.randomUUID only exists on https/localhost; a phone opening http://<pc-ip>:5173 needs the fallback.
const blobKey = () => 'b' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const blobByUrl = new Map(); // objectURL → { key, blob }
function registerBlob(blob, key) {
  const url = URL.createObjectURL(blob);
  blobByUrl.set(url, { key: key || blobKey(), blob });
  return url;
}
async function blobEntry(url) {
  if (!blobByUrl.has(url)) blobByUrl.set(url, { key: blobKey(), blob: await (await fetch(url)).blob() });
  return blobByUrl.get(url);
}
function imageToCanvas(img) {
  const c = makeCanvas(img.naturalWidth || img.width, img.naturalHeight || img.height);
  c.getContext('2d').drawImage(img, 0, 0);
  return c;
}
const rand = (a, b) => a + Math.random() * (b - a);
function shuffle(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }
let uid = 0; const newId = () => `s${++uid}`;

let statusTimer;
function status(msg, sticky = false) {
  $('#status').textContent = msg;
  clearTimeout(statusTimer);
  if (!sticky) statusTimer = setTimeout(updateCanvasStatus, 5000);
}

/** Decode any image source, downscale to MAX_SOURCE_SIDE, return {url,w,h}. */
async function normalizeSource(src, originalBlob) {
  const img = await loadImage(src);
  const w0 = img.naturalWidth, h0 = img.naturalHeight;
  const s = Math.min(1, MAX_SOURCE_SIDE / Math.max(w0, h0));
  if (s === 1 && originalBlob) return { url: registerBlob(originalBlob), w: w0, h: h0 };
  const w = Math.round(w0 * s), h = Math.round(h0 * s);
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return { url: await canvasToUrl(c), w, h };
}

// ---------------------------------------------------------------- print settings
const print = { mode: 'physical', w: 30, h: 40, unit: 'cm', dpi: 300, pxW: 3000, pxH: 4000, W: 0, H: 0, bg: '#ffffff' };

function computePx() {
  if (print.mode === 'pixels') return { W: Math.round(print.pxW), H: Math.round(print.pxH) };
  const perInch = print.unit === 'cm' ? 2.54 : 1;
  return { W: Math.round((print.w / perInch) * print.dpi), H: Math.round((print.h / perInch) * print.dpi) };
}
/** canvas px per user unit (cm / in / px) */
function pxPerUnit() {
  if (print.mode === 'pixels') return 1;
  return print.dpi / (print.unit === 'cm' ? 2.54 : 1);
}
function unitName() { return print.mode === 'pixels' ? 'px' : print.unit; }

function initPrintUi() {
  const sel = $('#sizePreset');
  SIZE_PRESETS.forEach((p, i) => sel.add(new Option(p.label, String(i))));
  sel.add(new Option('Custom size (cm / in)', 'custom'));
  sel.add(new Option('Pixel size (screen / digital)', 'pixels'));
  sel.value = String(DEFAULT_PRESET);
  writePrintFields();

  sel.addEventListener('change', () => {
    const v = sel.value;
    if (v === 'pixels') {
      print.mode = 'pixels';
    } else {
      print.mode = 'physical';
      if (v !== 'custom') Object.assign(print, { w: SIZE_PRESETS[v].w, h: SIZE_PRESETS[v].h, unit: SIZE_PRESETS[v].unit });
    }
    writePrintFields();
    applyPrintSize();
  });
  const onPhys = () => {
    print.w = Math.max(1, parseFloat($('#physW').value) || print.w);
    print.h = Math.max(1, parseFloat($('#physH').value) || print.h);
    print.unit = $('#physUnit').value;
    print.dpi = Number($('#dpi').value);
    const match = SIZE_PRESETS.findIndex((p) => p.unit === print.unit &&
      ((p.w === print.w && p.h === print.h) || (p.w === print.h && p.h === print.w)));
    sel.value = match >= 0 ? String(match) : 'custom';
    applyPrintSize();
  };
  ['#physW', '#physH'].forEach((s) => $(s).addEventListener('change', onPhys));
  $('#physUnit').addEventListener('change', () => {
    // convert the numbers so the physical size stays the same
    const f = $('#physUnit').value === 'cm' ? 2.54 : 1 / 2.54;
    if ($('#physUnit').value !== print.unit) {
      $('#physW').value = +(print.w * f).toFixed(2);
      $('#physH').value = +(print.h * f).toFixed(2);
    }
    onPhys();
  });
  $('#dpi').addEventListener('change', onPhys);
  const onPx = () => {
    print.pxW = Math.max(100, Math.round(+$('#pxW').value || print.pxW));
    print.pxH = Math.max(100, Math.round(+$('#pxH').value || print.pxH));
    applyPrintSize();
  };
  ['#pxW', '#pxH'].forEach((s) => $(s).addEventListener('change', onPx));
  $('#btnOrient').addEventListener('click', () => {
    [print.w, print.h] = [print.h, print.w];
    [print.pxW, print.pxH] = [print.pxH, print.pxW];
    writePrintFields();
    applyPrintSize();
  });
  $('#bgColor').addEventListener('input', (e) => setBackground(e.target.value, 'continuous'));
  $('#bgColor').addEventListener('change', () => markDirty()); // picker closed → one step
  $('#btnBgWhite').addEventListener('click', () => { $('#bgColor').value = '#ffffff'; setBackground('#ffffff'); });
}

function writePrintFields() {
  $('#physicalFields').classList.toggle('hidden', print.mode === 'pixels');
  $('#pixelFields').classList.toggle('hidden', print.mode !== 'pixels');
  $('#physW').value = print.w; $('#physH').value = print.h;
  $('#physUnit').value = print.unit; $('#dpi').value = String(print.dpi);
  $('#pxW').value = print.pxW; $('#pxH').value = print.pxH;
}

// ---- page background beyond a plain colour (see backgrounds.js)
print.background = { ...DEFAULT_BACKGROUND };
let bgImage = null; // loaded <img> for print.background.imageUrl
function bgImageReady() {
  const url = print.background.type === 'image' && print.background.imageUrl;
  if (!url) return null;
  if (bgImage && bgImage._url === url) return bgImage.complete && bgImage.naturalWidth ? bgImage : null;
  bgImage = new Image();
  bgImage._url = url;
  bgImage.onload = () => canvas.requestRenderAll();
  bgImage.src = url;
  return null;
}
async function bgImageLoaded() {
  if (print.background.type !== 'image' || !print.background.imageUrl) return;
  bgImageReady();
  if (!bgImage.complete) await new Promise((r) => { bgImage.addEventListener('load', r, { once: true }); bgImage.addEventListener('error', r, { once: true }); });
}
/** Textures keep the same physical size whatever the DPI. */
const textureScale = () => (print.mode === 'pixels' ? 1 : print.dpi / 300);
/** Paint the background over the page plus any bleed (in print pixels; the page starts at 0,0). */
function paintPage(ctx) {
  const b = bleedPx();
  ctx.save();
  ctx.translate(-b, -b);
  paintBackground(ctx, print.background, print.bg, print.W + 2 * b, print.H + 2 * b, { image: bgImageReady(), texScale: textureScale() });
  ctx.restore();
}
function syncBackgroundUi() {
  const b = print.background;
  $('#bgType').value = b.type;
  $('#bgColor2Wrap').classList.toggle('hidden', b.type !== 'gradient');
  $('#bgGradOpts').classList.toggle('hidden', b.type !== 'gradient');
  $('#bgTexOpts').classList.toggle('hidden', b.type !== 'texture');
  $('#bgImgOpts').classList.toggle('hidden', b.type !== 'image');
  $('#bgColor2').value = b.color2; $('#bgGradDir').value = b.gradDir;
  $('#bgTexture').value = b.texture; $('#bgTexStrength').value = b.texStrength;
  $('#bgImageFit').value = b.imageFit; $('#bgImageOpacity').value = b.imageOpacity;
  $('#bgImageName').textContent = b.imageUrl ? (b.imageName || 'Image chosen') : 'No image chosen yet';
  $('#bgColorLabel').textContent = { solid: 'Colour', gradient: 'From / to', texture: 'Paper colour', image: 'Colour behind' }[b.type];
}
function setBgProp(key, value, kind) {
  print.background = { ...print.background, [key]: value };
  syncBackgroundUi();
  canvas.requestRenderAll();
  markDirty(kind);
}
$('#bgType').addEventListener('change', (e) => setBgProp('type', e.target.value));
$('#bgColor2').addEventListener('input', (e) => setBgProp('color2', e.target.value, 'continuous'));
$('#bgColor2').addEventListener('change', () => markDirty());
$('#bgGradDir').addEventListener('change', (e) => setBgProp('gradDir', e.target.value));
$('#bgTexture').addEventListener('change', (e) => setBgProp('texture', e.target.value));
$('#bgTexStrength').addEventListener('input', (e) => setBgProp('texStrength', +e.target.value, 'continuous'));
$('#bgTexStrength').addEventListener('change', () => markDirty());
$('#bgImageFit').addEventListener('change', (e) => setBgProp('imageFit', e.target.value));
$('#bgImageOpacity').addEventListener('input', (e) => setBgProp('imageOpacity', +e.target.value, 'continuous'));
$('#bgImageOpacity').addEventListener('change', () => markDirty());
$('#bgImageInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  status('Loading the background image…', true);
  try {
    const src = URL.createObjectURL(f);
    const norm = await normalizeSource(src, f);
    if (norm.url !== src) URL.revokeObjectURL(src);
    print.background = { ...print.background, type: 'image', imageUrl: norm.url, imageName: f.name };
    syncBackgroundUi();
    canvas.requestRenderAll();
    markDirty();
    status('Background image set.');
  } catch { status('Could not read that image.'); }
});

function setBackground(color, kind) {
  print.bg = color;
  canvas.requestRenderAll();
  markDirty(kind);
}

let lastViewDims = '';
/** Apply print size to the canvas. Existing objects are remapped proportionally. */
function applyPrintSize() {
  const { W, H } = computePx();
  if (print.W && (W !== print.W || H !== print.H)) {
    const sx = W / print.W, sy = H / print.H, s = Math.sqrt(sx * sy);
    canvas.discardActiveObject();
    canvas.getObjects().forEach((o) => {
      const c = o.getCenterPoint();
      o.set({ scaleX: o.scaleX * s, scaleY: o.scaleY * s });
      o.setPositionByOrigin(new fabric.Point(c.x * sx, c.y * sy), 'center', 'center');
      o.setCoords();
    });
  }
  print.W = W; print.H = H;
  if (lastViewDims !== W + 'x' + H) { lastViewDims = W + 'x' + H; zoomMode = 'fit'; } // new page size → show all of it
  markDirty();
  const mp = (W * H) / 1e6;
  let info = `${W.toLocaleString()} × ${H.toLocaleString()} px (${mp.toFixed(1)} MP)`;
  if (print.mode === 'physical') info += ` · ${print.w} × ${print.h} ${print.unit} at ${print.dpi} DPI`;
  if (mp > 80) info += ' — very large; consider a lower DPI if the browser struggles.';
  $('#sizeInfo').textContent = info;
  $$('.unitLabel').forEach((el) => (el.textContent = unitName()));
  $('#txtSizeLabel') && ($('#txtSizeLabel').textContent = print.mode === 'pixels' ? 'px' : 'pt');
  updateZoom();
  refreshSelectionPanel();
  queueLayers(); // DPI badges depend on the print size
  refreshGridOptions();
  syncLayoutUi();
  syncGuidesUi();
}

// ---------------------------------------------------------------- canvas
fabric.Object.prototype.set({
  transparentCorners: false, cornerColor: '#2f6fde', cornerStrokeColor: '#ffffff', borderColor: '#2f6fde',
  cornerSize: 12, cornerStyle: 'circle', borderScaleFactor: 1.5,
});
// The canvas element always fills the stage; the print is a "page" inside it that is zoomed and
// panned through Fabric's viewport transform. 1 canvas unit = 1 print pixel. This keeps memory
// flat at any zoom level (the old approach grew the canvas element with the zoom).
const canvas = new fabric.Canvas('canvas', { preserveObjectStacking: true, selection: true, stopContextMenu: true });
let zoom = 1;
let zoomMode = 'fit';          // 'fit' re-fits on resize; 'manual' keeps the user's zoom & pan
const ZOOM_MAX = 4;            // 400% of print pixels
let stageColor = '#d9d6d0', offPageColor = 'rgba(217,214,208,.55)', pageShadow = 'rgba(0,0,0,.22)';

function readThemeColors() {
  const cs = getComputedStyle(document.documentElement);
  stageColor = cs.getPropertyValue('--stage').trim() || stageColor;
  offPageColor = cs.getPropertyValue('--offpage').trim() || offPageColor;
  pageShadow = cs.getPropertyValue('--page-shadow').trim() || pageShadow;
  canvas.requestRenderAll();
}

// Off-screen renders (export, project thumbnails) go through Fabric's renderCanvas, which cancels any
// redraw of the visible canvas that was waiting for the next frame. Opening a project draws it and
// saves (with a thumbnail) right away, so the collage stayed blank until something forced a redraw.
// Put back a redraw that was pending.
const fabricToCanvasElement = canvas.toCanvasElement.bind(canvas);
canvas.toCanvasElement = function (...args) {
  const pending = !!canvas.isRendering;
  try { return fabricToCanvasElement(...args); } finally { if (pending) canvas.requestRenderAll(); }
};

// Paint the work area and the page (in the print's background colour) beneath the objects.
const fabricClear = canvas.clearContext.bind(canvas);
canvas.clearContext = function (ctx) {
  fabricClear(ctx);
  if (ctx !== this.contextContainer) return this; // exports & the selection layer stay transparent
  const v = this.viewportTransform;
  ctx.save();
  ctx.fillStyle = stageColor;
  ctx.fillRect(0, 0, this.width, this.height);
  ctx.shadowColor = pageShadow; ctx.shadowBlur = 18; ctx.shadowOffsetY = 3;
  ctx.fillStyle = print.bg;
  const bl = bleedPx();
  ctx.fillRect(v[4] - bl * v[0], v[5] - bl * v[3], (print.W + 2 * bl) * v[0], (print.H + 2 * bl) * v[3]); // casts the page shadow
  ctx.restore();
  ctx.save();
  ctx.transform(v[0], v[1], v[2], v[3], v[4], v[5]);
  paintPage(ctx); // gradient / texture / image, in print pixels
  ctx.restore();
  drawGrid(ctx);
  return this;
};
// Dim whatever hangs off the page, since it won't be printed.
canvas.on('after:render', (opt) => {
  const ctx = canvas.contextContainer;
  if (opt && opt.ctx && opt.ctx !== ctx) return;
  const v = canvas.viewportTransform;
  ctx.save();
  ctx.fillStyle = offPageColor;
  const bl = bleedPx(); // the bleed is printed too, so it isn't dimmed
  ctx.beginPath();
  ctx.rect(0, 0, canvas.width, canvas.height);
  ctx.rect(v[4] - bl * v[0], v[5] - bl * v[3], (print.W + 2 * bl) * v[0], (print.H + 2 * bl) * v[3]);
  ctx.fill('evenodd');
  ctx.restore();
});

const ZOOM_SLIDER_MAX = 1000;
const zoomMin = () => Math.min(0.01, fitZoomValue() * 0.5);
function fitZoomValue() {
  const pad = Math.max(isNarrowScreen() ? 14 : 32, view.rulers ? RULER + 12 : 0);
  const e = print.guides ? pageExtras() : 0;
  return Math.max(0.002, Math.min((canvas.width - 2 * pad) / (print.W + 2 * e), (canvas.height - 2 * pad) / (print.H + 2 * e)));
}
function isNarrowScreen() { return window.matchMedia('(max-width: 900px)').matches; }

function resizeCanvasToStage() {
  const st = $('#stage');
  const w = Math.max(50, st.clientWidth), h = Math.max(50, st.clientHeight);
  if (w !== canvas.width || h !== canvas.height) canvas.setDimensions({ width: w, height: h });
}
function zoomToFit() {
  const z = fitZoomValue();
  canvas.setViewportTransform([z, 0, 0, z, (canvas.width - print.W * z) / 2, (canvas.height - print.H * z) / 2]);
  zoom = z;
  zoomMode = 'fit';
  updateZoomUi();
  canvas.requestRenderAll();
}
/** Keep at least a strip of the page on screen so it can't get lost. */
function clampPan() {
  const v = canvas.viewportTransform, m = 60;
  const pw = print.W * v[0], ph = print.H * v[3];
  v[4] = Math.min(canvas.width - m, Math.max(m - pw, v[4]));
  v[5] = Math.min(canvas.height - m, Math.max(m - ph, v[5]));
  canvas.setViewportTransform(v);
}
/** Zoom to z keeping the canvas-element point (px,py) fixed — e.g. under the mouse. */
function setViewZoom(z, px, py) {
  z = Math.min(ZOOM_MAX, Math.max(zoomMin(), z));
  if (px === undefined) { px = canvas.width / 2; py = canvas.height / 2; }
  canvas.zoomToPoint(new fabric.Point(px, py), z);
  zoom = z;
  zoomMode = 'manual';
  clampPan();
  updateZoomUi();
  canvas.requestRenderAll();
}
function panBy(dx, dy) {
  const v = canvas.viewportTransform;
  v[4] += dx; v[5] += dy;
  canvas.setViewportTransform(v);
  clampPan();
  zoomMode = 'manual';
  updateZoomUi();
  canvas.requestRenderAll();
}
function updateZoom() {
  if (!print.W) return;
  resizeCanvasToStage();
  if (zoomMode === 'fit') zoomToFit();
  else { clampPan(); updateZoomUi(); canvas.requestRenderAll(); }
}
function updateZoomUi() {
  const lo = Math.log(zoomMin()), hi = Math.log(ZOOM_MAX);
  $('#zoomSlider').value = String(Math.round(((Math.log(zoom) - lo) / (hi - lo)) * ZOOM_SLIDER_MAX));
  $('#zoomLabel').textContent = `${zoom < 0.1 ? (zoom * 100).toFixed(1) : Math.round(zoom * 100)}%`;
  $('#zoomFit').classList.toggle('on', zoomMode === 'fit');
}
window.addEventListener('resize', updateZoom);

$('#zoomSlider').addEventListener('input', (e) => {
  const lo = Math.log(zoomMin()), hi = Math.log(ZOOM_MAX);
  setViewZoom(Math.exp(lo + (Number(e.target.value) / ZOOM_SLIDER_MAX) * (hi - lo)));
});
$('#zoomIn').addEventListener('click', () => setViewZoom(zoom * 1.25));
$('#zoomOut').addEventListener('click', () => setViewZoom(zoom / 1.25));
$('#zoomFit').addEventListener('click', zoomToFit);
$('#zoomLabel').addEventListener('click', () => setViewZoom(1)); // 100% = actual print pixels

// Mouse wheel / trackpad: scroll pans, Ctrl/⌘ + scroll (and trackpad pinch) zooms at the pointer.
canvas.on('mouse:wheel', (opt) => {
  const e = opt.e;
  e.preventDefault(); e.stopPropagation();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.height : 1;
  const dx = e.deltaX * unit, dy = e.deltaY * unit;
  if (e.ctrlKey || e.metaKey) setViewZoom(zoom * Math.pow(0.998, Math.max(-300, Math.min(300, dy))), e.offsetX, e.offsetY);
  else if (e.shiftKey && !dx) panBy(-dy, 0);
  else panBy(-dx, -dy);
});

// Keyboard: Ctrl/⌘ + = / − / 0 zoom (instead of zooming the whole browser page).
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || document.querySelector('dialog[open]')) return;
  if (e.key === '=' || e.key === '+') { e.preventDefault(); setViewZoom(zoom * 1.25); }
  else if (e.key === '-') { e.preventDefault(); setViewZoom(zoom / 1.25); }
  else if (e.key === '0') { e.preventDefault(); zoomToFit(); }
});

// Drag to pan: hold Space and drag, or drag with the middle mouse button.
let spaceHeld = false, panDrag = null;
const typingInField = (e) => /^(input|textarea|select)$/i.test(e.target.tagName || '');
function setSpacePan(on) {
  spaceHeld = on;
  canvas.skipTargetFind = on;
  canvas.selection = !on;
  canvas.defaultCursor = on ? 'grab' : 'default';
  canvas.setCursor(canvas.defaultCursor);
}
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat || spaceHeld || typingInField(e) || document.querySelector('dialog[open]')) return;
  if (canvas.getActiveObject()?.isEditing) return;
  e.preventDefault();
  setSpacePan(true);
});
document.addEventListener('keyup', (e) => { if (e.code === 'Space' && spaceHeld) setSpacePan(false); });
window.addEventListener('blur', () => { if (spaceHeld) setSpacePan(false); });
canvas.upperCanvasEl.addEventListener('mousedown', (e) => {
  if (e.button === 1 || (e.button === 0 && spaceHeld)) {
    e.preventDefault(); // stops the browser's middle-click autoscroll
    panDrag = { x: e.clientX, y: e.clientY };
    canvas.setCursor('grabbing');
  }
}, true);
window.addEventListener('mousemove', (e) => {
  if (!panDrag) return;
  panBy(e.clientX - panDrag.x, e.clientY - panDrag.y);
  panDrag = { x: e.clientX, y: e.clientY };
});
window.addEventListener('mouseup', () => { if (panDrag) { panDrag = null; canvas.setCursor(spaceHeld ? 'grab' : 'default'); } });

const isSticker = (o) => o && o.type === 'image' && o.stickerId;
const isText = (o) => o && (o.type === 'textbox' || o.type === 'i-text');

function updateCanvasStatus() {
  const objs = allLeafObjects();
  const s = objs.filter(isSticker).length, t = objs.filter(isText).length;
  $('#status').textContent = `${s} sticker${s === 1 ? '' : 's'} and ${t} text box${t === 1 ? '' : 'es'} on the print.`;
}

/** The parts of a sticker's look that change its pixels (rendered by renderSticker). */
const lookOf = (x) => ({ outline: x.outline, adjust: x.adjust, mask: x.mask, edges: x.edges });
/** Fresh copies of a sticker's look settings, with defaults filled in for older projects. */
function lookCopies(x) {
  return {
    adjust: { ...DEFAULT_ADJUST, ...(x.adjust || {}) },
    mask: { ...DEFAULT_MASK, ...(x.mask || {}) },
    edges: { ...DEFAULT_EDGES, ...(x.edges || {}) },
    shadow: { ...DEFAULT_SHADOW, ...(x.shadow || {}) },
  };
}
/** Drop shadow for a sticker on the print. Sizes are relative to the sticker, so every copy matches,
 *  and the canvas keeps the light direction fixed when a copy is rotated. */
function stickerShadow(item, img) {
  const sh = item.shadow;
  if (!sh?.on) return null;
  const size = Math.max(img.width, img.height);
  const d = (sh.dist / 100) * size, a = (sh.angle * Math.PI) / 180;
  return new fabric.Shadow({
    color: `rgba(0,0,0,${sh.opacity / 100})`, blur: (sh.blur / 100) * size,
    offsetX: Math.cos(a) * d, offsetY: Math.sin(a) * d, affectStroke: false,
  });
}

function makeStickerObject(item, opts = {}) {
  const img = new fabric.Image(item.finalImg, { originX: 'center', originY: 'center', ...opts });
  img.stickerId = item.id;
  img.shadow = stickerShadow(item, item.finalImg);
  img.setControlsVisibility({ mt: false, mb: false, ml: false, mr: false });
  return img;
}

/** Longest side (canvas px) for a sticker given the "Sticker size" slider. */
function baseStickerSide() {
  return (Number($('#genSize').value) / 100) * Math.min(print.W, print.H);
}

function placeSingle(item) {
  const side = baseStickerSide() * (item.size || 1);
  const s = side / Math.max(item.finalImg.width, item.finalImg.height);
  const obj = makeStickerObject(item, {
    left: print.W / 2 + rand(-0.05, 0.05) * print.W, top: print.H / 2 + rand(-0.05, 0.05) * print.H,
    scaleX: s, scaleY: s, angle: 0,
  });
  canvas.add(obj);
  canvas.setActiveObject(obj);
  canvas.requestRenderAll();
  updateCanvasStatus();
}

/**
 * Build a new random layout. Locked items (and kept text boxes) stay where they are and the new
 * stickers keep clear of them; every other sticker is replaced. Placement maths lives in layouts.js.
 */
function generateCollage() {
  const used = library.filter((i) => i.use && i.count > 0);
  if (!used.length) { status('Tick at least one sticker (and give it a count above 0) to generate a collage.'); return; }
  const keepText = $('#genKeepText').checked;
  const replaceable = canvas.getObjects().filter((o) => !o.locked && (isSticker(o) || (!keepText && isText(o))));
  const lockedCount = canvas.getObjects().filter((o) => o.locked).length;
  if (replaceable.some(isSticker) && !confirm(`Replace the current layout with a new one?${lockedCount ? ' Locked items stay where they are.' : ''}`)) return;
  canvas.discardActiveObject();
  replaceable.forEach((o) => canvas.remove(o));

  const style = $('#genStyle').value;
  const m = (Number($('#genMargin').value) / 100) * Math.min(print.W, print.H);
  const obstacles = canvas.getObjects().filter((o) => o.visible !== false).map((o) => {
    const r = rectOf(o);
    return { x: r.cx, y: r.cy, hw: (r.r - r.l) / 2, hh: (r.b - r.t) / 2 }; // bounding box half-sizes
  });
  const copies = used.flatMap((item) => Array.from({ length: item.count }, () => item));
  const { placements, skipped } = computeLayout({
    style,
    items: copies.map((item) => ({ iw: item.finalImg.width, ih: item.finalImg.height, weight: item.size || 1 })),
    area: { l: m, t: m, r: print.W - m, b: print.H - m },
    base: baseStickerSide(),
    variation: Number($('#genVar').value) / 100,
    maxRot: Number($('#genRot').value),
    overlap: Number($('#genOverlap').value) / 100,
    bleed: $('#genBleed').checked,
    outward: $('#genOutward').checked,
    shape: $('#genShape').value,
    shapeText: $('#genShapeText').value,
    obstacles,
  });
  for (const p of placements) {
    canvas.add(makeStickerObject(copies[p.idx], { left: p.x, top: p.y, scaleX: p.s, scaleY: p.s, angle: p.angle }));
  }
  canvas.getObjects().filter(isText).forEach((t) => canvas.bringToFront(t));
  canvas.requestRenderAll();
  updateCanvasStatus();
  let msg = `Placed ${placements.length} sticker${placements.length === 1 ? '' : 's'}.`;
  if (lockedCount) msg += ` ${lockedCount} locked item${lockedCount === 1 ? '' : 's'} kept.`;
  if (skipped) msg += ` ${skipped} didn't fit — try fewer copies, smaller size weights or a smaller margin.`;
  status(msg + ' Drag, resize and rotate them as you like.');
}

// ---------------------------------------------------------------- text boxes
function addText() {
  const fontSize = Math.round(Math.min(print.W, print.H) * 0.06);
  const t = new fabric.Textbox('Your text', {
    originX: 'center', originY: 'center', left: print.W / 2, top: print.H / 2, width: print.W * 0.5, fontSize, fontFamily: 'Georgia',
    fill: '#222222', textAlign: 'center', strokeWidth: 0, stroke: '#ffffff', paintFirst: 'stroke',
  });
  canvas.add(t);
  canvas.setActiveObject(t);
  t.enterEditing(); t.selectAll();
  canvas.requestRenderAll();
  updateCanvasStatus();
}
$('#btnAddText').addEventListener('click', addText);

// ---------------------------------------------------------------- fonts
// A curated set of free Google Fonts plus common system fonts. The stylesheet only tells the browser
// where the fonts are; a font file is downloaded the first time it's used.
const FONT_GROUPS = [
  { label: 'Sans serif', fonts: ['Inter', 'Montserrat', 'Poppins', 'Oswald', 'Bebas Neue', 'Arial', 'Trebuchet MS'] },
  { label: 'Serif', fonts: ['Playfair Display', 'Merriweather', 'Lora', 'DM Serif Display', 'Georgia', 'Times New Roman'] },
  { label: 'Handwriting & script', fonts: ['Caveat', 'Dancing Script', 'Pacifico', 'Great Vibes', 'Satisfy', 'Shadows Into Light', 'Amatic SC', 'Permanent Marker'] },
  { label: 'Display', fonts: ['Abril Fatface', 'Lobster', 'Righteous', 'Bungee', 'Fredoka', 'Impact'] },
  { label: 'Typewriter', fonts: ['Courier Prime', 'Courier New'] },
];
const SYSTEM_FONTS = new Set(['Arial', 'Trebuchet MS', 'Georgia', 'Times New Roman', 'Impact', 'Courier New', 'Comic Sans MS', 'Brush Script MT']);
const WEB_FONTS = new Set(FONT_GROUPS.flatMap((g) => g.fonts).filter((f) => !SYSTEM_FONTS.has(f)));
const BOLD_FONTS = new Set(['Inter', 'Montserrat', 'Poppins', 'Oswald', 'Playfair Display', 'Merriweather', 'Lora', 'Caveat', 'Dancing Script', 'Amatic SC', 'Fredoka', 'Courier Prime']);
(function loadFontStylesheet() {
  const fams = [...WEB_FONTS].map((f) => 'family=' + f.replace(/ /g, '+') + (BOLD_FONTS.has(f) ? ':wght@400;700' : '')).join('&');
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?${fams}&display=swap`;
  document.head.appendChild(link);
})();
(function fillFontSelect() {
  const sel = $('#txtFont');
  sel.innerHTML = '';
  for (const g of FONT_GROUPS) {
    const og = document.createElement('optgroup');
    og.label = g.label;
    for (const f of g.fonts) { const o = new Option(f, f); o.style.fontFamily = `"${f}"`; og.appendChild(o); }
    sel.appendChild(og);
  }
})();

/** Make sure the given fonts are loaded, then re-measure the text that uses them. */
async function ensureFonts(families) {
  const need = [...new Set(families)].filter((f) => WEB_FONTS.has(f));
  if (!need.length) return;
  await Promise.all(need.flatMap((f) => [
    document.fonts.load(`400 40px "${f}"`),
    BOLD_FONTS.has(f) ? document.fonts.load(`700 40px "${f}"`) : null,
  ].filter(Boolean))).catch(() => { /* offline: the browser falls back to a similar font */ });
  need.forEach((f) => fabric.util.clearFabricFontCache(f));
  for (const t of allLeafObjects().filter(isText)) {
    if (!need.includes(t.fontFamily)) continue;
    t.initDimensions();
    if (t.curve) applyCurve(t);
    t.setCoords(); t.dirty = true;
    if (t.group) t.group.addWithUpdate();
  }
  canvas.requestRenderAll();
}
const textFontsInUse = () => allLeafObjects().filter(isText).map((t) => t.fontFamily);

// ---------------------------------------------------------------- curved text & labels
/** Custom text settings that are saved, copied and undone along with the text. */
const TEXT_PROPS = ['curve', 'labelOn', 'labelColor', 'labelRadius', 'labelPad'];
const CLONE_PROPS = ['stickerId', 'locked', 'groupName', ...TEXT_PROPS];

// Text on a path: Fabric doesn't wrap or size a Textbox for that, so do it here.
const textboxWrap = fabric.Textbox.prototype._wrapText;
fabric.Textbox.prototype._wrapText = function (lines, desiredWidth) {
  return textboxWrap.call(this, lines, this.path ? 1e7 : desiredWidth); // curved text is one unbroken line
};
const textboxInit = fabric.Textbox.prototype.initDimensions;
fabric.Textbox.prototype.initDimensions = function () {
  textboxInit.call(this);
  if (this.path) {
    // the box must hold the letters standing on the arc, not just the arc (or they get clipped)
    const m = this.fontSize * this.lineHeight * 1.1;
    this.width = this.path.width + 2 * m; this.height = this.path.height + 2 * m;
  }
};
// Label: a rounded, padded tag drawn behind the text (instead of Fabric's plain background box).
const textBackground = fabric.Textbox.prototype._renderBackground;
fabric.Textbox.prototype._renderBackground = function (ctx) {
  if (!this.labelOn || this.path) return textBackground.call(this, ctx);
  const pad = ((this.labelPad ?? 35) / 100) * this.fontSize;
  const w = this.width + 2 * pad, h = this.height + 2 * pad;
  const r = Math.min(w, h) / 2 * ((this.labelRadius ?? 20) / 50);
  ctx.save();
  ctx.fillStyle = this.labelColor || '#ffffff';
  ctx.beginPath();
  ctx.moveTo(-w / 2 + r, -h / 2);
  ctx.arcTo(w / 2, -h / 2, w / 2, h / 2, r); ctx.arcTo(w / 2, h / 2, -w / 2, h / 2, r);
  ctx.arcTo(-w / 2, h / 2, -w / 2, -h / 2, r); ctx.arcTo(-w / 2, -h / 2, w / 2, -h / 2, r);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
};
/** Labels reach past the text's own box, so they're drawn without Fabric's (clipping) cache. */
function syncLabelCaching(t) { t.objectCaching = !t.labelOn; t.dirty = true; }

/**
 * Bend a text along an arc. curve: −100…100 (0 = straight; positive bends like ∩, negative like ∪;
 * ±100 is nearly a full circle). The arc's length matches the text's length so letters keep their spacing.
 */
function applyCurve(t) {
  const c = t.curve || 0;
  t.set({ path: null });
  if (!c) { t.initDimensions(); t.setCoords(); return; }
  if (t.text.includes('\n')) t.set('text', t.text.replace(/\s*\n\s*/g, ' ')); // one line only
  t.initDimensions();
  t.set({ width: 1e5 }); t.initDimensions(); // measure the unwrapped line
  // The arc is made a little longer than the text. Fabric measures arcs approximately, and if the
  // path comes out even a fraction shorter than the text, the first letter is placed at the far end.
  // Letters are placed using the width including the spacing after the last letter, which
  // getLineWidth leaves out, so add that back too.
  const spacing = t.charSpacing > 0 ? t._getWidthOfCharSpacing() : 0;
  const L = Math.max(1, t.getLineWidth(0) + spacing) * 1.004 + 2;
  const theta = (Math.abs(c) / 100) * 2 * Math.PI * 0.95;
  const R = L / theta, half = theta / 2;
  const sx = R * Math.sin(half), cy = R * Math.cos(half), large = theta > Math.PI ? 1 : 0;
  const d = c > 0
    ? `M ${-sx} ${-cy} A ${R} ${R} 0 ${large} 1 ${sx} ${-cy}`   // over the top: ∩
    : `M ${-sx} ${cy} A ${R} ${R} 0 ${large} 0 ${sx} ${cy}`;    // under the bottom: ∪
  t.set({ path: new fabric.Path(d, { visible: false, fill: '', stroke: '' }), pathAlign: 'center', pathSide: 'left', pathStartOffset: 0 });
  t.initDimensions();
  t.setCoords();
  t.dirty = true;
}
canvas.on('text:changed', (e) => { if (e.target?.curve) { applyCurve(e.target); canvas.requestRenderAll(); } });

// ---------------------------------------------------------------- groups
const isGroup = (o) => !!o && o.type === 'group';
/** Every sticker and text on the print, including those inside groups. */
const allLeafObjects = () => canvas.getObjects().flatMap((o) => (isGroup(o) ? o.getObjects() : [o]));
function setupGroup(g) {
  g.setControlsVisibility({ mt: false, mb: false, ml: false, mr: false }); // keep proportions
  g.subTargetCheck = false;
}

/** Turn the current multi-selection into a permanent group, keeping its place in the stacking order. */
function groupSelection() {
  const a = canvas.getActiveObject();
  if (!a || a.type !== 'activeSelection') return;
  const members = a.getObjects();
  const top = Math.max(...members.map((o) => canvas.getObjects().indexOf(o)));
  const g = a.toGroup();
  setupGroup(g);
  canvas.moveTo(g, top - members.length + 1);
  canvas.setActiveObject(g);
  canvas.requestRenderAll();
  afterGroupChange(`Grouped ${members.length} items. They now move, resize and rotate together.`);
}
/** Break a group back into separate items (left selected, in the same stacking position). */
function ungroupSelection() {
  const g = canvas.getActiveObject();
  if (!isGroup(g)) return;
  const at = canvas.getObjects().indexOf(g);
  const children = g.getObjects();
  const sel = g.toActiveSelection();
  children.forEach((o, k) => canvas.moveTo(o, at + k));
  canvas.setActiveObject(sel);
  canvas.requestRenderAll();
  afterGroupChange(`Ungrouped ${children.length} items.`);
}
function afterGroupChange(msg) {
  markDirty();
  syncGroupButtons(); // Fabric switches the selection without firing selection events
  refreshSelectionPanel();
  updateMobileSelectionUi();
  queueLayers(true);
  updateCanvasStatus();
  status(msg);
}
function syncGroupButtons() {
  const a = canvas.getActiveObject();
  const canGroup = a?.type === 'activeSelection', canUngroup = isGroup(a);
  $('#selGroup').classList.toggle('hidden', !canGroup);
  $('#selUngroup').classList.toggle('hidden', !canUngroup);
  $('#qbGroup').classList.toggle('hidden', !(canGroup || canUngroup));
  $('#qbGroup').textContent = canUngroup ? 'Ungroup' : 'Group';
}
['selection:created', 'selection:updated', 'selection:cleared'].forEach((ev) => canvas.on(ev, syncGroupButtons));
$('#selGroup').addEventListener('click', groupSelection);
$('#selUngroup').addEventListener('click', ungroupSelection);
$('#qbGroup').addEventListener('click', () => (isGroup(canvas.getActiveObject()) ? ungroupSelection() : groupSelection()));

// ---------------------------------------------------------------- selection panel

function activeObjects() { return canvas.getActiveObjects(); }

function refreshSelectionPanel() {
  const objs = activeObjects();
  const panel = $('#selectionPanel');
  if (!objs.length) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  const single = objs.length === 1 ? objs[0] : null;
  $('#imageProps').classList.toggle('hidden', !single || isText(single));
  $('#textProps').classList.toggle('hidden', !isText(single));
  if (!single) return;

  if (isText(single)) {
    $('#txtFont').value = single.fontFamily;
    const ptFactor = print.mode === 'pixels' ? 1 : 72 / print.dpi;
    $('#txtSize').value = Math.round(single.fontSize * single.scaleY * ptFactor);
    $('#txtColor').value = toHex(single.fill);
    $('#txtStroke').value = toHex(single.stroke || '#ffffff');
    $('#txtStrokeW').value = +(single.strokeWidth / Math.max(1, single.fontSize) * 100).toFixed(1);
    $('#txtBold').classList.toggle('on', single.fontWeight === 'bold');
    $('#txtItalic').classList.toggle('on', single.fontStyle === 'italic');
    $('#txtUnderline').classList.toggle('on', !!single.underline);
    $('#txtSpacing').value = single.charSpacing || 0;
    $('#txtSpacingVal').textContent = single.charSpacing ? (single.charSpacing > 0 ? '+' : '') + single.charSpacing : 'normal';
    $('#txtCurve').value = single.curve || 0;
    $('#txtCurveVal').textContent = single.curve ? (single.curve > 0 ? '∩ ' : '∪ ') + Math.abs(single.curve) : 'straight';
    $('#txtLabel').checked = !!single.labelOn;
    $('#txtLabel').disabled = !!single.curve;
    $('#txtLabelRow').title = single.curve ? 'Labels work on straight text — set Curve to 0 first' : '';
    $('#txtLabelOpts').classList.toggle('hidden', !single.labelOn || !!single.curve);
    $('#txtLabelColor').value = toHex(single.labelColor || '#ffffff');
    $('#txtLabelRadius').value = single.labelRadius ?? 20;
    $('#txtLabelPad').value = single.labelPad ?? 35;
    $$('.txtAlign').forEach((b) => b.classList.toggle('on', b.dataset.align === single.textAlign));
  } else {
    $('#selW').value = +(single.getScaledWidth() / pxPerUnit()).toFixed(print.mode === 'pixels' ? 0 : 1);
    $('#selRot').value = Math.round(single.angle);
    if (isSticker(single)) {
      const native = 1 / single.scaleX; // source px per canvas px
      let msg;
      if (print.mode === 'physical') {
        const eff = Math.round(print.dpi * native);
        msg = `Effective resolution: ${eff} DPI — ${eff >= 250 ? 'great' : eff >= 150 ? 'OK for print' : 'low, may look soft when printed'}.`;
      } else {
        msg = `Shown at ${Math.round(single.scaleX * 100)}% of the sticker's own resolution.`;
      }
      $('#selDpi').textContent = msg;
    } else {
      $('#selDpi').textContent = '';
    }
  }
}
function toHex(c) {
  if (typeof c !== 'string') return '#000000';
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  const col = new fabric.Color(c);
  return '#' + col.toHex();
}

['selection:created', 'selection:updated', 'selection:cleared', 'object:modified', 'object:scaling', 'object:rotating']
  .forEach((ev) => canvas.on(ev, refreshSelectionPanel));

$('#selW').addEventListener('change', () => {
  const o = activeObjects()[0]; if (!o) return;
  const target = Math.max(0.1, +$('#selW').value) * pxPerUnit();
  const f = target / o.getScaledWidth();
  o.set({ scaleX: o.scaleX * f, scaleY: o.scaleY * f }); o.setCoords();
  canvas.requestRenderAll(); refreshSelectionPanel(); markDirty();
});
$('#selRot').addEventListener('change', () => {
  const o = activeObjects()[0]; if (!o) return;
  o.rotate(Number($('#selRot').value) || 0); o.setCoords(); canvas.requestRenderAll(); markDirty();
});

function forEachActive(fn) {
  const objs = activeObjects();
  objs.forEach(fn);
  canvas.requestRenderAll();
  markDirty();
}
$('#selFlipH').addEventListener('click', () => forEachActive((o) => o.set('flipX', !o.flipX)));
$('#selFlipV').addEventListener('click', () => forEachActive((o) => o.set('flipY', !o.flipY)));
$('#selForward').addEventListener('click', () => layerOp((a) => canvas.bringForward(a)));
$('#selBackward').addEventListener('click', () => layerOp((a) => canvas.sendBackwards(a)));
$('#selDelete').addEventListener('click', deleteSelection);
$('#selDuplicate').addEventListener('click', duplicateSelection);

function deleteSelection() {
  const objs = activeObjects();
  if (!objs.length) return;
  canvas.discardActiveObject();
  objs.forEach((o) => canvas.remove(o));
  canvas.requestRenderAll();
  updateCanvasStatus();
}

function duplicateSelection() {
  const objs = activeObjects();
  if (!objs.length) return;
  holdHistory(); // image clones load asynchronously; record them together
  canvas.discardActiveObject();
  const offset = Math.min(print.W, print.H) * 0.03;
  const clones = [];
  let pending = objs.length;
  objs.forEach((o) => {
    o.clone((c) => {
      c.set({ left: o.left + offset, top: o.top + offset });
      if (isSticker(o)) { c.stickerId = o.stickerId; c.setControlsVisibility({ mt: false, mb: false, ml: false, mr: false }); }
      if (isGroup(c)) setupGroup(c);
      for (const leaf of isGroup(c) ? c.getObjects() : [c]) {
        if (isText(leaf)) { syncLabelCaching(leaf); if (leaf.curve) applyCurve(leaf); }
      }
      canvas.add(c); clones.push(c);
      if (--pending === 0) {
        const sel = clones.length === 1 ? clones[0] : new fabric.ActiveSelection(clones, { canvas });
        canvas.setActiveObject(sel); canvas.requestRenderAll(); updateCanvasStatus();
        releaseHistory();
      }
    }, CLONE_PROPS);
  });
}

// text property bindings
function withText(fn, kind) {
  const o = activeObjects()[0];
  if (!isText(o)) return;
  fn(o);
  if (o.curve) applyCurve(o); // size/font/spacing change the arc's length
  o.setCoords(); canvas.requestRenderAll(); markDirty(kind);
}
$('#txtFont').addEventListener('change', (e) => {
  withText((t) => t.set('fontFamily', e.target.value));
  ensureFonts([e.target.value]).then(refreshSelectionPanel); // re-measure once the font has downloaded
});
$('#txtSpacing').addEventListener('input', (e) => { withText((t) => t.set('charSpacing', +e.target.value), 'continuous'); refreshSelectionPanel(); });
$('#txtSpacing').addEventListener('change', () => markDirty());
$('#txtCurve').addEventListener('input', (e) => { withText((t) => { t.curve = +e.target.value; if (!t.curve) applyCurve(t); }, 'continuous'); refreshSelectionPanel(); });
$('#txtCurve').addEventListener('change', () => markDirty());
$('#txtLabel').addEventListener('change', (e) => { withText((t) => { t.labelOn = e.target.checked; syncLabelCaching(t); }); refreshSelectionPanel(); });
$('#txtLabelColor').addEventListener('input', (e) => withText((t) => { t.labelColor = e.target.value; t.dirty = true; }, 'continuous'));
$('#txtLabelRadius').addEventListener('input', (e) => withText((t) => { t.labelRadius = +e.target.value; t.dirty = true; }, 'continuous'));
$('#txtLabelPad').addEventListener('input', (e) => withText((t) => { t.labelPad = +e.target.value; t.dirty = true; }, 'continuous'));
['#txtLabelColor', '#txtLabelRadius', '#txtLabelPad'].forEach((sel) => $(sel).addEventListener('change', () => markDirty()));
$('#txtSize').addEventListener('change', (e) => withText((t) => {
  const ptFactor = print.mode === 'pixels' ? 1 : 72 / print.dpi;
  t.set({ fontSize: Math.max(1, Number(e.target.value) / ptFactor / t.scaleY) });
}));
$('#txtColor').addEventListener('input', (e) => withText((t) => t.set('fill', e.target.value), 'continuous'));
$('#txtStroke').addEventListener('input', (e) => withText((t) => t.set('stroke', e.target.value), 'continuous'));
$('#txtStrokeW').addEventListener('input', (e) => withText((t) => t.set('strokeWidth', (Number(e.target.value) / 100) * t.fontSize), 'continuous'));
['#txtColor', '#txtStroke', '#txtStrokeW'].forEach((sel) => $(sel).addEventListener('change', () => markDirty()));
$('#txtBold').addEventListener('click', () => withText((t) => t.set('fontWeight', t.fontWeight === 'bold' ? 'normal' : 'bold')));
$('#txtItalic').addEventListener('click', () => withText((t) => t.set('fontStyle', t.fontStyle === 'italic' ? 'normal' : 'italic')));
$('#txtUnderline').addEventListener('click', () => withText((t) => t.set('underline', !t.underline)));
$$('.txtAlign').forEach((b) => b.addEventListener('click', () => withText((t) => t.set('textAlign', b.dataset.align))));
['#txtBold', '#txtItalic', '#txtUnderline', '.txtAlign'].forEach((s) => $$(s).forEach((b) => b.addEventListener('click', refreshSelectionPanel)));

// keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  const active = canvas.getActiveObject();
  if (active && active.isEditing) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelection(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); selectObjects(layerObjects()); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') { e.preventDefault(); if (e.shiftKey) ungroupSelection(); else groupSelection(); }
  else if (e.key === 'Escape' && active) { canvas.discardActiveObject(); canvas.requestRenderAll(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (e.key.startsWith('Arrow') && active) {
    e.preventDefault();
    const step = (e.shiftKey ? 0.02 : 0.004) * Math.min(print.W, print.H);
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    active.set({ left: active.left + d[0], top: active.top + d[1] }); active.setCoords(); canvas.requestRenderAll(); markDirty('continuous');
  }
});
document.addEventListener('keyup', (e) => { if (e.key.startsWith('Arrow') && continuousPending) markDirty(); });

// ---------------------------------------------------------------- snapping, guides & alignment
// While dragging, the item's bounding box snaps to the page edges/centre and to other items'
// edges/centres within SNAP_PX screen pixels; magenta guides show what it snapped to.
// Alt-drag ignores snapping. Rotation snaps to 45° steps when within a few degrees.
const SNAP_PX = 7;
const GUIDE_COLOR = '#e0249a';
let snapOn = true;
try { snapOn = localStorage.getItem('collage.snap') !== '0'; } catch { /* storage unavailable */ }
let guides = { v: [], h: [] };
let snapTargets = null; // cached per drag: { xs, ys }

function applySnapSetting() {
  $('#snapToggle').checked = snapOn;
  fabric.Object.prototype.snapAngle = snapOn ? 45 : 0;
  fabric.Object.prototype.snapThreshold = snapOn ? 4 : null;
}
$('#snapToggle').addEventListener('change', (e) => {
  snapOn = e.target.checked;
  try { localStorage.setItem('collage.snap', snapOn ? '1' : '0'); } catch { /* ignore */ }
  applySnapSetting();
});
applySnapSetting();

const rectOf = (o) => {
  const b = o.getBoundingRect(true, true);
  return { l: b.left, t: b.top, r: b.left + b.width, b: b.top + b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 };
};

function collectSnapTargets(moving) {
  const grid = gridLines();
  const xs = [0, print.W / 2, print.W, ...grid.xs], ys = [0, print.H / 2, print.H, ...grid.ys];
  if (print.guides.safe) { const sm = print.guides.safeMm * pxPerMm(); xs.push(sm, print.W - sm); ys.push(sm, print.H - sm); }
  for (const o of canvas.getObjects()) {
    if (moving.has(o) || !o.visible) continue;
    const r = rectOf(o);
    xs.push(r.l, r.cx, r.r); ys.push(r.t, r.cy, r.b);
  }
  return { xs, ys };
}

/** Smallest shift (within thr) that lines one of `edges` up with one of `targets`. */
function nearestSnap(edges, targets, thr) {
  let best = null;
  for (const e of edges) for (const c of targets) {
    const d = c - e;
    if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best))) best = d;
  }
  return best;
}
/** All target lines that the (already shifted) edges now sit on — so every match gets a guide. */
function matchedLines(edges, targets) {
  const out = new Set();
  for (const e of edges) for (const c of targets) if (Math.abs(c - e) < 0.5) out.add(c);
  return [...out];
}

canvas.on('object:moving', (opt) => {
  const t = opt.target;
  guides = { v: [], h: [] };
  if (!snapOn || opt.e?.altKey) return;
  if (!snapTargets) {
    const moving = new Set(t.type === 'activeSelection' ? t.getObjects() : [t]);
    moving.add(t);
    snapTargets = collectSnapTargets(moving);
  }
  const thr = SNAP_PX / zoom;
  let r = rectOf(t);
  const dx = nearestSnap([r.l, r.cx, r.r], snapTargets.xs, thr);
  const dy = nearestSnap([r.t, r.cy, r.b], snapTargets.ys, thr);
  if (dx !== null || dy !== null) {
    t.set({ left: t.left + (dx || 0), top: t.top + (dy || 0) });
    t.setCoords();
    r = rectOf(t);
  }
  if (dx !== null) guides.v = matchedLines([r.l, r.cx, r.r], snapTargets.xs);
  if (dy !== null) guides.h = matchedLines([r.t, r.cy, r.b], snapTargets.ys);
});

function clearGuides() {
  snapTargets = null;
  if (guides.v.length || guides.h.length) { guides = { v: [], h: [] }; canvas.requestRenderAll(); }
}
canvas.on('mouse:up', clearGuides);
canvas.on('selection:cleared', clearGuides);

canvas.on('after:render', (opt) => {
  if (!guides.v.length && !guides.h.length) return;
  const ctx = canvas.contextContainer;
  if (opt && opt.ctx && opt.ctx !== ctx) return; // never draw guides into an export
  const vpt = canvas.viewportTransform;
  ctx.save();
  ctx.transform(vpt[0], vpt[1], vpt[2], vpt[3], vpt[4], vpt[5]);
  ctx.strokeStyle = GUIDE_COLOR;
  ctx.lineWidth = 1 / zoom;
  ctx.setLineDash([6 / zoom, 4 / zoom]);
  ctx.beginPath();
  for (const x of guides.v) { ctx.moveTo(x, 0); ctx.lineTo(x, print.H); }
  for (const y of guides.h) { ctx.moveTo(0, y); ctx.lineTo(print.W, y); }
  ctx.stroke();
  ctx.restore();
});

/** Align/distribute the selection. One item aligns to the page; several align to their combined bounds. */
function alignSelection(mode) {
  const objs = activeObjects();
  if (!objs.length) return;
  if ((mode === 'distH' || mode === 'distV') && objs.length < 3) return;
  canvas.discardActiveObject(); // objects get back their absolute coordinates
  const items = objs.map((o) => ({ o, r: rectOf(o) }));
  const area = objs.length === 1
    ? { l: 0, t: 0, r: print.W, b: print.H }
    : items.reduce((a, { r }) => ({ l: Math.min(a.l, r.l), t: Math.min(a.t, r.t), r: Math.max(a.r, r.r), b: Math.max(a.b, r.b) }),
      { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity });
  const move = (o, dx, dy) => { o.set({ left: o.left + dx, top: o.top + dy }); o.setCoords(); };

  if (mode === 'distH' || mode === 'distV') {
    const horiz = mode === 'distH';
    const lo = horiz ? 'l' : 't', hi = horiz ? 'r' : 'b';
    items.sort((a, b) => (a.r[lo] + a.r[hi]) - (b.r[lo] + b.r[hi]));
    const total = items.reduce((s, { r }) => s + (r[hi] - r[lo]), 0);
    const gap = (area[hi] - area[lo] - total) / (items.length - 1);
    let pos = area[lo];
    for (const { o, r } of items) {
      const d = pos - r[lo];
      move(o, horiz ? d : 0, horiz ? 0 : d);
      pos += r[hi] - r[lo] + gap;
    }
  } else {
    const acx = (area.l + area.r) / 2, acy = (area.t + area.b) / 2;
    for (const { o, r } of items) {
      const dx = { left: area.l - r.l, hcenter: acx - r.cx, right: area.r - r.r }[mode] ?? 0;
      const dy = { top: area.t - r.t, vcenter: acy - r.cy, bottom: area.b - r.b }[mode] ?? 0;
      move(o, dx, dy);
    }
  }
  const sel = objs.length === 1 ? objs[0] : new fabric.ActiveSelection(objs, { canvas });
  canvas.setActiveObject(sel);
  canvas.requestRenderAll();
  refreshSelectionPanel();
  markDirty();
}
$$('.alignBtn').forEach((b) => b.addEventListener('click', () => alignSelection(b.dataset.align)));

function refreshAlignButtons() {
  const n = activeObjects().length;
  if (!n) return;
  $('#alignLabel').textContent = n === 1 ? 'Align to page' : `Align ${n} items to each other`;
  $$('.alignBtn[data-align^=dist]').forEach((b) => { b.disabled = n < 3; });
}
['selection:created', 'selection:updated'].forEach((ev) => canvas.on(ev, refreshAlignButtons));

// ---------------------------------------------------------------- phones & touch
// Below 900px the side panels become bottom sheets opened from a nav bar, the Selection panel
// moves into its own "Edit" sheet, and a quick-action bar appears while something is selected.
// On touch screens, two fingers on the print resize and rotate the selected item.
const mobileMQ = window.matchMedia('(max-width: 900px)');
let openSheet = null;
const isMobile = () => mobileMQ.matches;

fabric.Object.prototype.touchCornerSize = 40;

function setSheet(name) {
  openSheet = name;
  $$('[data-sheet-panel]').forEach((p) => p.classList.toggle('open', p.dataset.sheetPanel === openSheet));
  $$('#mobileNav button').forEach((b) => b.classList.toggle('on', b.dataset.sheet === openSheet));
}
$$('#mobileNav button').forEach((b) => b.addEventListener('click', () => setSheet(openSheet === b.dataset.sheet ? null : b.dataset.sheet)));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openSheet && !document.querySelector('dialog[open]')) setSheet(null); });

function applyResponsiveLayout() {
  const sel = $('#selectionPanel');
  const layers = $('#layersPanel');
  if (isMobile()) { $('#editSheet').appendChild(sel); $('#layersSheet').appendChild(layers); }
  else { $('.panel.right').appendChild(sel); $('.panel.right').insertBefore(layers, sel); setSheet(null); }
  updateMobileSelectionUi();
  updateZoom();
}
let lastMobile = null;
function syncResponsiveLayout() { if (isMobile() !== lastMobile) { lastMobile = isMobile(); applyResponsiveLayout(); } }
mobileMQ.addEventListener('change', syncResponsiveLayout);
window.addEventListener('resize', syncResponsiveLayout); // some browsers/emulators skip the media-query change event

function updateMobileSelectionUi() {
  const objs = activeObjects();
  const single = objs.length === 1 ? objs[0] : null;
  $('#quickBar').classList.toggle('show', isMobile() && objs.length > 0);
  $('#qbEditText').classList.toggle('hidden', !isText(single));
  $('#mobileNav [data-sheet=edit]').disabled = objs.length === 0;
  if (!objs.length && openSheet === 'edit') setSheet(null);
}
['selection:created', 'selection:updated', 'selection:cleared'].forEach((ev) => canvas.on(ev, updateMobileSelectionUi));
// on a phone, tapping the print to work on it tucks away the Stickers / Print sheets
canvas.on('mouse:down', () => { if (isMobile() && (openSheet === 'stickers' || openSheet === 'print')) setSheet(null); });

$('#qbEditText').addEventListener('click', () => {
  const t = activeObjects()[0];
  if (!isText(t)) return;
  t.enterEditing();
  t.selectAll();
  t.hiddenTextarea?.focus(); // brings up the on-screen keyboard
  canvas.requestRenderAll();
});
$('#qbDuplicate').addEventListener('click', duplicateSelection);
$('#qbDelete').addEventListener('click', deleteSelection);
$('#qbForward').addEventListener('click', () => layerOp((a) => canvas.bringForward(a)));
$('#qbBackward').addEventListener('click', () => layerOp((a) => canvas.sendBackwards(a)));
$('#qbMore').addEventListener('click', () => setSheet('edit'));

// Touch gestures (capture phase on window, so Fabric doesn't also act on them):
//  • two fingers on the selected item → resize & rotate it
//  • two fingers anywhere else        → zoom & pan the view
//  • one finger on empty space        → pan the view (a tap there deselects)
let gesture = null;
let swallowTouches = false; // once a gesture starts, ignore leftover finger moves until all fingers lift
const touchGeom = (e) => {
  const [a, b] = e.touches;
  return {
    d: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
    ang: Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX) * 180 / Math.PI,
    mx: (a.clientX + b.clientX) / 2, my: (a.clientY + b.clientY) / 2,
  };
};
const onCanvas = (e) => canvas.wrapperEl.contains(e.target);
const toCanvasEl = (x, y) => { const r = canvas.upperCanvasEl.getBoundingClientRect(); return { x: x - r.left, y: y - r.top }; };
function touchInside(obj, t) {
  const p = toCanvasEl(t.clientX, t.clientY), b = obj.getBoundingRect(); // viewport coordinates
  const pad = 20;
  return p.x >= b.left - pad && p.x <= b.left + b.width + pad && p.y >= b.top - pad && p.y <= b.top + b.height + pad;
}

window.addEventListener('touchstart', (e) => {
  if (!onCanvas(e)) return;
  if (e.touches.length === 2) {
    const obj = canvas.getActiveObject();
    const g = touchGeom(e);
    if (obj && !obj.isEditing && (touchInside(obj, e.touches[0]) || touchInside(obj, e.touches[1]))) {
      gesture = { kind: 'object', obj, d0: g.d, a0: g.ang, sx: obj.scaleX, sy: obj.scaleY, angle: obj.angle };
    } else {
      const m = toCanvasEl(g.mx, g.my), v = canvas.viewportTransform;
      gesture = { kind: 'view', z0: zoom, d0: g.d, px: (m.x - v[4]) / v[0], py: (m.y - v[5]) / v[3] };
    }
    swallowTouches = true;
    e.preventDefault(); e.stopPropagation();
  } else if (e.touches.length === 1 && !swallowTouches) {
    const target = canvas.findTarget(e);
    if (target) return; // let Fabric select / drag it
    const t = e.touches[0];
    gesture = { kind: 'pan', x: t.clientX, y: t.clientY, moved: 0 };
    swallowTouches = true;
    if (isMobile() && (openSheet === 'stickers' || openSheet === 'print')) setSheet(null);
    e.preventDefault(); e.stopPropagation();
  }
}, { capture: true, passive: false });

window.addEventListener('touchmove', (e) => {
  if (!swallowTouches) return;
  e.preventDefault(); e.stopPropagation();
  if (!gesture) return;
  if (gesture.kind === 'object' && e.touches.length >= 2) {
    const g = touchGeom(e);
    const k = Math.max(0.02, g.d / gesture.d0);
    let angle = gesture.angle + (g.ang - gesture.a0);
    if (snapOn) { const near = Math.round(angle / 45) * 45; if (Math.abs(angle - near) < 4) angle = near; }
    gesture.obj.set({ scaleX: gesture.sx * k, scaleY: gesture.sy * k });
    gesture.obj.rotate(angle);
    gesture.obj.setCoords();
    canvas.requestRenderAll();
    refreshSelectionPanel();
  } else if (gesture.kind === 'view' && e.touches.length >= 2) {
    const g = touchGeom(e);
    const z = Math.min(ZOOM_MAX, Math.max(zoomMin(), gesture.z0 * (g.d / gesture.d0)));
    const m = toCanvasEl(g.mx, g.my);
    canvas.setViewportTransform([z, 0, 0, z, m.x - gesture.px * z, m.y - gesture.py * z]);
    zoom = z; zoomMode = 'manual';
    clampPan(); updateZoomUi(); canvas.requestRenderAll();
  } else if (gesture.kind === 'pan' && e.touches.length === 1) {
    const t = e.touches[0];
    const dx = t.clientX - gesture.x, dy = t.clientY - gesture.y;
    gesture.moved += Math.abs(dx) + Math.abs(dy);
    gesture.x = t.clientX; gesture.y = t.clientY;
    panBy(dx, dy);
  }
}, { capture: true, passive: false });

const endTouch = (e) => {
  if (gesture?.kind === 'object' && e.touches.length < 2) {
    canvas.fire('object:modified', { target: gesture.obj });
    gesture = null;
  } else if (gesture?.kind === 'pan' && e.touches.length === 0 && gesture.moved < 8) {
    canvas.discardActiveObject(); // a tap on empty space clears the selection
    canvas.requestRenderAll();
  }
  if (e.touches.length === 0) { swallowTouches = false; gesture = null; }
};
window.addEventListener('touchend', endTouch, { capture: true });
window.addEventListener('touchcancel', endTouch, { capture: true });

// ---------------------------------------------------------------- layers
// A list of everything on the print, front first. Rows select (Ctrl/⌘ or tick box = add, Shift = range),
// can be dragged by the handle to reorder, hidden, or locked (a locked item can't be selected or moved
// on the print, which helps when many stickers overlap).
const ICON = {
  eye: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17.9 17.9A10 10 0 0 1 12 19c-7 0-11-7-11-7a18 18 0 0 1 5-5.9M9.9 4.2A9 9 0 0 1 12 4c7 0 11 7 11 7a18 18 0 0 1-2.2 3.2"/><line x1="1" y1="1" x2="23" y2="23"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  unlock: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.6-1.8"/></svg>',
};

/** How sharp a sticker will print at its current size; null when it's fine. */
function stickerQuality(o) {
  const sc = o.getObjectScaling();
  const s = Math.abs(sc.scaleX ?? sc.x);
  if (print.mode === 'physical') {
    const dpi = Math.round(print.dpi / s);
    if (dpi < 150) return { level: 'bad', label: `${dpi} dpi`, title: `Low resolution: ${dpi} DPI at this size — likely to look soft or pixelated when printed. Make it smaller or use a bigger image.` };
    if (dpi < 220) return { level: 'warn', label: `${dpi} dpi`, title: `${dpi} DPI at this size — fine from a distance, not crisp up close.` };
    return null;
  }
  if (s > 1.2) return { level: 'warn', label: `${Math.round(s * 100)}%`, title: 'Shown larger than its own resolution — may look soft.' };
  return null;
}

function setLocked(o, locked) { o.locked = !!locked; o.selectable = !locked; o.evented = !locked; }
const canSelect = (o) => o.visible !== false && !o.locked;
const layerObjects = () => canvas.getObjects().filter((o) => isSticker(o) || isText(o) || isGroup(o));
const expandedGroups = new WeakSet();

canvas.selectionKey = ['shiftKey', 'ctrlKey', 'metaKey']; // Shift / Ctrl / ⌘ + click adds to the selection on the print too

/** Select exactly these objects (kept in stacking order). Hidden and locked ones are skipped. */
function selectObjects(list) {
  const want = new Set(list);
  const objs = canvas.getObjects().filter((o) => want.has(o) && canSelect(o));
  canvas.discardActiveObject();
  if (objs.length === 1) canvas.setActiveObject(objs[0]);
  else if (objs.length > 1) canvas.setActiveObject(new fabric.ActiveSelection(objs, { canvas }));
  canvas.requestRenderAll();
  queueLayers();
}

let layersQueued = false, layersScrollToSel = false, layerAnchor = null;
/** Re-render the list once after the current burst of changes (e.g. a whole random layout). */
function queueLayers(scrollToSelection = false) {
  layersScrollToSel ||= scrollToSelection;
  if (layersQueued) return;
  layersQueued = true;
  Promise.resolve().then(() => { layersQueued = false; renderLayers(); });
}
['object:added', 'object:removed', 'object:modified', 'text:changed'].forEach((ev) => canvas.on(ev, () => queueLayers()));
['selection:created', 'selection:updated', 'selection:cleared'].forEach((ev) => canvas.on(ev, () => queueLayers(true)));

function renderLayers() {
  const ul = $('#layerList');
  const objs = layerObjects();
  const selected = new Set(canvas.getActiveObjects());
  const items = new Map(library.map((i) => [i.id, i]));
  $('#layerCount').textContent = objs.length ? `(${objs.length})` : '';
  $('#layersEmpty').classList.toggle('hidden', objs.length > 0);
  ['#lyFront', '#lyForward', '#lyBackward', '#lyBack'].forEach((s) => { $(s).disabled = selected.size === 0; });
  $('#lyClear').disabled = objs.length === 0;
  $('#lySelectAll').disabled = !objs.some(canSelect);

  // number repeated copies of the same sticker ("Rose · 3"), counting from the back
  const total = {}, nth = new Map();
  objs.forEach((o) => { if (isSticker(o)) { total[o.stickerId] = (total[o.stickerId] || 0) + 1; nth.set(o, total[o.stickerId]); } });

  const scrollTop = ul.scrollTop;
  ul.innerHTML = '';
  let lowRes = 0;
  let firstSel = null;
  for (const o of [...objs].reverse()) {
    const li = document.createElement('li');
    li.className = 'layer-row' + (selected.has(o) ? ' sel' : '') + (o.visible === false ? ' is-hidden' : '') + (o.locked ? ' is-locked' : '');
    li.innerHTML = '<span class="ly-handle" title="Drag to reorder">⋮⋮</span><input type="checkbox" class="ly-check" />'
      + '<span class="ly-thumb checker"></span><span class="ly-name"></span><span class="ly-badge"></span>'
      + '<button class="ly-btn ly-eye"></button><button class="ly-btn ly-lock"></button>';
    li.layerObj = o;
    const check = li.querySelector('.ly-check');
    check.checked = selected.has(o);
    check.disabled = !canSelect(o);
    check.title = 'Add to / remove from the selection';
    const thumb = li.querySelector('.ly-thumb'), nameEl = li.querySelector('.ly-name');
    if (isSticker(o)) {
      const it = items.get(o.stickerId);
      const im = document.createElement('img');
      im.src = it?.finalUrl || ''; im.alt = ''; im.draggable = false;
      thumb.appendChild(im);
      nameEl.textContent = (it?.name || 'Sticker') + (total[o.stickerId] > 1 ? ` · ${nth.get(o)}` : '');
      nameEl.title = nameEl.textContent + ' — double-click to rename the sticker';
      const q = stickerQuality(o);
      if (q) {
        const badge = li.querySelector('.ly-badge');
        badge.textContent = q.label; badge.title = q.title; badge.classList.add(q.level);
        if (q.level === 'bad') lowRes++;
      }
    } else if (isGroup(o)) {
      const kids = o.getObjects();
      const firstSticker = kids.find(isSticker);
      if (firstSticker) {
        const im = document.createElement('img');
        im.src = items.get(firstSticker.stickerId)?.finalUrl || ''; im.alt = ''; im.draggable = false;
        thumb.appendChild(im);
      } else { thumb.classList.add('ly-text'); thumb.textContent = 'G'; }
      thumb.classList.add('ly-group-thumb');
      const open = expandedGroups.has(o);
      nameEl.innerHTML = '<button class="ly-expand"></button><span class="ly-gname"></span>';
      nameEl.querySelector('.ly-expand').textContent = open ? '▾' : '▸';
      nameEl.querySelector('.ly-expand').title = open ? 'Hide the items in this group' : 'Show the items in this group';
      nameEl.querySelector('.ly-gname').textContent = `${o.groupName || 'Group'} · ${kids.length} items`;
      nameEl.title = (o.groupName || 'Group') + ' — double-click to rename; Ungroup (Ctrl+Shift+G) to edit items separately';
      const worst = kids.filter(isSticker).map(stickerQuality).filter(Boolean).sort((a, b) => (a.level === 'bad' ? -1 : 1))[0];
      if (worst) {
        const badge = li.querySelector('.ly-badge');
        badge.textContent = worst.label; badge.title = 'A sticker in this group: ' + worst.title; badge.classList.add(worst.level);
        if (worst.level === 'bad') lowRes++;
      }
      if (open) li.dataset.expand = '1';
    } else {
      thumb.classList.add('ly-text');
      thumb.textContent = 'T';
      const txt = (o.text || '').replace(/\s+/g, ' ').trim();
      nameEl.textContent = `“${txt.length > 40 ? txt.slice(0, 40) + '…' : txt}”`;
      nameEl.title = txt;
    }
    const eye = li.querySelector('.ly-eye'), lock = li.querySelector('.ly-lock');
    eye.innerHTML = o.visible === false ? ICON.eyeOff : ICON.eye;
    eye.title = o.visible === false ? 'Hidden — click to show (hidden items are not printed)' : 'Hide';
    lock.innerHTML = o.locked ? ICON.lock : ICON.unlock;
    lock.title = o.locked ? 'Locked — click to unlock' : 'Lock (can’t be selected or moved on the print)';
    ul.appendChild(li);
    if (selected.has(o) && !firstSel) firstSel = li;
    if (li.dataset.expand) { // the group's items, front first, indented (clicking one selects the group)
      for (const k of [...o.getObjects()].reverse()) {
        const sub = document.createElement('li');
        sub.className = 'layer-row layer-child' + (selected.has(o) ? ' sel' : '');
        sub.layerObj = o;
        sub.innerHTML = '<span></span><span></span><span class="ly-thumb checker"></span><span class="ly-name"></span>';
        if (isSticker(k)) {
          const im = document.createElement('img');
          im.src = items.get(k.stickerId)?.finalUrl || ''; im.alt = ''; im.draggable = false;
          sub.querySelector('.ly-thumb').appendChild(im);
          sub.querySelector('.ly-name').textContent = items.get(k.stickerId)?.name || 'Sticker';
        } else {
          sub.querySelector('.ly-thumb').classList.add('ly-text');
          sub.querySelector('.ly-thumb').textContent = 'T';
          sub.querySelector('.ly-name').textContent = `“${(k.text || '').replace(/\s+/g, ' ').trim().slice(0, 40)}”`;
        }
        ul.appendChild(sub);
      }
    }
  }
  ul.scrollTop = scrollTop;
  $('#layerCount').textContent = objs.length ? `(${objs.length})` : '';
  if (lowRes) {
    const warn = document.createElement('span');
    warn.className = 'ly-badge bad'; warn.textContent = `${lowRes} low-res`;
    warn.title = 'Stickers enlarged below 150 DPI. They are marked in the list.';
    $('#layerCount').appendChild(warn);
  }
  // keep the selected row in view inside the list (without scrolling the whole panel)
  if (layersScrollToSel && firstSel) {
    const top = firstSel.offsetTop, h = firstSel.offsetHeight;
    if (top < ul.scrollTop || top + h > ul.scrollTop + ul.clientHeight) ul.scrollTop = top - ul.clientHeight / 2 + h / 2;
  }
  layersScrollToSel = false;
}

function toggleInSelection(o) {
  const cur = canvas.getActiveObjects();
  selectObjects(cur.includes(o) ? cur.filter((x) => x !== o) : [...cur, o]);
  layerAnchor = o;
}

$('#layerList').addEventListener('click', (e) => {
  const li = e.target.closest('.layer-row');
  if (!li) return;
  const o = li.layerObj;
  if (e.target.closest('.ly-expand')) {
    if (expandedGroups.has(o)) expandedGroups.delete(o); else expandedGroups.add(o);
    queueLayers();
    return;
  }
  if (e.target.closest('.ly-eye')) {
    const show = o.visible === false;
    o.visible = show;
    if (!show) selectObjects(canvas.getActiveObjects().filter((x) => x !== o));
    canvas.requestRenderAll(); markDirty(); queueLayers();
    return;
  }
  if (e.target.closest('.ly-lock')) {
    setLocked(o, !o.locked);
    if (o.locked) selectObjects(canvas.getActiveObjects().filter((x) => x !== o));
    markDirty(); queueLayers();
    return;
  }
  if (e.target.closest('.ly-handle') || e.target.closest('.ly-rename')) return;
  if (!canSelect(o)) {
    status(o.locked ? 'That item is locked — click its lock to unlock it first.' : 'That item is hidden — click its eye to show it first.');
    if (e.target.classList.contains('ly-check')) e.target.checked = false;
    return;
  }
  if (e.target.classList.contains('ly-check') || e.ctrlKey || e.metaKey) { toggleInSelection(o); return; }
  if (e.shiftKey && layerAnchor && canvas.contains(layerAnchor)) {
    const rows = layerObjects().reverse();
    const a = rows.indexOf(layerAnchor), b = rows.indexOf(o);
    selectObjects(rows.slice(Math.min(a, b), Math.max(a, b) + 1));
    return;
  }
  selectObjects([o]);
  layerAnchor = o;
});

// double-click a sticker row's name to rename the sticker (all its copies share the name)
$('#layerList').addEventListener('dblclick', (e) => {
  const nameEl = e.target.closest('.ly-name');
  const li = e.target.closest('.layer-row');
  if (nameEl && li && isGroup(li.layerObj) && !li.classList.contains('layer-child')) {
    const g = li.layerObj;
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'ly-rename'; input.value = g.groupName || 'Group'; input.maxLength = 60;
    nameEl.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const finish = (save) => {
      if (done) return; done = true;
      if (save && input.value.trim() && input.value.trim() !== (g.groupName || 'Group')) { g.groupName = input.value.trim().slice(0, 60); markDirty(); }
      queueLayers();
    };
    input.addEventListener('keydown', (k) => { if (k.key === 'Enter') finish(true); else if (k.key === 'Escape') { k.preventDefault(); finish(false); } });
    input.addEventListener('blur', () => finish(true));
    return;
  }
  if (!nameEl || !li || !isSticker(li.layerObj)) return;
  const item = library.find((i) => i.id === li.layerObj.stickerId);
  if (!item) return;
  const input = document.createElement('input');
  input.type = 'text'; input.className = 'ly-rename'; input.value = item.name; input.maxLength = 60;
  nameEl.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const finish = (save) => {
    if (done) return; done = true;
    if (save) renameSticker(item, input.value);
    queueLayers();
  };
  input.addEventListener('keydown', (k) => { if (k.key === 'Enter') finish(true); else if (k.key === 'Escape') { k.preventDefault(); finish(false); } });
  input.addEventListener('blur', () => finish(true));
});

function renameSticker(item, name) {
  const n = (name || '').trim().slice(0, 60);
  if (!n || n === item.name) return;
  item.name = n;
  renderLibrary(); // also records the change for undo / autosave
  queueLayers();
}

// drag the ⋮⋮ handle to reorder (pointer events, so it works with mouse, pen and touch)
let layerDrag = null;
$('#layerList').addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('.ly-handle');
  if (!handle) return;
  e.preventDefault();
  const li = handle.closest('.layer-row');
  layerDrag = { li, obj: li.layerObj, k: null };
  li.classList.add('dragging');
  try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
});
window.addEventListener('pointermove', (e) => {
  if (!layerDrag) return;
  const ul = $('#layerList');
  const rows = [...ul.children].filter((r) => r !== layerDrag.li);
  let k = rows.length;
  for (let i = 0; i < rows.length; i++) {
    const rc = rows[i].getBoundingClientRect();
    if (e.clientY < rc.top + rc.height / 2) { k = i; break; }
  }
  layerDrag.k = k;
  ul.querySelectorAll('.drop-before, .drop-after').forEach((r) => r.classList.remove('drop-before', 'drop-after'));
  if (k < rows.length) rows[k].classList.add('drop-before');
  else rows[rows.length - 1]?.classList.add('drop-after');
  const ur = ul.getBoundingClientRect(); // auto-scroll near the edges of a long list
  if (e.clientY < ur.top + 24) ul.scrollTop -= 10;
  else if (e.clientY > ur.bottom - 24) ul.scrollTop += 10;
});
const endLayerDrag = () => {
  if (!layerDrag) return;
  const { obj, k } = layerDrag;
  layerDrag.li.classList.remove('dragging');
  layerDrag = null;
  if (k === null) { queueLayers(); return; }
  const others = layerObjects().length - 1;
  const inSelection = canvas.getActiveObjects();
  canvas.moveTo(obj, others - k); // list row k (front first) → stacking index
  if (inSelection.length > 1) selectObjects(inSelection); // rebuild so the selection draws in the new order
  canvas.requestRenderAll(); markDirty(); queueLayers();
};
window.addEventListener('pointerup', endLayerDrag);
window.addEventListener('pointercancel', endLayerDrag);

/** Front / forward / back / bottom for whatever is selected (one item or several). */
function layerOp(fn) {
  const a = canvas.getActiveObject();
  if (!a) return;
  const objs = canvas.getActiveObjects();
  fn(a);
  if (objs.length > 1) selectObjects(objs);
  canvas.requestRenderAll(); markDirty(); queueLayers();
}
$('#lyFront').addEventListener('click', () => layerOp((a) => canvas.bringToFront(a)));
$('#lyForward').addEventListener('click', () => layerOp((a) => canvas.bringForward(a)));
$('#lyBackward').addEventListener('click', () => layerOp((a) => canvas.sendBackwards(a)));
$('#lyBack').addEventListener('click', () => layerOp((a) => canvas.sendToBack(a)));
$('#lySelectAll').addEventListener('click', () => selectObjects(layerObjects()));

function clearPrint() {
  const objs = canvas.getObjects();
  if (!objs.length) return;
  if (!confirm(`Remove all ${objs.length} item${objs.length === 1 ? '' : 's'} from the print? You can undo this.`)) return;
  canvas.discardActiveObject();
  objs.slice().forEach((o) => canvas.remove(o));
  canvas.requestRenderAll();
  updateCanvasStatus();
  status('Cleared the print. Undo (Ctrl+Z) brings everything back.');
}
$('#lyClear').addEventListener('click', clearPrint);

$('#selCopies').addEventListener('click', () => {
  const o = activeObjects()[0];
  if (!isSticker(o)) return;
  const copies = canvas.getObjects().filter((x) => x.stickerId === o.stickerId);
  selectObjects(copies);
  const skipped = copies.filter((x) => !canSelect(x)).length;
  status(`Selected ${copies.length - skipped} cop${copies.length - skipped === 1 ? 'y' : 'ies'}` + (skipped ? ` (${skipped} hidden or locked left out).` : '.'));
});
['selection:created', 'selection:updated', 'selection:cleared'].forEach((ev) => canvas.on(ev, () => {
  const objs = activeObjects();
  $('#selCopies').classList.toggle('hidden', !(objs.length === 1 && isSticker(objs[0])));
}));

// collapsible panel sections (remembered in this browser)
$$('h2.collapsible').forEach((h) => {
  const sec = h.closest('section');
  const key = 'collage.collapsed.' + sec.dataset.collapse;
  try { if (localStorage.getItem(key) === '1') sec.classList.add('collapsed'); } catch { /* ignore */ }
  h.addEventListener('click', () => {
    sec.classList.toggle('collapsed');
    try { localStorage.setItem(key, sec.classList.contains('collapsed') ? '1' : '0'); } catch { /* ignore */ }
  });
});

// ---------------------------------------------------------------- grid & rulers
// View preferences (remembered in this browser, not part of the project). The grid is drawn under the
// stickers on the page and is never exported; with snapping on, items also snap to its lines.
const GRID_STEPS = { cm: [0.5, 1, 2, 5], in: [0.25, 0.5, 1, 2], px: [25, 50, 100, 200, 500] };
const view = { rulers: true, grid: false, gridStep: { cm: 1, in: 0.5, px: 100 } };
try { Object.assign(view, JSON.parse(localStorage.getItem('collage.view') || '{}')); } catch { /* ignore */ }
const saveView = () => { try { localStorage.setItem('collage.view', JSON.stringify(view)); } catch { /* ignore */ } };
const unitKey = () => (print.mode === 'pixels' ? 'px' : print.unit);
const gridSpacingPx = () => (view.gridStep[unitKey()] || GRID_STEPS[unitKey()][1]) * pxPerUnit();

function refreshGridOptions() {
  const key = unitKey(), sel = $('#gridStep');
  sel.innerHTML = '';
  for (const v of GRID_STEPS[key]) sel.add(new Option(`${v} ${key}`, String(v)));
  if (!GRID_STEPS[key].includes(view.gridStep[key])) view.gridStep[key] = GRID_STEPS[key][key === 'px' ? 2 : 1];
  sel.value = String(view.gridStep[key]);
}
function applyViewPrefs() {
  $('#rulersToggle').checked = view.rulers;
  $('#gridToggle').checked = view.grid;
  $('#gridStep').disabled = !view.grid;
  $('#stage').classList.toggle('with-rulers', view.rulers);
  canvas.requestRenderAll();
  drawRulers();
}
$('#rulersToggle').addEventListener('change', (e) => { view.rulers = e.target.checked; saveView(); applyViewPrefs(); updateZoom(); });
$('#gridToggle').addEventListener('change', (e) => { view.grid = e.target.checked; saveView(); applyViewPrefs(); });
$('#gridStep').addEventListener('change', (e) => { view.gridStep[unitKey()] = Number(e.target.value); saveView(); canvas.requestRenderAll(); });

// the menu pops over everything (position: fixed, so a scrolling toolbar on phones can't clip it)
const viewMenu = $('#viewMenu');
viewMenu.addEventListener('toggle', () => {
  if (!viewMenu.open) return;
  const r = viewMenu.querySelector('summary').getBoundingClientRect(), pop = viewMenu.querySelector('.menu-pop');
  pop.style.top = `${r.bottom + 6}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 268))}px`;
});
document.addEventListener('pointerdown', (e) => { if (viewMenu.open && !viewMenu.contains(e.target)) viewMenu.open = false; });

/** Grid lines (canvas px) for snapping; empty when the grid is hidden. */
function gridLines() {
  if (!view.grid) return { xs: [], ys: [] };
  const sp = gridSpacingPx(), xs = [], ys = [];
  for (let i = 1; i * sp < print.W - 0.5; i++) xs.push(i * sp);
  for (let i = 1; i * sp < print.H - 0.5; i++) ys.push(i * sp);
  return { xs, ys };
}

/** Called from the page painter (beneath the stickers). */
function drawGrid(ctx) {
  if (!view.grid) return;
  const v = canvas.viewportTransform;
  const sp = gridSpacingPx() * v[0];
  if (sp < 4) return; // too dense to be useful at this zoom
  const x0 = v[4], y0 = v[5], pw = print.W * v[0], ph = print.H * v[3];
  const c = new fabric.Color(print.bg).getSource(); // [r,g,b,a]
  const dark = (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) < 128;
  ctx.save();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 1;
  ctx.strokeStyle = dark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.12)';
  ctx.beginPath();
  for (let i = 1; i * sp < pw - 0.5; i++) { const x = Math.round(x0 + i * sp) + 0.5; ctx.moveTo(x, y0); ctx.lineTo(x, y0 + ph); }
  for (let i = 1; i * sp < ph - 0.5; i++) { const y = Math.round(y0 + i * sp) + 0.5; ctx.moveTo(x0, y); ctx.lineTo(x0 + pw, y); }
  ctx.stroke();
  ctx.restore();
}

// rulers along the top and left of the work area, in cm / in / px, following zoom and pan
const RULER = 20;
const NICE_STEPS = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000, 20000];
function sizeRulerCanvas(el, w, h) {
  const dpr = window.devicePixelRatio || 1;
  if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
    el.width = Math.round(w * dpr); el.height = Math.round(h * dpr);
    el.style.width = w + 'px'; el.style.height = h + 'px';
  }
  const ctx = el.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}
function drawRulers() {
  $$('.ruler, .ruler-corner').forEach((el) => el.classList.toggle('hidden', !view.rulers));
  if (!view.rulers || !print.W) return;
  const st = $('#stage'), W = st.clientWidth, H = st.clientHeight;
  const cs = getComputedStyle(document.documentElement);
  const col = (n, d) => cs.getPropertyValue(n).trim() || d;
  const colors = { bg: col('--panel', '#fff'), page: col('--field', '#fff'), text: col('--muted', '#777'), line: col('--border', '#ddd'), accent: col('--accent', '#2f6fde') };
  const v = canvas.viewportTransform;
  const ppu = pxPerUnit() * v[0]; // screen px per unit
  const major = NICE_STEPS.find((s) => s * ppu >= 55) || NICE_STEPS[NICE_STEPS.length - 1];
  const div = major * ppu >= 110 ? 10 : 5;
  const minor = major / div;
  const sel = canvas.getActiveObject();
  let selX = null, selY = null;
  if (sel) { const r = sel.getBoundingRect(); selX = [r.left, r.left + r.width]; selY = [r.top, r.top + r.height]; }
  drawAxis(sizeRulerCanvas($('#rulerX'), W, RULER), W, v[4], print.W * v[0], ppu, major, minor, div, selX, colors, false);
  drawAxis(sizeRulerCanvas($('#rulerY'), RULER, H), H, v[5], print.H * v[3], ppu, major, minor, div, selY, colors, true);
  $('.ruler-corner').textContent = unitKey();
}
function drawAxis(ctx, len, origin, pageLen, ppu, major, minor, div, selRange, c, vertical) {
  const along = (a, b) => (vertical ? [0, a, RULER, b] : [a, 0, b, RULER]); // rect helper in ruler space
  ctx.clearRect(0, 0, vertical ? RULER : len, vertical ? len : RULER);
  ctx.fillStyle = c.bg; ctx.fillRect(...along(0, len));
  ctx.fillStyle = c.page; ctx.fillRect(...along(origin, pageLen)); // the page's extent
  if (selRange) { ctx.globalAlpha = 0.25; ctx.fillStyle = c.accent; ctx.fillRect(...along(selRange[0], selRange[1] - selRange[0])); ctx.globalAlpha = 1; }
  ctx.strokeStyle = c.line; ctx.lineWidth = 1;
  ctx.beginPath();
  if (vertical) { ctx.moveTo(RULER - 0.5, 0); ctx.lineTo(RULER - 0.5, len); } else { ctx.moveTo(0, RULER - 0.5); ctx.lineTo(len, RULER - 0.5); }
  ctx.stroke();
  const showMinor = minor * ppu >= 5;
  const first = Math.floor(-origin / ppu / minor) * minor, last = (len - origin) / ppu;
  ctx.strokeStyle = c.text; ctx.fillStyle = c.text;
  ctx.font = '10px system-ui, sans-serif';
  ctx.beginPath();
  for (let i = Math.round(first / minor); i * minor <= last; i++) {
    const u = i * minor, p = Math.round(origin + u * ppu) + 0.5;
    const isMajor = i % div === 0, isHalf = div === 10 && i % 5 === 0;
    if (!isMajor && !showMinor) continue;
    const tick = isMajor ? RULER * 0.6 : isHalf ? RULER * 0.4 : RULER * 0.25;
    if (vertical) { ctx.moveTo(RULER - tick, p); ctx.lineTo(RULER, p); } else { ctx.moveTo(p, RULER - tick); ctx.lineTo(p, RULER); }
    if (isMajor) {
      const label = String(+u.toFixed(2));
      if (vertical) { ctx.save(); ctx.translate(9, p + 2); ctx.rotate(-Math.PI / 2); ctx.fillText(label, 0, 0); ctx.restore(); }
      else ctx.fillText(label, p + 2, 9);
    }
  }
  ctx.stroke();
}
canvas.on('after:render', (opt) => { if (!opt?.ctx || opt.ctx === canvas.contextContainer) drawRulers(); });
window.addEventListener('resize', drawRulers);

// ---------------------------------------------------------------- print guides & framing
// Saved with the project, since they describe how this print will be made and framed:
//  • safe area — dashed line; keep faces and text inside it (trimming and mats hide a few mm)
//  • bleed     — extra background around the edges in the export, trimmed off after printing
//  • mat/frame — on-screen preview of the framed result (never exported); also gives the mat opening size
const DEFAULT_GUIDES = { safe: false, safeMm: 5, bleedMm: 0, mat: false, matMm: 50, overlapMm: 5, matColor: '#f4f0e6', frameColor: '#2b2622', frameMm: 20 };
print.guides = { ...DEFAULT_GUIDES };
const BLEED_OPTIONS = {
  cm: [[0, 'None'], [2, '2 mm'], [3, '3 mm (most common)'], [5, '5 mm']],
  in: [[0, 'None'], [1.5875, '1/16 in'], [3.175, '1/8 in (most common)'], [6.35, '1/4 in']],
};
const pxPerMm = () => (print.mode === 'pixels' ? 300 / 25.4 : print.dpi / 25.4); // pixel-size prints: assume 300 DPI
const bleedPx = () => (print.mode === 'pixels' ? 0 : Math.round(print.guides.bleedMm * pxPerMm()));
/** How far guides and the frame preview reach beyond the page (print px), so "Fit" shows all of it. */
function pageExtras() {
  const g = print.guides;
  return Math.max(bleedPx(), g.mat ? (g.matMm + g.frameMm - g.overlapMm) * pxPerMm() : 0);
}
/** A length in mm, shown in the print's units. */
function fmtLen(mm) {
  if (print.mode !== 'pixels' && print.unit === 'in') return `${+(mm / 25.4).toFixed(2)} in`;
  return mm < 10 ? `${+mm.toFixed(1)} mm` : `${+(mm / 10).toFixed(1)} cm`;
}
/** A width × height in mm, shown in the print's units. */
function fmtSize(wMm, hMm) {
  if (print.mode !== 'pixels' && print.unit === 'in') return `${+(wMm / 25.4).toFixed(2)} × ${+(hMm / 25.4).toFixed(2)} in`;
  return `${+(wMm / 10).toFixed(1)} × ${+(hMm / 10).toFixed(1)} cm`;
}
const trimMm = () => ({ w: (print.W / pxPerMm()), h: (print.H / pxPerMm()) });

function refreshBleedOptions() {
  const sel = $('#guideBleed'), opts = BLEED_OPTIONS[print.mode === 'pixels' ? 'cm' : print.unit] || BLEED_OPTIONS.cm;
  sel.innerHTML = '';
  for (const [mm, label] of opts) sel.add(new Option(label, String(mm)));
  const cur = print.guides.bleedMm;
  if (!opts.some(([mm]) => Math.abs(mm - cur) < 0.01)) sel.add(new Option(`${fmtLen(cur)} (custom)`, String(cur)));
  sel.value = String(opts.find(([mm]) => Math.abs(mm - cur) < 0.01)?.[0] ?? cur);
  sel.disabled = print.mode === 'pixels';
}
function syncGuidesUi() {
  const g = print.guides;
  $('#guideSafe').checked = g.safe; $('#viewSafe').checked = g.safe;
  $('#guideSafeMm').value = g.safeMm; $('#guideSafeVal').textContent = fmtLen(g.safeMm);
  $('#guideSafeRow').classList.toggle('hidden', !g.safe);
  $('#matOn').checked = g.mat; $('#viewMat').checked = g.mat;
  $('#matOpts').classList.toggle('hidden', !g.mat);
  $('#matMm').value = g.matMm; $('#matMmVal').textContent = g.matMm ? fmtLen(g.matMm) : 'none';
  $('#matOverlapMm').value = g.overlapMm; $('#matOverlapVal').textContent = fmtLen(g.overlapMm);
  $('#matColor').value = g.matColor; $('#frameColor').value = g.frameColor;
  $('#frameMm').value = g.frameMm; $('#frameMmVal').textContent = g.frameMm ? fmtLen(g.frameMm) : 'none';
  $('#guideBleedHint').classList.toggle('hidden', print.mode === 'pixels' && !g.bleedMm);
  refreshBleedOptions();
  if (print.mode === 'pixels') { $('#matInfo').textContent = ''; return; }
  const t = trimMm(), win = { w: t.w - 2 * g.overlapMm, h: t.h - 2 * g.overlapMm };
  const outer = { w: win.w + 2 * g.matMm, h: win.h + 2 * g.matMm };
  $('#matInfo').innerHTML = g.matMm
    ? `Mat opening: <b>${fmtSize(win.w, win.h)}</b> · mat outer / frame inner size: <b>${fmtSize(outer.w, outer.h)}</b>`
    : `Frame inner size: <b>${fmtSize(t.w, t.h)}</b>`;
}
function setGuide(key, value, kind) {
  const before = print.guides;
  print.guides = { ...print.guides, [key]: value };
  syncGuidesUi();
  // the frame preview and bleed change how much room the page needs on screen
  if ((key === 'mat' || key === 'bleedMm' || before.mat) && zoomMode === 'fit') updateZoom();
  canvas.requestRenderAll();
  markDirty(kind);
}
const bindGuide = (sel, key, read, continuous) => {
  const el = $(sel);
  el.addEventListener(continuous ? 'input' : 'change', () => setGuide(key, read(el), continuous ? 'continuous' : undefined));
  if (continuous) el.addEventListener('change', () => markDirty());
};
bindGuide('#guideSafe', 'safe', (el) => el.checked);
bindGuide('#viewSafe', 'safe', (el) => el.checked);
bindGuide('#guideSafeMm', 'safeMm', (el) => +el.value, true);
bindGuide('#guideBleed', 'bleedMm', (el) => +el.value);
bindGuide('#matOn', 'mat', (el) => el.checked);
bindGuide('#viewMat', 'mat', (el) => el.checked);
bindGuide('#matMm', 'matMm', (el) => +el.value, true);
bindGuide('#matOverlapMm', 'overlapMm', (el) => +el.value, true);
bindGuide('#matColor', 'matColor', (el) => el.value, true);
bindGuide('#frameColor', 'frameColor', (el) => el.value, true);
bindGuide('#frameMm', 'frameMm', (el) => +el.value, true);
$$('.mat-preset').forEach((b) => b.addEventListener('click', () => {
  print.guides = { ...print.guides, matColor: b.dataset.mat || print.guides.matColor, matMm: b.dataset.mat ? (print.guides.matMm || 50) : 0 };
  setGuide('mat', true);
}));

/** Mat with its window, a bevelled cut edge, and the frame around it — drawn over the print. */
function drawFramePreview(ctx, k, z) {
  const g = print.guides, W = print.W, H = print.H;
  const ov = g.overlapMm * k, m = g.matMm * k, f = g.frameMm * k;
  const win = [ov, ov, W - 2 * ov, H - 2 * ov];
  const mo = [ov - m, ov - m, W - 2 * ov + 2 * m, H - 2 * ov + 2 * m];
  const fo = [mo[0] - f, mo[1] - f, mo[2] + 2 * f, mo[3] + 2 * f];
  const ring = (outer, inner) => { ctx.beginPath(); ctx.rect(...outer); ctx.rect(...inner); };
  // frame, casting a soft shadow on the wall
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 24; ctx.shadowOffsetY = 6;
  ctx.fillStyle = g.frameColor;
  ring(fo, mo); ctx.fill('evenodd');
  ctx.restore();
  if (f) { // a lighter inner lip on the frame for depth
    ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = Math.max(1 / z, f * 0.08);
    ctx.strokeRect(mo[0] - ctx.lineWidth / 2, mo[1] - ctx.lineWidth / 2, mo[2] + ctx.lineWidth, mo[3] + ctx.lineWidth);
  }
  if (m) {
    ctx.fillStyle = g.matColor;
    ring(mo, win); ctx.fill('evenodd');
    // bevelled window edge: the white core of the mat board
    const bev = Math.max(1 / z, 1.5 * k);
    ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = bev;
    ctx.strokeRect(win[0] - bev / 2, win[1] - bev / 2, win[2] + bev, win[3] + bev);
  }
  // the mat/frame edge throws a slight shadow onto the print (light from the top left)
  const s = 4 * k;
  let gr = ctx.createLinearGradient(0, win[1], 0, win[1] + s);
  gr.addColorStop(0, 'rgba(0,0,0,.22)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gr; ctx.fillRect(win[0], win[1], win[2], s);
  gr = ctx.createLinearGradient(win[0], 0, win[0] + s, 0);
  gr.addColorStop(0, 'rgba(0,0,0,.18)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gr; ctx.fillRect(win[0], win[1], s, win[3]);
}

canvas.on('after:render', (opt) => {
  const ctx = canvas.contextContainer;
  if ((opt && opt.ctx && opt.ctx !== ctx) || !print.W) return; // never part of an export
  const g = print.guides, v = canvas.viewportTransform, z = v[0], k = pxPerMm();
  ctx.save();
  ctx.transform(v[0], v[1], v[2], v[3], v[4], v[5]);
  if (g.mat) drawFramePreview(ctx, k, z);
  ctx.lineWidth = 1.25 / z;
  if (bleedPx() > 0 && !g.mat) { // trim line: where the print will be cut
    ctx.setLineDash([8 / z, 5 / z]); ctx.strokeStyle = 'rgba(220,40,60,.9)';
    ctx.strokeRect(0, 0, print.W, print.H);
  }
  if (g.safe) {
    const sm = g.safeMm * k;
    ctx.setLineDash([3 / z, 4 / z]); ctx.strokeStyle = 'rgba(0,150,210,.95)';
    ctx.strokeRect(sm, sm, print.W - 2 * sm, print.H - 2 * sm);
  }
  ctx.restore();
});

// ---------------------------------------------------------------- random layout settings
/** Show only the controls that matter for the chosen style. */
function syncLayoutUi() {
  const style = $('#genStyle').value;
  const auto = AUTO_SIZE_STYLES.has(style);
  $('#shapeOpts').classList.toggle('hidden', style !== 'shape');
  $('#shapeTextRow').classList.toggle('hidden', !(style === 'shape' && $('#genShape').value === 'text'));
  $('#outwardRow').classList.toggle('hidden', style !== 'circle');
  $('#overlapRow').classList.toggle('hidden', !OVERLAP_STYLES.has(style));
  $('#genSize').disabled = auto;
  $('#sizeRow').classList.toggle('disabled', auto);
  $('#autoSizeNote').classList.toggle('hidden', !auto);
  $('#overlapVal').textContent = `${$('#genOverlap').value}%`;
  const m = (Number($('#genMargin').value) / 100) * Math.min(print.W || 1, print.H || 1) / pxPerUnit();
  $('#marginVal').textContent = Number($('#genMargin').value) === 0 ? 'none' : `${+m.toFixed(print.mode === 'pixels' ? 0 : 1)} ${unitName()}`;
}
['#genStyle', '#genShape', '#genShapeText', '#genOverlap', '#genMargin', '#genBleed', '#genOutward'].forEach((sel) => {
  $(sel).addEventListener('input', () => { syncLayoutUi(); markDirty('continuous'); }); // saved with the project, not an undo step
  $(sel).addEventListener('change', syncLayoutUi);
});
function layoutSettingsForSave() {
  return {
    size: +$('#genSize').value, variation: +$('#genVar').value, rotation: +$('#genRot').value, keepText: $('#genKeepText').checked,
    style: $('#genStyle').value, shape: $('#genShape').value, shapeText: $('#genShapeText').value,
    overlap: +$('#genOverlap').value, margin: +$('#genMargin').value, bleed: $('#genBleed').checked, outward: $('#genOutward').checked,
  };
}
function applyLayoutSettings(l) {
  if (!l) return;
  const set = (sel, v) => { if (v !== undefined) $(sel).value = v; };
  const check = (sel, v) => { if (v !== undefined) $(sel).checked = v; };
  set('#genSize', l.size); set('#genVar', l.variation); set('#genRot', l.rotation); check('#genKeepText', l.keepText);
  set('#genStyle', l.style); set('#genShape', l.shape); set('#genShapeText', l.shapeText);
  set('#genOverlap', l.overlap); set('#genMargin', l.margin); check('#genBleed', l.bleed); check('#genOutward', l.outward);
  syncSliderLabels();
  syncLayoutUi();
}

// ---------------------------------------------------------------- sticker library
/** @type {Array<{id,name,steps:{url,w,h}[],outline:{on,w,c},finalUrl,finalImg,use,count}>} */
const library = [];

async function addToLibrary({ url, w, h }, name, tags = [], source = null) {
  const item = {
    id: newId(), name: name || 'Image', steps: [{ url, w, h, ox: 0, oy: 0 }], outline: { on: false, w: 4, c: '#ffffff' }, ...lookCopies({}),
    finalUrl: url, finalImg: await loadImage(url), use: true, count: 1, size: 1, tags: [], source: source ? { ...source } : null,
  };
  if (tags.length) addTags(item, tags.join(','));
  library.push(item);
  renderLibrary();
  return item;
}

// Library view: search (name or #tag), sort, tags. Filtering and sorting only change what's shown —
// the library's own order stays as added. "All", "None" and the copies bar act on the stickers shown.
const libView = { query: '', sort: 'added' };
const fold = (s) => (s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const MAX_TAGS = 12, MAX_TAG_LEN = 24;
const SIZE_WEIGHTS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const weightLabel = (w) => ({ 0.5: '½×', 0.75: '¾×', 1.25: '1¼×', 1.5: '1½×' }[w] || `${w}×`);

function libraryMatches(item, q) {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const name = fold(item.name), tags = (item.tags || []).map(fold);
  return words.every((w) => (w.startsWith('#')
    ? tags.some((t) => t.startsWith(w.slice(1)))
    : name.includes(w) || tags.some((t) => t.includes(w))));
}
const filterActive = () => !!libView.query.trim();
const shownLibrary = () => library.filter((i) => libraryMatches(i, libView.query));

function onPrintCounts() {
  const n = {};
  for (const o of allLeafObjects()) if (o.stickerId) n[o.stickerId] = (n[o.stickerId] || 0) + 1;
  return n;
}
function sortForView(list, onPrint) {
  const arr = list.slice(); // Array.sort is stable, so ties keep the order they were added
  if (libView.sort === 'name') arr.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  else if (libView.sort === 'copies') arr.sort((a, b) => b.count - a.count);
  else if (libView.sort === 'print') arr.sort((a, b) => (onPrint[b.id] || 0) - (onPrint[a.id] || 0));
  else if (libView.sort === 'ticked') arr.sort((a, b) => (b.use ? 1 : 0) - (a.use ? 1 : 0));
  return arr;
}

function cleanTag(t) { return t.replace(/^#+/, '').trim().replace(/\s+/g, '-').slice(0, MAX_TAG_LEN); } // "red rose" → "red-rose"
function addTags(item, text) {
  const tags = item.tags || (item.tags = []);
  let added = 0;
  for (const raw of text.split(',')) {
    const t = cleanTag(raw);
    if (t && tags.length < MAX_TAGS && !tags.some((x) => fold(x) === fold(t))) { tags.push(t); added++; }
  }
  return added;
}

/** Record a library change (undo + autosave) and redraw. */
function renderLibrary() {
  markDirty();
  renderLibraryView();
}

let libViewQueued = false;
/** Redraw the library list soon (e.g. "on print" counts after the print changed) — without
 *  interrupting someone typing a name or tag in it. */
function queueLibraryView() {
  if (libViewQueued) return;
  libViewQueued = true;
  Promise.resolve().then(() => {
    libViewQueued = false;
    if (!document.activeElement?.closest?.('#library')) renderLibraryView();
  });
}
canvas.on('object:added', queueLibraryView);
canvas.on('object:removed', queueLibraryView);

function renderLibraryView() {
  const ul = $('#library');
  const onPrint = onPrintCounts();
  const shown = sortForView(shownLibrary(), onPrint);
  const filtering = filterActive();
  ul.innerHTML = '';

  const total = library.filter((i) => i.use).reduce((n, i) => n + i.count, 0);
  $('#libCount').textContent = `${library.length} sticker${library.length === 1 ? '' : 's'} · ${total} to place`
    + (filtering ? ` · ${shown.length} shown` : '');
  $('#libTools').classList.toggle('hidden', library.length < 2 && !filtering);
  $('#libraryEmpty').classList.toggle('hidden', shown.length > 0);
  $('#libraryEmpty').textContent = library.length ? 'No stickers match your search.' : 'No stickers yet — upload, paste or search for images.';

  const tickedShown = shown.filter((i) => i.use).length;
  $('#bulkCopies').classList.toggle('hidden', shown.length < 2);
  $('#bulkLabel').textContent = `Copies for ${tickedShown} ticked${filtering ? ' (shown)' : ''}:`;
  ['#bulkMinus', '#bulkSet', '#bulkPlus', '#bulkSize', '#bulkRemove'].forEach((sel) => { $(sel).disabled = tickedShown === 0; });
  $('#bulkRemove').textContent = tickedShown ? `✕ Remove ${tickedShown} ticked` : '✕ Remove ticked';

  renderTagBar();

  for (const item of shown) {
    const li = document.createElement('li');
    li.className = 'lib-item' + (item.use ? '' : ' off') + (item.id === flashId ? ' flash' : '');
    const n = onPrint[item.id] || 0;
    li.innerHTML = `
      <input type="checkbox" ${item.use ? 'checked' : ''} title="Use in random collage" />
      <img class="lib-thumb checker" src="${item.finalUrl}" alt="" title="Click to edit" />
      <div class="lib-controls">
        <input class="lib-name" type="text" maxlength="60" aria-label="Sticker name" />
        ${item.source ? '<button class="lic-chip" title="Where this image is from and what its licence allows"></button>' : ''}
        <div class="lib-count-row">
          <label class="lib-count">Copies <input type="number" min="0" max="50" value="${item.count}" /></label>
          <label class="lib-count" title="Relative size in random layouts">Size <select class="lib-size">${SIZE_WEIGHTS.map((w) => `<option value="${w}" ${w === (item.size || 1) ? 'selected' : ''}>${weightLabel(w)}</option>`).join('')}</select></label>
          ${n ? `<span class="lib-onprint" title="Copies currently on the print">${n} on print</span>` : ''}
        </div>
        <div class="lib-tags"></div>
        <div class="row gap-sm wrap">
          <button data-act="edit">Edit</button>
          <button data-act="place" title="Add one copy to the print">Place</button>
          <button data-act="dup" title="Make a separate copy of this sticker — e.g. to crop a different part of the same image">Duplicate</button>
          <button data-act="remove" class="danger" title="Remove sticker">✕</button>
        </div>
      </div>`;
    const nameInput = li.querySelector('.lib-name');
    nameInput.value = item.name;
    nameInput.title = item.name + ' — click to rename';
    nameInput.addEventListener('change', () => { if (!nameInput.value.trim()) nameInput.value = item.name; renameSticker(item, nameInput.value); });
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); else if (e.key === 'Escape') { nameInput.value = item.name; nameInput.blur(); } });
    li.querySelector('input[type=checkbox]').addEventListener('change', (e) => { item.use = e.target.checked; renderLibrary(); });
    li.querySelector('.lib-count input').addEventListener('change', (e) => {
      item.count = Math.max(0, Math.min(50, Math.round(+e.target.value || 0))); renderLibrary();
    });
    li.querySelector('.lib-size').addEventListener('change', (e) => { item.size = Number(e.target.value); renderLibrary(); });
    renderItemTags(li.querySelector('.lib-tags'), item);
    const chip = li.querySelector('.lic-chip');
    if (chip) {
      const f = licenceFlags(item.source);
      chip.textContent = (f.nd ? '⚠ ' : f.unknown ? '? ' : '© ') + licenceShort(item.source);
      chip.classList.toggle('bad', f.nd);
      chip.classList.toggle('warn', !f.nd && (f.unknown || f.nc));
      chip.addEventListener('click', () => showLicence(item));
    }
    li.querySelector('.lib-thumb').addEventListener('click', () => openEditor(item));
    li.querySelector('[data-act=edit]').addEventListener('click', () => openEditor(item));
    li.querySelector('[data-act=place]').addEventListener('click', () => placeSingle(item));
    li.querySelector('[data-act=remove]').addEventListener('click', () => removeFromLibrary(item));
    li.querySelector('[data-act=dup]').addEventListener('click', () => duplicateSticker(item));
    ul.appendChild(li);
    if (item.id === flashId) { li.scrollIntoView({ block: 'nearest' }); flashId = null; }
  }
}

function renderItemTags(box, item) {
  box.innerHTML = '';
  for (const t of item.tags || []) {
    const chip = document.createElement('span');
    chip.className = 'tag';
    chip.innerHTML = '<button class="tag-name"></button><button class="tag-x" aria-label="Remove tag">×</button>';
    chip.querySelector('.tag-name').textContent = '#' + t;
    chip.querySelector('.tag-name').title = `Show only stickers tagged “${t}”`;
    chip.querySelector('.tag-name').addEventListener('click', () => setLibraryQuery('#' + t));
    chip.querySelector('.tag-x').title = `Remove tag “${t}”`;
    chip.querySelector('.tag-x').addEventListener('click', () => { item.tags = item.tags.filter((x) => x !== t); renderLibrary(); });
    box.appendChild(chip);
  }
  if ((item.tags || []).length >= MAX_TAGS) return;
  const add = document.createElement('button');
  add.className = 'tag-add';
  add.textContent = '+ tag';
  add.title = 'Add tags (separate several with commas)';
  add.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'tag-input'; input.placeholder = 'e.g. flowers, red';
    add.replaceWith(input);
    input.focus();
    let done = false;
    const finish = (save) => {
      if (done) return; done = true;
      if (save && input.value.trim() && addTags(item, input.value)) renderLibrary();
      else renderLibraryView();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') { e.preventDefault(); finish(false); } });
    input.addEventListener('blur', () => finish(true));
  });
  box.appendChild(add);
}

function renderTagBar() {
  const bar = $('#tagBar');
  const counts = new Map(); // folded → { label, n }
  for (const i of library) for (const t of i.tags || []) {
    const k = fold(t);
    if (!counts.has(k)) counts.set(k, { label: t, n: 0 });
    counts.get(k).n++;
  }
  bar.classList.toggle('hidden', counts.size === 0);
  bar.innerHTML = '';
  const active = new Set(fold(libView.query).split(/\s+/).filter((w) => w.startsWith('#')).map((w) => w.slice(1)));
  [...counts.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label)).forEach(([k, { label, n }]) => {
    const b = document.createElement('button');
    b.className = 'tag-filter' + (active.has(k) ? ' on' : '');
    b.textContent = `#${label} ${n}`;
    b.title = active.has(k) ? `Stop filtering by “${label}”` : `Show only stickers tagged “${label}”`;
    b.addEventListener('click', () => toggleTagFilter(label));
    bar.appendChild(b);
  });
}
function toggleTagFilter(label) {
  const words = libView.query.split(/\s+/).filter(Boolean);
  const k = '#' + fold(label);
  const has = words.some((w) => fold(w) === k);
  setLibraryQuery((has ? words.filter((w) => fold(w) !== k) : [...words, '#' + label]).join(' '));
}
function setLibraryQuery(q) {
  libView.query = q;
  $('#libSearch').value = q;
  renderLibraryView();
}
$('#libSearch').addEventListener('input', (e) => { libView.query = e.target.value; renderLibraryView(); });
$('#libSort').addEventListener('change', (e) => { libView.sort = e.target.value; renderLibraryView(); });

let flashId = null; // briefly highlight a newly made duplicate

/** A separate sticker with the same image and full edit history (images are shared, not copied). */
function duplicateSticker(item) {
  const copy = {
    ...item, id: newId(), name: item.name + ' (copy)',
    steps: item.steps.map((st) => ({ ...st })), outline: { ...item.outline }, ...lookCopies(item), tags: [...(item.tags || [])],
    source: item.source ? { ...item.source } : null,
  };
  library.splice(library.indexOf(item) + 1, 0, copy);
  flashId = copy.id;
  renderLibrary();
  status('Duplicated. Edit the copy — "Reset to original" in the editor goes back to the full source image.');
}

function bulkCopies(fn) {
  shownLibrary().filter((i) => i.use).forEach((i) => { i.count = Math.max(0, Math.min(50, Math.round(fn(i.count)))); });
  renderLibrary();
}
$('#bulkSet').addEventListener('click', () => { const n = +$('#bulkCount').value || 0; bulkCopies(() => n); });
$('#bulkPlus').addEventListener('click', () => bulkCopies((c) => c + 1));
$('#bulkMinus').addEventListener('click', () => bulkCopies((c) => c - 1));
$('#bulkCount').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#bulkSet').click(); });
$('#bulkSize').addEventListener('change', (e) => {
  const w = Number(e.target.value);
  e.target.value = '';
  if (!w) return;
  shownLibrary().filter((i) => i.use).forEach((i) => { i.size = w; });
  renderLibrary();
});

function removeFromLibrary(item) {
  const onCanvas = allLeafObjects().filter((o) => o.stickerId === item.id);
  if (onCanvas.length && !confirm(`Remove this sticker? Its ${onCanvas.length} cop${onCanvas.length === 1 ? 'y' : 'ies'} on the print will be removed too.`)) return;
  removeStickers([item]);
}

/** Remove stickers from the list along with all their copies on the print. One undo step. */
function removeStickers(items) {
  canvas.discardActiveObject();
  for (const item of items) removeCopiesOf(item);
  renderLibrary(); canvas.requestRenderAll(); updateCanvasStatus();
}
function removeCopiesOf(item) {
  const onCanvas = allLeafObjects().filter((o) => o.stickerId === item.id);
  onCanvas.forEach((o) => {
    const g = o.group;
    if (!g) { canvas.remove(o); return; }
    g.removeWithUpdate(o); // copies inside a group leave the group; an emptied group goes too
    if (!g.getObjects().length) canvas.remove(g);
    else if (g.getObjects().length === 1) { // a group of one is no group: free the last item in its place
      const only = g.getObjects()[0], at = canvas.getObjects().indexOf(g);
      g.removeWithUpdate(only);
      canvas.remove(g);
      canvas.insertAt(only, at);
    }
  });
  library.splice(library.indexOf(item), 1);
}

$('#bulkRemove').addEventListener('click', () => {
  const items = shownLibrary().filter((i) => i.use); // only ticked stickers that are visible in the list
  if (!items.length) return;
  const ids = new Set(items.map((i) => i.id));
  const copies = allLeafObjects().filter((o) => ids.has(o.stickerId)).length;
  const what = `${items.length} ticked sticker${items.length === 1 ? '' : 's'}`;
  if (!confirm(`Remove ${what}?` + (copies ? ` Their ${copies} cop${copies === 1 ? 'y' : 'ies'} on the print will be removed too.` : '') + ' You can undo this.')) return;
  removeStickers(items);
  status(`Removed ${what}. Undo (Ctrl+Z) brings them back.`);
});

$('#btnSelectAll').addEventListener('click', () => { shownLibrary().forEach((i) => (i.use = true)); renderLibrary(); });
$('#btnSelectNone').addEventListener('click', () => { shownLibrary().forEach((i) => (i.use = false)); renderLibrary(); });
$('#btnGenerate').addEventListener('click', generateCollage);

async function addFiles(files, source = null) {
  const images = [...files].filter((f) => f.type.startsWith('image/'));
  if (!images.length) return;
  holdHistory(); // one upload = one undo step, however many files
  try { await addFilesNow(images, source); } finally { releaseHistory(); }
}
async function addFilesNow(images, source) {
  let added = 0;
  for (const f of images) {
    status(`Adding ${f.name}…`, true);
    try {
      const src = URL.createObjectURL(f);
      const norm = await normalizeSource(src, f);
      if (norm.url !== src) URL.revokeObjectURL(src);
      await addToLibrary(norm, f.name.replace(/\.[^.]+$/, ''), [], source);
      added++;
    } catch (e) { console.error(e); status(`Could not read ${f.name}.`); }
  }
  status(`Added ${added} image${added === 1 ? '' : 's'}. Click a thumbnail to crop, cut out or outline it.`);
}
$('#fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });

// Paste: an image (screenshot, "Copy image" in a browser) or a link to an image becomes a sticker.
let pasteCount = 0;
const pastedName = (f) => (f.name && !/^image\.\w+$/i.test(f.name) ? f.name : `Pasted image ${++pasteCount}.png`);
async function addImageFromUrl(url) {
  status('Downloading the image from the link…', true);
  try {
    const r = await fetch('/api/proxy?url=' + encodeURIComponent(url));
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    const blob = await r.blob();
    let name = 'Pasted image';
    try { name = decodeURIComponent(new URL(url).pathname.split('/').pop()).replace(/\.[^.]+$/, '') || name; } catch { /* keep default */ }
    await addFiles([new File([blob], name + '.img', { type: blob.type })], { provider: 'link', title: name, pageUrl: url, source: new URL(url).hostname, license: 'Unknown — check the source' });
  } catch (err) {
    status('Could not add that link as an image: ' + err.message);
  }
}
document.addEventListener('paste', (e) => {
  if (document.querySelector('dialog[open]')) return;
  const t = e.target;
  if (/^(input|textarea)$/i.test(t.tagName || '') || t.isContentEditable) return; // normal text paste
  const files = [...(e.clipboardData?.items || [])]
    .filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
  if (files.length) {
    e.preventDefault();
    addFiles(files.map((f) => new File([f], pastedName(f), { type: f.type })));
    return;
  }
  const text = e.clipboardData?.getData('text/plain')?.trim();
  if (text && /^https?:\/\/\S+$/i.test(text)) { e.preventDefault(); addImageFromUrl(text); }
});
$('#btnPaste').addEventListener('click', async () => {
  try {
    const items = await navigator.clipboard.read();
    const files = [];
    for (const it of items) {
      const type = it.types.find((ty) => ty.startsWith('image/'));
      if (type) files.push(new File([await it.getType(type)], `Pasted image ${++pasteCount}.png`, { type }));
    }
    if (files.length) { addFiles(files); return; }
    const text = (await navigator.clipboard.readText?.())?.trim();
    if (text && /^https?:\/\//i.test(text)) { addImageFromUrl(text); return; }
    status('There is no image on the clipboard. Copy an image (or a link to one) first.');
  } catch {
    status('The browser didn’t allow reading the clipboard. Press Ctrl+V (⌘V on Mac) instead.');
  }
});
if (!navigator.clipboard?.read) $('#btnPaste').classList.add('hidden'); // e.g. when not on https/localhost

// drag & drop
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; $('#dropOverlay').classList.remove('hidden'); } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').classList.add('hidden'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('#dropOverlay').classList.add('hidden');
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});

// ---------------------------------------------------------------- sticker editor
// The sticker is shown in a zoomable, pannable view in every mode (only the rectangular Crop tool
// swaps it for Cropper.js, which has its own zoom). Modes:
//   view  – drag to pan, inspect details
//   pick  – click a colour to remove it (stays on so you can clean up several small areas)
//   erase – rubber brush
//   lasso – draw to crop: click to add corners, or press and drag to draw freehand
// View mapping: screen = image * z + (ox, oy). 1 image px = full-resolution sticker pixel.
let ed = null; // { item, steps, outline, cropper, busy, mode, baseImg }
const edDialog = $('#editorDialog');
const edCanvas = $('#edCanvas');
const ED_ZOOM_MAX = 32;
const ev = {
  z: 1, ox: 0, oy: 0, fit: true, cssW: 1, cssH: 1, imgW: 1, imgH: 1,
  src: null,                      // what is drawn: { canvas, x, y, w, h } in image coordinates
  pointers: new Map(), gesture: null, panDrag: null, space: false, hover: null,
};
let tool = null;                  // rubber / draw-to-crop session

function edCurrent() { return ed.steps[ed.steps.length - 1]; }

async function openEditor(item) {
  ed = { item, steps: item.steps.slice(), outline: { ...item.outline }, ...lookCopies(item), cropper: null, busy: false, mode: 'view', baseImg: null };
  $('#edOutline').checked = ed.outline.on;
  $('#edOutlineW').value = ed.outline.w;
  $('#edOutlineC').value = ed.outline.c;
  writeLookControls();
  endCrop();
  setPicking(false);
  edDialog.showModal();
  ev.fit = true; ev.imgW = ev.imgH = 0; ev.src = null;
  sizeEdCanvas();
  await refreshPreview();
}

// ---- what the view shows
let previewToken = 0, srcToken = 0, fullResTimer = 0;
async function refreshPreview() {
  if (!ed) return;
  const token = ++previewToken;
  const img = await loadImage(edCurrent().url);
  if (token !== previewToken || !ed) return;
  ed.baseImg = img;
  ev.imgW = img.naturalWidth; ev.imgH = img.naturalHeight;
  if (ev.fit) edFit(); else edClampView();
  updateDisplaySource(true);
  $('#edUndo').disabled = ed.steps.length <= 1;
}

/** The working copy while a hand tool is active; the plain image while picking colours;
 *  otherwise the finished look with outline (quick preview first, then full resolution). */
function updateDisplaySource(quickFirst) {
  clearTimeout(fullResTimer);
  const token = ++srcToken;
  if (!ed?.baseImg) return;
  if (tool) { ev.src = { canvas: tool.work, x: 0, y: 0, w: ev.imgW, h: ev.imgH }; drawEd(); return; }
  const look = ed.mode === 'pick' ? {} : lookOf(ed); // colour picking needs the plain pixels
  if (!lookNeedsRender(look)) { ev.src = { canvas: ed.baseImg, x: 0, y: 0, w: ev.imgW, h: ev.imgH }; drawEd(); return; }
  const make = (maxSide) => {
    const c = renderSticker(ed.baseImg, look, maxSide);
    const s = maxSide ? Math.min(1, maxSide / Math.max(ev.imgW, ev.imgH)) : 1;
    const pad = (c.width - Math.round(ev.imgW * s)) / 2; // outline margin, in rendered pixels
    return { canvas: c, x: -pad / s, y: -pad / s, w: c.width / s, h: c.height / s };
  };
  const big = Math.max(ev.imgW, ev.imgH) > PREVIEW_SIDE;
  ev.src = make(quickFirst && big ? PREVIEW_SIDE : 0);
  drawEd();
  if (quickFirst && big) {
    fullResTimer = setTimeout(() => {
      if (ed && token === srcToken && !tool) { ev.src = make(0); drawEd(); }
    }, 400);
  }
}

function setBusy(on, text = 'Working…') {
  if (ed) ed.busy = on;
  $('#edBusy').classList.toggle('hidden', !on);
  $('#edBusyText').textContent = text;
  $$('#editorDialog button').forEach((b) => { if (!b.hasAttribute('data-close')) b.disabled = on || b.dataset.lock === '1'; });
  if (!on) { syncCropButtons(); syncToolUi(); if (ed) $('#edUndo').disabled = ed.steps.length <= 1; }
}

/** Add an edit step. When transparent edges are trimmed, the view is shifted so the image doesn't jump. */
/** Where step i sits inside the original image (step 0), or null if unknown (older projects). */
function stepOrigin(i) {
  if (i === 0) return { ox: 0, oy: 0 };
  const st = ed.steps[i];
  return st.ox === undefined ? null : { ox: st.ox, oy: st.oy };
}
async function pushStep(c, trim = false, shift = null) {
  const out = trim ? trimTransparent(c) : c;
  if (out.trimOffset && !ev.fit) { ev.ox += out.trimOffset.x * ev.z; ev.oy += out.trimOffset.y * ev.z; }
  const prev = stepOrigin(ed.steps.length - 1);
  const origin = prev && {
    ox: prev.ox + (shift?.x || 0) + (out.trimOffset?.x || 0),
    oy: prev.oy + (shift?.y || 0) + (out.trimOffset?.y || 0),
  };
  ed.steps.push({ url: await canvasToUrl(out), w: out.width, h: out.height, ...(origin || {}) });
  await refreshPreview();
}

// ---- view: size, zoom, pan
function sizeEdCanvas() {
  const host = $('.editor-preview');
  ev.cssW = Math.max(1, host.clientWidth);
  ev.cssH = Math.max(1, host.clientHeight);
  const dpr = window.devicePixelRatio || 1;
  edCanvas.style.width = ev.cssW + 'px';
  edCanvas.style.height = ev.cssH + 'px';
  edCanvas.width = Math.round(ev.cssW * dpr);
  edCanvas.height = Math.round(ev.cssH * dpr);
  if (ev.imgW) { if (ev.fit) edFit(); else edClampView(); }
  drawEd();
}
window.addEventListener('resize', () => { if (ed) sizeEdCanvas(); });

const edFitZoom = () => Math.max(0.001, Math.min((ev.cssW - 24) / ev.imgW, (ev.cssH - 24) / ev.imgH));
function edFit() {
  const z = edFitZoom();
  Object.assign(ev, { z, ox: (ev.cssW - ev.imgW * z) / 2, oy: (ev.cssH - ev.imgH * z) / 2, fit: true });
  updateEdZoomUi();
}
function edClampView() {
  const m = 40, iw = ev.imgW * ev.z, ih = ev.imgH * ev.z;
  ev.ox = Math.min(ev.cssW - m, Math.max(m - iw, ev.ox));
  ev.oy = Math.min(ev.cssH - m, Math.max(m - ih, ev.oy));
}
/** Zoom to z keeping screen point (sx, sy) over the same image point. */
function edZoomTo(z, sx = ev.cssW / 2, sy = ev.cssH / 2) {
  if (!ed) return;
  z = Math.min(ED_ZOOM_MAX, Math.max(edFitZoom() * 0.5, z));
  const ix = (sx - ev.ox) / ev.z, iy = (sy - ev.oy) / ev.z;
  Object.assign(ev, { z, ox: sx - ix * z, oy: sy - iy * z, fit: false });
  edClampView(); updateEdZoomUi(); drawEd();
}
function edPan(dx, dy) {
  ev.ox += dx; ev.oy += dy; ev.fit = false;
  edClampView(); updateEdZoomUi(); drawEd();
}
function updateEdZoomUi() {
  const z = ev.z;
  $('#edZoomLabel').textContent = `${z < 0.1 ? (z * 100).toFixed(1) : Math.round(z * 100)}%`;
  $('#edZoomFit').classList.toggle('on', ev.fit);
}
$('#edZoomIn').addEventListener('click', () => edZoomTo(ev.z * 1.5));
$('#edZoomOut').addEventListener('click', () => edZoomTo(ev.z / 1.5));
$('#edZoomLabel').addEventListener('click', () => edZoomTo(1)); // 1 image pixel = 1 screen pixel
$('#edZoomFit').addEventListener('click', () => { edFit(); drawEd(); });

function setEdCursor() {
  if (!ed) return;
  edCanvas.style.cursor = ev.panDrag && !ev.panDrag.pickAt ? 'grabbing'
    : ev.space ? 'grab'
      : ed.mode === 'view' ? 'grab' : 'crosshair';
}

// ---- drawing
let checkerPattern = null;
function getChecker(ctx) {
  const cs = getComputedStyle(document.documentElement);
  const key = cs.getPropertyValue('--check-a') + cs.getPropertyValue('--check-b') + cs.getPropertyValue('--stage');
  if (!checkerPattern || checkerPattern.key !== key) {
    const t = makeCanvas(14, 14), g = t.getContext('2d');
    g.fillStyle = cs.getPropertyValue('--check-a').trim() || '#fff'; g.fillRect(0, 0, 14, 14);
    g.fillStyle = cs.getPropertyValue('--check-b').trim() || '#e8e8e8'; g.fillRect(0, 0, 7, 7); g.fillRect(7, 7, 7, 7);
    checkerPattern = { key, pattern: ctx.createPattern(t, 'repeat'), stage: cs.getPropertyValue('--stage').trim() || '#d9d6d0' };
  }
  return checkerPattern;
}

let edRaf = 0;
function drawEd() {
  cancelAnimationFrame(edRaf);
  edRaf = requestAnimationFrame(() => {
    if (!ed || edCanvas.classList.contains('hidden')) return;
    const ctx = edCanvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const { z, ox, oy } = ev;
    const chk = getChecker(ctx);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = chk.stage;
    ctx.fillRect(0, 0, ev.cssW, ev.cssH);
    const s = ev.src;
    if (s) {
      ctx.fillStyle = chk.pattern; // transparency checkerboard behind the image only
      ctx.fillRect(ox + s.x * z, oy + s.y * z, s.w * z, s.h * z);
      ctx.save();
      ctx.translate(ox, oy);
      ctx.scale(z, z);
      ctx.imageSmoothingEnabled = z < 3; // show real pixels when zoomed far in
      ctx.imageSmoothingQuality = 'high';
      if (!tool && ed.mode !== 'pick' && ed.shadow?.on) {
        // shadow offsets/blur ignore the transform, so they're given in device pixels
        const sh = ed.shadow, size = Math.max(s.w, s.h), a = (sh.angle * Math.PI) / 180, k = z * dpr;
        ctx.shadowColor = `rgba(0,0,0,${sh.opacity / 100})`;
        ctx.shadowBlur = (sh.blur / 100) * size * k;
        ctx.shadowOffsetX = Math.cos(a) * (sh.dist / 100) * size * k;
        ctx.shadowOffsetY = Math.sin(a) * (sh.dist / 100) * size * k;
      }
      ctx.drawImage(s.canvas, s.x, s.y, s.w, s.h);
      ctx.shadowColor = 'transparent';
      if (tool?.kind === 'lasso') drawLasso(ctx);
      ctx.restore();
    }
    if (tool?.kind === 'erase' && ev.hover && !ev.gesture && !ev.panDrag && !ev.space) {
      const r = Number($('#edBrush').value) / 2;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = tool.brushMode === 'restore' ? 'rgba(20,140,60,.95)' : 'rgba(0,0,0,.8)';
      ctx.beginPath(); ctx.arc(ev.hover.x, ev.hover.y, r, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.beginPath(); ctx.arc(ev.hover.x, ev.hover.y, Math.max(1, r - 1.5), 0, Math.PI * 2); ctx.stroke();
    }
  });
}

function drawLasso(ctx) {
  const L = tool.lasso;
  if (!L || !L.length) return;
  const z = ev.z;
  const trace = () => { ctx.beginPath(); L.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); };
  if (L.length >= 3) { // dim everything outside the shape (as if it were closed)
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    ctx.beginPath();
    ctx.rect(0, 0, ev.imgW, ev.imgH);
    L.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fill('evenodd');
  }
  const dashed = (w, dash, off = 0) => {
    ctx.lineWidth = w / z; ctx.setLineDash(dash.map((d) => d / z)); ctx.lineDashOffset = off / z;
    ctx.strokeStyle = '#ffffff'; ctx.stroke();
    ctx.strokeStyle = '#2f6fde'; ctx.lineDashOffset = (off + 5) / z; ctx.stroke();
  };
  trace();
  if (tool.closed) ctx.closePath();
  dashed(2, [6, 4]);
  const open = !tool.closed && !tool.press?.drawing;
  // preview of the next straight line, from the last corner to the pointer
  if (open && ev.hover && !ev.panDrag && !ev.gesture) {
    const h = { x: (ev.hover.x - ev.ox) / z, y: (ev.hover.y - ev.oy) / z };
    const snapFirst = L.length >= 3 && nearFirstPoint(ev.hover);
    const target = snapFirst ? L[0] : h;
    ctx.beginPath(); ctx.moveTo(L[L.length - 1].x, L[L.length - 1].y); ctx.lineTo(target.x, target.y);
    dashed(1.5, [3, 3]);
  }
  // corner markers; the first one grows when the pointer is close enough to close the shape
  ctx.setLineDash([]);
  for (const i of tool.marks) {
    const p = L[i];
    if (!p) continue;
    const big = i === 0 && open && L.length >= 3 && ev.hover && nearFirstPoint(ev.hover);
    const r = (big ? 7 : i === 0 ? 5 : 3.5) / z;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = i === 0 ? '#2f6fde' : '#ffffff'; ctx.fill();
    ctx.lineWidth = 1.5 / z; ctx.strokeStyle = i === 0 ? '#ffffff' : '#2f6fde'; ctx.stroke();
  }
}
function nearFirstPoint(css) {
  const p = tool.lasso[0];
  return Math.hypot(ev.ox + p.x * ev.z - css.x, ev.oy + p.y * ev.z - css.y) <= 12;
}

// ---- modes
function setPicking(on) {
  if (!ed) return;
  if (on) { endCrop(); ed.mode = 'pick'; } else if (ed.mode === 'pick') ed.mode = 'view';
  $('#edBgPick').textContent = ed.mode === 'pick' ? 'Done picking colours' : 'Click a color to remove';
  $('#edBgPick').classList.toggle('on', ed.mode === 'pick');
  setEdCursor();
  updateDisplaySource(true);
}

async function pickColorAt(p) {
  const cur = edCurrent();
  const x = Math.floor(p.x), y = Math.floor(p.y);
  if (x < 0 || y < 0 || x >= cur.w || y >= cur.h) return;
  setBusy(true, 'Removing color…');
  try {
    const c = imageToCanvas(ed.baseImg);
    removeColorAt(c, x, y, Number($('#edTol').value), $('#edContig').checked);
    await pushStep(c, true);
  } finally { setBusy(false); }
}

// ---- rectangular crop (Cropper.js)
function syncCropButtons() {
  const cropping = !!(ed && ed.cropper);
  $('#edCropStart').disabled = cropping;
  $('#edCropRatio').disabled = !cropping;
  $('#edCropApply').disabled = !cropping;
  $('#edCropCancel').disabled = !cropping;
}
function endCrop() {
  cancelTool();
  const wasCropping = !!ed?.cropper;
  if (ed?.cropper) { ed.cropper.destroy(); ed.cropper = null; }
  $('#cropHost').classList.remove('on');
  edCanvas.classList.remove('hidden');
  $('#edZoomBar').classList.remove('hidden');
  syncCropButtons();
  if (wasCropping) sizeEdCanvas();
}
$('#edCropStart').addEventListener('click', () => {
  setPicking(false);
  cancelTool();
  const img = $('#cropImg');
  img.src = edCurrent().url;
  edCanvas.classList.add('hidden');
  $('#edZoomBar').classList.add('hidden');
  $('#cropHost').classList.add('on');
  ed.cropper = new Cropper(img, { viewMode: 1, autoCropArea: 0.9, background: false, responsive: true });
  $('#edCropRatio').value = 'NaN';
  syncCropButtons();
});
$('#edCropRatio').addEventListener('change', (e) => ed?.cropper?.setAspectRatio(Number(e.target.value)));
$('#edCropCancel').addEventListener('click', endCrop);
$('#edCropApply').addEventListener('click', async () => {
  const data = ed.cropper.getData(true);
  const c = ed.cropper.getCroppedCanvas({ width: data.width, height: data.height, imageSmoothingQuality: 'high' });
  endCrop();
  ev.fit = true;
  await pushStep(c, false, { x: data.x, y: data.y });
});

// ---- automatic background removal (subject segmentation, runs locally in the browser)
let bgLibPromise = null;
$('#edBgAuto').addEventListener('click', async () => {
  setPicking(false); endCrop();
  setBusy(true, 'Loading background-removal model…');
  try {
    bgLibPromise ||= import(BG_REMOVAL_URL);
    const lib = await bgLibPromise;
    const blob = await (await fetch(edCurrent().url)).blob();
    const result = await lib.removeBackground(blob, {
      progress: (key, cur, total) => {
        if (total) $('#edBusyText').textContent = key.startsWith('fetch') ? `Downloading model… ${Math.round((cur / total) * 100)}%` : 'Cutting out subject…';
      },
      output: { format: 'image/png' },
    });
    const img = await loadImage(URL.createObjectURL(result));
    await pushStep(imageToCanvas(img), true);
  } catch (e) {
    console.error(e);
    bgLibPromise = null;
    alert('Automatic background removal failed: ' + e.message + '\n\nYou can still use "Click a color to remove" for plain backgrounds.');
  } finally { setBusy(false); }
});

$('#edBgPick').addEventListener('click', () => setPicking(ed.mode !== 'pick'));

// ---- outline
let outlineTimer;
function onOutlineChange() {
  ed.outline = { on: $('#edOutline').checked, w: Number($('#edOutlineW').value), c: $('#edOutlineC').value };
  clearTimeout(outlineTimer);
  outlineTimer = setTimeout(() => updateDisplaySource(true), 60);
}
['#edOutline', '#edOutlineW', '#edOutlineC'].forEach((s) => $(s).addEventListener('input', onOutlineChange));

// shape, edges, colour, shadow — all non-destructive, previewed live
const LOOK_PIXEL_INPUTS = ['#edMaskShape', '#edMaskRadius', '#edSmooth', '#edShrink', '#edFeather', '#edSpecks',
  '#edBright', '#edContrast', '#edSat', '#edBW', '#edTint', '#edTintAmt'];
const LOOK_SHADOW_INPUTS = ['#edShadow', '#edShadowDist', '#edShadowBlur', '#edShadowOpacity', '#edShadowAngle'];
function readLookControls() {
  ed.mask = { shape: $('#edMaskShape').value, radius: +$('#edMaskRadius').value };
  ed.edges = { smooth: +$('#edSmooth').value, shrink: +$('#edShrink').value, feather: +$('#edFeather').value, specks: $('#edSpecks').checked };
  ed.adjust = {
    brightness: +$('#edBright').value, contrast: +$('#edContrast').value, saturation: +$('#edSat').value,
    bw: $('#edBW').checked, tint: $('#edTint').value, tintAmt: +$('#edTintAmt').value,
  };
  ed.shadow = { on: $('#edShadow').checked, dist: +$('#edShadowDist').value, blur: +$('#edShadowBlur').value, opacity: +$('#edShadowOpacity').value, angle: +$('#edShadowAngle').value };
}
function writeLookControls() {
  $('#edMaskShape').value = ed.mask.shape; $('#edMaskRadius').value = ed.mask.radius;
  $('#edSmooth').value = ed.edges.smooth; $('#edShrink').value = ed.edges.shrink; $('#edFeather').value = ed.edges.feather; $('#edSpecks').checked = ed.edges.specks;
  $('#edBright').value = ed.adjust.brightness; $('#edContrast').value = ed.adjust.contrast; $('#edSat').value = ed.adjust.saturation;
  $('#edBW').checked = ed.adjust.bw; $('#edTint').value = ed.adjust.tint; $('#edTintAmt').value = ed.adjust.tintAmt;
  $('#edShadow').checked = ed.shadow.on; $('#edShadowDist').value = ed.shadow.dist; $('#edShadowBlur').value = ed.shadow.blur;
  $('#edShadowOpacity').value = ed.shadow.opacity; $('#edShadowAngle').value = ed.shadow.angle;
  syncLookLabels();
}
function syncLookLabels() {
  const signed = (v) => (v > 0 ? '+' : '') + v;
  $('#edMaskRadiusRow').classList.toggle('hidden', ed.mask.shape !== 'rounded');
  $('#edSmoothVal').textContent = ed.edges.smooth || 'off';
  $('#edShrinkVal').textContent = ed.edges.shrink || 'off';
  $('#edFeatherVal').textContent = ed.edges.feather || 'off';
  $('#edBrightVal').textContent = signed(ed.adjust.brightness);
  $('#edContrastVal').textContent = signed(ed.adjust.contrast);
  $('#edSatVal').textContent = ed.adjust.bw ? 'B&W' : signed(ed.adjust.saturation);
  $('#edTintVal').textContent = ed.adjust.tintAmt ? ed.adjust.tintAmt + '%' : 'off';
  $('#edSat').disabled = ed.adjust.bw;
  // a dot on collapsed sections that are doing something
  $('#edEdgesBox').classList.toggle('active', !!(ed.edges.smooth || ed.edges.shrink || ed.edges.feather || ed.edges.specks));
  $('#edColorBox').classList.toggle('active', !!(ed.adjust.brightness || ed.adjust.contrast || ed.adjust.saturation || ed.adjust.bw || ed.adjust.tintAmt));
  $('#edShadowBox').classList.toggle('active', !!ed.shadow.on);
}
let lookTimer;
LOOK_PIXEL_INPUTS.forEach((sel) => $(sel).addEventListener('input', () => {
  if (!ed) return;
  readLookControls(); syncLookLabels();
  clearTimeout(lookTimer);
  lookTimer = setTimeout(() => updateDisplaySource(true), 60);
}));
LOOK_SHADOW_INPUTS.forEach((sel) => $(sel).addEventListener('input', () => {
  if (!ed) return;
  readLookControls(); syncLookLabels(); drawEd(); // the shadow is drawn live, no re-render needed
}));
$('#edColorReset').addEventListener('click', () => {
  ed.adjust = { ...DEFAULT_ADJUST };
  writeLookControls();
  updateDisplaySource(true);
});

$('#edUndo').addEventListener('click', async () => {
  if (ed.steps.length > 1) { ed.steps.pop(); endCrop(); ev.fit = true; await refreshPreview(); }
});
$('#edReset').addEventListener('click', async () => {
  ed.steps = ed.steps.slice(0, 1);
  ed.outline.on = false; $('#edOutline').checked = false;
  Object.assign(ed, lookCopies({}));
  writeLookControls();
  endCrop(); setPicking(false); ev.fit = true; await refreshPreview();
});

// ---- hand tools: rubber and draw-to-crop
// Work happens on a full-resolution copy of the current step. The brush size is in screen pixels,
// so zooming in gives a finer brush. Rubber strokes are kept as vectors for exact "Undo stroke".
async function startTool(kind) {
  if (!ed || ed.busy) return;
  endCrop();
  setPicking(false);
  const img = ed.baseImg || await loadImage(edCurrent().url);
  tool = {
    kind, base: imageToCanvas(img), work: imageToCanvas(img), strokes: [], current: null, down: false,
    lasso: null, closed: false, marks: [], press: null, brushMode: 'erase', source: null, expand: null,
  };
  if (kind === 'erase') {
    // The restore brush paints back pixels from the original image. When the current step is a
    // smaller part of it (cropped, or trimmed after background removal), the work area grows to the
    // whole original so areas outside the current edges can be restored too.
    const org = stepOrigin(ed.steps.length - 1);
    if (org && ed.steps.length > 1) {
      const src = await loadImage(ed.steps[0].url);
      const sw = src.naturalWidth, sh = src.naturalHeight;
      tool.source = imageToCanvas(src);
      if (org.ox || org.oy || sw !== ev.imgW || sh !== ev.imgH) {
        const grow = (from) => { const c = makeCanvas(sw, sh); c.getContext('2d').drawImage(from, org.ox, org.oy); return c; };
        tool.base = grow(img); tool.work = grow(img);
        tool.expand = { ox: org.ox, oy: org.oy, w: ev.imgW, h: ev.imgH };
        ev.ox -= org.ox * ev.z; ev.oy -= org.oy * ev.z; // keep the image where it is on screen
        ev.imgW = sw; ev.imgH = sh;
      }
    } else {
      tool.source = imageToCanvas(img); // nothing older to go back to: restore undoes this session's erasing
    }
  }
  ed.mode = kind;
  setEdCursor();
  syncToolUi();
  updateDisplaySource(false);
}

function cancelTool(keepView = false) {
  if (!tool) return;
  if (tool.expand && !keepView) { // shrink the view back to the current step
    ev.ox += tool.expand.ox * ev.z; ev.oy += tool.expand.oy * ev.z;
    ev.imgW = tool.expand.w; ev.imgH = tool.expand.h;
  }
  tool = null;
  if (ed) { ed.mode = 'view'; setEdCursor(); updateDisplaySource(true); }
  syncToolUi();
}

const lassoReady = () => !!(tool?.lasso && tool.lasso.length >= 3);
const toolHasChanges = () => !!tool && (tool.kind === 'erase' ? tool.strokes.length > 0 : lassoReady());

async function applyTool() {
  if (!tool) return;
  const t = tool;
  if (!toolHasChanges()) { cancelTool(); return; }
  let out;
  if (t.kind === 'erase') {
    out = t.work;
  } else {
    out = makeCanvas(t.base.width, t.base.height);
    const ctx = out.getContext('2d');
    ctx.drawImage(t.base, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.beginPath();
    t.lasso.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fill();
  }
  const shift = t.expand ? { x: -t.expand.ox, y: -t.expand.oy } : null; // the work area started at the original's corner
  cancelTool(!!t.expand);
  setBusy(true, 'Applying…');
  try { await pushStep(out, true, shift); } finally { setBusy(false); }
}

function syncToolUi() {
  const kind = tool?.kind;
  $('#edEraseStart').classList.toggle('on', kind === 'erase');
  $('#edLassoStart').classList.toggle('on', kind === 'lasso');
  $('#edBrushRow').classList.toggle('hidden', kind !== 'erase');
  $('#edBrushMode').classList.toggle('hidden', kind !== 'erase');
  $('#edModeErase').classList.toggle('on', tool?.brushMode !== 'restore');
  $('#edModeRestore').classList.toggle('on', tool?.brushMode === 'restore');
  $('#edToolActions').classList.toggle('hidden', !kind);
  $('#edStrokeUndo').classList.toggle('hidden', kind !== 'erase');
  $('#edLassoClear').classList.toggle('hidden', kind !== 'lasso');
  $('#edLassoBack').classList.toggle('hidden', kind !== 'lasso');
  if (!ed?.busy) {
    $('#edToolApply').disabled = !toolHasChanges();
    $('#edStrokeUndo').disabled = !(tool && tool.strokes.length);
    $('#edLassoClear').disabled = !tool?.lasso;
    $('#edLassoBack').disabled = !tool?.lasso;
  }
  $('#edToolHint').textContent = kind === 'erase'
    ? (tool.brushMode === 'restore'
      ? 'Paint to bring back the original image — e.g. parts the background removal took away. Hold Alt to erase instead.'
      : 'Paint over anything you want to remove. Hold Alt (or pick Restore) to paint the original back. Ctrl+Z undoes the last stroke. Zoom in for a finer brush.')
    : kind === 'lasso'
      ? 'Click to place corners — straight lines join them — or press and drag to draw freehand. ' +
        'Close the shape by clicking the first corner, double-clicking or pressing Enter (Apply also closes it). ' +
        'Backspace removes the last point.'
      : '';
  drawEd();
}

function strokePath(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 1) ctx.lineTo(pts[0].x + 0.01, pts[0].y); // a single tap still erases a dot
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
}
function eraseStroke(ctx, stroke) {
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.lineWidth = stroke.w;
  strokePath(ctx, stroke.pts);
  ctx.stroke();
  ctx.restore();
}
/** Paint the original image back along the stroke. */
function restoreStroke(ctx, stroke) {
  const r = stroke.w / 2 + 2;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of stroke.pts) { x0 = Math.min(x0, p.x - r); y0 = Math.min(y0, p.y - r); x1 = Math.max(x1, p.x + r); y1 = Math.max(y1, p.y + r); }
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(tool.work.width, Math.ceil(x1)); y1 = Math.min(tool.work.height, Math.ceil(y1));
  if (x1 <= x0 || y1 <= y0) return;
  const tmp = makeCanvas(x1 - x0, y1 - y0), g = tmp.getContext('2d');
  g.translate(-x0, -y0);
  g.lineCap = 'round'; g.lineJoin = 'round'; g.lineWidth = stroke.w; g.strokeStyle = '#000';
  strokePath(g, stroke.pts); g.stroke();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-in'; // keep the brush shape, fill it with the original
  g.drawImage(tool.source, -x0, -y0);
  ctx.drawImage(tmp, x0, y0);
}
function applyStroke(ctx, stroke) { if (stroke.mode === 'restore') restoreStroke(ctx, stroke); else eraseStroke(ctx, stroke); }
function rebuildWork() {
  const ctx = tool.work.getContext('2d');
  ctx.clearRect(0, 0, tool.work.width, tool.work.height);
  ctx.drawImage(tool.base, 0, 0);
  tool.strokes.forEach((s) => applyStroke(ctx, s));
}

// lasso: a press that moves draws freehand; a press that doesn't move is a click that adds a corner
function lassoDown(p) {
  tool.press = {
    css: p.css, img: p.img, drawing: false, newShape: false,
    before: tool.lasso ? { pts: tool.lasso.slice(), closed: tool.closed, marks: tool.marks.slice() } : null,
  };
}
function lassoMove(p) {
  const pr = tool.press;
  if (!pr.drawing && Math.hypot(p.css.x - pr.css.x, p.css.y - pr.css.y) > 6) {
    pr.drawing = true;
    if (!tool.lasso || tool.closed) { tool.lasso = [pr.img]; tool.marks = [0]; tool.closed = false; pr.newShape = true; }
    else tool.lasso.push(pr.img); // continue an open shape with a freehand piece
  }
  if (pr.drawing) {
    const L = tool.lasso, last = L[L.length - 1];
    if (Math.hypot(p.img.x - last.x, p.img.y - last.y) * ev.z > 2) L.push(p.img);
  }
}
function lassoUp(p) {
  const pr = tool.press;
  tool.press = null;
  if (pr.drawing) {
    // a single freehand loop closes itself (like before); a freehand piece added to corners stays open
    if (pr.newShape) { if (tool.lasso.length >= 3) tool.closed = true; else restoreLasso(pr.before); }
    else tool.marks.push(tool.lasso.length - 1);
  } else if (!tool.lasso || tool.closed) {
    tool.lasso = [p.img]; tool.marks = [0]; tool.closed = false;
  } else if (tool.lasso.length >= 3 && nearFirstPoint(p.css)) {
    tool.closed = true;
  } else {
    const L = tool.lasso, last = L[L.length - 1];
    if (Math.hypot(p.img.x - last.x, p.img.y - last.y) * ev.z > 3) { L.push(p.img); tool.marks.push(L.length - 1); }
  }
  syncToolUi();
}
function restoreLasso(b) {
  if (b) { tool.lasso = b.pts; tool.closed = b.closed; tool.marks = b.marks; }
  else { tool.lasso = null; tool.closed = false; tool.marks = []; }
}
function closeLasso() { if (tool?.kind === 'lasso' && lassoReady() && !tool.closed) { tool.closed = true; syncToolUi(); } }
function lassoBack() {
  if (!tool?.lasso) return;
  if (tool.closed) { tool.closed = false; syncToolUi(); return; } // first press re-opens the shape
  const L = tool.lasso;
  // remove back to the previous corner (a whole freehand piece goes at once)
  const prev = tool.marks.filter((i) => i < L.length - 1).pop();
  if (prev === undefined) { restoreLasso(null); } else { L.length = prev + 1; tool.marks = tool.marks.filter((i) => i <= prev); }
  syncToolUi();
}

/** A second finger arrived mid-stroke: that was the start of a pinch, so undo the partial stroke. */
function abortDraw() {
  if (!tool) return;
  if (tool.kind === 'erase' && tool.down) { tool.down = false; tool.current = null; rebuildWork(); }
  if (tool.kind === 'lasso' && tool.press) { if (tool.press.drawing) restoreLasso(tool.press.before); tool.press = null; }
}

// ---- input on the view
const edPt = (e) => {
  const r = edCanvas.getBoundingClientRect();
  const css = { x: e.clientX - r.left, y: e.clientY - r.top };
  return { css, img: { x: (css.x - ev.ox) / ev.z, y: (css.y - ev.oy) / ev.z } };
};
function pinchGeom() {
  const [a, b] = [...ev.pointers.values()];
  return { d: Math.hypot(b.x - a.x, b.y - a.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
}

edCanvas.addEventListener('pointerdown', (e) => {
  if (!ed || ed.busy) return;
  e.preventDefault();
  try { edCanvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  if (e.pointerType === 'mouse') for (const [id, p] of ev.pointers) if (p.mouse) ev.pointers.delete(id); // stale mouse entry
  const p = edPt(e);
  ev.pointers.set(e.pointerId, { ...p.css, mouse: e.pointerType === 'mouse' });
  ev.hover = p.css;
  if (ev.pointers.size === 2) { // two fingers: zoom & pan
    abortDraw();
    ev.panDrag = null;
    const g = pinchGeom();
    ev.gesture = { d0: g.d, z0: ev.z, ix: (g.mx - ev.ox) / ev.z, iy: (g.my - ev.oy) / ev.z };
  } else if (ev.pointers.size === 1) {
    const panButton = e.button === 1 || (e.button === 0 && ev.space);
    if (panButton || (e.button === 0 && (ed.mode === 'view' || ed.mode === 'pick'))) {
      // drag pans; in colour-pick mode a click without dragging picks the colour
      ev.panDrag = { x: p.css.x, y: p.css.y, moved: 0, pickAt: !panButton && ed.mode === 'pick' ? p.img : null };
    } else if (e.button === 0 && tool?.kind === 'erase') {
      tool.down = true;
      // hold Alt to switch brush mode for one stroke
      const mode = e.altKey ? (tool.brushMode === 'restore' ? 'erase' : 'restore') : tool.brushMode;
      tool.current = { mode, w: Number($('#edBrush').value) / ev.z, pts: [p.img] };
      applyStroke(tool.work.getContext('2d'), tool.current);
    } else if (e.button === 0 && tool?.kind === 'lasso') {
      lassoDown(p);
    }
  }
  setEdCursor();
  drawEd();
});

edCanvas.addEventListener('pointermove', (e) => {
  if (!ed) return;
  const p = edPt(e);
  if (ev.pointers.has(e.pointerId)) ev.pointers.set(e.pointerId, { ...p.css, mouse: e.pointerType === 'mouse' });
  ev.hover = p.css;
  if (ev.gesture && ev.pointers.size >= 2) {
    const g = pinchGeom();
    const z = Math.min(ED_ZOOM_MAX, Math.max(edFitZoom() * 0.5, ev.gesture.z0 * (g.d / ev.gesture.d0)));
    Object.assign(ev, { z, ox: g.mx - ev.gesture.ix * z, oy: g.my - ev.gesture.iy * z, fit: false });
    edClampView(); updateEdZoomUi();
  } else if (ev.panDrag) {
    const dx = p.css.x - ev.panDrag.x, dy = p.css.y - ev.panDrag.y;
    ev.panDrag.moved += Math.abs(dx) + Math.abs(dy);
    ev.panDrag.x = p.css.x; ev.panDrag.y = p.css.y;
    if (!ev.panDrag.pickAt || ev.panDrag.moved > 5) { if (ev.panDrag.pickAt) { ev.panDrag.pickAt = null; setEdCursor(); } edPan(dx, dy); }
  } else if (tool?.kind === 'erase' && tool.down && tool.current) {
    const pts = tool.current.pts, last = pts[pts.length - 1];
    pts.push(p.img);
    applyStroke(tool.work.getContext('2d'), { mode: tool.current.mode, w: tool.current.w, pts: [last, p.img] });
  } else if (tool?.kind === 'lasso' && tool.press) {
    lassoMove(p);
  }
  drawEd();
});

const edPointerUp = (e) => {
  if (!ed) return;
  const p = edPt(e);
  ev.pointers.delete(e.pointerId);
  if (ev.gesture) { if (ev.pointers.size < 2) ev.gesture = null; drawEd(); return; }
  if (ev.panDrag) {
    const pick = ev.panDrag.pickAt;
    ev.panDrag = null;
    setEdCursor();
    if (pick && e.type === 'pointerup') pickColorAt(pick);
    return;
  }
  if (tool?.kind === 'erase' && tool.down) {
    tool.down = false;
    if (tool.current) { tool.strokes.push(tool.current); tool.current = null; }
    syncToolUi();
  } else if (tool?.kind === 'lasso' && tool.press) {
    if (e.type === 'pointerup') lassoUp(p); else abortDraw();
  }
  drawEd();
};
edCanvas.addEventListener('pointerup', edPointerUp);
edCanvas.addEventListener('pointercancel', edPointerUp);
edCanvas.addEventListener('pointerleave', () => { if (ed && !ev.pointers.size) { ev.hover = null; drawEd(); } });
edCanvas.addEventListener('dblclick', (e) => { e.preventDefault(); closeLasso(); });
edCanvas.addEventListener('auxclick', (e) => e.preventDefault());

// Scroll pans, Ctrl/⌘ + scroll (or trackpad pinch) zooms at the pointer — same as the main canvas.
edCanvas.addEventListener('wheel', (e) => {
  if (!ed) return;
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? ev.cssH : 1;
  const dx = e.deltaX * unit, dy = e.deltaY * unit;
  if (e.ctrlKey || e.metaKey) {
    const r = edCanvas.getBoundingClientRect();
    edZoomTo(ev.z * Math.pow(0.998, Math.max(-300, Math.min(300, dy))), e.clientX - r.left, e.clientY - r.top);
  } else if (e.shiftKey && !dx) edPan(-dy, 0);
  else edPan(-dx, -dy);
}, { passive: false });

// Unapplied rubber strokes / crop outline are never thrown away silently: switching to another tool
// (or clicking the active tool's button again, i.e. "done") applies them first. Cancel and
// "Undo step" are the explicit ways to discard them.
['#edCropStart', '#edBgAuto', '#edBgPick', '#edEraseStart', '#edLassoStart', '#edUndo'].forEach((sel) => {
  $(sel).addEventListener('click', async (e) => {
    if (!toolHasChanges()) return;
    e.stopImmediatePropagation();
    if (sel === '#edUndo') { cancelTool(); return; }
    const sameTool = (sel === '#edEraseStart' && tool.kind === 'erase') || (sel === '#edLassoStart' && tool.kind === 'lasso');
    await applyTool();
    if (!sameTool) $(sel).click();
  }, true);
});
$('#edEraseStart').addEventListener('click', () => (tool?.kind === 'erase' ? cancelTool() : startTool('erase')));
$('#edLassoStart').addEventListener('click', () => (tool?.kind === 'lasso' ? cancelTool() : startTool('lasso')));
$('#edBrush').addEventListener('input', () => { $('#edBrushVal').textContent = $('#edBrush').value + ' px'; drawEd(); });
$('#edToolApply').addEventListener('click', applyTool);
$('#edModeErase').addEventListener('click', () => { if (tool) { tool.brushMode = 'erase'; syncToolUi(); } });
$('#edModeRestore').addEventListener('click', () => { if (tool) { tool.brushMode = 'restore'; syncToolUi(); } });
$('#edToolCancel').addEventListener('click', () => cancelTool());
$('#edStrokeUndo').addEventListener('click', () => { if (tool?.strokes.length) { tool.strokes.pop(); rebuildWork(); syncToolUi(); } });
$('#edLassoClear').addEventListener('click', () => { if (tool) { restoreLasso(null); syncToolUi(); } });
$('#edLassoBack').addEventListener('click', lassoBack);

edDialog.addEventListener('keydown', (e) => {
  if (!ed) return;
  const t = e.target;
  const typing = /^(input|textarea|select)$/i.test(t.tagName || '') && !['range', 'checkbox', 'color'].includes(t.type);
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z' && !typing) {
    e.preventDefault();
    if (tool?.kind === 'erase') $('#edStrokeUndo').click();
    else if (tool?.kind === 'lasso') lassoBack();
    else if (!ed.cropper && !ed.busy) $('#edUndo').click();
  } else if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); edZoomTo(ev.z * 1.5); }
  else if (mod && e.key === '-') { e.preventDefault(); edZoomTo(ev.z / 1.5); }
  else if (mod && e.key === '0') { e.preventDefault(); edFit(); drawEd(); }
  else if (typing) return;
  else if (e.key === 'Enter' && tool?.kind === 'lasso') { e.preventDefault(); closeLasso(); }
  else if ((e.key === 'Backspace' || e.key === 'Delete') && tool?.kind === 'lasso') { e.preventDefault(); lassoBack(); }
  else if (e.code === 'Space' && !e.repeat) { e.preventDefault(); ev.space = true; setEdCursor(); drawEd(); }
});
edDialog.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && ev.space) { e.preventDefault(); ev.space = false; setEdCursor(); drawEd(); }
});

$('#edSave').addEventListener('click', async () => {
  if (toolHasChanges()) await applyTool(); // don't lose unapplied rubber / crop drawing
  else cancelTool();
  setBusy(true, 'Rendering sticker…');
  try {
    const { item } = ed;
    const base = await loadImage(edCurrent().url);
    const finalCanvas = renderSticker(base, lookOf(ed), 0, { trim: true });
    const finalUrl = await canvasToUrl(finalCanvas);
    const finalImg = await loadImage(finalUrl);
    Object.assign(item, { steps: ed.steps, outline: ed.outline, adjust: ed.adjust, mask: ed.mask, edges: ed.edges, shadow: ed.shadow, finalUrl, finalImg });
    // update every copy already on the print, keeping its on-print size
    const touchedGroups = new Set();
    allLeafObjects().filter((o) => o.stickerId === item.id).forEach((o) => {
      if (o.group) touchedGroups.add(o.group);
      const long = Math.max(o.getScaledWidth(), o.getScaledHeight());
      o.setElement(finalImg);
      const s = long / Math.max(finalImg.width, finalImg.height);
      o.set({ scaleX: s, scaleY: s, dirty: true }); o.setCoords();
      o.shadow = stickerShadow(item, finalImg);
    });
    touchedGroups.forEach((g) => g.addWithUpdate()); // re-fit groups around resized copies
    canvas.requestRenderAll();
    renderLibrary();
    closeEditor();
  } catch (e) {
    console.error(e); alert('Could not save sticker: ' + e.message);
  } finally { setBusy(false); }
});

function closeEditor() { endCrop(); ed = null; ev.pointers.clear(); ev.gesture = ev.panDrag = null; edDialog.close(); }
edDialog.addEventListener('cancel', (e) => {
  // Escape: never while busy; while drawing a crop shape it clears the shape instead of closing
  if (ed?.busy) { e.preventDefault(); return; }
  if (tool?.kind === 'lasso' && tool.lasso) { e.preventDefault(); restoreLasso(null); syncToolUi(); return; }
  if (toolHasChanges()) { e.preventDefault(); return; }
  endCrop();
  ed = null;
});

// generic close buttons
$$('[data-close]').forEach((b) => b.addEventListener('click', () => {
  const d = b.closest('dialog');
  if (d === edDialog) { if (!ed?.busy) closeEditor(); } else d.close();
}));

// ---------------------------------------------------------------- online image search
const search = { q: '', provider: 'openverse', page: 1, results: [], selected: new Map() };

fetch('/api/config').then((r) => r.json()).then((cfg) => {
  for (const opt of $$('#searchProvider option')) {
    if (cfg[opt.value] === false) { opt.disabled = true; opt.textContent += ' — needs a key (see README)'; }
  }
  try { // remember the last source used
    const last = localStorage.getItem('collage.searchProvider');
    if (last && cfg[last]) $('#searchProvider').value = last;
  } catch { /* ignore */ }
  syncSearchFilters();
}).catch(() => {});
/** Unsplash and Pexels images may all be edited and used commercially, so the filters don't apply there. */
function syncSearchFilters() {
  const p = $('#searchProvider').value;
  $('#searchFilters').classList.toggle('hidden', p === 'unsplash' || p === 'pexels' || p === 'google');
}
$('#searchProvider').addEventListener('change', () => {
  syncSearchFilters();
  try { localStorage.setItem('collage.searchProvider', $('#searchProvider').value); } catch { /* ignore */ }
});

$('#btnOpenSearch').addEventListener('click', () => { $('#searchDialog').showModal(); $('#searchQuery').focus(); });
$('#searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  search.q = $('#searchQuery').value.trim();
  search.provider = $('#searchProvider').value;
  search.page = 1; search.results = []; search.selected.clear();
  $('#searchResults').innerHTML = '';
  runSearch();
});
$('#searchMore').addEventListener('click', () => { search.page++; runSearch(); });

async function runSearch() {
  if (!search.q) return;
  $('#searchNote').textContent = 'Searching…';
  $('#searchMore').disabled = true;
  try {
    const filters = `&editable=${$('#searchEditable').checked ? 1 : 0}&commercial=${$('#searchCommercial').checked ? 1 : 0}`;
    const r = await fetch(`/api/search?provider=${encodeURIComponent(search.provider)}&page=${search.page}&q=${encodeURIComponent(search.q)}${filters}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    search.results.push(...data.results);
    data.results.forEach(renderSearchCard);
    $('#searchNote').textContent = search.results.length
      ? 'Click images to select them, then add them to your stickers. Each sticker keeps its licence and credit (see Credits).'
      : 'No results.';
    $('#searchMore').disabled = data.results.length === 0;
  } catch (e) {
    $('#searchNote').textContent = 'Search failed: ' + e.message;
  }
  updateSearchSel();
}

function renderSearchCard(res) {
  const card = document.createElement('div');
  card.className = 'search-card';
  card.title = `${res.title}${res.creator ? ' — ' + res.creator : ''}\n${res.license} · ${res.source || ''}`;
  card.innerHTML = '<img loading="lazy" alt="" /><div class="meta"></div>';
  const flags = licenceFlags({ ...res });
  if (flags && (flags.nd || flags.nc || flags.unknown)) {
    const b = document.createElement('span');
    b.className = 'lic-badge ' + (flags.nd ? 'bad' : 'warn');
    b.textContent = flags.nd ? 'No edits' : flags.unknown ? 'Licence?' : 'Non-commercial';
    b.title = licenceNotes({ ...res }).map((n) => n[1]).join(' ');
    card.appendChild(b);
  }
  // If the thumbnail service fails, try the full image; hide the result only if both fail.
  card.querySelector('img').onerror = (e) => {
    if (!e.target.dataset.triedFull && res.full && res.full !== res.thumb) {
      e.target.dataset.triedFull = '1';
      e.target.src = '/api/proxy?url=' + encodeURIComponent(res.full);
    } else card.remove();
  };
  card.querySelector('img').src = `/api/proxy?url=${encodeURIComponent(res.thumb)}`;
  card.querySelector('.meta').textContent = `${res.license}${res.width ? ` · ${res.width}×${res.height}` : ''}`;
  card.addEventListener('click', () => {
    if (search.selected.has(res.id)) search.selected.delete(res.id); else search.selected.set(res.id, res);
    card.classList.toggle('sel', search.selected.has(res.id));
    updateSearchSel();
  });
  $('#searchResults').appendChild(card);
}
function updateSearchSel() {
  $('#searchSelCount').textContent = `${search.selected.size} selected`;
  $('#searchAdd').disabled = search.selected.size === 0;
}

async function fetchProxied(url) {
  const r = await fetch(`/api/proxy?url=${encodeURIComponent(url)}`);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.blob();
}

$('#searchAdd').addEventListener('click', async () => {
  holdHistory(); // adding several search results = one undo step
  try { await addSearchPicks(); } finally { releaseHistory(); }
});
async function addSearchPicks() {
  const picks = [...search.selected.values()];
  $('#searchAdd').disabled = true;
  let ok = 0, lowRes = 0;
  for (const [i, res] of picks.entries()) {
    $('#searchNote').textContent = `Downloading ${i + 1} of ${picks.length}…`;
    let blob;
    // the full image; if the host refuses it, a smaller rendition; as a last resort the preview
    for (const [u, small] of [[res.full, false], [res.fullFallback, false], [res.thumb, true]]) {
      if (!u) continue;
      try { blob = await fetchProxied(u); if (small) lowRes++; break; } catch { /* try the next one */ }
    }
    if (!blob) continue;
    try {
      const src = URL.createObjectURL(blob);
      const norm = await normalizeSource(src, blob);
      if (norm.url !== src) URL.revokeObjectURL(src);
      const { id, thumb, full, fullFallback, width, height, downloadLocation, nonFree, ...source } = res;
      await addToLibrary(norm, res.title, [search.q], source);
      if (downloadLocation) fetch('/api/unsplash-download?loc=' + encodeURIComponent(downloadLocation)).catch(() => {}); // Unsplash's terms
      ok++;
    } catch (e) { console.error(e); }
  }
  search.selected.clear();
  $$('.search-card.sel').forEach((c) => c.classList.remove('sel'));
  updateSearchSel();
  $('#searchNote').textContent = `Added ${ok} of ${picks.length}.` + (lowRes ? ` ${lowRes} only available as a small preview.` : '');
  status(`Added ${ok} image${ok === 1 ? '' : 's'} from search.`);
  if (ok === picks.length) $('#searchDialog').close();
}

// ---------------------------------------------------------------- export
function syncExportInfo() {
  const b = bleedPx(), W = print.W + 2 * b, H = print.H + 2 * b;
  let info = `${W.toLocaleString()} × ${H.toLocaleString()} px`;
  if (print.mode === 'physical') info += ` — ${print.w} × ${print.h} ${print.unit} at ${print.dpi} DPI`;
  if (b) info += `, plus ${fmtLen(print.guides.bleedMm)} bleed on each side (file ${fmtSize(W / pxPerMm(), H / pxPerMm())}; trim to ${fmtSize(print.W / pxPerMm(), print.H / pxPerMm())})`;
  $('#exportInfo').textContent = info;
  const fmt = $('#exportFormat').value;
  const low = allLeafObjects().filter(isSticker).filter((o) => stickerQuality(o)?.level === 'bad').length;
  const notes = [];
  if (low) notes.push(`${low} sticker${low === 1 ? ' is' : 's are'} enlarged below 150 DPI and may look soft in print.`);
  if (fmt === 'pdf') notes.push('PDF: one page at the exact physical size' + (b ? ', with the trim size marked for the print shop' : '') + '. Colours are RGB; print shops convert them.');
  else if (print.mode === 'physical') notes.push('The DPI is written into the file so print shops read the right physical size.');
  if (print.guides.mat) notes.push('The mat and frame preview is not included.');
  $('#exportWarn').textContent = notes.join(' ');
  const credits = creditsText('print');
  $('#exportCreditsRow').classList.toggle('hidden', !credits.count);
  $('#exportCreditsCount').textContent = credits.count ? `(${credits.count} source${credits.count === 1 ? '' : 's'})` : '';
  const needCredit = library.some((i) => i.source && onPrintCounts()[i.id] && licenceFlags(i.source)?.credit);
  $('#exportCredits').checked = needCredit;
}
$('#exportFormat').addEventListener('change', syncExportInfo);
$('#btnExport').addEventListener('click', () => { syncExportInfo(); $('#exportDialog').showModal(); });

$('#exportGo').addEventListener('click', async () => {
  const fmt = $('#exportFormat').value;
  const btn = $('#exportGo');
  btn.disabled = true; btn.textContent = 'Rendering…';
  await new Promise((r) => setTimeout(r, 30));
  try {
    await ensureFonts(textFontsInUse());
    await document.fonts.ready;
    await bgImageLoaded();
    canvas.discardActiveObject(); canvas.requestRenderAll();
    // Rendered at true 1:1 scale; the display canvas is rounded to whole pixels, so crop to the exact print size.
    const v = canvas.viewportTransform;
    const b = bleedPx(); // with bleed, the file is larger than the print on every side
    const full = canvas.toCanvasElement(1 / zoom, {
      left: v[4] - b * zoom, top: v[5] - b * zoom, width: (print.W + 2 * b + 1) * zoom, height: (print.H + 2 * b + 1) * zoom,
    }); // +1 px guards against float rounding; cropped below
    const out = makeCanvas(print.W + 2 * b, print.H + 2 * b);
    const octx = out.getContext('2d');
    octx.translate(b, b);
    paintPage(octx);
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.drawImage(full, 0, 0);
    let blob;
    if (fmt === 'pdf') {
      const dpi = print.mode === 'physical' ? print.dpi : 300; // pixel-size prints are laid out at 300 DPI
      const jpeg = await canvasToBlob(out, 'image/jpeg', 0.95);
      blob = await jpegToPdf(jpeg, {
        widthPx: out.width, heightPx: out.height,
        widthPt: (out.width / dpi) * 72, heightPt: (out.height / dpi) * 72, bleedPt: (b / dpi) * 72,
        title: projectName,
      });
    } else {
      blob = await canvasToBlob(out, fmt === 'png' ? 'image/png' : 'image/jpeg', 0.95);
      if (print.mode === 'physical') blob = await insertDpiMetadata(blob, print.dpi, fmt);
    }
    const ext = { png: 'png', jpeg: 'jpg', pdf: 'pdf' }[fmt];
    const bleedTag = b ? `-bleed${+print.guides.bleedMm.toFixed(1)}mm` : '';
    const name = print.mode === 'physical'
      ? `${projectSlug()}-${print.w}x${print.h}${print.unit}-${print.dpi}dpi${bleedTag}.${ext}`
      : `${projectSlug()}-${print.W}x${print.H}.${ext}`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    if ($('#exportCredits').checked && !$('#exportCreditsRow').classList.contains('hidden')) {
      downloadBlob(new Blob([creditsText('print').text], { type: 'text/plain;charset=utf-8' }), `${slugify(projectName)}-credits.txt`);
    }
    $('#exportDialog').close();
    status(`Exported ${name} (${(blob.size / 1e6).toFixed(1)} MB).`);
  } catch (e) {
    console.error(e); alert('Export failed: ' + e.message);
  } finally { btn.disabled = false; btn.textContent = 'Download'; }
});

// ---------------------------------------------------------------- random-layout slider labels
function syncSliderLabels() {
  $('#sizeVal').textContent = `${$('#genSize').value}% of short side`;
  $('#varVal').textContent = `±${$('#genVar').value}%`;
  $('#rotVal').textContent = `±${$('#genRot').value}°`;
}
['#genSize', '#genVar', '#genRot'].forEach((s) => $(s).addEventListener('input', () => { syncSliderLabels(); markDirty('continuous'); }));
$('#genKeepText').addEventListener('change', () => markDirty());

// ---------------------------------------------------------------- save / load
const PROJECT_VERSION = 1;
let persistReady = false;   // false while booting or restoring, so half-built state is never autosaved
let saveTimer = null, saving = false, dirtyWhileSaving = false, unsaved = false;
let changeSeq = 0; // counts changes, so a save only counts as complete if nothing changed while it ran

/**
 * Something in the collage changed. Autosave is always scheduled. For undo, each user action becomes
 * one step: every change made while handling one event (a click, a key press, the end of a drag) is
 * recorded together right after that event — so a random layout or "Clear print" is one step, while
 * five quick deletes are five steps.
 * kind = 'continuous' is for input that keeps flowing (typing, dragging a colour picker, holding an
 * arrow key): it's recorded when that input ends (leaving the text box, releasing the picker or key).
 */
function markDirty(kind) {
  if (!persistReady) return;
  scheduleAutosave();
  if (kind === 'continuous') { continuousPending = true; return; }
  queueHistoryCommit();
}

/** The header's save message. kind: 'saving' | 'saved' | 'bad' | '' (nothing to show).
 *  On narrower windows only a mark shows (… ✓ !) and the words move to the tooltip. */
function setSaveState(kind, title) {
  const el = $('#saveState');
  el.textContent = { saving: 'Saving…', saved: 'Saved in this browser', bad: 'Autosave failed: use Save project', '': '' }[kind];
  el.dataset.state = kind;
  el.classList.toggle('bad', kind === 'bad');
  el.title = title || el.textContent;
}

function scheduleAutosave() {
  unsaved = true;
  changeSeq++;
  setSaveState('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(runAutosave, 1200);
}
['object:added', 'object:removed', 'object:modified'].forEach((ev) => canvas.on(ev, () => markDirty()));
canvas.on('text:changed', () => markDirty('continuous'));   // typing…
canvas.on('text:editing:exited', () => markDirty());        // …is one step per editing session

async function runAutosave() {
  if (saving) { dirtyWhileSaving = true; return; }
  saving = true;
  const seqAtStart = changeSeq;
  try {
    if (!currentSaved && projectIsBlank()) { unsaved = false; setSaveState(''); return; } // nothing to keep yet
    const { meta, blobs } = await serializeProject();
    const thumb = await makeThumbnail().catch(() => null);
    await saveProject(currentProjectId, meta, blobs, thumb);
    if (!currentSaved) { currentSaved = true; await setSetting('currentProject', currentProjectId); }
    unsaved = changeSeq !== seqAtStart; // edits made during the save still need saving
    setSaveState('saved', 'Saved in this browser at ' + new Date().toLocaleTimeString());
  } catch (e) {
    console.error(e);
    setSaveState('bad', 'Autosave failed: use Save project. ' + e.message);
  } finally {
    saving = false;
    if (dirtyWhileSaving || unsaved) { dirtyWhileSaving = false; scheduleAutosave(); }
  }
}

// ---- project name (saved with the project and the autosave; used for file names and the tab title)
const DEFAULT_PROJECT_NAME = 'Untitled collage';
let projectName = DEFAULT_PROJECT_NAME;
function setProjectName(name) {
  projectName = (name || '').trim().slice(0, 80) || DEFAULT_PROJECT_NAME;
  $('#projectName').value = projectName;
  $('#projectName').title = projectName + ' — click to rename';
  document.title = projectName === DEFAULT_PROJECT_NAME ? 'stick.it' : `${projectName} — stick.it`;
}
/** File-name-safe version of the project name ("Summer trip 2026!" → "Summer-trip-2026"). */
function projectSlug() {
  const slug = projectName.normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // "Ação" → "Acao"
    .replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60);
  return slug && projectName !== DEFAULT_PROJECT_NAME ? slug : 'collage';
}
$('#projectName').addEventListener('change', () => {
  const before = projectName;
  setProjectName($('#projectName').value);
  if (projectName !== before) { scheduleAutosave(); status(`Project renamed to “${projectName}”.`); }
});
$('#projectName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') e.target.blur();
  else if (e.key === 'Escape') { e.target.value = projectName; e.target.blur(); }
});
$('#projectName').addEventListener('focus', (e) => e.target.select());

/** Stickers as plain JSON; images are referenced by key (keyFor collects their data). */
async function serializeLibraryItems(items, keyFor) {
  const out = [];
  for (const item of items) {
    const steps = [];
    for (const st of item.steps) steps.push({ key: await keyFor(st.url), w: st.w, h: st.h, ox: st.ox, oy: st.oy });
    // the finished look (outline, shape…) is slow to re-render, so it's stored too
    const finalKey = lookNeedsRender(lookOf(item)) ? await keyFor(item.finalUrl) : null;
    out.push({ id: item.id, name: item.name, use: item.use, count: item.count, outline: { ...item.outline }, ...lookCopies(item), steps, finalKey, tags: [...(item.tags || [])], size: item.size || 1, source: item.source || null });
  }
  return out;
}
/** key → object URL, registering each blob once. */
function urlMaker(blobs) {
  const urlForKey = new Map();
  return (key) => {
    if (!urlForKey.has(key)) {
      const blob = blobs.get(key);
      if (!blob) throw new Error('Some image data is missing.');
      urlForKey.set(key, registerBlob(blob, key));
    }
    return urlForKey.get(key);
  };
}
/** A library item from its saved JSON. */
async function buildLibraryItem(s, urlOf) {
  const steps = s.steps.map((st) => ({ url: urlOf(st.key), w: st.w, h: st.h, ox: st.ox, oy: st.oy }));
  let finalUrl = s.finalKey ? urlOf(s.finalKey) : steps[steps.length - 1].url;
  if (!s.finalKey && lookNeedsRender({ ...lookCopies(s), outline: s.outline })) { // older saves: rebuild the finished look
    finalUrl = await canvasToUrl(renderSticker(await loadImage(steps[steps.length - 1].url), { ...lookCopies(s), outline: s.outline }, 0, { trim: true }));
  }
  const finalImg = await loadImage(finalUrl);
  return { id: s.id, name: s.name, use: s.use, count: s.count, outline: { ...s.outline }, ...lookCopies(s), steps, finalUrl, finalImg, tags: [...(s.tags || [])], size: s.size || 1, source: s.source || null };
}

/** Snapshot everything into { meta (JSON), blobs (Map key → Blob) }. */
async function serializeProject() {
  const blobs = new Map();
  const keyFor = async (url) => { const e = await blobEntry(url); blobs.set(e.key, e.blob); return e.key; };

  const lib = await serializeLibraryItems(library, keyFor);

  const meta = {
    app: 'collage-studio', version: PROJECT_VERSION, savedAt: new Date().toISOString(), name: projectName,
    print: serializePrint(),
    layout: layoutSettingsForSave(),
    library: lib,
    objects: serializeObjects(),
  };
  // the background image is stored like sticker images: by key, with its data in the blobs
  const bgUrl = meta.print.background?.imageUrl;
  if (bgUrl) {
    meta.print.background = { ...meta.print.background, imageKey: await keyFor(bgUrl) };
    delete meta.print.background.imageUrl;
  }
  return { meta, blobs };
}

function serializePrint() {
  return { mode: print.mode, w: print.w, h: print.h, unit: print.unit, dpi: print.dpi, pxW: print.pxW, pxH: print.pxH,
    bg: print.bg, preset: $('#sizePreset').value, background: { ...print.background }, guides: { ...print.guides } };
}

/** One sticker or text as plain JSON (positions are relative to its group, if it's in one). */
function serializeLeaf(o) {
  if (isSticker(o)) {
    return { kind: 'sticker', stickerId: o.stickerId, left: o.left, top: o.top, scaleX: o.scaleX, scaleY: o.scaleY,
      angle: o.angle, flipX: o.flipX, flipY: o.flipY, opacity: o.opacity, originX: o.originX, originY: o.originY,
      visible: o.visible !== false, locked: !!o.locked };
  }
  if (isText(o)) {
    const { path, ...props } = o.toObject(TEXT_PROPS); // the curve's path is rebuilt from "curve" when loading
    return { kind: 'text', props, locked: !!o.locked };
  }
  return null;
}

/** Objects on the print, in stacking order, as plain JSON. */
function serializeObjects() {
  return canvas.getObjects().map((o) => {
    // Objects inside a multi-selection store positions relative to it; record page positions instead.
    const groupTransform = canvas._realizeGroupTransformOnObject(o);
    try {
      if (isGroup(o)) {
        return { kind: 'group', name: o.groupName || '', left: o.left, top: o.top, width: o.width, height: o.height,
          scaleX: o.scaleX, scaleY: o.scaleY, angle: o.angle, flipX: o.flipX, flipY: o.flipY, originX: o.originX, originY: o.originY,
          opacity: o.opacity, visible: o.visible !== false, locked: !!o.locked, children: o.getObjects().map(serializeLeaf).filter(Boolean) };
      }
      return serializeLeaf(o);
    } finally {
      canvas._unwindGroupTransformOnObject(o, groupTransform);
    }
  }).filter(Boolean);
}

function buildLeaf(o, byId) {
  if (o.kind === 'sticker') {
    const item = byId.get(o.stickerId);
    if (!item) return null;
    const { kind, stickerId, locked, ...props } = o;
    const obj = makeStickerObject(item, props);
    setLocked(obj, locked);
    return obj;
  }
  if (o.kind === 'text') {
    const { type, version, text, path: _p, ...props } = o.props;
    const obj = new fabric.Textbox(text, props);
    syncLabelCaching(obj);
    if (obj.curve) applyCurve(obj);
    setLocked(obj, o.locked);
    return obj;
  }
  return null;
}

function addSerializedObjects(objects) {
  const byId = new Map(library.map((i) => [i.id, i]));
  for (const o of objects) {
    if (o.kind === 'group') {
      const children = o.children.map((c) => buildLeaf(c, byId)).filter(Boolean);
      if (!children.length) continue;
      const { kind, children: _c, locked, name, ...props } = o;
      const g = new fabric.Group(children, props, true); // children keep their positions inside the group
      g.groupName = name || '';
      setupGroup(g);
      setLocked(g, locked);
      canvas.add(g);
    } else {
      const obj = buildLeaf(o, byId);
      if (obj) canvas.add(obj);
    }
  }
  ensureFonts(textFontsInUse()); // web fonts may still be downloading
}

function applyPrintState(p) {
  Object.assign(print, p, { W: 0, H: 0 }); // W/H = 0 → no remapping of objects
  print.background = { ...DEFAULT_BACKGROUND, ...(p.background || {}) };
  print.guides = { ...DEFAULT_GUIDES, ...(p.guides || {}) };
  syncBackgroundUi();
  $('#sizePreset').value = p.preset || (print.mode === 'pixels' ? 'pixels' : 'custom');
  writePrintFields();
  $('#bgColor').value = print.bg;
  setBackground(print.bg);
  applyPrintSize();
}

/** Replace the current collage with a saved one. */
async function restoreProject(meta, blobs) {
  if (!meta || meta.app !== 'collage-studio') throw new Error('Not a stick.it project.');
  if (meta.version > PROJECT_VERSION) throw new Error('This project was saved by a newer version of the app.');
  persistReady = false;
  try {
    resetWorkspace();

    // print & layout settings
    setProjectName(meta.name);
    const pr = { ...meta.print, background: { ...(meta.print.background || {}) } };
    if (pr.background.imageKey) {
      const blob = blobs.get(pr.background.imageKey);
      pr.background.imageUrl = blob ? registerBlob(blob, pr.background.imageKey) : null;
      delete pr.background.imageKey;
    }
    applyPrintState(pr);
    applyLayoutSettings(meta.layout);

    // stickers
    const urlOf = urlMaker(blobs);
    let maxId = 0;
    for (const s of meta.library) {
      library.push(await buildLibraryItem(s, urlOf));
      maxId = Math.max(maxId, Number(String(s.id).replace(/\D/g, '')) || 0);
    }
    uid = Math.max(uid, maxId);

    addSerializedObjects(meta.objects);
    canvas.requestRenderAll();
    renderLibrary();
    updateCanvasStatus();
    refreshSelectionPanel();
  } finally {
    persistReady = true;
  }
}

function resetWorkspace() {
  canvas.discardActiveObject();
  canvas.getObjects().slice().forEach((o) => canvas.remove(o));
  library.splice(0, library.length);
}

// ---------------------------------------------------------------- undo / redo
// Each history entry is a JSON snapshot of the collage (print settings, sticker library, objects).
// Images aren't copied: entries refer to the object URLs, which stay alive for the session.
// One entry per user action (see markDirty). Actions that run in several async stages (uploading
// files, duplicating images) hold the history with holdHistory()/releaseHistory() so they stay one step.
const HISTORY_LIMIT = 100;
const hist = { stack: [], index: -1 };
let commitQueued = false, historyHold = 0, continuousPending = false;

function queueHistoryCommit() {
  if (commitQueued) return;
  commitQueued = true;
  setTimeout(() => { commitQueued = false; if (!historyHold) commitHistory(); }, 0); // after the current event finishes
}
function holdHistory() { historyHold++; }
function releaseHistory() {
  historyHold = Math.max(0, historyHold - 1);
  if (!historyHold) queueHistoryCommit();
}
const imgCache = new Map(); // finalUrl → loaded image, so undo doesn't re-decode

function snapshotState() {
  library.forEach((i) => imgCache.set(i.finalUrl, i.finalImg));
  return JSON.stringify({
    print: serializePrint(),
    library: library.map((i) => ({ id: i.id, name: i.name, use: i.use, count: i.count, outline: { ...i.outline }, ...lookCopies(i),
      steps: i.steps.map((s) => ({ ...s })), finalUrl: i.finalUrl, tags: [...(i.tags || [])], size: i.size || 1, source: i.source || null })),
    objects: serializeObjects(),
  });
}

function commitHistory() {
  continuousPending = false;
  if (!persistReady) return;
  const snap = snapshotState();
  if (snap === hist.stack[hist.index]) return; // e.g. only the selection changed
  hist.stack.splice(hist.index + 1);            // a new change drops the redo branch
  hist.stack.push(snap);
  if (hist.stack.length > HISTORY_LIMIT) hist.stack.shift();
  hist.index = hist.stack.length - 1;
  updateHistoryButtons();
}

function resetHistory() {
  continuousPending = false;
  hist.stack = [];
  hist.index = -1;
  commitHistory();
}

function updateHistoryButtons() {
  $('#btnUndo').disabled = hist.index <= 0;
  $('#btnRedo').disabled = hist.index >= hist.stack.length - 1;
}

function stepHistory(delta) {
  if (!persistReady || document.querySelector('dialog[open]')) return;
  const active = canvas.getActiveObject();
  if (active?.isEditing) active.exitEditing();
  if (commitQueued || continuousPending) commitHistory(); // record unfinished input first, so it can be undone too
  const target = hist.index + delta;
  if (target < 0 || target >= hist.stack.length) return;
  hist.index = target;
  applyState(hist.stack[target]);
  status(delta < 0 ? 'Undone.' : 'Redone.');
}
function undo() { stepHistory(-1); }
function redo() { stepHistory(1); }

function applyState(json) {
  const st = JSON.parse(json);
  persistReady = false;
  try {
    resetWorkspace();
    applyPrintState(st.print);
    for (const s of st.library) library.push({ ...s, tags: [...(s.tags || [])], finalImg: imgCache.get(s.finalUrl) });
    addSerializedObjects(st.objects);
    canvas.requestRenderAll();
    renderLibrary();
    updateCanvasStatus();
    refreshSelectionPanel();
  } finally {
    persistReady = true;
  }
  updateHistoryButtons();
  scheduleAutosave();
}

$('#btnUndo').addEventListener('click', undo);
$('#btnRedo').addEventListener('click', redo);

$('#btnSaveProject').addEventListener('click', async () => {
  const btn = $('#btnSaveProject');
  btn.disabled = true;
  status('Packing project…', true);
  try {
    const { meta, blobs } = await serializeProject();
    const file = encodeProjectFile(meta, blobs);
    const name = projectName === DEFAULT_PROJECT_NAME
      ? `collage-${new Date().toISOString().slice(0, 10)}.collage`
      : `${slugify(projectName)}.collage`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    status(`Saved ${name} (${(file.size / 1e6).toFixed(1)} MB). Use "Open" to continue from it later.`);
  } catch (e) {
    console.error(e); status('Could not save project: ' + e.message);
  } finally { btn.disabled = false; }
});

$('#btnOpenProject').addEventListener('click', () => $('#projectInput').click());
$('#projectInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  status(`Opening ${file.name}…`, true);
  try {
    await flushSave(); // the current collage stays in Projects
    const { meta, blobs } = await decodeProjectFile(file);
    await restoreProject(meta, blobs);
    if (!meta.name) setProjectName(file.name.replace(/\.collage$/i, '').replace(/[-_]+/g, ' ')); // older files had no name
    currentProjectId = newProjectId(); currentSaved = false; unsaved = true;
    await runAutosave(); // keep it as a new project right away
    resetHistory();
    status(`Opened ${file.name}.`);
  } catch (err) {
    console.error(err); status('Could not open project: ' + err.message);
  }
});

$('#btnNewProject').addEventListener('click', () => startNewProject());

window.addEventListener('beforeunload', (e) => {
  if (unsaved && (library.length || canvas.getObjects().length)) { e.preventDefault(); e.returnValue = ''; }
});

// ---------------------------------------------------------------- projects (several, kept in this browser)
let currentProjectId = null;
let currentSaved = false; // false until this project is first stored (an untouched new project isn't saved)
const newProjectId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const projectIsBlank = () => !library.length && !canvas.getObjects().length && projectName === DEFAULT_PROJECT_NAME;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** File-name-safe version of a name. */
function slugify(name, fallback = 'collage') {
  const slug = (name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60);
  return slug && name !== DEFAULT_PROJECT_NAME ? slug : fallback;
}

/** A small JPEG of the print for the projects list. */
async function makeThumbnail(maxSide = 320) {
  if (!print.W) return null;
  const s = maxSide / Math.max(print.W, print.H);
  const v = canvas.viewportTransform;
  const full = canvas.toCanvasElement(s / zoom, { left: v[4], top: v[5], width: (print.W + 1) * zoom, height: (print.H + 1) * zoom });
  const out = makeCanvas(Math.max(1, Math.round(print.W * s)), Math.max(1, Math.round(print.H * s)));
  const g = out.getContext('2d');
  g.scale(s, s);
  paintPage(g);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.drawImage(full, 0, 0);
  return canvasToBlob(out, 'image/jpeg', 0.8);
}

/** Finish any pending save of the current project (before switching away from it). */
async function flushSave() {
  for (let tries = 0; tries < 5; tries++) { // repeat if more changes arrive while saving
    clearTimeout(saveTimer);
    while (saving) await sleep(40);
    if (!unsaved) return;
    await runAutosave();
  }
}

async function openProject(id) {
  if (id === currentProjectId) return;
  await flushSave();
  status('Opening…', true);
  const saved = await loadProject(id);
  if (!saved) { status('That project could not be found.'); return; }
  await restoreProject(saved.meta, saved.blobs);
  currentProjectId = id; currentSaved = true; unsaved = false;
  await setSetting('currentProject', id);
  resetHistory();
  setSaveState('saved');
  status(`Opened “${projectName}”.`);
}

async function startNewProject({ save = true } = {}) {
  if (save) await flushSave();
  persistReady = false;
  clearTimeout(saveTimer);
  resetWorkspace();
  $('#bgColor').value = '#ffffff';
  print.background = { ...DEFAULT_BACKGROUND };
  print.guides = { ...DEFAULT_GUIDES };
  syncBackgroundUi();
  syncGuidesUi();
  setBackground('#ffffff');
  renderLibrary();
  updateCanvasStatus();
  refreshSelectionPanel();
  currentProjectId = newProjectId(); currentSaved = false; unsaved = false;
  persistReady = true;
  resetHistory();
  setSaveState('');
  setProjectName(DEFAULT_PROJECT_NAME);
  status('Started a new collage. Your other projects are under Projects.');
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ---- projects dialog
const pjDialog = $('#projectsDialog');
let pjThumbUrls = [];
const relTime = (t) => {
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const s = (t - Date.now()) / 1000;
  for (const [unit, sec] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (Math.abs(s) >= sec) return rtf.format(Math.round(s / sec), unit);
  }
  return 'just now';
};
async function renderProjects() {
  pjThumbUrls.forEach((u) => URL.revokeObjectURL(u));
  pjThumbUrls = [];
  const list = await listProjects();
  const grid = $('#pjGrid');
  grid.innerHTML = '';
  $('#pjEmpty').classList.toggle('hidden', list.length > 0);
  for (const p of list) {
    const card = document.createElement('div');
    const isCurrent = p.id === currentProjectId;
    card.className = 'pj-card' + (isCurrent ? ' current' : '');
    card.innerHTML = `
      <div class="pj-thumb checker"></div>
      <div class="pj-info"><div class="pj-name"></div><div class="hint pj-meta"></div><div class="hint pj-time"></div></div>
      <div class="row gap-sm wrap pj-actions">
        <button data-pj="open" class="primary">${isCurrent ? 'Open now' : 'Open'}</button>
        <button data-pj="dup">Duplicate</button>
        <button data-pj="dl" title="Download as a .collage file">Download</button>
        <button data-pj="del" class="danger">Delete</button>
      </div>`;
    if (p.thumb) {
      const url = URL.createObjectURL(p.thumb); pjThumbUrls.push(url);
      const im = document.createElement('img'); im.src = url; im.alt = '';
      card.querySelector('.pj-thumb').appendChild(im);
    }
    card.querySelector('.pj-name').textContent = p.name;
    const sm = p.summary || {};
    card.querySelector('.pj-meta').textContent = `${sm.size || ''} · ${sm.stickers ?? 0} sticker${sm.stickers === 1 ? '' : 's'} · ${sm.onPrint ?? 0} on the print`;
    card.querySelector('.pj-time').textContent = 'Saved ' + relTime(p.savedAt);
    card.querySelector('[data-pj=open]').disabled = isCurrent;
    card.querySelector('[data-pj=open]').addEventListener('click', async () => { pjDialog.close(); await openProject(p.id); });
    card.querySelector('[data-pj=dup]').addEventListener('click', async () => {
      if (isCurrent) await flushSave();
      await duplicateProject(p.id, newProjectId(), `${p.name} (copy)`);
      renderProjects();
    });
    card.querySelector('[data-pj=dl]').addEventListener('click', async () => {
      if (isCurrent) await flushSave();
      const saved = await loadProject(p.id);
      if (!saved) return;
      const file = encodeProjectFile(saved.meta, saved.blobs);
      downloadBlob(file, `${slugify(p.name)}.collage`);
    });
    card.querySelector('[data-pj=del]').addEventListener('click', async () => {
      if (!confirm(`Delete “${p.name}” from this browser? This can't be undone. (Download it first if you want to keep a copy.)`)) return;
      if (isCurrent) { clearTimeout(saveTimer); while (saving) await sleep(40); unsaved = false; }
      await deleteProject(p.id);
      if (isCurrent) {
        const rest = (await listProjects())[0];
        if (rest) { currentProjectId = null; await openProject(rest.id); } else await startNewProject({ save: false });
      }
      status(`Deleted “${p.name}”.`);
      renderProjects();
    });
    grid.appendChild(card);
  }
  renderStorageInfo();
}
async function renderStorageInfo() {
  if (!navigator.storage?.estimate) { $('#pjStorage').textContent = ''; return; }
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  const mb = (n) => (n / 1e6 >= 1000 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(0.1, n / 1e6).toFixed(1)} MB`);
  $('#pjStorage').textContent = `Using ${mb(usage)} of browser storage` + (quota ? ` (up to ${mb(quota)} available)` : '');
  const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : true;
  $('#pjPersist').classList.toggle('hidden', persisted);
}
$('#btnProjects').addEventListener('click', async () => {
  await flushSave(); // so the current project's card is up to date
  await renderProjects();
  pjDialog.showModal();
});
pjDialog.addEventListener('close', () => { pjThumbUrls.forEach((u) => URL.revokeObjectURL(u)); pjThumbUrls = []; });
$('#pjNew').addEventListener('click', async () => { pjDialog.close(); await startNewProject(); });
$('#pjImport').addEventListener('click', () => { pjDialog.close(); $('#projectInput').click(); });
$('#pjPersist').addEventListener('click', async () => {
  const ok = await navigator.storage.persist?.();
  status(ok ? 'The browser will keep this app’s projects even when space runs low.' : 'The browser didn’t agree — download important projects to keep a copy.');
  renderStorageInfo();
});

// ---------------------------------------------------------------- sticker collections
const collDialog = $('#collectionsDialog');
let collThumbUrls = [];
const newCollectionId = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const tickedShown = () => shownLibrary().filter((i) => i.use);

/** Small JPEG previews of stickers, for the collections list. */
async function stickerThumbs(items, max = 10) {
  const out = [];
  for (const it of items.slice(0, max)) {
    const s = 72 / Math.max(it.finalImg.width, it.finalImg.height);
    const c = makeCanvas(Math.max(1, Math.round(it.finalImg.width * s)), Math.max(1, Math.round(it.finalImg.height * s)));
    const g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(it.finalImg, 0, 0, c.width, c.height);
    out.push(await canvasToBlob(c, 'image/jpeg', 0.8));
  }
  return out;
}
async function collectionFromItems(items) {
  const blobs = new Map();
  const keyFor = async (url) => { const e = await blobEntry(url); blobs.set(e.key, e.blob); return e.key; };
  const entries = await serializeLibraryItems(items, keyFor);
  return { entries, blobs, thumbs: await stickerThumbs(items) };
}

async function renderCollections() {
  collThumbUrls.forEach((u) => URL.revokeObjectURL(u));
  collThumbUrls = [];
  const ticked = tickedShown().length;
  $('#collTickedInfo').textContent = ticked
    ? `${ticked} ticked sticker${ticked === 1 ? '' : 's'} in this project can be saved.`
    : 'Tick stickers in the Stickers list to save them as a collection.';
  $('#collSave').disabled = !ticked;
  const list = await listCollections();
  const box = $('#collList');
  box.innerHTML = '';
  $('#collEmpty').classList.toggle('hidden', list.length > 0);
  for (const col of list) {
    const row = document.createElement('div');
    row.className = 'coll-row';
    row.innerHTML = `
      <div class="coll-head"><b class="coll-name"></b> <span class="hint coll-count"></span></div>
      <div class="coll-thumbs"></div>
      <div class="row gap-sm wrap">
        <button data-c="use" class="primary">Add to this project</button>
        <button data-c="add" title="Add the ticked stickers of this project to the collection">Add ticked stickers</button>
        <button data-c="ren">Rename</button>
        <button data-c="del" class="danger">Delete</button>
      </div>`;
    row.querySelector('.coll-name').textContent = col.name;
    row.querySelector('.coll-count').textContent = `${col.items.length} sticker${col.items.length === 1 ? '' : 's'}`;
    for (const t of col.thumbs || []) {
      const url = URL.createObjectURL(t); collThumbUrls.push(url);
      const im = document.createElement('img'); im.src = url; im.alt = '';
      row.querySelector('.coll-thumbs').appendChild(im);
    }
    row.querySelector('[data-c=add]').disabled = !ticked;
    row.querySelector('[data-c=use]').addEventListener('click', async () => {
      const n = await addCollectionToProject(col.id);
      if (n) { collDialog.close(); status(`Added ${n} sticker${n === 1 ? '' : 's'} from “${col.name}”.`); }
    });
    row.querySelector('[data-c=add]').addEventListener('click', async () => {
      const loaded = await loadCollection(col.id);
      const extra = await collectionFromItems(tickedShown());
      const blobs = new Map([...loaded.blobs, ...extra.blobs]);
      await saveCollection(col.id, { name: col.name, items: [...loaded.record.items, ...extra.entries], thumbs: [...(loaded.record.thumbs || []), ...extra.thumbs].slice(0, 10) }, blobs);
      status(`Added ${extra.entries.length} sticker${extra.entries.length === 1 ? '' : 's'} to “${col.name}”.`);
      renderCollections();
    });
    row.querySelector('[data-c=ren]').addEventListener('click', async () => {
      const name = prompt('Rename collection', col.name);
      if (name && name.trim()) { await renameCollection(col.id, name.trim().slice(0, 60)); renderCollections(); }
    });
    row.querySelector('[data-c=del]').addEventListener('click', async () => {
      if (!confirm(`Delete the collection “${col.name}”? Stickers already added to projects stay there.`)) return;
      await deleteCollection(col.id);
      renderCollections();
    });
    box.appendChild(row);
  }
}
/** Copy a collection's stickers into the current project (one undo step). Returns how many were added. */
async function addCollectionToProject(id) {
  const loaded = await loadCollection(id);
  if (!loaded) return 0;
  holdHistory();
  try {
    const urlOf = urlMaker(loaded.blobs);
    let n = 0;
    for (const entry of loaded.record.items) {
      const item = await buildLibraryItem({ ...entry, id: newId(), use: true, count: entry.count || 1 }, urlOf);
      library.push(item);
      n++;
    }
    renderLibrary();
    return n;
  } catch (e) {
    console.error(e); status('Could not add that collection: ' + e.message); return 0;
  } finally { releaseHistory(); }
}
$('#btnCollections').addEventListener('click', async () => { await renderCollections(); collDialog.showModal(); });
collDialog.addEventListener('close', () => { collThumbUrls.forEach((u) => URL.revokeObjectURL(u)); collThumbUrls = []; });
$('#collSave').addEventListener('click', async () => {
  const items = tickedShown();
  if (!items.length) return;
  const name = ($('#collName').value.trim() || `Collection ${new Date().toLocaleDateString()}`).slice(0, 60);
  $('#collSave').disabled = true;
  try {
    const c = await collectionFromItems(items);
    await saveCollection(newCollectionId(), { name, items: c.entries, thumbs: c.thumbs }, c.blobs);
    $('#collName').value = '';
    status(`Saved ${items.length} sticker${items.length === 1 ? '' : 's'} as “${name}”.`);
  } finally { renderCollections(); }
});
$('#collName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#collSave').click(); });

// ---------------------------------------------------------------- licences & credits
// Stickers from image search (or a pasted link) remember where they came from: title, creator, licence
// and source page. That drives the licence chip in the library, warnings, and the credits list.

/** What a sticker's licence means in practice. */
function licenceFlags(src) {
  if (!src) return null; // the user's own image
  const l = src.license || '';
  return {
    unknown: src.provider === 'link' || src.provider === 'google' || /unknown|see source/i.test(l),
    nd: /\bND\b/i.test(l),                 // no derivatives: edits/cut-outs may not be allowed
    nc: /\bNC\b/i.test(l),                 // non-commercial
    sa: /\bSA\b/i.test(l),                 // share-alike
    credit: /\bBY\b|GFDL/i.test(l),        // attribution required
    free: /CC0|public domain|Unsplash|Pexels/i.test(l),
  };
}
function licenceShort(src) {
  const f = licenceFlags(src);
  if (!f) return '';
  return f.unknown ? 'Licence unknown' : src.license;
}
/** One line of credit text for a source. */
function creditLine(src) {
  if (src.provider === 'link') return `Image from ${src.pageUrl} (licence unknown)`;
  if (src.provider === 'unsplash' || src.provider === 'pexels') return `${src.attribution}: ${src.pageUrl}`;
  const by = src.creator ? ` by ${src.creator}` : '';
  const lic = src.license ? `, ${src.license}${src.licenseUrl ? ` (${src.licenseUrl})` : ''}` : '';
  return `“${src.title || 'Untitled'}”${by}${lic}. Source: ${src.pageUrl || src.source || 'unknown'}`;
}
function licenceNotes(src) {
  const f = licenceFlags(src);
  if (!f) return [];
  const notes = [];
  if (f.unknown) notes.push(['warn', 'The licence is unknown. Check the source page before printing, sharing or selling this.']);
  if (f.nd) notes.push(['bad', 'No derivatives (ND): the licence doesn’t allow changed versions, so cropping, cutting out or recolouring it may not be permitted.']);
  if (f.nc) notes.push(['warn', 'Non-commercial (NC): fine for a print for yourself, not for one you sell.']);
  if (f.credit) notes.push(['info', 'Credit required: include the credit line wherever you share or show the print (see Credits).']);
  if (f.sa) notes.push(['info', 'Share-alike (SA): if you share the finished collage, use the same licence.']);
  if (f.free && !f.credit) notes.push(['ok', 'Free to use and edit; a credit is appreciated but not required.']);
  return notes;
}

// the licence dialog (opened from a sticker's licence chip)
function showLicence(item) {
  const src = item.source;
  const box = $('#licenceBody');
  box.innerHTML = '';
  const row = (label, value, href) => {
    if (!value) return;
    const p = document.createElement('p');
    p.innerHTML = '<b></b> ';
    p.querySelector('b').textContent = label + ':';
    if (href) { const a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = value; p.appendChild(a); }
    else p.appendChild(document.createTextNode(value));
    box.appendChild(p);
  };
  row('Title', src.title);
  row('Creator', src.creator, src.creatorUrl);
  row('Licence', licenceShort(src), src.licenseUrl);
  row('From', src.source || src.provider);
  row('Source page', src.pageUrl ? 'Open the original' : '', src.pageUrl);
  for (const [kind, text] of licenceNotes(src)) {
    const n = document.createElement('p');
    n.className = 'lic-note ' + kind;
    n.textContent = text;
    box.appendChild(n);
  }
  const credit = document.createElement('p');
  credit.className = 'lic-credit';
  credit.textContent = creditLine(src);
  box.appendChild(credit);
  $('#licenceTitle').textContent = item.name;
  $('#licenceDialog').showModal();
}

// ---- credits list
function creditsText(scope) {
  const onPrint = onPrintCounts();
  const items = library.filter((i) => i.source && (scope === 'all' || onPrint[i.id]));
  const seen = new Set(), lines = [];
  for (const i of items) {
    const line = creditLine(i.source);
    const key = i.source.pageUrl || line;
    if (seen.has(key)) continue; // copies / duplicates of the same image are credited once
    seen.add(key);
    lines.push(line);
  }
  const own = library.filter((i) => !i.source && (scope === 'all' || onPrint[i.id])).length;
  const head = `Image credits — ${projectName}`;
  if (!lines.length) return { text: `${head}\n\nAll images are your own${own ? '' : ' (no stickers yet)'} — nothing to credit.`, count: 0 };
  return {
    text: `${head}\n\n${lines.map((l, n) => `${n + 1}. ${l}`).join('\n')}${own ? `\n\nPlus ${own} image${own === 1 ? '' : 's'} of your own.` : ''}\n`,
    count: lines.length,
  };
}
function renderCredits() {
  const { text, count } = creditsText($('#creditsScope').value);
  $('#creditsText').value = text;
  $('#creditsCount').textContent = count ? `${count} source${count === 1 ? '' : 's'} to credit.` : '';
}
$('#btnCredits').addEventListener('click', () => { renderCredits(); $('#creditsDialog').showModal(); });
$('#creditsScope').addEventListener('change', renderCredits);
$('#creditsCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#creditsText').value); status('Credits copied to the clipboard.'); }
  catch { $('#creditsText').select(); status('Select-all done — press Ctrl+C (⌘C) to copy.'); }
});
$('#creditsDownload').addEventListener('click', () => {
  downloadBlob(new Blob([$('#creditsText').value], { type: 'text/plain;charset=utf-8' }), `${slugify(projectName)}-credits.txt`);
});

// ---------------------------------------------------------------- theme
// 'auto' follows the system setting; the choice is remembered in this browser.
const THEMES = ['auto', 'dark', 'light'];
/** "◐ Auto" → icon plus a word that hides on narrower windows (the tooltip keeps the full name). */
function setIconLabel(btn, label) {
  const [icon, ...words] = label.split(' ');
  btn.textContent = icon;
  const span = document.createElement('span');
  span.className = 'lbl'; span.textContent = ' ' + words.join(' ');
  btn.appendChild(span);
}
const THEME_LABEL = { auto: '◐ Auto', dark: '☾ Dark', light: '☀ Light' };
let theme = 'auto';
try { theme = localStorage.getItem('collage.theme') || 'auto'; } catch { /* ignore */ }
function applyTheme() {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  setIconLabel($('#btnTheme'), THEME_LABEL[theme]);
  $('#btnTheme').title = 'Theme: ' + theme + ' (click to change)';
  readThemeColors();
}
$('#btnTheme').addEventListener('click', () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  try { localStorage.setItem('collage.theme', theme); } catch { /* ignore */ }
  applyTheme();
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readThemeColors);
applyTheme();

// Look: "Classic" (the original clean layout) or "Playful" (colours, rounded type and sticker-like
// buttons taken from the stick.it logo). Only styles change; it works with both light and dark.
const LOOK_LABEL = { classic: '▢ Classic', playful: '✦ Playful' };
let look = 'classic';
try { look = localStorage.getItem('collage.look') === 'playful' ? 'playful' : 'classic'; } catch { /* ignore */ }
function applyLook() {
  if (look === 'playful') {
    document.documentElement.setAttribute('data-look', 'playful');
    ensureUiFont();
  } else document.documentElement.removeAttribute('data-look');
  setIconLabel($('#btnLook'), LOOK_LABEL[look]);
  $('#btnLook').title = 'Look: ' + look + ' (click to switch between Classic and Playful)';
  readThemeColors();
}
function ensureUiFont() {
  if (document.getElementById('uiFont')) return;
  const l = document.createElement('link');
  l.id = 'uiFont'; l.rel = 'stylesheet';
  l.href = 'https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600&display=swap'; // kept for offline use by the service worker
  document.head.appendChild(l);
}
$('#btnLook').addEventListener('click', () => {
  look = look === 'playful' ? 'classic' : 'playful';
  try { localStorage.setItem('collage.look', look); } catch { /* ignore */ }
  applyLook();
});
applyLook();

// ---------------------------------------------------------------- offline & install
// The service worker (sw.js) keeps the app usable offline. Browsers only allow it on https or
// localhost, so it's skipped when the app is opened over the local network (http://<pc-ip>:5173).
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Offline support is unavailable:', e));
}
function syncOnline() {
  $('#offlineBadge').classList.toggle('hidden', navigator.onLine);
}
window.addEventListener('online', syncOnline);
window.addEventListener('offline', syncOnline);
syncOnline();

// "Install app": browsers that support it hand us a prompt we can show from our own button
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('#btnInstall').classList.remove('hidden');
});
$('#btnInstall').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null;
  $('#btnInstall').classList.add('hidden');
  if (outcome === 'accepted') status('Installed. stick.it now opens in its own window and works offline.');
});
window.addEventListener('appinstalled', () => $('#btnInstall').classList.add('hidden'));

// ---------------------------------------------------------------- boot
initPrintUi();
syncBackgroundUi();
syncGuidesUi();
syncSliderLabels();
applyViewPrefs();
setBackground('#ffffff');
applyPrintSize();
syncResponsiveLayout();
renderLibrary();
updateCanvasStatus();

(async () => {
  try {
    const id = await getSetting('currentProject');
    const saved = id && await loadProject(id);
    if (saved) {
      await restoreProject(saved.meta, saved.blobs);
      currentProjectId = id; currentSaved = true;
      setSaveState('saved');
      status(`Restored “${projectName}” from ${new Date(saved.savedAt).toLocaleString()}.`);
    }
  } catch (e) {
    console.error(e);
    status('Could not restore the autosaved collage: ' + e.message);
  } finally {
    if (!currentProjectId) currentProjectId = newProjectId();
    persistReady = true;
    resetHistory();
  }
})();

// exposed for debugging in the console
window.collage = { canvas, library, print, addToLibrary, generateCollage, serializeProject, restoreProject, get edView() { return { z: ev.z, ox: ev.ox, oy: ev.oy, fit: ev.fit, imgW: ev.imgW, imgH: ev.imgH }; }, get edTool() { return tool; }, get ed() { return ed; } };
