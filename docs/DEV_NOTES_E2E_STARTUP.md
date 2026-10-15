# E2E startup analysis (2026-10-13 CST)

Real GUI under Xvfb `:110` + Openbox, not unit smoke only.

## What was opened

| Surface | How | Result |
|---------|-----|--------|
| Native SideX (`target/release/SideX`) | `SIDEX_STARTUP_TRACE=1`, workspace `/tmp/sidex-e2e-ws` | Window 1280×800; trace markers OK |
| Explorer | Ctrl+Shift+E | PASS — `hello.js`, `sample.md`, `sample.pdf` |
| Terminal | Ctrl+\` | PASS — `echo SIDEX_E2E_OK` → `SIDEX_E2E_OK` |
| Command palette | Ctrl+Shift+P | PASS |
| Markdown | Quick Open `sample.md` | PASS — editor shows `# SideX MD` / WYSIWYG smoke text |
| PDF | Open `sample.pdf` | PARTIAL — EmbedPDF chrome (View/Annotate/Shapes, zoom) loads; `embedpdf-*.js` + `pdfium-*.wasm` HTTP 200; page canvas stayed dark under Xvfb (Software GL). Standalone `smoke:pdf` EmbedPDF mount **8/8** |
| Open With | Palette “Reopen Editor With” | PARTIAL — command attempted; picker not clearly confirmed on 0.1.5 staging dist |
| Web staging (`:1420` / Playwright) | `smoke-interactive-web` | PASS — workbench, palette, extensions view |
| Remote SSH lab (`:2222`–`:2228`) | `smoke:remote-ssh` | PASS **39/39** + live `SIDEX_REMOTE_SSH_LIVE_OK` |

Screenshots: `docs/assets/e2e-*.png` and `smoke-artifacts/e2e/`.

## Startup timings (Asia/Shanghai)

### Native `SIDEX_STARTUP_TRACE` (binary log)

| Mark | Typical |
|------|---------|
| builder begin | +0ms |
| window restore_and_show | **150–320ms** |
| setup complete (AI off) | **167–342ms** |

Cold paint (first non-solid frame with workbench pixels, wall clock from process spawn, frontend already on `:1420`): **~3.8s**.

### Smoke `npm run smoke:startup` (this session)

| Metric | ms |
|--------|-----|
| web DCL | 599 |
| web workbench proxy | 980 |
| web total | 1579 |
| native window/setup (smoke wall) | 829 |

## Blocker found → fix

**Symptom:** After wiping `~/.local/share/dev.sidex.app` WebKit cache, launching the cargo-built `SideX` with **no** process on `:1420` yields a blank white window. Logs show WebKit fetching `http://localhost:1420/` (Tauri `devUrl`). Sibling `dist/` alone is not loaded.

**Root cause:** Linux/Windows `cloud-build.yml` uses `cargo build --release` (fast path). That binary keeps Vite’s `devUrl` instead of embedding `frontendDist` the way `tauri build` / macOS DMG does. Docs previously claimed the frontend was embedded — incorrect for this path.

**Fix shipped:**

1. `scripts/ensure-frontend-server.sh` — serves `dist/` on `127.0.0.1:1420` if nothing answers.
2. `scripts/sidex` calls it before exec.
3. Linux cloud package: `SideX` wrapper → serve `dist/` → `SideX.bin`.
4. `docs/CLOUD-BUILD.md` corrected.

macOS remains `npx tauri build --bundles dmg` (embedded). Long-term: switch Linux/Windows cloud-build to `tauri build --no-bundle` when CI time allows.

## Other notes

- Missing `/wasm/hash|tfidf/*.js` → 404 on staging 0.1.5 dist (non-fatal for editor).
- AT-SPI / session-manager warnings under Xvfb are noise.
- AI / `sidex-server` stayed off (`SIDEX_CHAT_ENABLED=false`).
