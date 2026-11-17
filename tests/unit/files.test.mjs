// File formats: the .collage project file and the PDF writer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeProjectFile, decodeProjectFile } from '../../public/project.js';
import { jpegToPdf } from '../../public/pdf.js';

test('.collage file: project data and images survive a round trip', async () => {
  const meta = { app: 'collage-studio', version: 1, name: 'Ação & “quotes”', library: [{ id: 's1', steps: [{ key: 'a' }] }], objects: [] };
  const blobs = new Map([
    ['a', new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'image/png' })],
    ['b', new Blob([new Uint8Array(70000).fill(7)], { type: 'image/jpeg' })],
  ]);
  const file = encodeProjectFile(meta, blobs);
  const back = await decodeProjectFile(file);
  assert.deepEqual(back.meta, meta);
  assert.deepEqual([...back.blobs.keys()], ['a', 'b']);
  assert.deepEqual(new Uint8Array(await back.blobs.get('a').arrayBuffer()), new Uint8Array([1, 2, 3, 4, 5]));
  assert.equal(back.blobs.get('b').size, 70000);
  assert.equal(back.blobs.get('b').type, 'image/jpeg');
});

test('.collage file: other files are rejected with a clear message', async () => {
  await assert.rejects(decodeProjectFile(new Blob(['hello world, not a project'])), /not a stick\.it project/);
});

test('PDF: valid structure, exact page size and trim box, JPEG embedded intact', async () => {
  // a fake "JPEG": correct start/end markers are all the writer relies on
  const jpegBytes = new Uint8Array([0xff, 0xd8, ...new Array(1000).fill(0x42), 0xff, 0xd9]);
  const cm = (v) => (v / 2.54) * 72;
  const bleed = (3 / 25.4) * 72;
  const pdf = await jpegToPdf(new Blob([jpegBytes]), {
    widthPx: 100, heightPx: 140, widthPt: cm(30) + 2 * bleed, heightPt: cm(40) + 2 * bleed, bleedPt: bleed, title: 'Test (1)',
  });
  const bytes = new Uint8Array(await pdf.arrayBuffer());
  const text = new TextDecoder('latin1').decode(bytes);
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  // every object listed in the cross-reference table starts where it says
  const xrefAt = Number(text.match(/startxref\n(\d+)/)[1]);
  assert.ok(text.startsWith('xref\n0 7\n', xrefAt));
  const offsets = [...text.slice(xrefAt).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
  assert.equal(offsets.length, 6);
  offsets.forEach((o, i) => assert.ok(text.startsWith(`${i + 1} 0 obj`, o), `object ${i + 1} offset`));
  // page = trim + bleed; TrimBox = exactly 30 × 40 cm
  const [, tx0, ty0, tx1, ty1] = text.match(/\/TrimBox \[([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)\]/).map(Number);
  assert.ok(Math.abs((tx1 - tx0) - cm(30)) < 0.01 && Math.abs((ty1 - ty0) - cm(40)) < 0.01);
  // the JPEG is stored byte for byte
  const len = Number(text.match(/\/DCTDecode \/Length (\d+)/)[1]);
  const start = text.indexOf('stream\n', text.indexOf('/DCTDecode')) + 7;
  assert.equal(len, jpegBytes.length);
  assert.deepEqual(bytes.slice(start, start + len), jpegBytes);
  assert.match(text, /\/Title \(Test \\\(1\\\)\)/); // parentheses escaped
});
