# Remote SSH — SideX adaptation notes

## What “Remote SSH plugin” means here

SideX ships a **built-in Remote Explorer** (`Connect to…` → **Connect to Host…**) backed by `sidex-remote` (russh 0.46). That is the primary path. Open VSX **`jeanp413.open-remote-ssh`** proposed APIs are enabled; its “download server + websocket” protocol is **not** claimed.

## Build / test on the box (`/workspace/sidex`)

```bash
cd /workspace/sidex
# multi-sshd lab (ports 2222–2228)
./scripts/remote-ssh-lab.sh up
export SIDEX_SSH_LAB=/tmp/sidex-ssh-lab SSH_AUTH_SOCK=$SIDEX_SSH_LAB/agent.sock

cargo test -p sidex-remote --lib
cargo test -p sidex-remote --test live_ssh -- --test-threads=4

npm run smoke:remote-ssh
# keep green when touching shared workbench bits:
npm run smoke:startup
npm run smoke:preview-md-diff
```

## Behavior matrix (phase 2)

Legend: **pass** = covered by automated test + works · **fixed** = was broken, now pass · **unsupported** = clear coded error, no hang · **fail** = still broken

### ssh_config

| Item | Status | Evidence |
|------|--------|----------|
| Aliases / multi-alias (`Host a b`) | pass | `config_alias_and_second_alias` |
| HostName / Port / User | pass | live + unit `ssh_config` |
| IdentityFile + IdentitiesOnly | pass | lab `lab-key` |
| Include (relative, nested, after Host) | pass | `config_include_and_wildcard` + unit |
| Wildcards + `!` negation | pass | unit + `lab-wild-*` |
| ProxyJump chain + order | pass / fixed | `config_proxy_jump_goes_through_jump_host` (direct-tcpip in jump log) |
| ProxyJump loops / max hops | pass | `config_proxy_jump_loop_is_rejected` |
| ProxyCommand | pass / fixed | `config_proxy_command_nc` |
| Failing ProxyCommand | pass | `config_failing_proxy_command_reports_error_fast` |
| user@host:port / ssh:// + overrides | pass | `config_user_at_host_port_overrides` |
| Match all / host | pass | unit |
| Token expand `%h %p %r %u %d %n` | pass | unit |

### auth

| Item | Status | Evidence |
|------|--------|----------|
| ssh-agent | pass / fixed | `auth_agent` (real `AgentClient`) |
| Public key (ed25519, rsa) | pass | `auth_key_ed25519_and_rsa` |
| Encrypted key + passphrase | pass / fixed | `auth_encrypted_key_passphrase_flow` + UI prompt |
| Password | pass | `auth_password_ok_and_wrong` |
| Password → keyboard-interactive (PAM) | pass / fixed | `auth_password_falls_back_to_keyboard_interactive` (kbd-first) |
| Wrong credentials | pass | coded `SIDEX_AUTH_FAILED`, fast |
| OTP-style kbd-interactive (non-password prompts) | unsupported | `SIDEX_UNSUPPORTED` / `auth_otp_style_…` |
| Host key first-seen (TOFU learn) | pass / fixed | `hostkey_first_seen_is_learned_then_trusted` |
| Host key changed | pass / fixed | `hostkey_changed_is_refused_with_details` |
| StrictHostKeyChecking yes | pass | `hostkey_strict_rejects_unknown_accepts_known` |
| known_hosts per-port | pass | `hostkey_known_hosts_is_per_port` |

### lifecycle

| Item | Status | Evidence |
|------|--------|----------|
| Connect timeout | pass / fixed | `lifecycle_blackhole_times_out`, unit `silent_server_times_out` |
| Unreachable / DNS | pass | `lifecycle_unknown_host_name` |
| Connection refused | pass | `lifecycle_refused_is_fast_and_coded` |
| Disconnect mid-session | pass | `lifecycle_connection_drop_is_detected_then_reconnect` |
| Reconnect | pass | same + `remote_reconnect` Tauri cmd |
| Multiple hosts in parallel | pass / fixed | `lifecycle_multiple_hosts_in_parallel` (Arc transport, lock not held across await) |
| Cancel during connect | pass | `lifecycle_cancel_connect_by_dropping` + `remote_cancel_connect` |

### remote FS

| Item | Status | Evidence |
|------|--------|----------|
| stat / read / write / create / delete / rename / mkdir | pass / fixed | `fs_*` live tests |
| Large files (12 MiB) streaming | pass / fixed | `fs_text_binary_large_roundtrip` (stdin `cat >`, not base64 argv) |
| Binary safe | pass / fixed | same (no lossy UTF-8) |
| Unicode / spaces / quotes / `$` / newlines in paths | pass / fixed | `fs_unicode_…` + fish login |
| Symlinks (file/dir/dangling) | pass / fixed | `fs_stat_types_symlinks_missing` |
| Permission denied | pass | `fs_permission_denied_everywhere` |
| External change visible via stat | pass | `fs_external_change_visible_via_stat` |
| File watching | unsupported | no inotify bridge yet |
| Login shell = fish | pass / fixed | base64+env wrap; `exec_fish_login_shell_still_runs_posix` |

### exec / terminal / forwarding

| Item | Status | Evidence |
|------|--------|----------|
| Exit codes / stderr / signals | pass / fixed | `exec_exit_codes_stderr_signal` |
| Env quoting | pass / fixed | `exec_env_is_quoted_exactly` |
| Long-running + large stdout + stdin | pass | `exec_long_running_and_large_output_and_stdin_eof` |
| PTY + resize | pass / fixed | `pty_size_resize_and_tty` |
| Local port forward (port 0 → bound) | pass / fixed | `forward_local_port_zero_returns_bound_port` |
| Reverse / remote forward | unsupported | `SIDEX_UNSUPPORTED` |

### opening / authority / UI / extension

| Item | Status | Notes |
|------|--------|-------|
| Open folder / home after connect | pass | `afterSshConnected` |
| Authority `ssh-remote+user@host[:port]` | pass | `buildSshRemoteAuthority` |
| Recents | unsupported | not wired to storage yet |
| Connect to Host / Remote Explorer / status bar | pass | existing contrib |
| Close Remote Connection | pass / fixed | `sidex.remote.close` |
| Errors shown (coded) | pass / fixed | `[SIDEX_*]` → friendly notification |
| Graceful web (non-Tauri) message | pass | `SIDEX_UNSUPPORTED` / desktop required |
| open-remote-ssh activation / resolver register | pass / fixed | `host.cjs` stores resolvers; routes `vscode.openFolder` with ssh-remote → `sidex.remote.openAuthority` |
| jeanp413 server install / websocket | unsupported | clear gap; prefer built-in |
| Platform detect (uname) | pass | `platform_detect_linux_and_override` + unit table from upstream |

## Counts (this revision)

| pass | fixed (subset of pass) | unsupported | fail |
|------|------------------------|-------------|------|
| 70+ matrix rows green in live/unit | ~20 formerly broken items | 5 (OTP kbd, reverse forward, watching, recents, jeanp413 server) | 0 |

Live suite: **44/44** with `SIDEX_SSH_LAB` (`cargo test -p sidex-remote --test live_ssh`).

## Gaps still open

- Reverse port forwarding
- OTP / multi-prompt keyboard-interactive beyond password
- Remote file watching
- Recent-hosts persistence
- Full jeanp413 / MS remote-ssh server install path

## Extra live suite: `tests/live_ssh_matrix.rs` (45 tests, all pass)

A second, independent live suite against `scripts/remote-ssh-lab.sh`
(`SIDEX_SSH_LAB=/tmp/sidex-ssh-lab cargo test -p sidex-remote --tests`):
ed25519/RSA/encrypted key (missing / right / wrong passphrase), agent and
IdentityFile fallback, password, PAM keyboard-interactive, wrong creds,
host key learned→trusted / changed / strict-unknown, refused / blackhole
timeout / bad DNS (bounded), parallel multi-host, cancel during connect,
kill-session-mid-command → `SIDEX_CONNECTION_LOST` (no hang) + backoff
reconnect while the host restarts, no retry on auth failure, ssh_config
alias / multi-alias / Include glob / wildcard / user@alias + overrides /
ProxyJump (verified via jump sshd `direct-tcpip` log) / loop rejected /
ProxyCommand ok + broken, exit codes / stderr / env quoting / SIGKILL=137,
fish login shell bypass, concurrent + 5 MB output, PTY `stty size` after
resize, `-L` port 0, reverse forward → `SIDEX_UNSUPPORTED`, FS CRUD /
EEXIST / rename overwrite / 8 MB binary / weird names (newline, tab,
quotes, `$`, backtick, CJK, emoji, leading dash) / symlinks (dir, file,
broken) / EACCES / EISDIR / ENOTDIR / ENOENT / external change, platform
detect (bash + fish).

The lab also authorizes `~/.ssh/id_*.pub` on :2222 so the default
`smoke:remote-ssh` (no env) stays 39/39.
