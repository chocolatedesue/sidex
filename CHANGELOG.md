# Changelog

## 0.1.12 — 2026-10-13

### Fixed
- **CI / cloud-build:** sync workspace `Cargo.lock` after the 0.1.11 package version bump so Linux/Windows `cargo build --locked` succeeds again.
- **CI / attach to release:** `gh release` commands now pass `-R $GITHUB_REPOSITORY` because the attach job has no git checkout (was: `fatal: not a git repository`).

## 0.1.11

### Fixed
- **PDF Preview:** EmbedPDF pages actually paint (was empty dark canvas). Root cause: `page-width` zoom against a zero-sized host. Now uses `fit-page`, ArrayBuffer `documentManager` open, wasm probe, and layout resize nudge.
- **File icons:** Packaged builds must ship `extensions/theme-seti` + non-empty `builtin-extensions.js` (postbuild guard). E2E validates explorer icon pixels, not smoke-only.


## 0.1.10 — 2026-10-13

### Fixed
- **E2E:** cargo-built Linux/Windows SideX opened a blank window unless Vite was on `:1420`. Added `scripts/ensure-frontend-server.sh`, wired it into `scripts/sidex`, and wrap cloud-build Linux `SideX` so packaged `dist/` is served automatically. Documented in `docs/CLOUD-BUILD.md` + `docs/DEV_NOTES_E2E_STARTUP.md`.

### Verification
- Native Xvfb E2E: startup trace, explorer, terminal, palette, markdown open; PDF toolbar/assets load (canvas paint under software GL still partial).
- `smoke:startup` 9/9, `smoke:pdf` 8/8, `smoke:remote-ssh` 39/39, interactive web 5/5.

## 0.1.9 — 2026-10-13

### Fixed
- **PDF / EmbedPDF:** seed `public/pdfium.wasm` via `scripts/ensure-pdfium-wasm.sh` (setup + cloud-build) so `/pdfium.wasm` is same-origin; stop relying on EmbedPDF’s jsDelivr default. Safe Uint8Array→Blob copy for WebKit/Tauri.
- **Cloud build `--locked`:** regenerate workspace `Cargo.lock` (syn / aws-lc bumps) so Linux/Windows `cargo build --locked` succeeds.
- **CLI:** `sidex --version` / `--help` never open a GUI (shell fast-path); `--install-cli` prefers a binary with early-CLI.
- **Smoke:** startup `windowMark` recorded when setup+window arrive in one chunk.

### Perf
- PDF open path prefers cached `/pdfium.wasm` (no CDN RTT / no HEAD probe). Native startup markers documented in `docs/DEV_NOTES_ISSUES_PERF.md`.


## 0.1.6 — 2026-10-13

### Added
- **Remote SSH behavior matrix** (`DEV_NOTES_REMOTE_SSH.md`) with pass/fixed/unsupported coverage modeled on open-remote-ssh + russh.
- Multi-sshd lab (`scripts/remote-ssh-lab.sh`) and live suite `cargo test -p sidex-remote --test live_ssh` (44 tests).
- SSH config parser: Include, wildcards, ProxyJump/ProxyCommand, Match, tokens.
- Coded errors `[SIDEX_*]` (timeout, refused, host key, auth, FS errno, unsupported).
- `remote_cancel_connect`, `remote_reconnect`, `remote_detect_platform`, `remote_forward_port`.
- Commands: **Close Remote Connection**, **Open SSH Remote Authority**; passphrase prompt; friendly host-key errors.
- host.cjs: real `registerRemoteAuthorityResolver`; route ssh-remote openFolder → SideX connector.

### Fixed
- Host key verification (TOFU / strict / changed).
- Real ssh-agent auth + default identity files; encrypted keys.
- Password → keyboard-interactive (kbd-first, empty PAM prompts).
- ProxyJump via `direct-tcpip` + `connect_stream`; ProxyCommand via child stdio.
- Connect timeout; parallel hosts (Arc transport, no lock across await).
- Fish/zsh-safe remote scripts (base64 env wrap); binary/large file write via stdin `cat >`.
- Safe path quoting; symlink-aware stat/readdir; PTY resize; local forward port 0.
- Keepalive via russh Config (no leaking session channels).

### Unchanged / still green
- Open With ↔ VS Code UX (421fc7e), preview plugins + MD Diff WYSIWYG, Tauri 2.12 startup smokes, AI default-off, EmbedPDF path.

### Unsupported (fail gracefully)
- Reverse port forward, OTP kbd-interactive, file watching, recent hosts, jeanp413 server install/websocket.


## Unreleased (post-0.1.5) — Open With ↔ VS Code UX

### Fixed
- **Open With / Reopen With hope = actual:** picker no longer double-lists workbench Markdown hosts from `markdown-language-features` contributes, and no longer shows fake marketplace PDF entries labeled "(via EmbedPDF)" that always opened EmbedPDF. Built-in options only where they work.
- **VS Code-shaped choices:** `.md` → Text Editor (default) + **Markdown Preview** (`vscode.markdown.preview.editor`) + **Markdown Editor** (`vscode.markdown.editor`, Diff via `createDiffEditorInput`); `.pdf` → Text Editor + **PDF Preview** (EmbedPDF, default). Marketplace non-PDF preview `customEditors` still appear and resolve via the webview bridge.

### Changed
- Markdown Preview viewType aligned to VS Code id `vscode.markdown.preview.editor` (was `sidex.markdown.preview`).
- PDF Open With label shortened to **PDF Preview** (detail: EmbedPDF).

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

## Unreleased (post-0.1.5) — Remote SSH plugin adaptation

### Added
- **Built-in Remote SSH (plugin-shaped):** after Connect to Host / Remote Explorer SSH connect, SideX binds `ssh-remote+user@host`, registers a `vscode-remote` FileSystemProvider over `sidex-remote`, resolves the authority (`ManagedRemoteConnection`), and offers **Open Remote Home / Other Folder**.
- **Remote FS Tauri commands:** `remote_read_dir` / `remote_read_file` / `remote_write_file` / `remote_stat` / `remote_home` / `remote_mkdir` / `remote_delete` / `remote_rename`.
- **Open VSX Remote SSH hooks:** `extensionEnabledApiProposals` for `jeanp413.open-remote-ssh` (`resolvers`, `tunnels`, `contribRemoteHelp`, `contribViewsRemote`) in bootstrap + product fallback.
- **Authority resolver:** deferred `resolveAuthority` + working `_setResolvedAuthority` (no longer stub-throws).
- Auth fallback: SSH agent → identity file from `~/.ssh/config` → password prompt.
- **SSH exec exit status:** `sidex-remote` `exec_inner` now reads `ChannelMsg::ExitStatus` (was stuck at `-1`, breaking `remote_home` / read_file checks).
- Live example: `cargo run -p sidex-remote --example ssh_localhost_smoke` (default `127.0.0.1:2222`).
- `npm run smoke:remote-ssh` (+ optional `SIDEX_SMOKE_SSH=user@host`).

### Note / limits
- Built-in path does **not** install Microsoft/VSCodium “VS Code Server” on the remote; it uses SideX’s Rust SSH transport for FS. Full `jeanp413.open-remote-ssh` server download still needs a healthy Node extension host + matching server build.
- Remote file watching and remote PTY terminal UI not wired in this pass.
- EmbedPDF / Markdown WYSIWYG / Open With / AI-off unchanged.
