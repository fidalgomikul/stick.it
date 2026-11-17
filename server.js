// stick.it — tiny zero-dependency dev server.
// Serves the static app from ./public and provides helper endpoints:
//   GET /api/search?provider=…&q=…&page=1  → image search, results in one common format with licence info
//   GET /api/proxy?url=…                    → fetches a remote image so the browser can use it on a canvas
//                                             without CORS "tainting" (needed for export)
//   GET /api/config                         → which optional search providers have keys configured
//   GET /api/unsplash-download?loc=…        → tells Unsplash a photo was used (their API terms require it)
//
// Run:  node server.js            (then open http://localhost:5173)
// Search providers:
//   Openverse, Wikimedia Commons — free, no key needed
//   Unsplash  — set UNSPLASH_ACCESS_KEY=…  (free key: https://unsplash.com/developers)
//   Pexels    — set PEXELS_API_KEY=…       (free key: https://www.pexels.com/api/)
//   Google    — set GOOGLE_API_KEY=… and GOOGLE_CX=… (Custom Search; closed to new customers)

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 5173;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PROXY_BYTES = 25 * 1024 * 1024;
const UA = 'stick.it/0.1 (local dev)';
const PAGE_SIZE = 20;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/*
 * Every provider returns results shaped like:
 * { id, title, thumb, full, width, height, source, pageUrl,
 *   license, licenseUrl, creator, creatorUrl, attribution, provider, downloadLocation? }
 */

async function searchOpenverse(q, page, filters) {
  const url = new URL('https://api.openverse.org/v1/images/');
  url.searchParams.set('q', q);
  url.searchParams.set('page', String(page));
  url.searchParams.set('page_size', String(PAGE_SIZE)); // anonymous limit
  const types = [filters.editable && 'modification', filters.commercial && 'commercial'].filter(Boolean);
  if (types.length) url.searchParams.set('license_type', types.join(','));
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Openverse responded ${r.status}`);
  const data = await r.json();
  return (data.results || []).map((it) => {
    const license = it.license === 'cc0' ? 'CC0' : it.license === 'pdm' ? 'Public domain' : `CC ${(it.license || '').toUpperCase()} ${it.license_version || ''}`.trim();
    return {
      id: 'ov-' + it.id, provider: 'openverse',
      title: it.title || 'Untitled',
      thumb: it.thumbnail || it.url, full: it.url,
      width: it.width, height: it.height,
      source: it.source, pageUrl: it.foreign_landing_url,
      license, licenseUrl: it.license_url || '',
      creator: it.creator || '', creatorUrl: it.creator_url || '',
      attribution: it.attribution || '',
    };
  });
}

async function searchWikimedia(q, page, filters) {
  const url = new URL('https://commons.wikimedia.org/w/api.php');
  const params = {
    action: 'query', format: 'json', generator: 'search', gsrnamespace: '6',
    gsrsearch: `filetype:bitmap ${q}`, gsrlimit: String(PAGE_SIZE), gsroffset: String((page - 1) * PAGE_SIZE),
    prop: 'imageinfo', iiprop: 'url|size|extmetadata', iiurlwidth: '360',
    iiextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist|ObjectName|AttributionRequired|NonFree',
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Wikimedia Commons responded ${r.status}`);
  const data = await r.json();
  const pages = Object.values(data.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  return pages.map((p) => {
    const ii = p.imageinfo?.[0];
    if (!ii) return null;
    const md = ii.extmetadata || {};
    const license = stripHtml(md.LicenseShortName?.value) || 'See source page';
    const creator = stripHtml(md.Artist?.value);
    // a large rendition instead of a possibly huge original. Commons only serves standard thumbnail
    // widths (… 1920, 3840); other widths are refused, so ask for 3840 when the original is bigger.
    const step = (w) => ii.thumburl && ii.thumburl.replace(/\/\d+px-([^/]+)$/, `/${w}px-$1`);
    const full = ii.width > 3840 && ii.thumburl ? step(3840) : ii.url;
    // Commons rate-limits downloads of originals; if one is refused, the app falls back to this
    const fallbackWidth = [3840, 1920, 1280, 960].find((w) => w < ii.width);
    const fullFallback = fallbackWidth && ii.thumburl ? step(fallbackWidth) : '';
    const title = stripHtml(md.ObjectName?.value) || p.title.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '');
    return {
      id: 'wm-' + p.pageid, provider: 'wikimedia',
      title, thumb: ii.thumburl || ii.url, full, fullFallback,
      width: ii.width, height: ii.height,
      source: 'Wikimedia Commons', pageUrl: ii.descriptionurl,
      license, licenseUrl: md.LicenseUrl?.value || '',
      creator, creatorUrl: '',
      attribution: `"${title}"${creator ? ` by ${creator}` : ''}, ${license}, via Wikimedia Commons`,
      nonFree: md.NonFree?.value === 'true',
    };
  }).filter(Boolean).filter((it) => {
    if (it.nonFree) return false;
    if (filters.editable && /\bND\b/i.test(it.license)) return false;     // "no derivatives"
    if (filters.commercial && /\bNC\b/i.test(it.license)) return false;   // "non-commercial"
    return true;
  });
}

const utm = (u) => u && `${u}${u.includes('?') ? '&' : '?'}utm_source=stick_it&utm_medium=referral`; // Unsplash asks for these on links

async function searchUnsplash(q, page) {
  const url = new URL('https://api.unsplash.com/search/photos');
  url.searchParams.set('query', q);
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(PAGE_SIZE));
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Version': 'v1', Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` } });
  if (!r.ok) throw new Error(`Unsplash responded ${r.status}`);
  const data = await r.json();
  return (data.results || []).map((p) => ({
    id: 'us-' + p.id, provider: 'unsplash',
    title: p.alt_description || p.description || 'Unsplash photo',
    thumb: p.urls?.small, full: `${p.urls?.raw}&w=3000&fm=jpg&q=90`,
    width: p.width, height: p.height,
    source: 'Unsplash', pageUrl: utm(p.links?.html),
    license: 'Unsplash License', licenseUrl: 'https://unsplash.com/license',
    creator: p.user?.name || '', creatorUrl: utm(p.user?.links?.html),
    attribution: `Photo by ${p.user?.name || 'unknown'} on Unsplash`,
    downloadLocation: p.links?.download_location,
  }));
}

async function searchPexels(q, page) {
  const url = new URL('https://api.pexels.com/v1/search');
  url.searchParams.set('query', q);
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(PAGE_SIZE));
  const r = await fetch(url, { headers: { 'User-Agent': UA, Authorization: process.env.PEXELS_API_KEY } });
  if (!r.ok) throw new Error(`Pexels responded ${r.status}`);
  const data = await r.json();
  return (data.photos || []).map((p) => ({
    id: 'px-' + p.id, provider: 'pexels',
    title: p.alt || 'Pexels photo',
    thumb: p.src?.medium, full: `${p.src?.original}?auto=compress&cs=tinysrgb&w=3000`,
    width: p.width, height: p.height,
    source: 'Pexels', pageUrl: p.url,
    license: 'Pexels License', licenseUrl: 'https://www.pexels.com/license/',
    creator: p.photographer || '', creatorUrl: p.photographer_url || '',
    attribution: `Photo by ${p.photographer || 'unknown'} on Pexels`,
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
    id: `g${page}-${i}`, provider: 'google',
    title: it.title || 'Untitled',
    thumb: it.image?.thumbnailLink || it.link, full: it.link,
    width: it.image?.width, height: it.image?.height,
    source: it.displayLink, pageUrl: it.image?.contextLink,
    license: 'Unknown — check the source', licenseUrl: '',
    creator: '', creatorUrl: '', attribution: '',
  }));
}

const PROVIDERS = {
  openverse: { search: searchOpenverse, ready: () => true },
  wikimedia: { search: searchWikimedia, ready: () => true },
  unsplash: { search: searchUnsplash, ready: () => !!process.env.UNSPLASH_ACCESS_KEY, needs: 'UNSPLASH_ACCESS_KEY' },
  pexels: { search: searchPexels, ready: () => !!process.env.PEXELS_API_KEY, needs: 'PEXELS_API_KEY' },
  google: { search: searchGoogle, ready: () => !!(process.env.GOOGLE_API_KEY && process.env.GOOGLE_CX), needs: 'GOOGLE_API_KEY and GOOGLE_CX' },
};

async function handleSearch(reqUrl, res) {
  const q = (reqUrl.searchParams.get('q') || '').trim().slice(0, 200);
  const page = Math.max(1, Math.min(20, Number(reqUrl.searchParams.get('page')) || 1));
  const name = reqUrl.searchParams.get('provider') || 'openverse';
  const filters = { editable: reqUrl.searchParams.get('editable') === '1', commercial: reqUrl.searchParams.get('commercial') === '1' };
  const provider = PROVIDERS[name];
  if (!q) return sendJson(res, 400, { error: 'Missing query' });
  if (!provider) return sendJson(res, 400, { error: 'Unknown provider' });
  if (!provider.ready()) return sendJson(res, 400, { error: `This search needs a key on the server: set ${provider.needs} before starting it (see the README).` });
  try {
    return sendJson(res, 200, { provider: name, results: await provider.search(q, page, filters) });
  } catch (e) {
    return sendJson(res, 502, { error: e.message });
  }
}

/** Unsplash's API terms: when a photo is used, call its download_location (with our key). */
async function handleUnsplashDownload(reqUrl, res) {
  const loc = reqUrl.searchParams.get('loc') || '';
  if (!process.env.UNSPLASH_ACCESS_KEY || !/^https:\/\/api\.unsplash\.com\//.test(loc)) return sendJson(res, 400, { error: 'Bad request' });
  try {
    const r = await fetch(loc, { headers: { 'User-Agent': UA, Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` } });
    return sendJson(res, r.ok ? 200 : 502, { ok: r.ok });
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
    return sendJson(res, 200, Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) => [k, p.ready()])));
  }
  if (reqUrl.pathname === '/api/unsplash-download') return handleUnsplashDownload(reqUrl, res);
  return handleStatic(reqUrl, res);
}).listen(PORT, () => {
  console.log(`stick.it running at http://localhost:${PORT}`);
});
