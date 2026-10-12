# SideX Cross-Validation Report (LAB-707 操作腻子)

**Date:** 2026-10-12 (Asia/Shanghai, UTC+8)  
**Repo:** `chocolatedesue/sidex`  
**Box checkout:** `/workspace/sidex` (Grok Bot built-in machine)  
**Verified HEAD (pre-follow-up):** `de752693bfde907345e15425283abe6ef3f65de4`  
**Remote:** `origin/main` contains merge `Merge feature/markdown-wysiwyg-vscode-parity` (confirmed via `gh api` + `git fetch`).  
**Follow-up on this report:** KeyChord fix commit `ac1edaa73f0577ab9027aaae30da7534d8e7515f` (see § Fixes pushed).

Sources: Multica LAB-707 description + comments (dds c + prior agents), `DEV_NOTES_MD_WYSIWYG.md`, vendored VS Code 1.141 `markdown-editor-out`, local build/CI.

---

## Summary table — user Grok Bot requirements

|---|-------------|--------|----------|

---

## LAB-707 操作腻子 acceptance checklist

|---|------|--------|------------------|

---

## Protocol cross-check (VS Code `markdown-editor-out` ↔ SideX host)

|-----------|---------|----------------|

Asset base: `${origin}/extensions/markdown-language-features/markdown-editor-out` (vite middleware + postbuild copy).

---

## Feel / icons / plugins (Grok Bot ask)

|--------|--------|

---

## Remaining gaps (honest)

1. Extension host WIP → stock `MarkdownEditorProvider` features (rich links, rename, completions, code-block editors, comments, syntax highlighter API) unavailable.  
2. Workbench `customEditor` largely stubbed for *extension*-contributed editors.  
3. PDF: pdf.js EditorPane ≠ requested embed-pdf-viewer.  
4. Box rustc 1.85 cannot build/test Tauri crates needing 1.91.  
5. Formatting CI red on unrelated AI/chat prettier + rustfmt.  
6. No headless GUI proof of WYSIWYG unlock→edit→source round-trip on this box.  
7. Diff/inline-diff Markdown Editor path not ported.

---

## Fixes pushed in this validation pass

|--------|-----|

`ac1edaa73f0577ab9027aaae30da7534d8e7515f`

---

## How to manually try on Windows SideX

1. Pull/build `main` (or download Cloud build artifact from Actions → **Cloud build**).  
2. Dev: `npm run setup:full && npm run dev` (or packaged `SideX.exe`).  
3. Open a `.md` file.  
4. **WYSIWYG:** Command Palette → `Markdown: Open Markdown Editor` (or title Codicon markdown) → `Markdown Editor: Toggle Lock` to unlock → type in rendered view → confirm source updates.  
5. **Side preview:** `Ctrl+K` then `V` (chord) or title open-preview icon.  
6. **Reopen With…:** pick Markdown Preview / Markdown Editor / Text.  
7. **PDF:** open a `.pdf` — expect Modern PDF Preview EditorPane (pdf.js).  
8. Confirm AI panel stays hidden until Settings → `sidex.chat.enabled`.  
9. Extensions: search Open VSX; note activation limits without full extension host.

Web-only smoke: `npm run build &&` serve `dist` / vite preview with `?folder=` / `?file=` (see Multica `win-webtest.log`).

---

## Multica alignment

- Workspace: **ccds lab** (`052cc38c-…`), issue **LAB-707** in_progress.  
- User asks covered: CLI interop, MD reader/WYSIWYG, web test, AI off, cloud build, reopen-with, PDF embedded preview, public+arch, install notes, 白屏 lifecycle awareness.  
- Optional Multica comment: draft not posted automatically (needs explicit send approval); parent may paste summary table above.
