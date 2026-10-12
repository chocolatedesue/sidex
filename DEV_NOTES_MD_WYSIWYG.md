# SideX — Markdown WYSIWYG (所见即所得) + VS Code parity notes

Date: 2026-10-12 (Asia/Shanghai). Merged to **`main`**; app version **0.1.5**.
Box checkout: `/workspace/sidex` (fork `chocolatedesue/sidex`).
Original feature branch: `feature/markdown-wysiwyg-vscode-parity`.

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
- Install-by-id resolves siden/Open VSX download then `install_extension_from_url` (web can search via HTTP fallback).
- Extension host: Node LocalProcess host activates many providers. **customEditors** now resolve via `resolveCustomEditor` webview bridge for common preview plugins; PDF still uses built-in EmbedPDF. Full VS Code parity (all APIs) remains incomplete.

## Build status (box)

- `npm install` — OK (Node 20 on box; tas-client wants ≥22 — warning only).
- `npm run setup` / `setup:full` — builtins + VS Code **1.141** `markdown-editor-out`.
- `npm run build` — **green**. `postbuild` copies `extensions/` into `dist/extensions/` including `markdown-editor-out/editor.js`.
- Dev static: `GET /extensions/markdown-language-features/markdown-editor-out/editor.js` → 200 via vite middleware.
- Toolchain: **rustc/cargo 1.99.0** (latest stable) via rustup (`PATH` must include `~/.cargo/bin`). `cargo check` / release binary OK; Tauri GUI needs display.
- Push / release: `gh` as **chocolatedesue**; shipped on `main` and tag **v0.1.5**.

## Remaining gaps vs VS Code Markdown Editor

1. Extension-host activation of upstream `MarkdownEditorProvider` (rich links, rename, completions, code-block editors, comments, syntax highlighting via proposed API). Workbench still hosts `markdown-editor-out` directly.
2. Workbench `customEditor` service remains a stub; marketplace custom editors now resolve through the Tauri extension-host **webview bridge** (`resolveCustomEditor`) instead of being deferred (non-PDF). PDF stays on EmbedPDF.
3. ~~Diff / inline-diff Markdown Editor path not ported.~~ **Ported (2026-10-13):** `MarkdownDiffEditorManager` + `createDiffEditorInput` + command `markdown.openMarkdownDiffEditor` (side-by-side WYSIWYG via `SideBySideEditorInput`). Inline custom-diff highlight API (`customEditorDiffs` / line markers) still not ported.
4. Undo/redo from the webview prefers a focused text editor; model edits still apply via `pushEditOperations`.
5. `setup-extensions.sh` GitHub *source* tarball path does not include `markdown-editor-out`; the script now pulls the **product** linux build when those assets are missing.

## 2026-10-13 — Preview plugins + Markdown Diff WYSIWYG

### Preview / custom-editor plugins
- **Root cause:** `_registerExtensionCustomEditor` skipped every non-PDF viewType (`deferred (non-PDF webview bridge pending)`), so Open VSX preview extensions could install but never open a pane.
- **Fix:** Node `host.cjs` gains `resolveCustomEditor` / `customEditorClosed` (CustomTextEditorProvider + CustomReadonlyEditorProvider). Workbench registers selectors and opens a webview, then asks the host to resolve. PDF associations still map to EmbedPDF.
- **Smoke:** `npm run smoke:preview-md-diff` (16/16).

### Markdown Diff Editor (WYSIWYG)
- New `markdownDiffEditor.ts`; resolver `createDiffEditorInput` for `vscode.markdown.editor`.
- Commands / Editor title: **Markdown: Open Markdown Diff Editor**.
- How to try: open a changed `.md` from SCM (text diff) → Command Palette / title icon → Markdown Diff Editor; or Reopen Editor With → Markdown Editor on a diff.

## Out of scope

SideX built-in AI agent / `sidexChat` — not touched.


## 2026-10-12 dep/perf + release follow-up

See CROSS_VALIDATION_REPORT.md "Dependency + performance pass" and "Release 0.1.4". rustc 1.99; Wasmtime 49 lazy; npm/cargo patch bumps; EmbedPDF + marketplace install; tag `v0.1.5`.


## 2026-10-13 — Open With / Reopen With ↔ VS Code UX

- Skip re-registering `vscode.markdown.editor` / `vscode.markdown.preview.editor` / PDF remaps from ext-host contributes (picker had duplicates or "(via EmbedPDF)" stubs).
- Preview viewType → `vscode.markdown.preview.editor`; PDF label → **PDF Preview**.
- Working marketplace preview plugins still register once and open via resolveCustomEditor bridge.
