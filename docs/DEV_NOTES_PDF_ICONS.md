# PDF paint + file icons (2026-10-13 CST)

## PDF empty dark canvas

**Symptom:** EmbedPDF toolbar mounts; page area stays solid `#111827` under Xvfb / SideX dark theme.

**Root cause:** `zoom.defaultZoomLevel: 'page-width'` paints **zero** page tiles when the host is measured at 0×0 (EditorPane before first `layout`), and does not recover after resize. Repro (Chromium + WebKit): `fit-page` / numeric zoom → white page with “SideX EmbedPDF”; `page-width` → empty dark.

**Fix (v0.1.11):**
- Open via `documentManager.initialDocuments[{ buffer }]` (no `blob:` fetch).
- Default zoom `fit-page`.
- `_ensureHostSize` + `resize` nudge after mount / layout.
- Resolve `/pdfium.wasm` with byte-length probe; serve as `application/wasm` blob.

## File icons missing in E2E

**Symptom:** Explorer lists files but Seti icons absent when `:1420` served an old staging `dist/` with empty `builtin-extensions.js` and **no** `dist/extensions/theme-seti`.

**Fix:** `npm run setup` + postbuild copies `extensions/` and fails the build if `theme-seti` / `builtin-extensions.js` lacks `theme-seti`. Default remains `workbench.iconTheme: vs-seti` in `src/main.ts`.

## Verification

- `npm run smoke:pdf` — `embedpdf.pixels` (shadow DOM IMG tiles), not mount-only.
- `scripts/e2e-pdf-icons.mjs` — Xvfb SideX; white page pixels + explorer chroma; shots in `docs/assets/e2e-pdf.png`, `e2e-explorer-icons.png`.

## E2E evidence (Asia/Shanghai)

- PDF pane white pixels: **364443** — page text “SideX EmbedPDF” visible (`docs/assets/e2e-pdf.png`).
- Explorer colorful icon pixels: **97+** — JS / MD / PDF Seti icons visible (`docs/assets/e2e-explorer-icons.png`).
- Capture: Xvfb `:110` + `scrot` (window `import` BadMatch under SW GL).
