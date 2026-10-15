# Win / Mac / Linux compatibility + keybinding sensing (v0.1.15)

Cross-checked against **VS Code 1.141** behavior for paths, terminal profiles, CLI install, and modifier/chord sensing.

## Fixes

| Area | Issue | Fix |
|------|--------|-----|
| Terminal defaults | Hardcoded `defaultProfile.linux=bash` / `osx=zsh` blocked `$SHELL` detection | Omit defaults; Tauri backend sets from detected profile |
| Windows profiles | Missing `profiles.windows` / `env.windows` | Added PowerShell / pwsh / cmd / Git Bash |
| Default profile name | `shell.split('/')` broke on `C:\\...\\powershell.exe` | Use `getShellBasename` + detected `profileName` |
| Fish | Rust still forced `-l` when args `None` | Exclude fish from auto-login args (profile + SI inject unchanged) |
| CLI install | PATH check used `:` on Windows; bin always `~/.local/bin` | `;` separator; `%LOCALAPPDATA%\\SideX\\bin` on Windows |
| Redo | Rust defaults only `Ctrl/Cmd+Shift+Z` | Win/Linux also `Ctrl+Y` (VS Code primary) |
| Chord timeout | Rust `ChordState` 3s; VS Code 5s | Align to **5s** + expire in `process_key` |
| Sensing aliases | Missing `cmdorctrl` | Parse `cmdorctrl` → Cmd (mac) / Ctrl (else); `option`→Alt |
| Labels | META always printed `Meta` | `Cmd` / `Win` / `Meta` by OS |

## Smoke

- `npm run smoke:compat`
- `npm run smoke:terminal`
- `cargo test -p sidex-keymap`
- `cargo test --manifest-path src-tauri/Cargo.toml --lib commands::terminal::tests cli::tests`

## Skipped

Webview UA spoofing, full keyboard layout mapper ports, Tauri 3.
