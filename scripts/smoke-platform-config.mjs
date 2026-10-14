/**
 * Smoke: platform config merging (macOS/Windows/Linux).
 *
 * Tauri merges `tauri.<platform>.conf.json` into `tauri.conf.json` with
 * JSON Merge Patch (RFC 7396) — see `tauri_utils::config::parse::read_from`.
 * Under that algorithm **arrays replace wholesale**, so an override that only
 * declares the fields it wants to change silently drops everything else in the
 * array. That is exactly what happened to `app.windows`: on macOS the main
 * window lost its title, size, `visible: false`, background colour and
 * `useHttpsScheme`, which changes the webview origin (`tauri://localhost`
 * instead of `https://tauri.localhost`) and how custom-scheme subresources
 * (icon fonts) are treated.
 *
 * This check re-applies the same merge and asserts the resulting window config,
 * so the platform files cannot regress again.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const confDir = path.join(root, 'src-tauri');

/** RFC 7396 JSON Merge Patch (arrays and scalars replace). */
function mergePatch(target, patch) {
	if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
		return patch;
	}
	const base = target && typeof target === 'object' && !Array.isArray(target) ? target : {};
	const out = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) {
			delete out[key];
		} else {
			out[key] = mergePatch(out[key], value);
		}
	}
	return out;
}

let failures = 0;
const pass = (m, d) => console.log(`PASS  ${m}${d ? ` — ${d}` : ''}`);
const fail = (m, d) => {
	failures++;
	console.error(`FAIL  ${m}${d ? ` — ${d}` : ''}`);
};

const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const base = readJson(path.join(confDir, 'tauri.conf.json'));
const baseWindow = base.app.windows[0];

const PLATFORMS = ['macos', 'windows', 'linux'];
const merged = {};
for (const platform of PLATFORMS) {
	const overridePath = path.join(confDir, `tauri.${platform}.conf.json`);
	merged[platform] = fs.existsSync(overridePath)
		? mergePatch(structuredClone(base), readJson(overridePath))
		: structuredClone(base);
}

// Fields the workbench depends on regardless of platform.
const REQUIRED = [
	'title',
	'width',
	'height',
	'minWidth',
	'minHeight',
	'resizable',
	'fullscreen',
	'shadow',
	'visible',
	'dragDropEnabled',
	'useHttpsScheme',
	'backgroundColor'
];

for (const platform of PLATFORMS) {
	const w = merged[platform].app.windows[0];
	const missing = REQUIRED.filter(
		field => JSON.stringify(w[field]) !== JSON.stringify(baseWindow[field])
	);
	if (missing.length > 0) {
		for (const field of missing) {
			fail(`${platform}: window.${field} lost by the platform config merge`, `merged=${JSON.stringify(w[field])} base=${JSON.stringify(baseWindow[field])}`);
		}
	} else {
		pass(`${platform}: platform merge keeps every base window field`);
	}
}

// macOS must keep the native traffic lights, since the workbench draws no window
// controls on macOS (`titlebarPart.ts`: "macOS native: traffic lights handled by OS").
const mac = merged.macos.app.windows[0];
if (mac.decorations === true) {
	pass('macos: native window decorations (traffic lights) enabled');
} else {
	fail('macos: decorations must stay true or the window has no traffic lights', `decorations=${JSON.stringify(mac.decorations)}`);
}
if (mac.titleBarStyle === 'Overlay' && mac.hiddenTitle === true) {
	pass('macos: titleBarStyle=Overlay + hiddenTitle (VS Code-like titlebar)');
} else {
	fail('macos: expected titleBarStyle=Overlay and hiddenTitle=true', `got ${mac.titleBarStyle}/${mac.hiddenTitle}`);
}

// Non-macOS keeps the frameless custom titlebar.
for (const platform of ['windows', 'linux']) {
	const w = merged[platform].app.windows[0];
	if (w.decorations === false && w.shadow === true) {
		pass(`${platform}: frameless window with shadow`);
	} else {
		fail(`${platform}: expected decorations=false + shadow=true`, `got ${w.decorations}/${w.shadow}`);
	}
}

// The app icon and the bundled resources are arrays too — an override that
// re-declares them would drop the rest (and a missing icon.icns means no macOS
// app icon at all).
for (const platform of PLATFORMS) {
	const icon = merged[platform].bundle.icon;
	if (!Array.isArray(icon) || !icon.includes('icons/icon.icns')) {
		fail(`${platform}: bundle.icon lost icons/icon.icns`, JSON.stringify(icon));
	}
	const resources = merged[platform].bundle.resources;
	if (!Array.isArray(resources) || !resources.includes('extension-host/*')) {
		fail(`${platform}: bundle.resources lost extension-host/*`, JSON.stringify(resources));
	}
}
pass('bundle.icon (incl. icon.icns) and bundle.resources survive the merge on every platform');

// A window array of the wrong length means an override replaced the whole list.
for (const platform of PLATFORMS) {
	if (merged[platform].app.windows.length !== base.app.windows.length) {
		fail(`${platform}: app.windows length changed by the merge`, `${merged[platform].app.windows.length} vs ${base.app.windows.length}`);
	}
}
if (failures === 0) {
	pass('platform config merge: every check passed');
}

console.log(`\n${failures === 0 ? 'OK' : `${failures} failure(s)`} — platform config smoke`);
process.exit(failures === 0 ? 0 : 1);
