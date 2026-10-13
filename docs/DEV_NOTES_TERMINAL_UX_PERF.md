# Terminal UX + performance (v0.1.14)

Aligned with **VS Code 1.141** where measurable; cross-validated before push.

## Usability

| Item | Change | Evidence |
|------|--------|----------|
| Shell detection | Merge `/etc/shells` + `which` PATH (fish/zsh/bash/pwsh); dedupe by basename; single default | `detects_fish_when_present` test; fish present on box |
| Fish support | Profile drops forced `-l` (VS Code default); inject `shellIntegration.fish` via `--init-command` | smoke:terminal; packaged `src-tauri/shell-integration/shellIntegration.fish` |
| Basic completion | `terminal.integrated.suggest.enabled: true` + quickSuggestions | smoke:terminal; VS Code default |

## Performance (important only)

| Item | Before | After | Cross-check |
|------|--------|-------|-------------|
| PTY→IPC emit coalesce (8ms / 64KB) | 1 emit per `read()` | Batched bursts | Unit: 100 tiny chunks → ≤20 emits (~80%+ fewer) |
| Flow control + `terminal_ack_data` | JS invoked missing command every chunk | Real unacked high/low water (256K/64K) | Registered in `lib.rs`; frontend ack kept |
| Frontend rAF merge | Each IPC chunk → `onProcessData` | Same-frame join before xterm | smoke:terminal |
| `terminal.integrated.smoothScrolling` | `true` (SideX) | `false` (VS Code default) | smoke:ux / terminal |
| `workbench.list.smoothScrolling` | `true` | `false` (VS Code default) | smoke:terminal |

Skipped (not measurable / agent-only): Copilot terminal sandbox, mass upstream leak cherry-picks, Tauri 3.

## Commands

- `npm run smoke:terminal` — 12 checks
- `cargo test --manifest-path src-tauri/Cargo.toml --lib commands::terminal::tests`
- `npm run smoke:ux`
