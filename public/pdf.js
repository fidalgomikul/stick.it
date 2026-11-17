// Minimal PDF writer: one page showing one JPEG image at an exact physical size.
// No library needed — a PDF is a small text structure plus the JPEG bytes (which PDF can embed as-is
// with the DCTDecode filter). With bleed, the page (MediaBox/BleedBox) includes the bleed and the
// TrimBox marks the final size, which is what print shops' software expects.

const enc = new TextEncoder();

/** Escape text for a PDF literal string; anything outside printable ASCII becomes '?'. */
function pdfString(s) {
  return '(' + String(s).replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1') + ')';
}
const num = (n) => +n.toFixed(3);

/**
 * @param {Blob} jpeg      baseline RGB JPEG
 * @param {object} o
 * @param {number} o.widthPx, o.heightPx   image size in pixels
 * @param {number} o.widthPt, o.heightPt   page size in points (1/72 in), including any bleed
 * @param {number} [o.bleedPt=0]           bleed on each side, in points
 * @param {string} [o.title]
 * @returns {Promise<Blob>} application/pdf
 */
export async function jpegToPdf(jpeg, o) {
  const img = new Uint8Array(await jpeg.arrayBuffer());
  const parts = [], offsets = [];
  let pos = 0;
  const push = (d) => { const u = typeof d === 'string' ? enc.encode(d) : d; parts.push(u); pos += u.length; };
  const obj = (n, body) => { offsets[n] = pos; push(`${n} 0 obj\n${body}\nendobj\n`); };

  const w = num(o.widthPt), h = num(o.heightPt), b = num(o.bleedPt || 0);
  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // marks the file as binary

  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /BleedBox [0 0 ${w} ${h}] `
    + `/TrimBox [${b} ${b} ${num(w - b)} ${num(h - b)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  offsets[4] = pos;
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${o.widthPx} /Height ${o.heightPx} /ColorSpace /DeviceRGB `
    + `/BitsPerComponent 8 /Filter /DCTDecode /Length ${img.length} >>\nstream\n`);
  push(img);
  push('\nendstream\nendobj\n');
  const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
  const stamp = `D:${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
  obj(6, `<< /Title ${pdfString(o.title || 'Collage')} /Producer (Collage Studio) /CreationDate (${stamp}) >>`);

  const xref = pos;
  let table = 'xref\n0 7\n0000000000 65535 f \n';
  for (let n = 1; n <= 6; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`; // 20 bytes each
  push(table);
  push(`trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}
