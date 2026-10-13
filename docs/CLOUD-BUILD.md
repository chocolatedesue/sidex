# Cloud builds

Two clouds can build this tree. Neither needs a local toolchain.

| Where | What | Trigger |
|---|---|---|
| GitHub Actions — `build.yml` (upstream) | `cargo check` on Linux / macOS / Windows | push to `main`, PR (paths-filtered) |
| GitHub Actions — `release.yml` (upstream) | the real release: `tauri build` × 6 targets, signing, Cloudflare R2 + updater manifest | tag `v*` or manual dispatch |
| GitHub Actions — `cloud-build.yml` (added here) | unsigned Linux x86_64 + Windows x86_64 release binaries and an unsigned macOS **`.dmg`** (Apple Silicon), as **workflow artifacts** | manual dispatch, or tag `v*` |
| CNB — `.cnb.yml` (added here) | `check` on push/PR; `linux-x86_64` release tarball published to the `dist/linux-x86_64` branch | push to `main`, PR |

## Getting a binary without any secrets

`release.yml` signs with an Apple certificate, Azure Trusted Signing and uploads
to R2 (`siden-assets`), so on a mirror without those secrets it will fail.
`cloud-build.yml` is the no-secrets path:

1. Actions tab → **Cloud build (no signing secrets)** → *Run workflow*, or
2. `git tag v0.1.5 && git push origin v0.1.5` — the tag also attaches the files
   to a GitHub Release.

Artifacts land under the run’s **Artifacts** section: `sidex-linux-x86_64`
(`.tar.gz`), `sidex-windows-x86_64` (`.zip`), and `sidex-macos-arm64` (`.dmg`).

Only the common architectures are built (x86_64 for Linux/Windows, Apple
Silicon for macOS). Intel macOS is a one-line addition to the `macos` matrix in
`.github/workflows/cloud-build.yml` if it is ever needed.

These artifacts are built with a **relaxed release profile** — parallel codegen
and no LTO, set through `CARGO_PROFILE_RELEASE_*` environment variables — because
the repo’s shipping profile (`lto = "thin"`, `codegen-units = 1`) serialises
codegen and dominates the build time. Same optimisation level, faster build,
marginally slower binary: fine for testing, not what you would publish. Drop
those two env vars to get the shipping profile, or use upstream’s `release.yml`.

The macOS **`.dmg`** is **unsigned** (no Apple certificate in this mirror), so
Gatekeeper will refuse it on first open. Download, open the DMG, drag SideX to
Applications, then either right-click → *Open*, or clear the quarantine flag:

```bash
xattr -dr com.apple.quarantine /Applications/SideX.app
open /Applications/SideX.app
```

The tarball/zip contains the release binary (the workbench frontend is embedded
in it), `dist/` (the built frontend assets), the `extension-host/` and
`shell-integration/` runtime resources the app looks for next to the executable,
and a copy of this file.

Running the Linux build needs GTK 3 and WebKit 2:

```bash
sudo apt-get install -y libwebkit2gtk-4.1-0 libgtk-3-0
./SideX /path/to/a/folder      # or: ./SideX file.md

# Optional: put `sidex` on your PATH (like VS Code's `code`)
./install-cli.sh               # or: ./SideX --install-cli
sidex .
sidex --version
```

The AI panel is off unless you turn it on (`sidex.chat.enabled`), so a plain
launch does not start the agent server, probe a model list or register inline
completions.

## CNB

`.cnb.yml` mirrors the same idea on CNB nodes (no Actions minutes, and it is
where the mirror’s Linux artifacts are meant to live):

- `check` — frontend bundle, `cargo check --all-targets`, `cargo test --lib cli`
- `linux-x86_64` — release build, packaged as `sidex-<version>-linux-x86_64.tar.gz`
  and pushed to the **`dist/linux-x86_64`** branch so the root branch stays clean

```bash
# once the CNB mirror repo exists (see below)
cnb build start-build  --repo <org>/sidex --branch main     # trigger by hand
cnb build get-build-logs --repo <org>/sidex --branch main   # list builds
git clone --branch dist/linux-x86_64 https://cnb.cool/<org>/sidex.git sidex-dist
```

The CNB pipeline needs the repo to exist first:

```bash
cnb repositories create-repo --slug <org> --name sidex --visibility private \
  --description "SideX — mirror of github.com/Sidenai/sidex with CNB cloud builds"
```

Creating it needs a CNB token with the `group-resource:rw` scope for the target
org; the agent account used while setting this up only had read scope, so the
repo still has to be created by someone who owns the org.

Both pipelines install the Tauri Linux stack per run:

```
libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev
librsvg2-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev
```

Node 20+ comes from NodeSource; the CNB job points cargo at the aliyun mirror
(crates.io is slow from CNB nodes) — nothing in the repository depends on it.

## Notes / possible follow-ups

- macOS is not built in `.cnb.yml` — CNB has no cloud macOS nodes — so it goes
  through GitHub Actions (`cloud-build.yml`, unsigned). Upstream's `release.yml`
  builds the signed DMGs when the Apple secrets are present.
- `cargo build --release` produces the raw binary rather than a `.deb`/AppImage;
  `tauri build` (the CLI is already a dev dependency) would emit installers —
  that is what upstream’s `release.yml` does, given the secrets.
- The workflows install system packages with `apt-get` on every run. A build
  environment with them baked in (`docker.build` + Dockerfile on CNB) would cut
  several minutes per build.

## Local alternative

```bash
sudo apt-get install -y pkg-config build-essential \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev
npm install && npm run build
cargo build --release --manifest-path src-tauri/Cargo.toml
```
