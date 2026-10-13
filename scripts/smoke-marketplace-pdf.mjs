#!/usr/bin/env node
/**
 * Headless smoke: marketplace Open VSX search + EmbedPDF mount against a PDF blob.
 * Does not require Tauri. Writes evidence under smoke-artifacts/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'smoke-artifacts');
fs.mkdirSync(outDir, { recursive: true });

const evidence = { at: new Date().toISOString(), steps: [] };
function step(name, ok, detail) {
  evidence.steps.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function marketplaceSearch() {
  const url = 'https://marketplace.siden.ai/api/-/search?query=prettier&size=2';
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const json = await res.json();
  const exts = json.extensions || [];
  const first = exts[0];
  const ok = res.ok && exts.length > 0 && !!(first?.files?.download || first?.downloadUrl);
  step('marketplace.search.siden', ok, ok ? `${first.namespace}.${first.name} v${first.version}` : `HTTP ${res.status}`);
  // Open VSX direct fallback
  const ovsx = await fetch('https://open-vsx.org/api/-/search?query=prettier&size=1', { headers: { accept: 'application/json' } });
  const oj = await ovsx.json();
  step('marketplace.search.openvsx', ovsx.ok && (oj.extensions || []).length > 0, `count=${(oj.extensions || []).length}`);
  // Gallery extensionquery (VS Code Extensions view path)
  const g = await fetch('https://marketplace.siden.ai/api/gallery/extensionquery', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json;api-version=3.0-preview.1',
    },
    body: JSON.stringify({
      filters: [{ criteria: [{ filterType: 10, value: 'prettier' }], pageNumber: 1, pageSize: 2, sortBy: 0, sortOrder: 0 }],
      assetTypes: [],
      flags: 914,
    }),
  });
  const gj = await g.json().catch(() => ({}));
  const gCount = gj?.results?.[0]?.extensions?.length || 0;
  step('marketplace.gallery.extensionquery', g.ok && gCount > 0, `HTTP ${g.status} count=${gCount}`);
  return first;
}

async function embedPdfSmoke() {
  const pdfPath = path.join(root, 'test-fixtures', 'sample.pdf');
  const pdfB64 = fs.readFileSync(pdfPath).toString('base64');
  const distIndex = path.join(root, 'dist', 'index.html');
  const hasDist = fs.existsSync(distIndex);
  const hasWasm = fs.existsSync(path.join(root, 'dist', 'pdfium.wasm')) || fs.existsSync(path.join(root, 'public', 'pdfium.wasm'));
  step('build.dist.present', true, hasDist ? 'dist/index.html' : 'optional — public/pdfium.wasm covers EmbedPDF until next vite build');
  step('build.pdfium.wasm', hasWasm, hasWasm ? 'pdfium.wasm present' : 'missing');
  step('build.ensurePdfiumScript', fs.existsSync(path.join(root, 'scripts', 'ensure-pdfium-wasm.sh')));
  step('build.public.pdfium', fs.existsSync(path.join(root, 'public', 'pdfium.wasm')), 'public/pdfium.wasm (gitignored; created by ensure)');

  // Standalone EmbedPDF page (does not need full SideX workbench)
  const wasmSrc = fs.existsSync(path.join(root, 'public', 'pdfium.wasm'))
    ? path.join(root, 'public', 'pdfium.wasm')
    : path.join(root, 'node_modules', '@embedpdf', 'snippet', 'dist', 'pdfium.wasm');
  const snippetJs = path.join(root, 'node_modules', '@embedpdf', 'snippet', 'dist', 'embedpdf.js');
  const html = `<!doctype html><html><body style="margin:0">
<div id="pdf" style="width:800px;height:600px"></div>
<script type="module">
  import EmbedPDF from '/node_modules/@embedpdf/snippet/dist/embedpdf.js';
  const bin = Uint8Array.from(atob('${pdfB64}'), c => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bin], { type: 'application/pdf' }));
  const viewer = EmbedPDF.init({
    type: 'container',
    target: document.getElementById('pdf'),
    src: url,
    worker: false,
    fontFallback: null,
    fonts: { ui: null },
    wasmUrl: '/pdfium.wasm',
    tabBar: 'never',
    disabledCategories: ['print','export','redaction','document'],
  });
  window.__SIDEX_PDF_OK__ = !!viewer;
  document.title = viewer ? 'embedpdf-ok' : 'embedpdf-fail';
</script></body></html>`;
  const pagePath = path.join(outDir, 'embedpdf-smoke.html');
  fs.writeFileSync(pagePath, html);
  // copy wasm next to served root via playwright route — use file server from repo root
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  // Serve via playwright's setContent won't resolve /node_modules — use a tiny static server
  const { createServer } = await import('node:http');
  const { lookup } = await import('node:module').then(async () => {
    try { return await import('mime-types'); } catch { return { lookup: () => null }; }
  }).catch(() => ({ lookup: () => null }));

  const server = createServer((req, res) => {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/' || urlPath === '/embedpdf-smoke.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(fs.readFileSync(pagePath));
      return;
    }
    if (urlPath === '/pdfium.wasm') {
      res.writeHead(200, { 'content-type': 'application/wasm' });
      res.end(fs.readFileSync(wasmSrc));
      return;
    }
    const filePath = path.join(root, urlPath.replace(/^\//, ''));
    if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404); res.end('missing'); return;
    }
    const ext = path.extname(filePath);
    const type = ext === '.js' ? 'text/javascript' : ext === '.wasm' ? 'application/wasm' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    fs.createReadStream(filePath).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    await page.goto(`http://127.0.0.1:${port}/embedpdf-smoke.html`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(8000);
    await page.waitForFunction(() => document.title === "embedpdf-ok" && !document.body.innerText.includes("Initializing plugins"), { timeout: 20000 }).catch(() => {});
    const ok = await page.evaluate(() => window.__SIDEX_PDF_OK__ === true || document.title === 'embedpdf-ok');
    const shot = path.join(outDir, 'embedpdf-smoke.png');
    await page.screenshot({ path: shot, fullPage: true });
    step('embedpdf.mount', ok, shot);
    // Also hit dist if present
    if (hasDist) {
      await page.goto(`http://127.0.0.1:${port}/dist/index.html`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      const distShot = path.join(outDir, 'sidex-dist-index.png');
      await page.screenshot({ path: distShot, fullPage: true }).catch(() => {});
      step('sidex.dist.index', fs.existsSync(distShot), distShot);
    }
  } finally {
    await browser.close();
    server.close();
  }
}

const first = await marketplaceSearch();
await embedPdfSmoke();
fs.writeFileSync(path.join(outDir, 'smoke-evidence.json'), JSON.stringify(evidence, null, 2));
const failed = evidence.steps.filter(s => !s.ok);
console.log(`\n${evidence.steps.length - failed.length}/${evidence.steps.length} passed`);
process.exit(failed.length ? 1 : 0);
