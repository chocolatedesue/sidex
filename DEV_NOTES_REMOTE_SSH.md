# Remote SSH — SideX adaptation notes

## What “Remote SSH plugin” means here

SideX already ships a **built-in Remote Explorer** (`Connect to…` → **Connect to Host…** labeled *Remote-SSH*) backed by the Rust crate `sidex-remote` (russh). That is the primary “plugin” path users hit without installing Microsoft’s proprietary extension.

Separately, Open VSX publishes **`jeanp413.open-remote-ssh`**. SideX now enables the proposed APIs that extension needs (`resolvers`, …). Full parity with its “download server + websocket” protocol is **not** claimed yet.

## Built-in connect path (working target)

1. Command Palette → **Connect to…** → **Connect to Host…** (or Remote Explorer SSH leaf).
2. Pick `~/.ssh/config` host or **Add New SSH Host…** (`user@host[:port]`).
3. Auth: agent → config `IdentityFile` → password prompt.
4. On success: authority `ssh-remote+user@host` is resolved; pick **Open Remote Home** (or other path).
5. Explorer opens `vscode-remote://ssh-remote+…/path` via SideX FS provider.

## Open VSX extension path

1. Extensions view → search **Open Remote - SSH** (`jeanp413.open-remote-ssh`) on Open VSX / siden gallery → Install.
2. Proposed APIs are pre-allowed in product (`extensionEnabledApiProposals`).
3. Remaining work: Node extension host must activate the resolver; remote must fetch a SideX/VSCodium-compatible server. Until then prefer the built-in path.

## Build / test on this box (`/workspace/sidex`)

```bash
cd /workspace/sidex
npm run smoke:remote-ssh
# optional live SSH probe:
# SIDEX_SMOKE_SSH=box@127.0.0.1,22 npm run smoke:remote-ssh

cargo test -p sidex-remote
# full app (when iterating UI):
npm run build
cd src-tauri && cargo build
```

## Manual UI check

1. Launch SideX (Tauri or web+mock — FS commands need Tauri).
2. Status bar remote icon → Connect to Host.
3. Connect to a host; confirm notification + folder picker; Explorer lists remote files.

## Gaps

| Area | Status |
|------|--------|
| SSH connect + exec | Yes (`sidex-remote`) |
| vscode-remote FS read/write | Yes (this change) |
| Open remote folder workspace | Yes (createAndEnterWorkspace) |
| Authority resolver for extensions | Deferred resolve + product proposals |
| jeanp413 server install / websocket | Not complete |
| Remote terminal PTY UI | Transport has `open_pty`; workbench not wired |
| File watching | No |
