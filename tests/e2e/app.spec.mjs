// End-to-end tests: drive the app like a person would and check the results.
// Each test gets a fresh browser profile, so storage starts empty.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ICONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'icons');
const IMAGES = ['icon-192.png', 'apple-touch-icon.png', 'icon-512.png'].map((f) => join(ICONS, f)); // real PNGs to use as stickers

/** Open the app and fail the test on any page error or console error. */
async function openApp(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', (d) => d.accept()); // confirm() prompts
  await page.goto('/');
  await page.waitForFunction(() => window.collage && window.collage.print.W > 0);
  return errors;
}
const libraryNames = (page) => page.evaluate(() => window.collage.library.map((i) => i.name));
const objectCount = (page) => page.evaluate(() => window.collage.canvas.getObjects().length);
async function addImages(page, files = IMAGES) {
  const before = (await libraryNames(page)).length;
  await page.setInputFiles('#fileInput', files);
  await expect.poll(async () => (await libraryNames(page)).length).toBe(before + files.length);
}

test('loads cleanly and shows the AI notice', async ({ page }) => {
  const errors = await openApp(page);
  await expect(page.locator('.ai-note')).toContainText('no AI-generated images');
  await expect(page.locator('#libraryEmpty')).toBeVisible();
  expect(errors).toEqual([]);
});

test('upload, generate a layout, and undo one action at a time', async ({ page }) => {
  const errors = await openApp(page);
  await addImages(page);
  await page.evaluate(() => window.collage.library.forEach((i) => { i.count = 3; }));
  await page.selectOption('#genStyle', 'packed');
  await page.click('#btnGenerate');
  await expect.poll(() => objectCount(page)).toBe(9);
  // two separate deletes are two undo steps
  for (let k = 0; k < 2; k++) {
    await page.evaluate(() => { const c = window.collage.canvas; c.setActiveObject(c.getObjects()[0]); });
    await page.keyboard.press('Delete');
    await page.waitForTimeout(50);
  }
  await expect.poll(() => objectCount(page)).toBe(7);
  await page.click('#btnUndo');
  await expect.poll(() => objectCount(page)).toBe(8);
  await page.click('#btnUndo');
  await expect.poll(() => objectCount(page)).toBe(9);
  await page.click('#btnUndo'); // the whole generated layout was one step
  await expect.poll(() => objectCount(page)).toBe(0);
  await page.click('#btnRedo');
  await expect.poll(() => objectCount(page)).toBe(9);
  expect(errors).toEqual([]);
});

test('exports a PNG at the exact print size and a PDF with the trim size', async ({ page }) => {
  await openApp(page);
  await addImages(page, IMAGES.slice(0, 1));
  await page.click('#library .lib-item [data-act=place]');
  const { W, H } = await page.evaluate(() => ({ W: window.collage.print.W, H: window.collage.print.H }));

  await page.click('#btnExport');
  await page.selectOption('#exportFormat', 'png');
  const [png] = await Promise.all([page.waitForEvent('download'), page.click('#exportGo')]);
  const pngBytes = readFileSync(await png.path());
  expect(pngBytes.subarray(1, 4).toString()).toBe('PNG');
  expect([pngBytes.readUInt32BE(16), pngBytes.readUInt32BE(20)]).toEqual([W, H]); // IHDR width/height
  expect(pngBytes.includes(Buffer.from('pHYs'))).toBe(true); // DPI written into the file
  expect(png.suggestedFilename()).toMatch(/30x40cm-300dpi\.png$/);

  // with 3 mm bleed: the PDF page is larger, the TrimBox is exactly 30 × 40 cm
  await page.selectOption('#guideBleed', '3');
  await page.click('#btnExport');
  await page.selectOption('#exportFormat', 'pdf');
  const [pdf] = await Promise.all([page.waitForEvent('download'), page.click('#exportGo')]);
  const text = readFileSync(await pdf.path()).toString('latin1');
  expect(text.startsWith('%PDF-1.4')).toBe(true);
  const [, x0, y0, x1, y1] = text.match(/\/TrimBox \[([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)\]/).map(Number);
  expect(Math.abs(((x1 - x0) / 72) * 2.54 - 30)).toBeLessThan(0.01);
  expect(Math.abs(((y1 - y0) / 72) * 2.54 - 40)).toBeLessThan(0.01);
  expect(pdf.suggestedFilename()).toMatch(/-bleed3mm\.pdf$/);
});

test('sticker editor: removing a colour cuts out and trims, and Save updates the print', async ({ page }) => {
  await openApp(page);
  await addImages(page, IMAGES.slice(1, 2)); // the icon on a solid blue square
  await page.click('#library .lib-item [data-act=place]');
  await page.click('#library .lib-item [data-act=edit]');
  await page.waitForFunction(() => window.collage.edView.imgW > 0);
  await page.click('#edBgPick');
  // click the top-left corner pixel area of the image in the editor view
  const pt = await page.evaluate(() => {
    const v = window.collage.edView, r = document.querySelector('#edCanvas').getBoundingClientRect();
    return { x: r.left + v.ox + 4 * v.z, y: r.top + v.oy + 4 * v.z };
  });
  await page.mouse.click(pt.x, pt.y);
  await expect.poll(() => page.evaluate(() => window.collage.ed?.steps.length)).toBe(2);
  const step = await page.evaluate(() => window.collage.ed.steps.at(-1));
  expect(step.w).toBeLessThan(180); // the blue border was removed and trimmed away
  await page.check('#edOutline');
  await page.click('#edSave');
  await expect(page.locator('#editorDialog')).toBeHidden();
  const saved = await page.evaluate(() => ({ outline: window.collage.library[0].outline.on, onPrintUsesNewImage: window.collage.canvas.getObjects()[0]._element === window.collage.library[0].finalImg }));
  expect(saved).toEqual({ outline: true, onPrintUsesNewImage: true });
});

test('projects are kept, listed and reopened after a reload', async ({ page }) => {
  await openApp(page);
  await page.fill('#projectName', 'Trip to Lisbon');
  await page.press('#projectName', 'Enter');
  await addImages(page, IMAGES.slice(0, 2));
  await page.click('#btnProjects'); // opening the list saves the current project first
  await expect(page.locator('#pjGrid .pj-card')).toHaveCount(1);
  await expect(page.locator('#pjGrid .pj-card .pj-name')).toHaveText('Trip to Lisbon');
  await page.click('#pjNew');
  await expect.poll(async () => (await libraryNames(page)).length).toBe(0);
  await page.fill('#projectName', 'Second one');
  await page.press('#projectName', 'Enter');
  await addImages(page, IMAGES.slice(2, 3));
  await page.click('#btnProjects');
  await expect(page.locator('#pjGrid .pj-card')).toHaveCount(2);
  await page.keyboard.press('Escape');

  await page.reload();
  await page.waitForFunction(() => window.collage && window.collage.library.length === 1);
  await expect(page.locator('#projectName')).toHaveValue('Second one'); // reopens the last project
  await page.click('#btnProjects');
  await page.locator('#pjGrid .pj-card', { hasText: 'Trip to Lisbon' }).locator('[data-pj=open]').click();
  await expect(page.locator('#projectName')).toHaveValue('Trip to Lisbon');
  await expect.poll(async () => (await libraryNames(page)).length).toBe(2);
});

test('text, groups and layers', async ({ page }) => {
  const errors = await openApp(page);
  await addImages(page, IMAGES.slice(0, 2));
  await page.click('#library .lib-item:nth-child(1) [data-act=place]');
  await page.click('#library .lib-item:nth-child(2) [data-act=place]');
  await page.click('#btnAddText');
  await page.evaluate(() => window.collage.canvas.getActiveObject().exitEditing());
  await page.fill('#txtCurve', '50');
  await page.dispatchEvent('#txtCurve', 'input');
  expect(await page.evaluate(() => !!window.collage.canvas.getActiveObject().path)).toBe(true);
  // select everything and group it
  await page.click('#lySelectAll');
  await page.keyboard.press('Control+g');
  await expect(page.locator('#layerList .ly-gname')).toHaveText('Group · 3 items');
  expect(await objectCount(page)).toBe(1);
  await page.keyboard.press('Control+Shift+g');
  await expect.poll(() => objectCount(page)).toBe(3);
  expect(errors).toEqual([]);
});

test('works offline once it has been opened', async ({ page, context }) => {
  await openApp(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // now controlled by the service worker
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await addImages(page, IMAGES.slice(0, 1));
  await page.click('#btnProjects'); // save
  await page.keyboard.press('Escape');

  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => window.collage && window.collage.library.length === 1);
  await expect(page.locator('#offlineBadge')).toBeVisible();
  const answer = await page.evaluate(async () => (await fetch('/api/search?q=x')).status);
  expect(answer).toBe(503); // a clear "you're offline" reply instead of a hang
  await context.setOffline(false);
});
