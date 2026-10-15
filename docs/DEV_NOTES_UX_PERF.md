# SideX UX / Perf triage (VS Code 1.140–1.141 + Tauri 2.12)

Reviewed against VS Code stable **1.140** (2026-09-30) and **1.141** (2026-10-07), and Tauri **2.12.3** (already on SideX).

## Triage table

| Item | Source | Decision | Notes |
|------|--------|----------|-------|
| Compact layout density (`window.density.layout`) | 1.141 | **Port** | Settings + CSS + class wiring (`density-compact`) + View menu toggle |
| Frosted glass overlays (`workbench.modernUIFrostedGlass`) | 1.141 | **Port** | CSS backdrop-filter; respects reduced-transparency; opt-out setting |
| Frosted glass opacity | 1.141 | **Port** | `workbench.modernUIFrostedGlassOpacity` |
| Tab style connected/pill (`workbench.experimental.modernUIEditorTabStyle`) | 1.141 | **Port** | CSS-only SideX surface (no full experimental modern UI) |
| Compact editor tab height | 1.141 / density | **Port** | `editor-tabs-compact` when density or `window.density.editorTabHeight` is compact |
| Spreading block paste (`editor.multiCursorPaste: spread`) | 1.141 | **Port** | Default enabled in configurationDefaults |
| Agent session grid / harness / sandbox / Copilot | 1.140–1.141 | **Skip** | Agent-host product surface; SideX keeps AI off by default |
| Worktree cleanup / Dev Container cache | 1.140–1.141 | **Skip** | Agent-host only |
| Terminal macOS grayscale font rendering | 1.140 | **Done earlier** | `terminal.integrated.fontRendering` already in defaults |
| Chat terminal output reflow | 1.140 | **Skip / parity only** | Setting present; AI surfaces stay disabled |
| `editor.selectedTextMatchMode` | 1.140 | **Port** | Default `findOptions` |
| Upstream memory-leak disposable fixes (SimonSiefke batch) | 1.141 thanks | **Later** | Valuable; needs selective upstream cherry-picks, not a drive-by |
| Welcome / splash first paint | UX gap | **Port** | `#sidex-splash` until `.monaco-workbench` mounts; product JSON → 1.141.0 |
| Empty editor watermark readability | UX gap | **Port** | Theme-token colors for shortcuts on dark chrome |
| Empty explorer / getting-started density | UX gap | **Port** | Light CSS polish |
| Titlebar / statusbar / sash tighter in compact | UX gap | **Port** | Under `density-compact` |
| Activity bar compact size | already present | **Keep** | `workbench.activityBar.compact` already wired |
| File icons / vscode-icons | prior | **Done** | Separate commit |
| Terminal operator UX | prior | **Done** | Separate commit |
| Tauri 2.12 → 3.0 alpha | Tauri | **Skip** | Stay on 2.12.3 stable |
| Tauri release profile (thin LTO, strip, codegen-units 1) | Tauri | **Keep** | Already tuned; cloud-build relaxes for speed |
| Window starts `visible: false` + restore | Tauri | **Keep** | Avoids white flash; paired with `#111111` backgroundColor |
| Deep-link registration deferred after first paint | Tauri | **Keep** | Prior startup work |
| Updater plugin present | Tauri | **Keep** | No change this round |
| wry additionalBrowserArgs / disable GPU | Tauri | **Later** | Platform-specific; measure before enabling |
| Overlay scrollbars / thin thumbs | UX | **Keep + polish** | Already thin; rounded slider |
| Important perf optimizations | user | **Deferred** | Only after CI green + UX; require cross-validated numbers |

## Shipped

### v0.1.8
- `window.density.layout` / frosted-glass settings + runtime class controller
- Splash screen + product version alignment to 1.141
- VS Code 1.141-ish editor/list defaults
- Tauri window `backgroundColor: #111111`
- Version **0.1.8**

### v0.1.13
- Editor tab styles: `connected` / `pill` / `default` (`workbench.experimental.modernUIEditorTabStyle`)
- View → Appearance → **Layout Density** toggle (`sidex.ux.toggleLayoutDensity`) + Command Palette tab-style actions
- Compact editor tabs + breadcrumbs when density/tab-height is compact
- Empty-editor watermark uses theme tokens (readable on SideX dark)
- Version sync: `package.json` / `Cargo.toml` / `Cargo.lock` / `tauri.conf.json` all **0.1.13**

### v0.1.14 / v0.1.15 (mirror line)
- Terminal: PTY IPC coalescing + flow control, fish shell integration, cross-platform profiles (Windows `profiles` / `env`, pwsh default)
- Keybinding sensing: chord timeout 5s, `cmdorctrl` / `option` aliases, Win/Linux `Ctrl+Y` redo
- CLI `--install-cli` on Windows installs to `%LOCALAPPDATA%\SideX\bin`

## Not boiling the ocean

No Copilot harness, no Tauri 3, no mass upstream leak cherry-picks, no speculative perf flags without measurement.
