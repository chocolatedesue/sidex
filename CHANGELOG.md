# Changelog

## Unreleased (post-0.1.5) — Preview plugins + Markdown Diff WYSIWYG

### Fixed
- **Marketplace preview plugins actually run:** non-PDF `customEditors` were deferred after install. Extension host now implements `resolveCustomEditor` / `customEditorClosed`; workbench opens a webview and resolves CustomTextEditor / CustomReadonlyEditor providers (SVG/HTML/Markdown preview-style extensions). PDF still uses built-in EmbedPDF.

### Added
- **Markdown Diff Editor (WYSIWYG):** side-by-side original|modified via `SideBySideEditorInput` + standalone `markdown-editor-out` hosts. Command / title: `Markdown: Open Markdown Diff Editor`; resolver `createDiffEditorInput` for `vscode.markdown.editor` (Reopen With on diffs).
- `npm run smoke:preview-md-diff` — static + live host resolve smoke (`smoke-artifacts/preview-md-diff-evidence.json`).

### Note
- Inline `customEditorDiffs` change-highlight API not ported yet; AI default-off / EmbedPDF / MD WYSIWYG single editor unchanged. No release tag in this push.

## Unreleased (post-0.1.5) — Tauri pin + startup smoke

### Changed
- **Tauri 2.x pins** in `src-tauri/Cargo.toml` to latest stable 2.x (not 3.0 alpha): `tauri` **2.12.3**, `tauri-build` **2.7.2**, `tauri-plugin-{log,dialog,shell}` **2.10 / 2.8 / 2.5**, single-instance **2.5.3**, deep-link **2.6.1**. Compatible with rustc **1.99** (crates require ≥1.90).
- **Startup cold path:** document essential plugins (dialog/shell/single-instance/deep-link); `tauri-plugin-log` remains debug-only; Linux deep-link `register_all` moved off the critical path (background thread after window show).
- **`SIDEX_STARTUP_TRACE=1`:** stderr markers for builder / window restore / setup complete (AI server still not started).
- AI default-off + Wasmtime lazy engine **re-verified**.

### Added
- `scripts/smoke-startup.mjs` — web time-to-workbench + optional Xvfb native binary smoke; evidence in `smoke-artifacts/startup-evidence.json`.

### Note for next tag
- Box measured: native setup-complete **~515ms** (trace), web workbench **~2.3s** total; include in **0.1.6** release notes / cloud artifacts when tagging.

## 0.1.5 — 2026-10-12

Follow-up on the same day as 0.1.4 (Asia/Shanghai).

### Changed
- **Toolchain:** box/dev **rustc/cargo 1.99.0** (latest stable); workspace + `src-tauri` `rust-version` **1.99.0** (was 1.91).
- **Wasmtime 43 → 49.0.2** (needs Rust ≥1.96; now allowed). Engine still **lazy** on first WASM extension load.
- Synced `package-lock.json` so CI `npm ci` works (cloud-build on `v0.1.4` failed on lock drift).
- Cheap `dead_code` allows on unused TextMate/storage helpers; `cargo fix` unused imports.

### Build / release
- Local: `npm run build` + `cargo build --release` (relaxed profile OK for testing).
- Tag **v0.1.5**; unsigned multi-OS via `cloud-build.yml`.

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
