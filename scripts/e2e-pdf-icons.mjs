/**
 * Native Xvfb E2E: open sample.pdf, assert page pixels (not empty dark),
 * and assert explorer file icons are painted (seti theme).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'smoke-artifacts', 'e2e-pdf-icons');
fs.mkdirSync(out, { recursive: true });
const DISPLAY = process.env.SIDEX_E2E_DISPLAY || ':110';
const evidence = { at: new Date().toISOString(), zone: 'Asia/Shanghai (UTC+8)', display: DISPLAY, steps: [] };
const step = (name, ok, detail) => {
  evidence.steps.push({ name, ok, detail: detail && String(detail).slice(0, 500) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
};
const sh = (cmd, opts = {}) => spawnSync('bash', ['-lc', cmd], { encoding: 'utf8', ...opts });

function analyzePng(file, regionPy) {
  const py = `
from PIL import Image
im=Image.open(${JSON.stringify(file)}).convert('RGB')
w,h=im.size
${regionPy}
px=list(crop.getdata())
avg=tuple(sum(c[i] for c in px)//len(px) for i in range(3))
white=sum(1 for a,b,c in px if a>230 and b>230 and c>230)
colorful=sum(1 for a,b,c in px if max(a,b,c)-min(a,b,c)>28 and 50<a+b+c<720)
print(w,h,avg[0],avg[1],avg[2],white,colorful,len(px))
`;
  const r = spawnSync('python3', ['-c', py], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || 'pillow failed');
  const [W,H,ar,ag,ab,white,colorful,n] = r.stdout.trim().split(/\s+/).map(Number);
  return { w:W, h:H, avg:[ar,ag,ab], white, colorful, n };
}

sh(`bash "${root}/scripts/ensure-pdfium-wasm.sh"`);
const dist = path.join(root, 'dist');
step('dist.theme-seti', fs.existsSync(path.join(dist, 'extensions/theme-seti/icons/seti.woff')));
step('dist.builtin-theme-seti', fs.readFileSync(path.join(dist, 'builtin-extensions.js'), 'utf8').includes('theme-seti'));

sh(`fuser -k 1420/tcp 2>/dev/null || true; pkill -f 'python3 - .*1420' 2>/dev/null || true; sleep 0.3`);
execSync(`bash "${root}/scripts/ensure-frontend-server.sh" "${dist}"`, { stdio: 'inherit' });
step('http.pdfium', /200/.test(sh('curl -sI http://127.0.0.1:1420/pdfium.wasm').stdout || ''));
step('http.seti.woff', /200/.test(sh('curl -sI http://127.0.0.1:1420/extensions/theme-seti/icons/seti.woff').stdout || ''));

// Fresh Xvfb
sh(`pkill -f 'Xvfb\\\\s*${DISPLAY}' 2>/dev/null || true; pkill -f 'openbox' 2>/dev/null || true; sleep 0.4`);
const xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1280x800x24', '-ac', '+extension', 'GLX'], {
  stdio: 'ignore', detached: true,
});
xvfb.unref();
for (let i = 0; i < 20; i++) {
  const r = sh(`DISPLAY=${DISPLAY} xdpyinfo >/dev/null 2>&1 && echo OK`);
  if (r.stdout.includes('OK')) break;
  sh('sleep 0.25');
}
step('xvfb', /OK/.test(sh(`DISPLAY=${DISPLAY} xdpyinfo >/dev/null 2>&1 && echo OK`).stdout || ''), DISPLAY);
spawn('openbox', [], { env: { ...process.env, DISPLAY }, stdio: 'ignore', detached: true }).unref();
sh('sleep 0.4');

const ws = '/tmp/sidex-e2e-pdf-icons';
fs.rmSync(ws, { recursive: true, force: true });
fs.mkdirSync(ws, { recursive: true });
fs.copyFileSync(path.join(root, 'test-fixtures/sample.pdf'), path.join(ws, 'sample.pdf'));
fs.writeFileSync(path.join(ws, 'hello.js'), 'console.log(1)\n');
fs.writeFileSync(path.join(ws, 'sample.md'), '# hi\n');

const bin = path.join(root, 'target/release/SideX');
step('native.binary', fs.existsSync(bin), bin);
sh(`pkill -f 'target/release/SideX' 2>/dev/null || true; sleep 0.3`);

const log = path.join(out, 'sidex.log');
const child = spawn(bin, [ws], {
  env: {
    ...process.env,
    DISPLAY,
    SIDEX_STARTUP_TRACE: '1',
    SIDEX_CHAT_ENABLED: 'false',
    WEBKIT_DISABLE_COMPOSITING_MODE: '1',
    WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS: '1',
    LIBGL_ALWAYS_SOFTWARE: '1',
    NO_AT_BRIDGE: '1',
  },
  stdio: ['ignore', fs.openSync(log, 'w'), fs.openSync(log, 'a')],
  detached: true,
});
child.unref();
fs.writeFileSync(path.join(out, 'sidex.pid'), String(child.pid));

let win = '';
for (let i = 0; i < 60; i++) {
  sh('sleep 0.5');
  const r = sh(`DISPLAY=${DISPLAY} xdotool search --name SideX 2>/dev/null | head -1`);
  if (r.stdout.trim()) { win = r.stdout.trim(); break; }
  // also any mapped window
  if (i === 20) {
    const tree = sh(`DISPLAY=${DISPLAY} xwininfo -root -tree 2>/dev/null | head -30`);
    fs.writeFileSync(path.join(out, 'xwininfo.txt'), tree.stdout + tree.stderr);
  }
}
step('window', !!win, win || `none; log=${fs.readFileSync(log,'utf8').slice(0,300)}`);
if (!win) {
  fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
  process.exit(1);
}

sh(`DISPLAY=${DISPLAY} xdotool windowactivate --sync ${win} windowsize ${win} 1280 800 windowmove ${win} 0 0`);
sh('sleep 3');

sh(`DISPLAY=${DISPLAY} xdotool key --window ${win} ctrl+shift+e`);
sh('sleep 1.2');
const explorerShot = path.join(out, '01-explorer.png');
sh(`DISPLAY=${DISPLAY} scrot ${JSON.stringify(explorerShot)}`);

sh(`DISPLAY=${DISPLAY} xdotool key --window ${win} ctrl+p`);
sh('sleep 0.5');
sh(`DISPLAY=${DISPLAY} xdotool type --window ${win} --delay 25 'sample.pdf'`);
sh('sleep 0.4');
sh(`DISPLAY=${DISPLAY} xdotool key --window ${win} Return`);
sh('sleep 8');
const pdfShot = path.join(out, '02-pdf.png');
sh(`DISPLAY=${DISPLAY} scrot ${JSON.stringify(pdfShot)}`);
sh('sleep 2');
const pdfShot2 = path.join(out, '03-pdf-wait.png');
sh(`DISPLAY=${DISPLAY} scrot ${JSON.stringify(pdfShot2)}`);

const pdfStats = analyzePng(pdfShot2, 'crop=im.crop((320,90,min(1200,w-20),min(650,h-40)))');
const pdfOk = pdfStats.white > 1500;
step('pdf.page.pixels', pdfOk, JSON.stringify(pdfStats));

const expStats = analyzePng(explorerShot, 'crop=im.crop((48,90,min(320,w//3),min(320,h//2)))');
const iconsOk = expStats.colorful > 20;
step('explorer.file.icons', iconsOk, JSON.stringify(expStats));

fs.copyFileSync(pdfShot2, path.join(root, 'docs/assets/e2e-pdf.png'));
fs.copyFileSync(explorerShot, path.join(root, 'docs/assets/e2e-explorer-icons.png'));
fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));

const failed = evidence.steps.filter(s => !s.ok);
console.log(`\n${evidence.steps.length - failed.length}/${evidence.steps.length} passed`);
try { process.kill(child.pid, 'SIGTERM'); } catch {}
process.exit(failed.length ? 1 : 0);
