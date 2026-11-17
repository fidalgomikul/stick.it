// Layout engine: every style places every sticker, keeps them inside the margins, and the
// "packed" style never overlaps stickers or locked items. (The "shape" style needs a browser canvas
// for its mask, so it's covered by the end-to-end tests.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout } from '../../public/layouts.js';

const W = 3543, H = 4724, m = 100;
const area = { l: m, t: m, r: W - m, b: H - m };
const items = (n) => Array.from({ length: n }, (_, i) => ({ iw: [400, 600, 300][i % 3], ih: [400, 300, 500][i % 3], weight: 1 }));
const base = { area, base: 0.22 * W, variation: 0.2, maxRot: 20, overlap: 0, bleed: false, outward: false, obstacles: [] };
const toRad = (d) => (d * Math.PI) / 180;

/** Corners of a placed sticker (w × h scaled by s, rotated by angle around x, y). */
function corners(p, it) {
  const w = it.iw * p.s, h = it.ih * p.s, a = toRad(p.angle), c = Math.cos(a), s = Math.sin(a);
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => [p.x + x * c - y * s, p.y + x * s + y * c]);
}
/** Separating-axis test for two convex quadrilaterals. */
function overlaps(A, B) {
  for (const poly of [A, B]) {
    for (let i = 0; i < 4; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % 4], nx = y2 - y1, ny = x1 - x2;
      const proj = (P) => P.map(([x, y]) => x * nx + y * ny);
      const a = proj(A), b = proj(B);
      if (Math.max(...a) <= Math.min(...b) || Math.max(...b) <= Math.min(...a)) return false;
    }
  }
  return true;
}
const inside = (pts) => pts.every(([x, y]) => x >= area.l - 1 && x <= area.r + 1 && y >= area.t - 1 && y <= area.b + 1);

for (const style of ['scatter', 'pile', 'packed', 'grid', 'circle']) {
  test(`${style}: places every sticker inside the margins`, () => {
    const list = items(18);
    const { placements, skipped } = computeLayout({ ...base, style, items: list });
    assert.equal(placements.length + skipped, 18);
    assert.equal(skipped, 0);
    for (const p of placements) assert.ok(inside(corners(p, list[p.idx])), `${style}: sticker ${p.idx} crosses the margin`);
  });
}

test('packed: no two stickers overlap, even rotated and with many copies', () => {
  for (const maxRot of [0, 25, 90]) {
    const list = items(60);
    const { placements } = computeLayout({ ...base, style: 'packed', items: list, maxRot });
    const quads = placements.map((p) => corners(p, list[p.idx]));
    for (let i = 0; i < quads.length; i++) for (let j = i + 1; j < quads.length; j++) {
      assert.ok(!overlaps(quads[i], quads[j]), `stickers ${i} and ${j} overlap at maxRot ${maxRot}`);
    }
  }
});

test('locked items (obstacles) are avoided by packed and scatter', () => {
  const obstacle = { x: W / 2, y: H / 2, hw: 400, hh: 500 };
  const box = [[obstacle.x - obstacle.hw, obstacle.y - obstacle.hh], [obstacle.x + obstacle.hw, obstacle.y - obstacle.hh], [obstacle.x + obstacle.hw, obstacle.y + obstacle.hh], [obstacle.x - obstacle.hw, obstacle.y + obstacle.hh]];
  for (const style of ['packed', 'scatter']) {
    const list = items(12);
    const { placements } = computeLayout({ ...base, style, items: list, obstacles: [obstacle], maxRot: 0 });
    for (const p of placements) assert.ok(!overlaps(corners(p, list[p.idx]), box), `${style} covered the locked item`);
  }
});

test('size weights scale stickers (scatter, no variation)', () => {
  const list = [{ iw: 400, ih: 400, weight: 1 }, { iw: 400, ih: 400, weight: 2 }];
  const { placements } = computeLayout({ ...base, style: 'scatter', variation: 0, items: list });
  const s = Object.fromEntries(placements.map((p) => [p.idx, p.s]));
  assert.ok(Math.abs(s[1] / s[0] - 2) < 1e-9);
});

test('bleed lets stickers run off the page edge', () => {
  let over = 0;
  for (let k = 0; k < 5; k++) {
    const list = items(30);
    const { placements } = computeLayout({ ...base, style: 'scatter', bleed: true, area: { l: 0, t: 0, r: W, b: H }, items: list });
    over += placements.filter((p) => corners(p, list[p.idx]).some(([x, y]) => x < 0 || y < 0 || x > W || y > H)).length;
  }
  assert.ok(over > 0);
});
