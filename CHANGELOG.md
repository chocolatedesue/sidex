# Changelog

## 0.1.12 — 2026-10-14

### Fixed
- **macOS: the main window silently lost its entire configuration.** Tauri
  merges `tauri.macos.conf.json` into `tauri.conf.json` with JSON Merge Patch
  (RFC 7396), where an array is replaced wholesale. The macOS override declared
  `app.windows[0]` only to switch on native decorations, so on macOS the window
  lost its title, size, `visible: false`, the background colour, drag-and-drop
  and `useHttpsScheme`. Dropping `useHttpsScheme` moves the webview origin from
  `https://tauri.localhost` to `tauri://localhost`, which changes how
  custom-scheme subresources are treated — the likely cause of icons not
  rendering on macOS, since extension icon fonts are loaded through
  `sidex-asset://`. The override now carries the complete window config.
- Guarded by a new `npm run test:platform-config`, which re-applies Tauri's own
  merge to `tauri.conf.json` plus each platform override and asserts the
  resulting window and bundle configuration (including `icons/icon.icns` and
  the bundled resources), so an override can no longer clobber them.

## 0.1.11 — 2026-10-14

### Added
- **Node extensions can run.** Real VS Code extensions now activate and reach the
  workbench: the extension host derives the implicit `onLanguage:*` /
  `onCommand:*` / `onView:*` / `onDebug*` / … activation events from
  `contributes` (VS Code semantics) instead of only honouring an explicit
  `activationEvents` list, and the workbench registers a user-installed
  extension's `contributes.languages` so its files open with the right language
  id instead of Plain Text.
- **Tinymist (Typst) works end to end.** With `myriad-dreamin.tinymist` installed
  (plus the `tinymist` server binary on `PATH` or `tinymist.serverPath`), a
  `.typ` file gets the `typst` language, the language server starts, edits sync
  live and diagnostics show up. Covered by `npm run e2e:typst`.
- `vscode.DocumentDropOrPasteEditKind` in the extension-host `vscode` shim; its
  absence aborted activation of tinymist and markdown-language-features.

### Fixed
- **Release builds now log.** `tauri-plugin-log` was only installed in debug
  builds, so every `log::` record — including the extension host's forwarded
  stderr — was dropped. Setting `SIDEX_LOG` raises the level to debug.

### Notes
- Node-based extensions need a system `node` (>= 18) on `PATH`; SideX does not
  bundle one yet, and without it the extension host fails to start.

## 0.1.10 — 2026-10-14

### Fixed
- **Go to Line/Column (Ctrl+G) did nothing.** `workbench.action.gotoLine` was
  never registered: the only thing importing
  `contrib/codeEditor/browser/quickaccess/gotoLineQuickAccess.ts` was the
  `codeEditor.contribution` barrel, and that file had been removed. Restored the
  quick-access provider, the `GotoLineAction` / `GotoOffsetAction` actions and
  the `Ctrl+G` keybinding, and wired the module back into `workbench.common.main`.
- **Zoom (Ctrl+= / Ctrl+- / Ctrl+0) did nothing.** The workbench runs in a system
  webview now, so the Electron native zoom was gone and nothing replaced it. Added
  `browser/actions/zoomActions.ts`: `workbench.action.zoomIn` / `zoomOut` /
  `zoomReset`, the `window.zoomLevel` setting, and a CSS `zoom` on the workbench
  container that follows the setting on startup and on change.
- **No language support — every file opened as Plain Text.** `npm run build` never
  ran `scripts/setup-extensions.sh`, so the built-in extension catalog was empty
  in the shipped artifacts (only `release.yml` populated it). `build` now runs it,
  so `.js` / `.ts` / `.py` / `.md` and the rest open with a real language mode,
  file icons and grammar.
- **Toggle Line Comment (Ctrl+/) was a no-op.** `languageConfigurationExtensionPoint.ts`
  had been replaced by a 10-line stub, so no comment token / indentation rule was
  ever registered for any language. Restored the real `LanguageConfigurationFileHandler`.

### Tests
- **`scripts/e2e/gui-smoke.sh`** now covers the everyday editor gestures in
  addition to boot + quick open + save: undo, redo, move / delete / duplicate
  line, toggle comment, cut and paste assert on the file on disk; find,
  find+replace, go-to-line, settings, sidebar, panel and zoom assert on a real
  before/after pixel delta. 25 checks, all green on Linux.

## 0.1.9 — 2026-10-14

### Added
- **Extension host: custom document lifecycle** (`host.cjs`). `openCustomDocument`
  results are tracked by panel and by resource; `onDidChangeCustomDocument` is
  forwarded to the workbench as `customDocumentDirty`; new protocol handlers
  `saveCustomDocument` / `saveCustomDocumentAs` / `revertCustomDocument` /
  `backupCustomDocument` / `deleteCustomDocumentBackup`; closing an editor
  unsubscribes, disposes the document and clears the indexes.
- **Workbench: custom editor module** (`contrib/customEditor`). The whole module
  had been reduced to four stubs, so `contributes.customEditors` had nowhere to
  land. Restored and registered in `workbench.common.main` — `CustomEditorInput`,
  the input serializer, the working-copy handler, the capability registry and the
  `contributes.customEditors` extension point.
- **Node unit suite** `scripts/test-ext-host.mjs` (12 cases) and a CI job for it.
- **Native GUI e2e** `scripts/e2e/gui-smoke.sh`: Xvfb + openbox + xdotool + scrot,
  asserting on observable results (workbench painted, quick open shown, command
  palette shown, Ctrl+S persisted to disk with the original line intact), plus a
  `Native GUI e2e` workflow.
- `docs/SIDEX-DEVELOPMENT-PLAN.md` — batched plan with per-batch acceptance
  criteria and test method.

### Fixed
- **Disk extension theme contributions.** `_syncDiskThemeExtensions` and
  `_registerDiskExtensionWithWorkbench` were called but never defined, so every
  call threw and was swallowed. They now read installed manifests over the bridge
  (new `extension_read_manifest_json` command) and feed the `themes` /
  `iconThemes` / `productIconThemes` extension points with the union of the
  extension service's descriptions and the disk ones, re-applying on
  `onDidChangeExtensions`.
- Native e2e command-palette assertion was a false positive (the welcome editor
  rotates its hint text); it now diffs a static editor.

### Notes
- Known debt, unchanged: `prettier --check` (178 files), `cargo fmt` (141 files),
  and 7 pre-existing `tsc` errors in unrelated files.

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
