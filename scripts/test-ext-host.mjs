#!/usr/bin/env node
/**
 * Unit tests for the Node extension host (`src-tauri/extension-host/host.cjs`).
 *
 * The host is a plain CommonJS module that also exports its singleton instance,
 * so it can be driven in-process without Tauri, Rust, or a real webview. These
 * tests cover the custom editor path:
 *
 *   openCustomDocument -> resolveCustomEditor -> onDidChangeCustomDocument (dirty)
 *     -> save / saveAs / revert / backup / deleteBackup -> customEditorClosed
 *
 * Run: `npm run test:ext-host` (i.e. `node --test scripts/test-ext-host.mjs`).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const host = require(path.join(root, 'src-tauri/extension-host/host.cjs'));

const RESOURCE = 'file:///tmp/sidex-ext-host-test.custom';
const VIEW_TYPE = 'sidex.test.customEditor';

/** Collect host events for the duration of one test. */
function collectEvents() {
  const events = [];
  const onEvent = (ev) => events.push(ev);
  host.on('event', onEvent);
  return {
    events,
    stop() { host.off('event', onEvent); },
    dirtyEvents() { return events.filter((e) => e.type === 'customDocumentDirty'); },
    lastDirty() { const d = this.dirtyEvents(); return d[d.length - 1]; },
  };
}

/** Reset the singleton's mutable state so tests do not leak into each other. */
beforeEach(() => {
  host._customEditorProviders = new Map();
  host._customDocuments = new Map();
  host._customDocumentsByResource = new Map();
  host._customDocumentBackups = new Map();
  host._webviewPanels = new Map();
  host._textDocuments = new Map();
  host._textDocuments.set(RESOURCE, {
    uri: RESOURCE,
    languageId: 'plaintext',
    version: 1,
    text: 'hello custom document',
  });
});

/** A CustomDocument-shaped object backed by a testable edit emitter. */
function makeCustomDocument() {
  const listeners = [];
  const document = {
    uri: RESOURCE,
    disposed: false,
    edits: [],
    onDidChangeCustomDocument(listener) {
      listeners.push(listener);
      return { dispose() { const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1); } };
    },
    dispose() { this.disposed = true; },
    _fireEdit() {
      const edit = { label: 'test edit', undo: () => {}, redo: () => {} };
      this.edits.push(edit);
      for (const l of listeners.slice()) l(edit);
      return edit;
    },
    _listenerCount() { return listeners.length; },
  };
  return document;
}

/** Register a provider and resolve a custom editor; returns the spy + handles. */
async function openCustomEditor(providerOverrides = {}) {
  const document = makeCustomDocument();
  const calls = {
    openCustomDocument: [],
    resolveCustomEditor: [],
    saveCustomDocument: [],
    saveCustomDocumentAs: [],
    revertCustomDocument: [],
    backupCustomDocument: [],
  };
  const provider = {
    async openCustomDocument(uri, context, token) {
      calls.openCustomDocument.push({ uri: uri?.toString?.() || String(uri), context, token });
      return document;
    },
    async resolveCustomEditor(doc, panel, token) {
      calls.resolveCustomEditor.push({ doc, panel, token });
      panel.webview.html = '<html><body>custom</body></html>';
    },
    async saveCustomDocument(doc, token) { calls.saveCustomDocument.push({ doc, token }); },
    async saveCustomDocumentAs(doc, destination, token) { calls.saveCustomDocumentAs.push({ doc, destination, token }); },
    async revertCustomDocument(doc, token) { calls.revertCustomDocument.push({ doc, token }); },
    async backupCustomDocument(doc, context, token) {
      calls.backupCustomDocument.push({ doc, context, token });
      return { id: 'backup-1', destination: context?.destination, delete() { calls.backupDeleted = true; } };
    },
    ...providerOverrides,
  };
  host._customEditorProviders.set(VIEW_TYPE, provider);

  const panelId = `panel-${Math.random().toString(36).slice(2)}`;
  const reply = await host.handleMessage({
    id: 1,
    type: 'resolveCustomEditor',
    params: { viewType: VIEW_TYPE, panelId, resource: RESOURCE, title: 'Custom' },
  });
  return { document, calls, provider, panelId, reply };
}

test('resolveCustomTextEditor still resolves and pushes webview HTML', async () => {
  const events = collectEvents();
  try {
    host._customEditorProviders.set(VIEW_TYPE, {
      resolveCustomTextEditor(doc, panel) {
        panel.webview.html = '<html><body>text-editor</body></html>';
      },
    });
    const reply = await host.handleMessage({
      id: 1,
      type: 'resolveCustomEditor',
      params: { viewType: VIEW_TYPE, panelId: 'p-text', resource: RESOURCE },
    });
    assert.equal(reply.result.resolved, true);
    const html = events.events.find((e) => e.type === 'webviewHtmlUpdate');
    assert.ok(html, 'expected a webviewHtmlUpdate event');
    assert.match(html.html, /text-editor/);
    // A CustomTextEditorProvider has no CustomDocument, so no lifecycle entry.
    assert.equal(host._customDocuments.size, 0);
  } finally {
    events.stop();
  }
});

test('resolveCustomEditor calls openCustomDocument then resolveCustomEditor', async () => {
  const events = collectEvents();
  try {
    const { document, calls, reply } = await openCustomEditor();
    assert.equal(reply.result.resolved, true);
    assert.equal(calls.openCustomDocument.length, 1);
    assert.equal(calls.resolveCustomEditor.length, 1);
    assert.equal(calls.resolveCustomEditor[0].doc, document, 'provider must receive the CustomDocument');
    assert.equal(calls.openCustomDocument[0].context.backupId, undefined);
    const html = events.events.find((e) => e.type === 'webviewHtmlUpdate');
    assert.match(html.html, /custom/);
  } finally {
    events.stop();
  }
});

test('resolveCustomEditor tracks the custom document by panel and resource', async () => {
  const events = collectEvents();
  try {
    const { panelId } = await openCustomEditor();
    assert.ok(host._customDocuments.has(panelId));
    assert.equal(host._customDocumentsByResource.get(RESOURCE), panelId);
    assert.equal(host._customDocuments.get(panelId).viewType, VIEW_TYPE);
  } finally {
    events.stop();
  }
});

test('a CustomDocument edit marks the editor dirty', async () => {
  const events = collectEvents();
  try {
    const { document, panelId } = await openCustomEditor();
    assert.equal(events.lastDirty(), undefined, 'no dirty event before an edit');
    document._fireEdit();
    const dirty = events.lastDirty();
    assert.ok(dirty, 'expected a customDocumentDirty event');
    assert.equal(dirty.dirty, true);
    assert.equal(dirty.panelId, panelId);
    assert.equal(dirty.resource, RESOURCE);
  } finally {
    events.stop();
  }
});

test('saveCustomDocument calls the provider and clears dirty', async () => {
  const events = collectEvents();
  try {
    const { document, calls, panelId } = await openCustomEditor();
    document._fireEdit();
    const reply = await host.handleMessage({
      id: 2,
      type: 'saveCustomDocument',
      params: { panelId },
    });
    assert.equal(reply.result.saved, true);
    assert.equal(calls.saveCustomDocument.length, 1);
    assert.equal(calls.saveCustomDocument[0].doc, document);
    assert.equal(events.lastDirty().dirty, false, 'save must clear dirty');
  } finally {
    events.stop();
  }
});

test('saveCustomDocument resolves the document by resource too', async () => {
  const events = collectEvents();
  try {
    const { calls } = await openCustomEditor();
    const reply = await host.handleMessage({
      id: 3,
      type: 'saveCustomDocument',
      params: { resource: RESOURCE },
    });
    assert.equal(reply.result.saved, true);
    assert.equal(calls.saveCustomDocument.length, 1);
  } finally {
    events.stop();
  }
});

test('saveCustomDocumentAs moves the resource and clears dirty', async () => {
  const events = collectEvents();
  try {
    const { calls, panelId } = await openCustomEditor();
    const destination = 'file:///tmp/sidex-ext-host-test-renamed.custom';
    const reply = await host.handleMessage({
      id: 4,
      type: 'saveCustomDocumentAs',
      params: { panelId, destination },
    });
    assert.equal(reply.result.saved, true);
    assert.equal(calls.saveCustomDocumentAs.length, 1);
    assert.equal(calls.saveCustomDocumentAs[0].destination.toString(), destination);
    assert.equal(host._customDocuments.get(panelId).resource, destination);
    assert.equal(host._customDocumentsByResource.get(destination), panelId);
    assert.equal(host._customDocumentsByResource.get(RESOURCE), undefined);
  } finally {
    events.stop();
  }
});

test('revertCustomDocument calls the provider and clears dirty', async () => {
  const events = collectEvents();
  try {
    const { document, calls, panelId } = await openCustomEditor();
    document._fireEdit();
    const reply = await host.handleMessage({ id: 5, type: 'revertCustomDocument', params: { panelId } });
    assert.equal(reply.result.reverted, true);
    assert.equal(calls.revertCustomDocument.length, 1);
    assert.equal(events.lastDirty().dirty, false);
  } finally {
    events.stop();
  }
});

test('backupCustomDocument returns a backup id and deleteCustomDocumentBackup deletes it', async () => {
  const events = collectEvents();
  try {
    const { calls, panelId } = await openCustomEditor();
    const reply = await host.handleMessage({
      id: 6,
      type: 'backupCustomDocument',
      params: { panelId, destination: 'file:///tmp/backup.custom' },
    });
    assert.equal(reply.result.backupId, 'backup-1');
    assert.equal(calls.backupCustomDocument.length, 1);
    assert.equal(calls.backupCustomDocument[0].context.destination.toString(), 'file:///tmp/backup.custom');

    const del = await host.handleMessage({
      id: 7,
      type: 'deleteCustomDocumentBackup',
      params: { backupId: 'backup-1' },
    });
    assert.equal(del.result, true);
    assert.equal(calls.backupDeleted, true);
    assert.equal(host._customDocumentBackups.has('backup-1'), false);
  } finally {
    events.stop();
  }
});

test('customEditorClosed disposes the document and stops dirty notifications', async () => {
  const events = collectEvents();
  try {
    const { document, panelId } = await openCustomEditor();
    document._fireEdit();
    const before = events.dirtyEvents().length;

    const reply = await host.handleMessage({ id: 8, type: 'customEditorClosed', params: { panelId } });
    assert.equal(reply.result, true);
    assert.equal(document.disposed, true, 'CustomDocument.dispose must be called');
    assert.equal(host._customDocuments.has(panelId), false);
    assert.equal(host._customDocumentsByResource.has(RESOURCE), false);
    assert.equal(document._listenerCount(), 0, 'dirty listener must be unsubscribed');

    document._fireEdit();
    assert.equal(events.dirtyEvents().length, before, 'no dirty events after close');
  } finally {
    events.stop();
  }
});

test('lifecycle handlers report a clear error when nothing is open', async () => {
  const reply = await host.handleMessage({ id: 9, type: 'saveCustomDocument', params: { panelId: 'nope' } });
  assert.match(reply.error, /no open custom document/);
});

test('lifecycle handlers report a clear error when the provider lacks the method', async () => {
  const events = collectEvents();
  try {
    host._customEditorProviders.set(VIEW_TYPE, {
      openCustomDocument: async () => makeCustomDocument(),
      resolveCustomEditor: async () => {},
    });
    const panelId = 'panel-no-save';
    const open = await host.handleMessage({
      id: 10,
      type: 'resolveCustomEditor',
      params: { viewType: VIEW_TYPE, panelId, resource: RESOURCE },
    });
    assert.equal(open.result.resolved, true);
    const reply = await host.handleMessage({ id: 11, type: 'saveCustomDocument', params: { panelId } });
    assert.match(reply.error, /has no saveCustomDocument/);
  } finally {
    events.stop();
  }
});
