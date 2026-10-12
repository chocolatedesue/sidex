# Changelog

## 0.1.4 — 2026-10-12

LAB-707 / Grok Bot box pass on `chocolatedesue/sidex` (Asia/Shanghai).

### Added
- **Markdown WYSIWYG (所见即所得):** hosts VS Code **1.141** `markdown-editor-out` webview (`Markdown: Open Markdown Editor`, title-bar icon, Reopen With). Side preview remains `Ctrl+K` then `V` (KeyChord).
- **EmbedPDF EditorPane** (`@embedpdf/snippet`): default for `.pdf` / Reopen With — replaces earlier pdf.js pane; worker off + fontFallback null to avoid init hang.
- Open VSX / siden marketplace: search fallback, gallery query, **install-by-id** resolves download URL then `install_extension_from_url`.
- Web smoke scripts: `scripts/smoke-marketplace-pdf.mjs`, `scripts/smoke-interactive-web.mjs`.
- Docs: `CROSS_VALIDATION_REPORT.md`, `DEV_NOTES_MD_WYSIWYG.md`, `docs/CLOUD-BUILD.md`.

### Changed
- AI chat **default off** (`sidex.chat.enabled` false); agent server not started unless enabled.
- `index.html` `__SIDEX_TAURI__` detects real Tauri (no longer hard-coded true on web).
- Toolchain: **rustc 1.91**; Wasmtime engine **lazy** on first WASM extension load; macOS PATH probe faster; PDF open path drops an extra buffer copy.
- npm patch bumps (vite 6.4.4, eslint/prettier/playwright, tauri plugins, …); cargo lock updates within wasmtime **43.x**.

### Known limits
- Full Tauri GUI / extension-host activate E2E prefers cloud-build or a desktop with display.
- Non-PDF extension `customEditors` still need webview `resolveCustomEditor` bridge.
- MD Diff Editor WYSIWYG not ported.

## 0.1.3

Prior fork baseline before the LAB-707 Markdown / EmbedPDF / marketplace pass.
