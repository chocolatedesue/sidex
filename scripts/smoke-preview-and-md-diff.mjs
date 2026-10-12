#!/usr/bin/env node
/**
 * Smoke: preview-plugin custom-editor bridge + Markdown Diff WYSIWYG wiring.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'smoke-artifacts');
fs.mkdirSync(outDir, { recursive: true });

const evidence = { at: new Date().toISOString(), zone: 'Asia/Shanghai (UTC+8)', steps: [] };
const step = (name, ok, detail) => {
  evidence.steps.push({ name, ok, detail: detail || '' });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const hostSrc = read('src-tauri/extension-host/host.cjs');
step('host.resolveCustomEditor.case', hostSrc.includes("case 'resolveCustomEditor'"));
step('host.resolveCustomEditor.handler', hostSrc.includes('_handleResolveCustomEditor'));
step('host.customEditorClosed', hostSrc.includes("case 'customEditorClosed'"));
step('host.resolveCustomTextEditor', hostSrc.includes('resolveCustomTextEditor'));
step('host.openCustomDocument', hostSrc.includes('openCustomDocument'));

const bridgeSrc = read('src/vs/workbench/contrib/extensions/browser/tauriExtensionHost.contribution.ts');
step('bridge.nonPdfRegistered', bridgeSrc.includes('[webview bridge]') && bridgeSrc.includes('_openExtensionCustomEditor'));
step('bridge.noLongerDeferred', !bridgeSrc.includes('deferred (non-PDF webview bridge pending)'));
step('bridge.resolveRequest', bridgeSrc.includes("'resolveCustomEditor'") || bridgeSrc.includes('"resolveCustomEditor"') || bridgeSrc.includes('resolveCustomEditor'));
step('bridge.openWithSkipsBuiltins', bridgeSrc.includes('BUILTIN_OPEN_WITH_VIEW_TYPES') && bridgeSrc.includes('Open With: skip'));
step('bridge.openWithNoFakePdfRemap', !bridgeSrc.includes('via EmbedPDF'));
step('bridge.pdfBuiltinOnly', bridgeSrc.includes('use built-in PDF Preview'));

const contribSrc = read('src/vs/workbench/contrib/markdown/browser/markdown.contribution.ts');
step('md.createDiffEditorInput', contribSrc.includes('createDiffEditorInput'));
step('md.openMarkdownDiffEditor.cmd', contribSrc.includes('markdown.openMarkdownDiffEditor'));
step('md.diffEditorTitle', contribSrc.includes('Open Markdown Diff Editor'));

const diffSrc = read('src/vs/workbench/contrib/markdown/browser/markdownDiffEditor.ts');
step('md.diff.sideBySide', diffSrc.includes('SideBySideEditorInput'));
step('md.diff.standalone', diffSrc.includes('createStandaloneEditorInput'));

const edSrc = read('src/vs/workbench/contrib/markdown/browser/markdownEditor.ts');
step('md.standaloneApi', edSrc.includes('createStandaloneEditorInput'));


const previewSrc = read('src/vs/workbench/contrib/markdown/browser/markdownPreview.ts');
step('md.preview.viewType.vscode', previewSrc.includes("MARKDOWN_PREVIEW_VIEW_TYPE = 'vscode.markdown.preview.editor'"));

const pdfContrib = read('src/vs/workbench/contrib/pdfPreview/browser/pdfPreview.contribution.ts');
step('pdf.openWith.label', pdfContrib.includes("'PDF Preview'") && pdfContrib.includes('EmbedPDF'));
step('pdf.openWith.default', pdfContrib.includes('RegisteredEditorPriority.default'));

step('md.editor.viewType.vscode', edSrc.includes("MARKDOWN_EDITOR_VIEW_TYPE = 'vscode.markdown.editor'") || edSrc.includes('vscode.markdown.editor'));

// Live resolveCustomEditor against host.cjs (no IPC process.send → module.exports branch)
try {
  const require = createRequire(import.meta.url);
  const host = require(path.join(root, 'src-tauri/extension-host/host.cjs'));
  const viewType = 'sidex.smoke.preview';
  let gotHtml = false;
  let htmlEvent = null;
  const onEvent = (ev) => {
    if (ev?.type === 'webviewHtmlUpdate') htmlEvent = ev;
  };
  host.on('event', onEvent);
  host._customEditorProviders = new Map();
  host._customEditorProviders.set(viewType, {
    resolveCustomTextEditor(_document, panel) {
      panel.webview.html = '<html><body><h1>smoke-preview</h1></body></html>';
      gotHtml = true;
    },
  });
  const resource = 'file:///tmp/sidex-smoke-preview.md';
  if (!host._textDocuments) host._textDocuments = new Map();
  host._textDocuments.set(resource, { uri: resource, languageId: 'markdown', version: 1, text: '# hi' });

  const reply = await Promise.resolve(
    host.handleMessage({
      id: 4242,
      type: 'resolveCustomEditor',
      params: { viewType, panelId: 'smoke-panel-1', resource, title: 'Smoke' },
    })
  );
  host.off('event', onEvent);
  const ok = !!(reply?.result?.resolved && gotHtml && htmlEvent?.html?.includes('smoke-preview'));
  step('host.live.resolveCustomEditor', ok, JSON.stringify({
    resolved: reply?.result?.resolved,
    gotHtml,
    htmlSnippet: (htmlEvent?.html || '').slice(0, 80),
    error: reply?.error,
  }));
} catch (e) {
  step('host.live.resolveCustomEditor', false, e instanceof Error ? e.message : String(e));
}

const failed = evidence.steps.filter((s) => !s.ok).length;
evidence.failed = failed;
evidence.passed = evidence.steps.length - failed;
fs.writeFileSync(path.join(outDir, 'preview-md-diff-evidence.json'), JSON.stringify(evidence, null, 2));
console.log(`\n${evidence.passed}/${evidence.steps.length} passed`);
process.exit(failed ? 1 : 0);
