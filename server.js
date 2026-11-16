// Collage Studio — tiny zero-dependency dev server.
// Serves the static app from ./public and provides two helper endpoints:
//   GET /api/search?q=...&page=1   → image search (Openverse by default, Google CSE if configured)
//   GET /api/proxy?url=...         → fetches a remote image so the browser can use it on a canvas
//                                    without CORS "tainting" (needed for export).
//
// Run:  node server.js            (then open http://localhost:5173)
// Optional Google Programmable Search (Custom Search JSON API):
//   set GOOGLE_API_KEY=...  and  set GOOGLE_CX=...   before starting.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 5173;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PROXY_BYTES = 25 * 1024 * 1024;
const UA = 'CollageStudio/0.1 (local dev)';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function searchOpenverse(q, page) {
  const url = new URL('https://api.openverse.org/v1/images/');
  url.searchParams.set('q', q);
  url.searchParams.set('page', String(page));
  url.searchParams.set('page_size', '20'); // anonymous limit
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Openverse responded ${r.status}`);
  const data = await r.json();
  return (data.results || []).map((it) => ({
    id: it.id,
    title: it.title || 'Untitled',
    thumb: it.thumbnail || it.url,
    full: it.url,
    width: it.width,
    height: it.height,
    source: it.source,
    pageUrl: it.foreign_landing_url,
    license: `${(it.license || '').toUpperCase()} ${it.license_version || ''}`.trim(),
    creator: it.creator || '',
  }));
}

async function searchGoogle(q, page) {
  const url = new URL('https://www.googleapis.com/customsearch/v1');
  url.searchParams.set('key', process.env.GOOGLE_API_KEY);
  url.searchParams.set('cx', process.env.GOOGLE_CX);
  url.searchParams.set('q', q);
  url.searchParams.set('searchType', 'image');
  url.searchParams.set('num', '10');
  url.searchParams.set('start', String((page - 1) * 10 + 1));
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`Google responded ${r.status}`);
  const data = await r.json();
  return (data.items || []).map((it, i) => ({
    id: `g${page}-${i}`,
    title: it.title || 'Untitled',
    thumb: it.image?.thumbnailLink || it.link,
    full: it.link,
    width: it.image?.width,
    height: it.image?.height,
    source: it.displayLink,
    pageUrl: it.image?.contextLink,
    license: 'Unknown — check source',
    creator: '',
  }));
}

async function handleSearch(reqUrl, res) {
  const q = (reqUrl.searchParams.get('q') || '').trim();
  const page = Math.max(1, Math.min(20, Number(reqUrl.searchParams.get('page')) || 1));
  const wanted = reqUrl.searchParams.get('provider') || 'openverse';
  if (!q) return sendJson(res, 400, { error: 'Missing query' });
  const googleReady = !!(process.env.GOOGLE_API_KEY && process.env.GOOGLE_CX);
  try {
    if (wanted === 'google') {
      if (!googleReady) return sendJson(res, 400, { error: 'Google search is not configured on the server (set GOOGLE_API_KEY and GOOGLE_CX).' });
      return sendJson(res, 200, { provider: 'google', results: await searchGoogle(q, page) });
    }
    return sendJson(res, 200, { provider: 'openverse', results: await searchOpenverse(q, page) });
  } catch (e) {
    return sendJson(res, 502, { error: e.message });
  }
}

async function handleProxy(reqUrl, res) {
  const target = reqUrl.searchParams.get('url');
  let parsed;
  try { parsed = new URL(target); } catch { return sendJson(res, 400, { error: 'Bad url' }); }
  if (!/^https?:$/.test(parsed.protocol)) return sendJson(res, 400, { error: 'Only http(s) allowed' });
  // Don't let the proxy be used to reach the local network.
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[::1\])/i.test(parsed.hostname)) {
    return sendJson(res, 400, { error: 'Local addresses are not allowed' });
  }
  try {
    const r = await fetch(parsed, { headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' /* like a browser; some hosts reject image/* alone (406) */ }, redirect: 'follow' });
    const type = r.headers.get('content-type') || '';
    if (!r.ok) return sendJson(res, 502, { error: `Upstream responded ${r.status}` });
    if (!type.startsWith('image/')) return sendJson(res, 415, { error: `Not an image (${type})` });
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_PROXY_BYTES) return sendJson(res, 413, { error: 'Image too large' });
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=3600' });
    res.end(buf);
  } catch (e) {
    return sendJson(res, 502, { error: e.message });
  }
}

function handleStatic(reqUrl, res) {
  let rel = decodeURIComponent(reqUrl.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  if (reqUrl.pathname === '/api/search') return handleSearch(reqUrl, res);
  if (reqUrl.pathname === '/api/proxy') return handleProxy(reqUrl, res);
  if (reqUrl.pathname === '/api/config') {
    return sendJson(res, 200, { google: !!(process.env.GOOGLE_API_KEY && process.env.GOOGLE_CX) });
  }
  return handleStatic(reqUrl, res);
}).listen(PORT, () => {
  console.log(`Collage Studio running at http://localhost:${PORT}`);
});
