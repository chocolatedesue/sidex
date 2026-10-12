# Cloud builds

Two clouds can build this tree. Neither needs a local toolchain.

| Where | What | Trigger |
|---|---|---|
| GitHub Actions — `build.yml` (upstream) | `cargo check` on Linux / macOS / Windows | push to `main`, PR (paths-filtered) |
| GitHub Actions — `release.yml` (upstream) | the real release: `tauri build` × 6 targets, signing, Cloudflare R2 + updater manifest | tag `v*` or manual dispatch |
| GitHub Actions — `cloud-build.yml` (added here) | unsigned Linux + Windows release binaries as **workflow artifacts** | manual dispatch, or tag `v*` |
| CNB — `.cnb.yml` (added here) | `check` on push/PR; `linux-x86_64` release tarball published to the `dist/linux-x86_64` branch | push to `main`, PR |

## Getting a binary without any secrets

`release.yml` signs with an Apple certificate, Azure Trusted Signing and uploads
to R2 (`siden-assets`), so on a mirror without those secrets it will fail.
`cloud-build.yml` is the no-secrets path:

1. Actions tab → **Cloud build (no signing secrets)** → *Run workflow*, or
2. `git tag v0.1.3 && git push origin v0.1.3` — the tag also attaches the files
   to a GitHub Release.

Artifacts land under the run’s **Artifacts** section: `sidex-linux-x86_64`
(`.tar.gz`) and `sidex-windows-x86_64` (`.zip`).

The tarball/zip contains the release binary (the workbench frontend is embedded
in it), `dist/` (the built frontend assets), the `extension-host/` and
`shell-integration/` runtime resources the app looks for next to the executable,
and a copy of this file.

Running the Linux build needs GTK 3 and WebKit 2:

```bash
sudo apt-get install -y libwebkit2gtk-4.1-0 libgtk-3-0
./SideX /path/to/a/folder      # or: ./SideX file.md
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

- macOS is not built in `.cnb.yml` (CNB has no cloud macOS nodes) and is not in
  `cloud-build.yml` (it would need the Apple signing material to be useful).
  Upstream’s `release.yml` covers it.
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
