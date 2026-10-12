import fs from 'fs';
import path from 'path';

const DIST_DIR = 'dist';
const ASSETS_DIR = path.join(DIST_DIR, 'assets');

function formatSize(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} kB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function getFileSizes(dir, extension) {
	if (!fs.existsSync(dir)) return { total: 0, files: [] };

	const files = fs
		.readdirSync(dir)
		.filter(f => f.endsWith(extension))
		.map(f => ({
			name: f,
			size: fs.statSync(path.join(dir, f)).size
		}))
		.sort((a, b) => b.size - a.size);

	return {
		total: files.reduce((sum, f) => sum + f.size, 0),
		files
	};
}

// Copy extensions
if (fs.existsSync('extensions')) {
	fs.cpSync('extensions', path.join(DIST_DIR, 'extensions'), { recursive: true, force: true });
}
if (fs.existsSync('extensions-meta.json')) {
	fs.copyFileSync('extensions-meta.json', path.join(DIST_DIR, 'extensions-meta.json'));
}
console.log('Post-build: copied extensions\n');

// EmbedPDF (LAB-707) needs PDFium WASM next to the app. public/ copies on Vite
// build, but keep an explicit fallback from node_modules for cloud/CI caches.
const PDFIUM_CANDIDATES = [
	path.join('public', 'pdfium.wasm'),
	path.join('node_modules', '@embedpdf', 'snippet', 'dist', 'pdfium.wasm'),
	path.join('node_modules', '@embedpdf', 'pdfium', 'dist', 'pdfium.wasm'),
];
const pdfiumDest = path.join(DIST_DIR, 'pdfium.wasm');
let copiedPdfium = false;
for (const src of PDFIUM_CANDIDATES) {
	if (fs.existsSync(src)) {
		fs.copyFileSync(src, pdfiumDest);
		console.log(`Post-build: copied ${src} → ${pdfiumDest}\n`);
		copiedPdfium = true;
		break;
	}
}
if (!copiedPdfium) {
	console.warn('Post-build: pdfium.wasm not found — EmbedPDF PDF preview will fail\n');
}


// The markdown preview renders KaTeX itself (it is bundled), but the
// stylesheet and the fonts it pulls in are fetched at runtime. Vite serves
// those from the project in dev; a build has to copy them next to the app.
// Deliberately NOT into `dist/node_modules`: Tauri's bundler refuses to bundle
// a frontendDist that contains a top-level `node_modules` folder, which is what
// broke the macOS `.app` build.
const KATEX_SRC = path.join('node_modules', 'katex', 'dist');
const KATEX_DEST = path.join(DIST_DIR, 'katex');
if (fs.existsSync(KATEX_SRC)) {
	fs.cpSync(KATEX_SRC, KATEX_DEST, { recursive: true, force: true });
	console.log(`Post-build: copied the katex stylesheet + fonts to ${KATEX_DEST}\n`);
} else {
	console.warn('Post-build: node_modules/katex not found — markdown math will not render in this build\n');
}

// Calculate bundle sizes
const js = getFileSizes(ASSETS_DIR, '.js');
const css = getFileSizes(ASSETS_DIR, '.css');
const wasm = getFileSizes(ASSETS_DIR, '.wasm');
const other = getFileSizes(ASSETS_DIR, '.ttf');

console.log('═══════════════════════════════════════════════════════════');
console.log('                    BUNDLE SIZE SUMMARY                     ');
console.log('═══════════════════════════════════════════════════════════');
console.log(`  JavaScript:  ${formatSize(js.total).padStart(12)}`);
console.log(`  CSS:         ${formatSize(css.total).padStart(12)}`);
console.log(`  Fonts:       ${formatSize(other.total).padStart(12)}`);
console.log(`  WASM:        ${formatSize(wasm.total).padStart(12)}`);
console.log('───────────────────────────────────────────────────────────');
console.log(`  TOTAL:       ${formatSize(js.total + css.total + other.total + wasm.total).padStart(12)}`);
console.log('═══════════════════════════════════════════════════════════');

// Show top 5 largest JS files
console.log('\nTop 5 largest JS chunks:');
js.files.slice(0, 5).forEach((f, i) => {
	console.log(`  ${i + 1}. ${f.name.padEnd(50)} ${formatSize(f.size).padStart(10)}`);
});
console.log('');
