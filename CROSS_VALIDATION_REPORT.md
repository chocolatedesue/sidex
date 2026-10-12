# SideX Cross-Validation Report (LAB-707 操作腻子)

**Date:** 2026-10-12 (Asia/Shanghai, UTC+8) — release prep **0.1.4**  
**Repo:** `chocolatedesue/sidex`  
**Box checkout:** `/workspace/sidex` (Grok Bot built-in machine)  
**Version:** app `0.1.5` (`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml`)  
**Tip:** `git log -1 --oneline` on `origin/main`; tag `v0.1.5` + GitHub Release; see `CHANGELOG.md`.

Sources: Multica LAB-707 (ccds lab) prior agent work + this pass (marketplace, EmbedPDF EditorPane, audit/optimize, build+interactive smoke). **No Multica issue comment** (user dismissed widget).

---

## Summary — user Grok Bot requirements

| # | Requirement | Result | Evidence |
|---|-------------|--------|----------|
| 1 | Developed on Grok Bot box | **PASS** | Local `/workspace/sidex`; no Cursor CloudAgent for this pass |
| 2 | Feel / icons / **插件系统** | **PARTIAL→improved** | Codicon MD titles; Open VSX + siden gallery; install-by-id fixed; customEditors from ext host → Reopen With (PDF via EmbedPDF). Full custom-editor webview resolve still incomplete for non-PDF |
| 3 | MD 所见即所得 = VS Code latest | **PASS** | VS Code **1.141** `markdown-editor-out`; KeyChord `Ctrl+K V` |
| 4 | Cross-validate + interactive | **PASS** (web) / **PARTIAL** (native GUI) | Playwright: marketplace API, EmbedPDF mount, vite preview workbench + Extensions view. Box rustc **1.91** via rustup; `cargo check`/`cargo build --release` feasible; no display → no Tauri GUI E2E |
| 5 | Push **main** | **PASS** (this tip) | Commits on `origin/main` |

---

## LAB-707 腻子 — audit of prior work + this pass

| # | Item | Prior | This pass | Result |
|---|------|-------|-----------|--------|
| 1 | CLI folder/file/goto/single-instance/sidex:// | Implemented in `cli.rs` | Reviewed; `cargo check` OK on rustc 1.91 | **PASS** (code) / GUI E2E pending |
| 2 | MD WYSIWYG + preview | Ported + KeyChord fix | Retained; lifecycle/`retainContextWhenHidden`/`createEditorInputWhenReady` re-checked | **PASS** |
| 3 | Web 自测 | Prior win-webtest | `vite preview` + Playwright interactive (palette, Extensions view, marketplace fetch from page) | **PASS** |
| 4 | AI default OFF / no sidex-server at boot | `sidex.chat.enabled` false; `server::register` only | Re-verified | **PASS** |
| 5 | cloud-build.yml | Present; common arches | Unchanged (still valid) | **PASS** (workflow) |
| 6 | Reopen With / editorAssociations | MD Preview + MD Editor option | + PDF EmbedPDF default; ext customEditors (PDF) register as option via EmbedPDF | **PASS** |
| 7 | PDF **embed-pdf-viewer** EditorPane | Was pdf.js | **Switched to `@embedpdf/snippet` (EmbedPDF / same stack as Modern-PDF-Preview)**; `worker:false` + `fontFallback:null` to avoid init hang | **PASS** |
| 8 | Public repo / CI | Public | — | **PASS** |
| 9 | Install smoke Win/Mac | Prior Multica | Box: web smoke; VSIX download validated; native Tauri not built here | **PARTIAL** |
| 10 | MD 首开白屏 lifecycle | Documented mitigations | Re-audited; no regression found | **PARTIAL** (no native GUI re-proof) |

### Regressions / UX tightened this pass

1. **`index.html` `__SIDEX_TAURI__`** was hard-coded `true` → web preview pretended to be desktop (ext-host bootstrap noise, wrong install path). Now detects real Tauri (`__TAURI_INTERNALS__` / `__TAURI__` / UA).
2. **Marketplace `install(id)`** wrongly called `install_extension` with an id as a `.vsix` path → now resolves download URL (siden → Open VSX) then `install_extension_from_url`.
3. **Web marketplace search** falls back to HTTP when `invoke` unavailable.
4. **PDF** replaced pdf.js with EmbedPDF; hang on “Initializing plugins…” mitigated (`worker:false`, `fontFallback:null`).
5. **Custom editor associations** from extension manifests synced via host `getExtensionState`; PDF ones wire Reopen With through EmbedPDF.
6. Marked unused `tauriExtensionHostBridge.ts` as **SUPERSEDED** (full path is `tauriExtensionHost.contribution.ts`).

---

## Marketplace / plugin host — what activates vs stubbed

| Capability | Status |
|------------|--------|
| Search siden `api/-/search` + Open VSX fallback | **Works** (Rust + TS web fallback) |
| Gallery `api/gallery/extensionquery` (Extensions view) | **Works** |
| Download + unpack VSIX (`install_extension_from_url`) | **Works** (Tauri); payload validated on box via Open VSX prettier VSIX |
| Extensions view UI (web) | **Works** (Playwright) |
| Hot-load + `activateExtension` after install | **Wired** in `tauriExtensionHost.contribution` (desktop only) |
| Language features via ext host | **Wired** when host up (desktop) |
| `contributes.customEditors` → Reopen With (PDF) | **Works** via EmbedPDF pane |
| Full custom editor webview `resolveCustomEditor` | **Stub / deferred** (non-PDF) |
| Dead lighter bridge (`start_extension_host`) | **Not imported** |

---

## Build + interactive evidence (box)

Commands:

```bash
npm run build                          # green; embedpdf + pdfium.wasm in dist
npx vite preview --host 127.0.0.1 --port 4173
node scripts/smoke-marketplace-pdf.mjs # 7/7
node scripts/smoke-interactive-web.mjs # 5/5
```

Artifacts under `/workspace/sidex/smoke-artifacts/`:

- `smoke-evidence.json`, `interactive-web-evidence.json`
- `embedpdf-smoke.png`, `web-workbench.png`, `web-command-palette.png`, `web-extensions-view.png`
- `build.log`

AI remains default-off (`sidex.chat.enabled` default `false`).

---


---

## Dependency + performance pass (same day, follow-up)

**Toolchain:** box `rustc`/`cargo` upgraded via rustup **1.85.1 → 1.91.0** (matches `workspace.package.rust-version`). `cargo check --manifest-path src-tauri/Cargo.toml` now **PASS** (after installing webkit/gtk pkg-config deps).  

**Kept non-breaking (no major jumps):** `monaco-editor` 0.52.x, `@xterm/xterm` 5.5.x, `katex` 0.16.x, `typescript` ~5.6, `vite` 6.x, `@embedpdf/snippet` 2.15.1, `wasmtime` 43.x.  

### npm (installed)

| Package | Before | After |
|---------|--------|-------|
| vite | 6.4.2 | **6.4.4** |
| typescript-eslint | 8.58.2 | **8.71.1** (dropped redundant `@typescript-eslint/{eslint-plugin,parser}` — flat config uses meta package) |
| eslint | 9.39.4 | **9.39.5** |
| prettier | 3.8.3 | **3.9.10** |
| playwright | 1.62.1 | **1.64.0** |
| @microsoft/1ds-core-js / post-js | 4.3.11 | **4.4.5** |
| @tauri-apps/plugin-dialog | 2.7.0 | **2.8.2** |
| @tauri-apps/plugin-shell | 2.3.5 | **2.5.0** |
| @vscode/tree-sitter-wasm | 0.3.0 | **0.3.1** |
| @webgpu/types | 0.1.69 | **0.1.74** |
| @embedpdf/snippet | 2.15.1 | 2.15.1 (latest) |
| monaco / xterm / katex / typescript | unchanged majors | unchanged |

### Cargo (Cargo.lock `cargo update`, same majors)

| Crate | Before | After |
|-------|--------|-------|
| wasmtime / wasmtime-wasi | 43.0.1 | **43.0.2** (49.x available but needs Rust 1.96 — skipped) |
| tauri | 2.12.3 | 2.12.3 |
| tokio | (workspace 1.x) | **1.53.2** in lock |
| serde | 1.x | **1.0.229** |
| reqwest | 0.12.x (+0.13 transitive) | 0.12.28 / 0.13.5 |

### Performance / startup

1. **Wasmtime lazy:** `WasmExtensionRuntime::new()` is now cheap; `Engine`+`Linker` built on **first** `load_extension` (was eager at Tauri `.manage`, paying cold-start cost even with zero WASM extensions).
2. **macOS PATH:** skip login-shell probe when PATH already has Homebrew/`/usr/local/bin`; timeout **3s → 1.5s**.
3. **PDF memory:** EmbedPDF open path does **one** `ArrayBuffer` slice into the Blob URL (removed double-copy).
4. **AI:** still default-off (`sidex.chat.enabled` false); unchanged.
5. **Compile fix:** `sidex-extensions` marketplace fallback used tracing-style `log::warn!(error = %err, …)` → fixed to `log` crate format (unblocked `cargo check`).

### Re-validation

```
rustc 1.91.0 / cargo 1.91.0
cargo check --manifest-path src-tauri/Cargo.toml   # PASS (warnings only)
cargo test -p sidex-extensions --lib               # 101 passed
cargo test -p sidex-text --lib                     # 295 passed
npm run build                                      # PASS; EmbedPDF + pdfium.wasm in dist
smoke-marketplace-pdf.mjs                          # 7/7
smoke-interactive-web.mjs                          # 5/5
```

MD WYSIWYG / EmbedPDF / marketplace install path **not intentionally changed** beyond PDF buffer copy + marketplace log fix.


## Remaining hard limits (honest)

1. Box has **rustc 1.99.0** (latest stable via rustup); `cargo check` / release binary build OK. Full signed `tauri build` + GUI E2E still prefer **cloud-build** / desktop with display (`docs/CLOUD-BUILD.md`).
2. Non-PDF extension **customEditors** need webview resolve bridge (host stores providers; pane path incomplete).
3. Formatting CI may still fail on pre-existing AI-crate prettier/rustfmt noise.
4. MD Diff Editor WYSIWYG path not ported.
5. EmbedPDF chunk ~1.1 MB (lazy-loaded on first PDF).
6. Upstream `release.yml` needs Apple/Azure/R2 secrets — this fork uses `cloud-build.yml` + `gh release` for unsigned artifacts.

---

## Manual try on Windows SideX

1. Pull `main` or download Actions **Cloud build** artifact.  
2. Open `.md` → **Markdown: Open Markdown Editor** → Toggle Lock; side preview **Ctrl+K then V**.  
3. Open `.pdf` → **Modern PDF Preview (EmbedPDF)**.  
4. Reopen Editor With… → Preview / Markdown Editor / EmbedPDF / Text.  
5. Extensions view → search (siden/Open VSX) → Install → restart or hot-load on desktop.  
6. AI panel stays off until `sidex.chat.enabled`.


---

## Release 0.1.5

- Toolchain **rustc 1.99.0**; wasmtime **49.0.2**; `package-lock.json` synced for `npm ci`.
- Docs/CHANGELOG updated; local `npm run build` + `cargo build --release` → `release-artifacts/`.
- Tag **v0.1.5** → GitHub Release; `cloud-build.yml` on the tag for Win/macOS/Linux unsigned binaries.
- Prior tag `v0.1.4` remains (cloud-build failed there on lock drift).

## Release 0.1.4

- Version bump + docs/CHANGELOG; local linux tarball + web dist on GitHub Release.
- Cloud-build for `v0.1.4` **failed** (`npm ci` lock out of sync) — fixed in 0.1.5.

---

## Tauri / startup / perf pass (post-0.1.5)

**Date:** 2026-10-12 (Asia/Shanghai, UTC+8)  
**SHA tip:** see `git log -1` after this commit.

### Tauri versions (crates.io latest **2.x**, stay off 3.0-alpha)

| Crate | Cargo.toml pin | Locked / tree |
|-------|----------------|---------------|
| tauri | **2.12.3** (was 2.10.3) | 2.12.3 |
| tauri-build | **2.7.2** (was 2.5.6) | 2.7.2 |
| tauri-plugin-log | **2.10** | 2.10.1 |
| tauri-plugin-dialog | **2.8** | 2.8.2 |
| tauri-plugin-shell | **2.5** | 2.5.0 |
| tauri-plugin-single-instance | 2.5.3 | 2.5.3 |
| tauri-plugin-deep-link | 2.6.1 | 2.6.1 |
| @tauri-apps/api / cli (npm) | ^2.12.3 / ^2.12.2 | latest stable 2.x |
| wasmtime | 49 | 49.0.2 (lazy Engine) |

rustc **1.99.0**; Tauri 2.12 requires rustc ≥1.90 — OK. **Did not** take Tauri 3.0 alpha.

### Plugin / cold-path review

| Item | Decision |
|------|----------|
| dialog + shell | Keep on Builder (Open/Save + external open from first paint) |
| single-instance + deep-link | Keep on Builder (CLI / `sidex://`) |
| log | Debug-only inside `setup` (not release cold path) |
| deep-link `register_all` (Linux) | **Deferred** to background thread after window show |
| AI / `sidex-server` | Still register-only; spawn via `server_ensure_started` when `sidex.chat.enabled` |
| Wasmtime | Still lazy on first WASM extension load |

### Startup smoke (`scripts/smoke-startup.mjs`) — measured on box

Web (static `dist` from 0.1.5 linux package, Playwright headless):

```
webDomContentLoaded  ~843ms
webWorkbenchProxy    ~1468ms (after DCL)
webTotalFromNav      ~2312ms
no agent :7433 probe
```

Native (`target/release/SideX`, rustc 1.99, `SIDEX_STARTUP_TRACE=1`, Xvfb):

```
[sidex-startup] builder begin                 +0ms
[sidex-startup] window restore_and_show     +487ms
[sidex-startup] setup complete (AI off)     +515ms
script wall: nativeWindowRestore ~827ms, nativeSetupComplete ~1239ms
no sidex-server process
```

Evidence: `smoke-artifacts/startup-evidence.json`, `startup-web.png`, `startup-native.log`.

### Intact

EmbedPDF EditorPane, MD WYSIWYG (VS Code 1.141 markdown-editor-out), marketplace install path — **not intentionally changed**.

