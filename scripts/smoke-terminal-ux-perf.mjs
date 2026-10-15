#!/usr/bin/env node
/**
 * Cross-check terminal UX + perf defaults (no GUI required).
 * Fails if SideX drifts from VS Code 1.141 snappy defaults or loses fish/suggest wiring.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainTs = fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8');
const termRs = fs.readFileSync(path.join(root, 'src-tauri/src/commands/terminal.rs'), 'utf8');
const backend = fs.readFileSync(
	path.join(root, 'src/vs/workbench/contrib/terminal/browser/tauriTerminalBackend.ts'),
	'utf8'
);
const libRs = fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
	if (cond) {
		pass++;
		console.log(`PASS  ${name}`);
	} else {
		fail++;
		console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`);
	}
}

check(
	'terminal.smoothScrolling default false (VS Code)',
	/'terminal\.integrated\.smoothScrolling':\s*false/.test(mainTs)
);
check(
	'list.smoothScrolling default false (VS Code)',
	/'workbench\.list\.smoothScrolling':\s*false/.test(mainTs)
);
check(
	'terminal.suggest.enabled true (basic completion)',
	/'terminal\.integrated\.suggest\.enabled':\s*true/.test(mainTs)
);
check(
	'fish profile without forced -l (VS Code align)',
	/fish:\s*\{\s*path:\s*'fish'\s*\}/.test(mainTs) && !/fish:\s*\{\s*path:\s*'fish',\s*args:\s*\['-l'\]/.test(mainTs)
);
check('PTY emit coalesce constants present', /EMIT_COALESCE_MS/.test(termRs) && /FLOW_HIGH_WATER/.test(termRs));
check('terminal_ack_data implemented', /pub fn terminal_ack_data/.test(termRs));
check('terminal_ack_data registered', /commands::terminal_ack_data/.test(libRs));
check('fish shellIntegration inject', /shellIntegration\.fish/.test(termRs) && /--init-command/.test(termRs));
check('PATH which() merge for shells', /which::which\(bin\)/.test(termRs) && /"fish"/.test(termRs));
check(
	'Rust does not force -l for fish basename',
	!/"zsh" \| "bash" \| "sh" \| "fish"/.test(termRs)
);
check('frontend rAF coalesce', /requestAnimationFrame/.test(backend) && /rafPending/.test(backend));
check('frontend ack still wired', /terminal_ack_data/.test(backend));
check(
	'shellIntegration.fish packaged',
	fs.existsSync(path.join(root, 'src-tauri/shell-integration/shellIntegration.fish'))
);

console.log(`\nterminal ux/perf smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
