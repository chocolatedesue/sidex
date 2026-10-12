# SideX — Markdown WYSIWYG (所见即所得) + VS Code parity notes

Date: 2026-10-12 (Asia/Shanghai). Branch: `feature/markdown-wysiwyg-vscode-parity`.
Box checkout: `/workspace/sidex` (fork `chocolatedesue/sidex`).

## What this is

VS Code ≥ 1.135 ships a third Markdown mode — **Markdown Editor** — a hybrid
WYSIWYG editor (`viewType: vscode.markdown.editor`) implemented in
`extensions/markdown-language-features` on top of `@vscode/markdown-editor`.
The TextDocument stays the source of truth; the webview is the rendered surface.

SideX's extension host is still WIP, so the full extension
`CustomTextEditorProvider` path does not activate yet. This change **reuses the
exact VS Code 1.141 `markdown-editor-out` webview bundle** and hosts it from the
workbench (same approach SideX already uses for the side-by-side Markdown
Preview). Protocol: the simple `postMessage` contract the shipped `editor.js`
speaks (`ready` / `edit` / `update` / `history` / `openLink` / `setReadonly` / …).

## Key files

| Path | Role |
|------|------|
| `src/vs/workbench/contrib/markdown/browser/markdownEditor.ts` | Workbench host for VS Code Markdown Editor webview |
| `src/vs/workbench/contrib/markdown/browser/markdown.contribution.ts` | Registers editor resolver, commands, title icons, settings |
| `src/vs/workbench/contrib/markdown/browser/markdownPreview.ts` | Existing side Preview (live sync, KaTeX, GFM) — kept |
| `scripts/setup-extensions.sh` | Bumps catalog to VS Code **1.141.0**; ensures `markdown-editor-out` |
| `vite.config.ts` | Dev-server `/extensions/**` static for the webview assets |
| `crates/sidex-extensions/src/marketplace.rs` | Open VSX fallback when `marketplace.siden.ai` is down |

Gitignored runtime assets (populated by `npm run setup:full` / setup script):

- `extensions/markdown-language-features/markdown-editor-out/` (editor.js + chunks)
- `extensions/markdown-basics`, `markdown-math`, `mermaid-markdown-features`

## How to try (vs VS Code)

1. On the box: `cd /workspace/sidex && npm run setup:full && npm run dev`
   - Or, if `extensions/` already has `markdown-editor-out/editor.js`, `npm run setup && npm run dev`.
2. Open any `.md` file.
3. **Markdown Editor (WYSIWYG)**  
   - Command Palette → `Markdown: Open Markdown Editor`  
   - or Editor title bar → Markdown icon  
   - or `Reopen Editor With…` → **Markdown Editor**  
   - Unlock via `Markdown Editor: Toggle Lock` (starts locked/read-only, same as VS Code).
4. **Side Preview (classic)** — still available: `Ctrl+K V` / `Open Preview to the Side`.
5. Compare with stock VS Code 1.141: same three modes (Text / Preview / Markdown Editor).

### Cross-check checklist

- [ ] Unlock → type in rendered view → source `.md` updates with correct Markdown syntax  
- [ ] Edit source in Text Editor → Markdown Editor refreshes (authoritative `update`)  
- [ ] Mermaid fenced blocks render (bundled in `markdown-editor-out`)  
- [ ] KaTeX in side Preview still works (`katex` dependency + preview path)  
- [ ] Theme tokens follow workbench (`--vscode-*` / default markdown-editor theme CSS)  
- [ ] Editor title shows Codicon `markdown` + `open-preview` (Preview)  

## Icon / chrome

- Editor title: `Codicon.markdown` for Open Markdown Editor; existing `Codicon.openPreview` for Preview to the Side.
- Activity bar / product icon theme already use `@vscode/codicons` (`package.json`). No custom icon font added.
- Remaining gap vs stock VS Code: full **product icon theme** picker and some contributed view icons that only appear when the matching built-in extensions activate under a working extension host.

## Plugins / Open VSX

- Install path: Rust `sidex-extensions` marketplace client → default `https://marketplace.siden.ai/api` (Open-VSX-compatible).
- This change: if that worker errors on search, **retry once against `https://open-vsx.org/api`** so Markdown-related extensions remain discoverable.
- Hard limit (unchanged): **extension host is WIP**. Installing a VSIX/Open VSX extension that needs Node `vscode` API (including stock `markdown-language-features` itself) will not fully activate. Language basics / themes / many web-capable pieces can still load via the web worker host; custom editors from extensions need the restored `customEditor` contribution + LocalProcess host (stubbed today).

## Build status (box)

- `npm install` — OK (Node 20 on box; tas-client wants ≥22 — warning only).
- `npm run build` — run after `setup` so `extensions-meta` + vite succeed; full Tauri GUI may not run headless.
- `cargo check -p sidex-extensions` — marketplace fallback should compile.

## Remaining gaps vs VS Code Markdown Editor

1. Extension-host activation of upstream `MarkdownEditorProvider` (rich links, rename, completions, code-block editors, comments, syntax highlighting via proposed API).
2. Workbench `customEditor` service is still largely stubbed — “Reopen Editor With” for *extension*-contributed custom editors needs that restore.
3. Diff / inline-diff Markdown Editor path not ported.
4. Undo/redo from the webview prefers a focused text editor; model edits still apply via `pushEditOperations`.
5. `setup-extensions.sh` GitHub *source* tarball path does not include `markdown-editor-out`; the script now pulls the **product** linux build when those assets are missing.

## Out of scope

SideX built-in AI agent / `sidexChat` — not touched.
