# Issues + perf (2026-10-13, v0.1.9)

Workstream on **mikasans/sidex**: diagnose outstanding bugs, fix with root cause, measure perf with cross-checks.

## Issues found → fixed

| Issue | Root cause | Fix | Evidence |
|-------|------------|-----|----------|
| Cloud build Linux/Windows fail on `cargo build --locked` | Workspace `Cargo.lock` stale vs crates.io (syn/aws-lc bumps) | Regenerated `Cargo.lock` | Local `cargo metadata --locked` exit 0; was exit 101 |
| PDF Preview / EmbedPDF broken or CDN-dependent | `public/pdfium.wasm` gitignored & missing; EmbedPDF defaults `wasmUrl` to jsDelivr | `scripts/ensure-pdfium-wasm.sh` in `npm run setup` + cloud-build; prefer `/pdfium.wasm`; safe Uint8Array→Blob copy | `ensure` copies 4.5MB; smoke embedpdf.mount pass; smoke checks public wasm |
| `sidex --version` opens GUI | Shell launcher forwarded to stale release binary without early-CLI | Bash handles `--version`/`--help`; `--install-cli` probes early-CLI binary | `timeout 2 ./scripts/sidex --version` prints `SideX 0.1.9` |
| Smoke `windowMark=false` despite log line | Loop broke on `setup complete` before recording window mark in same chunk | Check window mark before setup break | smoke:startup reports windowMark=true |
| CLI version skew vs package | Stale binary / launcher | Launcher reads `package.json` for `--version` | Prints 0.1.9 |

## Still open (not bugs / deferred)

- Remote SSH: OTP 2FA, reverse forward, file watching, recents, jeanp413 server path
- Upstream memory-leak cherry-picks, Tauri 3, wry GPU flags (see `DEV_NOTES_UX_PERF.md`)
- Full `npm run build` web dist refresh on this box (smoke web path still may use staging symlink)

## Perf — measure → change → re-measure

### Native cold/warm (SIDEX_STARTUP_TRACE=1, existing release binary)

| Run | window restore | setup complete |
|-----|----------------|----------------|
| 1 (colder) | 421ms | 453ms |
| 2 | 247ms | 267ms |
| 3 | 243ms | 260ms |

Median window ≈ **247ms**, setup ≈ **267ms**. Smoke wall clock was inflated (~2s) by 400ms poll + windowMark race; after smoke fix, wall ≈ marker time.

### PDF open path

| Change | Expected | Cross-check |
|--------|----------|-------------|
| Prefer `/pdfium.wasm` (no HEAD probe) | Avoid CDN RTT + failed fetch hangs | Default EmbedPDF wasmUrl is jsDelivr — must pass local |
| Uint8Array copy for Blob | Avoid SharedArrayBuffer Blob throw on WebKit | Matches ImagePreview-style byte copy |
| ensure on setup/CI | Packaged dist always has wasm | postbuild still copies; publicDir seeds `/pdfium.wasm` |

### Web smoke (staging 0.1.5 dist symlink — treat as baseline only)

| Metric | Before (this session) | After smoke-only fixes |
|--------|----------------------|------------------------|
| web DCL | 880ms | **534ms** (same staging dist; variance / cache — not a bundle claim) |
| web workbench | 1893ms | **969ms** (same caveat) |
| native smoke wall | 2063ms, windowMark=false | **411ms**, windowMark=true (smoke race fix + warm) |

No claim of frontend bundle win without a fresh `vite build`. Native binary markers unchanged by Cargo.lock/PDF/CLI (no Rust cold-path edit); smoke wall drop is measurement accuracy + warm cache.

## Cross-validation

- `npm run smoke:startup`
- `npm run smoke:ux`
- `npm run smoke:cli-icons`
- `npm run smoke:preview-md-diff`
- `npm run smoke:pdf` (ensure + marketplace/embedpdf)
- `cargo metadata --manifest-path src-tauri/Cargo.toml --locked`
