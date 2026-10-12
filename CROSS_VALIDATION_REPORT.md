# SideX Cross-Validation Report (LAB-707 操作腻子)

**Date:** 2026-10-12 (Asia/Shanghai, UTC+8)  
**Repo:** `chocolatedesue/sidex`  
**Box checkout:** `/workspace/sidex` (Grok Bot built-in machine)  
**Merge HEAD:** `de752693bfde907345e15425283abe6ef3f65de4` (feature/markdown-wysiwyg-vscode-parity → main)  
**Follow-up HEAD:** `3873daaaddf4fc8f6d4299cc03e7d1df25850d46` (KeyChord + this report)  
**Remote:** `origin/main` includes both (pushed).

Sources: Multica LAB-707 (ccds lab) user asks + agent deliveries, `DEV_NOTES_MD_WYSIWYG.md`, VS Code 1.141 `markdown-editor-out`, local `npm run build`, GitHub Actions.

---

## Summary table — user Grok Bot requirements

| # | Requirement | Result | Evidence |
|---|-------------|--------|----------|
| 1 | Developed on Grok Bot box (not Cursor cloud) | **PASS** | Local `/workspace/sidex`; commits `40708cf` / `deccf62` / merge `de75269`; no Cursor CloudAgent for WYSIWYG. |
| 2 | Align VS Code feel / icons / plugins | **PARTIAL** | Codicon `markdown` / `openPreview` / `edit` on editor title. Open VSX fallback in `marketplace.rs`. Extension host WIP limits plugin activation. |
| 3 | Markdown 所见即所得 = VS Code latest WYSIWYG | **PASS** | `viewType: vscode.markdown.editor`; loads VS Code **1.141** `markdown-editor-out/editor.js` (~598KB). Not a toy renderer. |
| 4 | Cross-validate vs VS Code behavior | **PARTIAL** | Protocol/commands/assets verified; GUI E2E not on headless box. **Ctrl+K V** chord fixed (was wrong non-chord binding). |
| 5 | Pushed and merged into **main** | **PASS** | Merge `de75269` on `origin/main`; follow-up `3873daaaddf4fc8f6d4299cc03e7d1df25850d46` pushed. |

---

## LAB-707 操作腻子 acceptance checklist

| # | Item | Result | Evidence / notes |
|---|------|--------|------------------|
| 1 | CLI 基础文件夹互操作 (argv / folder-uri / file-uri / goto / single-instance / sidex://) | **PARTIAL** | `src-tauri/src/cli.rs` implements flags, deep links, tests. Box rustc **1.85.1** cannot compile (deps need **1.91**); `cargo test --lib cli` not runnable here. |
| 2 | Markdown latest reader + 所见即所得 + preview (GFM/KaTeX/scroll) | **PASS** | `markdownEditor.ts` + `markdown.contribution.ts` + vendored `markdown-editor-out`. Preview `markdownPreview.ts` retained. `setup-extensions.sh` → VS Code 1.141.0. `npm run build` green; `dist/.../editor.js` present. |
| 3 | Web 模式自测 (fs-bridge, Tauri detect, ?folder=/?file=) | **PARTIAL** | `vite-plugin-sidex-fs-bridge.ts` present. Multica `win-webtest.log` shows prior Windows web smoke. No `npm run e2e` script; playwright dep only. |
| 4 | AI/Copilot default OFF; no sidex-server on startup | **PASS** | `sidex.chat.enabled` default **false**. `server::register` only; spawn via `server_ensure_started` on demand. |
| 5 | 云构建 cloud-build.yml | **PASS** (workflow) / **PARTIAL** (push CI) | Workflow builds win/linux/mac arm64. Last cloud-build dispatch **success** (`38246656651`). Merge push: Lint JS OK; Formatting + Lint Rust **failed** on pre-existing prettier/rustfmt in AI crates (not MD files). |
| 6 | Preview plugin / Reopen Editor With / editorAssociations | **PASS** | Resolvers for Markdown Preview + `vscode.markdown.editor` at `RegisteredEditorPriority.option`. |
| 7 | PDF built-in EditorPane via embed-pdf-viewer | **PARTIAL** | Native `pdfPreview` EditorPane wired; uses **pdfjs-dist**, not `@embedpdf`/embed-pdf-viewer. |
| 8 | Public repo + common-arch CI | **PASS** | Public `chocolatedesue/sidex`; cloud-build common arches documented. |
| 9 | Install/open smoke Windows/Mac | **PARTIAL** | Prior Multica agent reported both. This box has no SideX GUI / no Mac. |
| 10 | 审查: markdown 首开白屏 lifecycle | **PARTIAL** | Mitigated/documented in `markdownPreview.ts` (resolver open lifecycle, `retainContextWhenHidden`, resolve model first). Not GUI-reverified on box. |

---

## Protocol cross-check (editor.js ↔ SideX host)

| Direction | Message | SideX |
|-----------|---------|-------|
| W→H | ready (+ editEpoch) | Sets ready, syncs epoch |
| W→H | edit (start, endExclusive, text, editEpoch) | pushEditOperations; stale → update |
| H→W | update (content, editEpoch) | On model change / refresh |
| W→H | history (undo/redo) | Code editor trigger or re-sync |
| W→H | openLink | Opener / open editor |
| W→H | setReadonly | Profile storage |
| H→W | command / toggleReadonly | Matches editor.js case |
| W→H | code-block / comments | No-op / empty (ext host gap) |

Asset base: `${origin}/extensions/markdown-language-features/markdown-editor-out`.

---

## Feel / icons / plugins

| Aspect | Status |
|--------|--------|
| Title Codicon markdown + open-preview + edit | PASS |
| Product icon theme picker parity | PARTIAL |
| Open VSX fallback when siden marketplace down | PASS (code) |
| MD extensions own custom editor | FAIL (ext host WIP) |

---

## Remaining gaps

1. Extension host WIP — rich Markdown Editor features unavailable.  
2. customEditor stub for extension-contributed editors.  
3. PDF is pdf.js, not embed-pdf-viewer.  
4. Box rustc 1.85 vs required 1.91.  
5. Formatting CI red on unrelated AI files.  
6. No box GUI proof of WYSIWYG round-trip.  
7. Diff Markdown Editor path not ported.

---

## Fixes pushed this pass

| Commit | Change |
|--------|--------|
| `3873daaaddf4fc8f6d4299cc03e7d1df25850d46` | `KeyChord(Ctrl/Cmd+K, V)` for `markdown.showPreviewToSide` (was Ctrl+K / Ctrl+V separately). Plus this report. |

---

## Manual try on Windows SideX

1. Pull `main` or download Actions **Cloud build** artifact.  
2. `npm run setup:full && npm run dev` or run `SideX.exe`.  
3. Open `.md`.  
4. Palette → **Markdown: Open Markdown Editor** → **Toggle Lock** → edit rendered view → confirm source updates.  
5. Side preview: **Ctrl+K then V** (chord) or open-preview icon.  
6. Reopen Editor With… → Preview / Markdown Editor / Text.  
7. Open `.pdf` → Modern PDF Preview (pdf.js).  
8. AI panel stays off until `sidex.chat.enabled`.  
9. Extensions: Open VSX search works with fallback; activation limited without full host.

Web smoke: build + serve dist with `?folder=` / `?file=` (see Multica win-webtest.log).

---

## Multica alignment

- Workspace **ccds lab**, issue **LAB-707** in_progress.  
- 腻子 items above map to user asks (CLI, MD WYSIWYG, web, AI off, cloud build, reopen-with, PDF, public CI, install, 白屏).  
- Multica issue comment **not** posted (needs explicit user/parent approval to comment on the issue).
