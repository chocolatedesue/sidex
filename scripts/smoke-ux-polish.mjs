#!/usr/bin/env node
/**
 * Smoke: VS Code 1.141 UX polish artifacts are present (settings, CSS, splash, contribution).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
	if (cond) {
		pass++;
		console.log(`PASS  ${name}`);
	} else {
		fail++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
	}
}

const styles = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
ok('CSS density-compact', styles.includes('.monaco-workbench.density-compact'));
ok('CSS frosted-glass', styles.includes('.monaco-workbench.frosted-glass'));
ok('CSS reduced-transparency', styles.includes('prefers-reduced-transparency'));

const contrib = fs.readFileSync(
	path.join(root, 'src/vs/workbench/contrib/sidexUx/browser/sidexUx.contribution.ts'),
	'utf8'
);
ok('setting window.density.layout', contrib.includes("'window.density.layout'"));
ok('setting frosted glass', contrib.includes("'workbench.modernUIFrostedGlass'"));

const controller = fs.readFileSync(
	path.join(root, 'src/vs/workbench/contrib/sidexUx/browser/sidexUx.ts'),
	'utf8'
);
ok('controller toggles density-compact', controller.includes("density-compact"));
ok('controller toggles frosted-glass', controller.includes("frosted-glass"));

const mainCommon = fs.readFileSync(path.join(root, 'src/vs/workbench/workbench.common.main.ts'), 'utf8');
ok('contribution imported', mainCommon.includes('sidexUx.contribution'));

const main = fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8');
ok('default multiCursorPaste spread', main.includes("'editor.multiCursorPaste': 'spread'"));
ok('default frosted glass', main.includes("'workbench.modernUIFrostedGlass': true"));
ok('default density layout', main.includes("'window.density.layout': 'default'"));

const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
ok('splash present', index.includes('id="sidex-splash"'));
ok('product version 1.141', index.includes("version: '1.141.0'"));

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
ok('package 0.1.9', pkg.version === '0.1.9');

const tauri = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
ok('tauri 0.1.9', tauri.version === '0.1.9');
ok('tauri backgroundColor', tauri.app?.windows?.[0]?.backgroundColor === '#111111');

const notes = fs.readFileSync(path.join(root, 'docs/DEV_NOTES_UX_PERF.md'), 'utf8');
ok('triage notes exist', notes.includes('Triage table'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
