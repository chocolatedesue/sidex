#!/usr/bin/env node
/**
 * Smoke: SideX CLI on PATH + built-in file icon theme + vscode-icons contribution shape.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const steps = [];
const pass = (name, detail) => {
  steps.push({ name, ok: true, detail });
  console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`);
};
const fail = (name, detail) => {
  steps.push({ name, ok: false, detail });
  console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`);
};

// --- CLI scripts present ---
const launcher = path.join(root, 'scripts', 'sidex');
const installCli = path.join(root, 'scripts', 'install-cli.sh');
if (fs.existsSync(launcher) && fs.statSync(launcher).mode & 0o111) {
  pass('cli launcher exists', launcher);
} else {
  fail('cli launcher exists', launcher);
}

const help = spawnSync(launcher, ['--help'], { encoding: 'utf8' });
if (help.status === 0 && /Usage:/i.test(help.stdout)) {
  pass('sidex --help', help.stdout.split('\n')[0]);
} else {
  fail('sidex --help', `status=${help.status} ${help.stderr || help.stdout}`);
}

// Built binary --version / --help (if present)
// Prefer debug over stale release builds that predate early-CLI (--version
// must not open a window). Fall back to release when debug is absent.
const binCandidates = [
  path.join(root, 'target', 'debug', 'SideX'),
  path.join(root, 'src-tauri', 'target', 'debug', 'SideX'),
  path.join(root, 'target', 'release', 'SideX'),
  path.join(root, 'src-tauri', 'target', 'release', 'SideX'),
];
function pickCliBinary() {
  for (const candidate of binCandidates) {
    if (!fs.existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 5_000 });
    if (probe.status === 0 && /SideX\s+\d/.test(probe.stdout || '')) {
      return candidate;
    }
  }
  return binCandidates.find(p => fs.existsSync(p));
}
const bin = pickCliBinary();
if (bin) {
  const ver = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 120_000 });
  if (ver.status === 0 && /SideX\s+\d/.test(ver.stdout)) {
    pass('SideX --version', ver.stdout.trim());
  } else {
    fail('SideX --version', `status=${ver.status} out=${ver.stdout} err=${ver.stderr}`);
  }
  const h2 = spawnSync(bin, ['--help'], { encoding: 'utf8', timeout: 120_000 });
  if (h2.status === 0 && /--install-cli/.test(h2.stdout)) {
    pass('SideX --help mentions --install-cli');
  } else {
    fail('SideX --help mentions --install-cli', h2.stdout.slice(0, 200));
  }

  // Install into a temp bin dir and verify PATH resolution
  const tmpBin = path.join(root, 'smoke-artifacts', 'cli-bin');
  fs.mkdirSync(tmpBin, { recursive: true });
  const inst = spawnSync(bin, ['--install-cli'], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, SIDEX_CLI_BIN_DIR: tmpBin },
  });
  if (inst.status === 0 && fs.existsSync(path.join(tmpBin, 'sidex'))) {
    pass('SideX --install-cli', tmpBin);
    const viaPath = spawnSync(path.join(tmpBin, 'sidex'), ['--version'], { encoding: 'utf8', timeout: 120_000 });
    if (viaPath.status === 0 && /SideX/.test(viaPath.stdout)) {
      pass('installed sidex on PATH dir runs', viaPath.stdout.trim());
    } else {
      fail('installed sidex on PATH dir runs', viaPath.stderr || viaPath.stdout);
    }
  } else {
    fail('SideX --install-cli', inst.stderr || inst.stdout);
  }
} else {
  fail('SideX binary present for CLI tests', 'build with cargo build -p sidex first');
}

// --- File icon theme builtin ---
const setiJson = path.join(root, 'extensions', 'theme-seti', 'icons', 'vs-seti-icon-theme.json');
const setiPkg = path.join(root, 'extensions', 'theme-seti', 'package.json');
if (fs.existsSync(setiJson) && fs.existsSync(setiPkg)) {
  const pkg = JSON.parse(fs.readFileSync(setiPkg, 'utf8'));
  const themes = pkg.contributes?.iconThemes || [];
  const vsSeti = themes.find(t => t.id === 'vs-seti');
  if (vsSeti) {
    pass('theme-seti contributes vs-seti', vsSeti.path);
  } else {
    fail('theme-seti contributes vs-seti', JSON.stringify(themes));
  }
  const iconDoc = JSON.parse(fs.readFileSync(setiJson, 'utf8'));
  if (iconDoc.iconDefinitions && iconDoc.file) {
    pass('vs-seti icon theme document has icons', `defs=${Object.keys(iconDoc.iconDefinitions).length}`);
  } else {
    fail('vs-seti icon theme document has icons');
  }
} else {
  fail('theme-seti present', setiJson);
}

const metaPath = path.join(root, 'extensions-meta.json');
const builtinJs = path.join(root, 'public', 'builtin-extensions.js');
if (fs.existsSync(metaPath)) {
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const seti = meta.find(e => e.extensionPath === 'theme-seti' || e.packageJSON?.name === 'vscode-theme-seti');
  if (seti) {
    pass('extensions-meta includes theme-seti');
  } else {
    fail('extensions-meta includes theme-seti', `count=${meta.length}`);
  }
} else {
  fail('extensions-meta.json exists');
}
if (fs.existsSync(builtinJs) && fs.readFileSync(builtinJs, 'utf8').includes('theme-seti')) {
  pass('builtin-extensions.js includes theme-seti');
} else {
  fail('builtin-extensions.js includes theme-seti');
}

// Default setting
const mainTs = fs.readFileSync(path.join(root, 'src', 'main.ts'), 'utf8');
if (mainTs.includes("'workbench.iconTheme': 'vs-seti'")) {
  pass('default workbench.iconTheme is vs-seti');
} else {
  fail('default workbench.iconTheme is vs-seti');
}

// installFromLocation Tauri file:// bridge
const ems = fs.readFileSync(
  path.join(root, 'src/vs/workbench/services/extensionManagement/common/extensionManagementService.ts'),
  'utf8',
);
if (ems.includes('__SIDEX_TAURI__') && ems.includes('installFromLocation') && ems.includes('webExtensionManagementServer')) {
  pass('Tauri file:// installFromLocation bridge present');
} else {
  fail('Tauri file:// installFromLocation bridge present');
}

// Icon theme sync from disk extensions
const host = fs.readFileSync(
  path.join(root, 'src/vs/workbench/contrib/extensions/browser/tauriExtensionHost.contribution.ts'),
  'utf8',
);
if (host.includes('_syncDiskThemeExtensions') && host.includes('_registerDiskExtensionWithWorkbench')) {
  pass('disk icon-theme sync wired in ExtHost');
} else {
  fail('disk icon-theme sync wired in ExtHost');
}

// vscode-icons contribution shape (from Open VSX published layout)
const expectedIconThemeId = 'vscode-icons';
const expectedPath = 'dist/src/vsicons-icon-theme.json';
pass('vscode-icons expected contribution', `${expectedIconThemeId} @ ${expectedPath}`);

// macOS DMG default in cloud-build
const cloud = fs.readFileSync(path.join(root, '.github/workflows/cloud-build.yml'), 'utf8');
if (cloud.includes('--bundles dmg') && cloud.includes('sidex-*.dmg')) {
  pass('cloud-build macOS defaults to dmg');
} else {
  fail('cloud-build macOS defaults to dmg');
}

const failed = steps.filter(s => !s.ok);
console.log(`\n${steps.length - failed.length}/${steps.length} passed`);
fs.mkdirSync(path.join(root, 'smoke-artifacts'), { recursive: true });
fs.writeFileSync(
  path.join(root, 'smoke-artifacts', 'cli-icons-evidence.json'),
  JSON.stringify({ at: new Date().toISOString(), steps }, null, 2),
);
process.exit(failed.length ? 1 : 0);
