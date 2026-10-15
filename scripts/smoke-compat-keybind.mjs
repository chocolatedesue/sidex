#!/usr/bin/env node
/**
 * Cross-platform compatibility + VS Code keybinding sensing smoke (no GUI).
 * Win/Mac/Linux profiles, CLI PATH separators, fish -l, Ctrl/Cmd/chords.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainTs = fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8');
const termRs = fs.readFileSync(path.join(root, 'src-tauri/src/commands/terminal.rs'), 'utf8');
const cliRs = fs.readFileSync(path.join(root, 'src-tauri/src/cli.rs'), 'utf8');
const backend = fs.readFileSync(
	path.join(root, 'src/vs/workbench/contrib/terminal/browser/tauriTerminalBackend.ts'),
	'utf8'
);
const keybindingRs = fs.readFileSync(path.join(root, 'crates/sidex-keymap/src/keybinding.rs'), 'utf8');
const defaultsRs = fs.readFileSync(path.join(root, 'crates/sidex-keymap/src/defaults.rs'), 'utf8');
const resolverRs = fs.readFileSync(path.join(root, 'crates/sidex-keymap/src/resolver.rs'), 'utf8');

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

// --- Terminal profiles / defaults (Win/Mac/Linux) ---
check(
	'no hardcoded defaultProfile.linux/osx (detect $SHELL)',
	!/'terminal\.integrated\.defaultProfile\.(linux|osx)'\s*:/.test(mainTs)
);
check(
	'windows terminal profiles present',
	/'terminal\.integrated\.profiles\.windows'/.test(mainTs) &&
		/powershell\.exe/.test(mainTs) &&
		/cmd\.exe/.test(mainTs)
);
check('windows env map present', /'terminal\.integrated\.env\.windows'\s*:\s*\{\}/.test(mainTs));
check(
	'fish profile still without forced -l',
	/fish:\s*\{\s*path:\s*'fish'\s*\}/.test(mainTs)
);
check(
	'Rust spawn does not auto -l fish',
	/"zsh"\s*\|\s*"bash"\s*\|\s*"sh"/.test(termRs) &&
		!/"zsh"\s*\|\s*"bash"\s*\|\s*"sh"\s*\|\s*"fish"/.test(termRs)
);
check(
	'backend Windows shell fallback',
	/isWindows[\s\S]*powershell\.exe/.test(backend) && /knownShells[\s\S]*pwsh\.exe/.test(backend)
);
check(
	'default profile uses detected profileName',
	/profiles\.find\(p => p\.isDefault\)/.test(backend) && /getShellBasename/.test(backend)
);

// --- CLI PATH ---
check('CLI default bin uses LOCALAPPDATA on Windows', /LOCALAPPDATA/.test(cliRs) && /default_cli_bin_dir/.test(cliRs));
check('CLI PATH check uses ; on Windows', /cfg!\(windows\).*';'/.test(cliRs.replace(/\s+/g, '')) || /sep = if cfg!\(windows\) \{ ';' \}/.test(cliRs));
check('path_contains_dir helper', /fn path_contains_dir/.test(cliRs));

// --- Keybinding sensing / chords / modifiers ---
check('chord timeout 5s (VS Code)', /TIMEOUT_SECS:\s*u64\s*=\s*5/.test(keybindingRs));
check('resolver uses ChordState expiry', /state\.is_expired\(\)/.test(resolverRs) && /ChordState::new/.test(resolverRs));
check('parse accepts cmdorctrl', /"cmdorctrl"/.test(keybindingRs));
check(
	'parse accepts cmd/meta/win/option aliases',
	/"meta"\s*\|\s*"cmd"/.test(keybindingRs) && /"alt"\s*\|\s*"option"/.test(keybindingRs)
);
check('primary() platform Cmd vs Ctrl', /fn primary\(\)/.test(defaultsRs) && /Modifiers::META/.test(defaultsRs) && /Modifiers::CTRL/.test(defaultsRs));
check('Win/Linux Ctrl+Y redo binding', /!is_macos\(\)[\s\S]*Key::Y[\s\S]*"redo"/.test(defaultsRs));
check(
	'format META as Cmd on mac / Win elsewhere',
	/target_os = "macos"[\s\S]*"Cmd"/.test(keybindingRs) && /target_os = "windows"[\s\S]*"Win"/.test(keybindingRs)
);

// Tauri menu still uses CmdOrCtrl (cross-platform accelerator)
const libRs = fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8');
check('native menu CmdOrCtrl accelerators', /CmdOrCtrl\+/.test(libRs));

console.log(`\ncompat/keybind smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
