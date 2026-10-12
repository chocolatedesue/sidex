# Cloud builds

SideX builds on CNB cloud nodes. Every push to `main` runs two pipelines
(see `.cnb.yml`); pull requests run the fast one only.

| Pipeline | What it does | Roughly |
|---|---|---|
| `check` | `npm ci` → `npm run build` (frontend) → `cargo check --all-targets` → `cargo test --lib cli` | minutes |
| `linux-x86_64` | the above, plus `cargo build --release` and a packaged tarball | tens of minutes |

Nothing needs to be installed locally: push, then either watch the build in the
CNB web UI or from a shell:

```bash
cnb build get-build-logs --repo <org>/sidex --branch main   # list builds
cnb build start-build   --repo <org>/sidex --branch main    # trigger by hand
```

## Getting the Linux build

The `linux-x86_64` pipeline packages `sidex-<version>-linux-x86_64.tar.gz` and
publishes it to the **`dist/linux-x86_64` branch** of this repository (the root
branch stays clean; artifacts never mix with source):

```bash
git clone --branch dist/linux-x86_64 https://cnb.cool/<org>/sidex.git sidex-dist
tar xzf sidex-dist/sidex-*.tar.gz
```

The tarball contains:

- `SideX` — the release binary (the workbench frontend is embedded in it)
- `dist/` — the built frontend assets (kept for debugging / reuse)
- `extension-host/`, `shell-integration/` — runtime resources the app looks for
  next to the executable
- `README.md` — a copy of this file

Run it on a machine with GTK 3 and WebKit 2 (Debian/Ubuntu):

```bash
sudo apt-get install -y libwebkit2gtk-4.1-0 libgtk-3-0
./SideX /path/to/a/folder      # or: ./SideX file.md
```

The AI panel is off unless you turn it on (`sidex.chat.enabled`), so a plain
launch does not start the agent server, probe a model list or register inline
completions. Enabling the panel starts that stack on demand.

## Linux build dependencies

The Tauri Linux stack, installed per run because the image does not ship it:

```
libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev
librsvg2-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev
```

Node 20 comes from NodeSource. Cargo is pointed at the aliyun mirror (crates.io
is slow from CNB nodes) by writing `.cargo/config.toml` at build time — nothing
in the repository depends on that mirror.

## Notes / possible follow-ups

- macOS is not built here: CNB has no cloud macOS nodes. Windows is not built
  here either — a `cargo-xwin` cross job (as in the Malgel pipeline) would fit
  next to `linux-x86_64`.
- The pipeline installs system packages with `apt-get` on every run. Baking them
  into a build environment (`docker.build` + a Dockerfile) would cut several
  minutes per build.
- `cargo build --release` produces the raw binary rather than a `.deb`/AppImage.
  Adding `tauri build` (the `@tauri-apps/cli` is already a dev dependency) would
  emit installers instead.

## Local alternative

For a one-off local build the same steps work; on a Debian/Ubuntu box:

```bash
sudo apt-get install -y pkg-config build-essential \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev
npm install && npm run build
cargo build --release --manifest-path src-tauri/Cargo.toml
```
