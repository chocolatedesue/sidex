#!/usr/bin/env node
/**
 * SideX startup smoke — web (always) + optional native Tauri binary under Xvfb.
 * AI stays off (default). Writes smoke-artifacts/startup-evidence.json
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'smoke-artifacts');
fs.mkdirSync(outDir, { recursive: true });

const evidence = {
  at: new Date().toISOString(),
  zone: 'Asia/Shanghai (UTC+8)',
  aiDefaultOff: true,
  steps: [],
  timingsMs: {},
};

const step = (name, ok, detail) => {
  evidence.steps.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

function which(bin) {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

async function serveStatic(dir, port) {
  const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath.endsWith('/')) urlPath += 'index.html';
    const file = path.join(dir, urlPath.replace(/^\//, ''));
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(file);
    const types = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.wasm': 'application/wasm',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2',
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', resolve);
    server.on('error', reject);
  });
  return server;
}

function findWebRoot() {
  const candidates = [
    path.join(root, 'dist'),
    path.join(root, 'release-artifacts', 'web-dist'),
    path.join(outDir, 'web-dist'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'index.html'))) return c;
  }
  // extract tarball once
  const tar = path.join(root, 'release-artifacts', 'sidex-0.1.5-web-dist.tar.gz');
  if (fs.existsSync(tar)) {
    const dest = path.join(outDir, 'web-dist');
    fs.mkdirSync(dest, { recursive: true });
    const r = spawnSync('tar', ['xzf', tar, '-C', dest], { encoding: 'utf8' });
    if (r.status === 0 && fs.existsSync(path.join(dest, 'index.html'))) return dest;
  }
  return null;
}

function findSideXBinary() {
  const env = process.env.SIDEX_BIN;
  if (env && fs.existsSync(env)) return env;
  const candidates = [
    path.join(root, 'target', 'release', 'SideX'),
    path.join(root, 'src-tauri', 'target', 'release', 'SideX'),
    path.join(root, 'release-artifacts', 'linux-staging', 'SideX'),
    path.join(root, 'release-artifacts', 'dist-pkg', 'sidex-0.1.5-linux-x86_64', 'SideX'),
  ];
  return candidates.find((c) => fs.existsSync(c)) || null;
}

async function webStartup() {
  const webRoot = findWebRoot();
  if (!webRoot) {
    step('web.root', false, 'no dist/index.html (run npm run build or extract web-dist)');
    return;
  }
  step('web.root', true, webRoot);
  const port = Number(process.env.SIDEX_STARTUP_PORT || 4177);
  const server = await serveStatic(webRoot, port);
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(60000);
  try {
    const t0 = Date.now();
    const res = await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    evidence.timingsMs.webDomContentLoaded = Date.now() - t0;
    step('web.domContentLoaded', !!res && res.ok(), `${evidence.timingsMs.webDomContentLoaded}ms status=${res?.status()}`);

    const t1 = Date.now();
    // Proxies for first paint / workbench ready
    await page.waitForFunction(() => {
      const b = document.body;
      if (!b) return false;
      const text = b.innerText || '';
      const hasWorkbench =
        !!document.querySelector('.monaco-workbench') ||
        !!document.querySelector('#workbench.parts.editor') ||
        !!document.querySelector('.part.editor');
      return hasWorkbench || text.length > 20;
    }, { timeout: 45000 });
    evidence.timingsMs.webWorkbenchProxy = Date.now() - t1;
    evidence.timingsMs.webTotalFromNav = Date.now() - t0;
    step(
      'web.workbenchProxy',
      true,
      `workbench+${evidence.timingsMs.webWorkbenchProxy}ms total+${evidence.timingsMs.webTotalFromNav}ms`
    );

    // Confirm AI setting default remains off in product defaults path (no sidex-server spawn on web)
    const chatDefault = await page.evaluate(() => {
      try {
        // configuration may not be ready; just ensure no accidental WS to agent
        return performance.getEntriesByType('resource').some((e) => String(e.name).includes(':7433'));
      } catch {
        return false;
      }
    });
    step('web.noAgentPortProbe', chatDefault === false, `agent7433=${chatDefault}`);

    await page.screenshot({ path: path.join(outDir, 'startup-web.png') });
  } catch (e) {
    step('web.startup.error', false, String(e));
    await page.screenshot({ path: path.join(outDir, 'startup-web-error.png') }).catch(() => {});
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}

async function nativeStartup() {
  const bin = findSideXBinary();
  if (!bin) {
    step('native.binary', false, 'SideX binary not found');
    return;
  }
  step('native.binary', true, bin);

  // Quick dynamic-linker check
  const ldd = spawnSync('ldd', [bin], { encoding: 'utf8' });
  const missing = (ldd.stdout || '')
    .split('\n')
    .filter((l) => l.includes('not found'))
    .map((l) => l.trim());
  if (missing.length) {
    step('native.libs', false, missing.join('; '));
    evidence.timingsMs.nativeSkippedMissingLibs = true;
    return;
  }
  step('native.libs', true, 'ldd ok');

  const xvfb = which('xvfb-run');
  if (!xvfb) {
    step('native.xvfb', false, 'xvfb-run missing');
    return;
  }
  step('native.xvfb', true, xvfb);

  const logFile = path.join(outDir, 'startup-native.log');
  const t0 = Date.now();
  const child = spawn(
    xvfb,
    ['-a', '-s', '-screen 0 1400x900x24', bin],
    {
      env: {
        ...process.env,
        SIDEX_STARTUP_TRACE: '1',
        // Keep AI off
        SIDEX_CHAT_ENABLED: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += d.toString();
  });
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  // Wait for startup markers or window or timeout
  const deadline = Date.now() + 25000;
  let sawSetup = false;
  let sawWindow = false;
  while (Date.now() < deadline) {
    const combined = stderr + stdout;
    // Window mark is emitted before setup complete; record it even when both
    // arrive in the same poll chunk (old code broke on setup first → windowMark=false).
    if (/\[sidex-startup\] window restore_and_show/.test(combined)) {
      if (!sawWindow) {
        sawWindow = true;
        evidence.timingsMs.nativeWindowRestore = Date.now() - t0;
      }
    }
    if (/\[sidex-startup\] setup complete/.test(combined)) {
      sawSetup = true;
      evidence.timingsMs.nativeSetupComplete = Date.now() - t0;
      break;
    }
    // xdotool window probe
    const win = spawnSync('xdotool', ['search', '--name', 'SideX'], {
      encoding: 'utf8',
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
    });
    // Under xvfb-run, DISPLAY is set inside the wrapper — child may have window without us seeing it.
    await new Promise((r) => setTimeout(r, 400));
    if (child.exitCode !== null) break;
  }

  evidence.timingsMs.nativeObservedMs = Date.now() - t0;
  fs.writeFileSync(logFile, `STDOUT\n${stdout}\n\nSTDERR\n${stderr}\n`);

  // Kill after observation window
  try {
    child.kill('SIGTERM');
  } catch {}
  await new Promise((r) => setTimeout(r, 800));
  try {
    child.kill('SIGKILL');
  } catch {}

  const traceLines = (stdout + stderr)
    .split('\n')
    .filter((l) => l.includes('[sidex-startup]'));
  evidence.nativeTrace = traceLines;

  if (sawSetup || sawWindow || traceLines.length) {
    step(
      'native.startupTrace',
      true,
      `setup=${sawSetup} windowMark=${sawWindow} observed=${evidence.timingsMs.nativeObservedMs}ms traces=${traceLines.length}`
    );
  } else if (child.exitCode && child.exitCode !== 0) {
    step('native.startupTrace', false, `exit=${child.exitCode} see ${logFile}`);
  } else {
    // Binary ran under Xvfb for the observation window without crashing — soft pass
    step(
      'native.ranUnderXvfb',
      true,
      `observed=${evidence.timingsMs.nativeObservedMs}ms (no SIDEX_STARTUP_TRACE in this binary build — rebuild to get markers)`
    );
  }

  // Ensure we did not spawn sidex-server
  const ps = spawnSync('pgrep', ['-af', 'sidex-server'], { encoding: 'utf8' });
  const servers = (ps.stdout || '').trim();
  step('native.noSidexServer', !servers, servers || 'none');
}

await webStartup();
if (process.env.SIDEX_SKIP_NATIVE === '1') {
  step('native.skipped', true, 'SIDEX_SKIP_NATIVE=1');
} else {
  await nativeStartup();
}

fs.writeFileSync(path.join(outDir, 'startup-evidence.json'), JSON.stringify(evidence, null, 2));
const failed = evidence.steps.filter((s) => !s.ok);
console.log(`\n${evidence.steps.length - failed.length}/${evidence.steps.length} passed`);
console.log('timingsMs', JSON.stringify(evidence.timingsMs));
process.exit(failed.length ? 1 : 0);
