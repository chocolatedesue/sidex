/*---------------------------------------------------------------------------------------------
 *  Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { localize } from '../../../../nls.js';
import { IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { IWebviewWorkbenchService } from '../../webviewPanel/browser/webviewWorkbenchService.js';
import { WebviewInput } from '../../webviewPanel/browser/webviewEditorInput.js';
import { WebviewInitInfo } from '../../webview/browser/webview.js';
import { asWebviewUri } from '../../webview/common/webview.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { renderMarkdownDocument, DEFAULT_MARKDOWN_STYLES } from './markdownDocumentRenderer.js';
import { MarkedKatexSupport } from './markedKatexSupport.js';
import { resolveAmdNodeModulePath } from '../../../../amdX.js';

export const MARKDOWN_PREVIEW_VIEW_TYPE = 'sidex.markdown.preview';

const PREVIEW_OPEN_FILES_KEY = 'markdown.preview.openFiles';
const PREVIEW_SECURITY_KEY = 'markdown.preview.security';
const RENDER_DEBOUNCE_MS = 300;
const SCROLL_SYNC_GUARD_MS = 80;

const HAS_SCHEME = /^\w[\w\d+.-]*:/;

/**
 * Preview content trust level, mirroring `markdown.previewSecurity` in VS Code.
 * The default only permits `http(s)` links and no relative paths or media.
 */
export enum MarkdownPreviewSecurityLevel {
	Strict = 'strict',
	AllowInsecureContent = 'allowInsecureContent',
	AllowScriptsAndAllContent = 'allowScriptsAndAllContent',
	DisableContentSecurityWarning = 'disableContentSecurityWarning'
}

const DEFAULT_SECURITY_LEVEL = MarkdownPreviewSecurityLevel.Strict;

function resolveMarkdownUri(baseDir: URI, href: string): URI {
	if (HAS_SCHEME.test(href)) {
		return URI.parse(href);
	}
	return URI.joinPath(baseDir, href);
}

function rewriteImageSrcs(html: string, baseDir: URI): string {
	return html.replace(
		/<img\s+([^>]*?)src="([^"]*?)"([^>]*)>/gi,
		(_match, before: string, src: string, after: string) => {
			if (HAS_SCHEME.test(src) || src.startsWith('data:')) {
				return _match;
			}
			const resolved = resolveMarkdownUri(baseDir, src);
			const webviewSafe = asWebviewUri(resolved);
			return `<img ${before}src="${webviewSafe.toString()}"${after}>`;
		}
	);
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, ch => {
		switch (ch) {
			case '&':
				return '&amp;';
			case '<':
				return '&lt;';
			case '>':
				return '&gt;';
			case '"':
				return '&quot;';
			default:
				return '&#39;';
		}
	});
}

/**
 * Client-side half of the preview: keeps the editor and the preview scrolled
 * together and forwards link clicks. Runs inside the webview sandbox and talks
 * to the workbench through `acquireVsCodeApi()`, which the webview host exposes
 * when scripts are enabled.
 */
function previewClientSource(): string {
	return `(function () {
	var vscode = acquireVsCodeApi();
	var syncing = false;
	function scrollMax() {
		return Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
	}
	function progress() {
		var max = scrollMax();
		return max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
	}
	function applyScroll(value) {
		var max = scrollMax();
		syncing = true;
		window.scrollTo(0, Math.round(Math.min(1, Math.max(0, value)) * max));
		setTimeout(function () { syncing = false; }, ${SCROLL_SYNC_GUARD_MS});
	}
	window.addEventListener('scroll', function () {
		if (syncing) { return; }
		vscode.postMessage({ type: 'onDidScrollPreview', scrollYPercentage: progress() });
	}, { passive: true });
	window.addEventListener('message', function (event) {
		var message = event.data;
		if (!message) { return; }
		if (message.type === 'scrollToProgress') {
			applyScroll(message.value);
		} else if (message.type === 'setBodyStyles' && message.value) {
			document.body.setAttribute('style', message.value);
		}
	});
	document.addEventListener('click', function (event) {
		var target = event.target;
		var anchor = target && target.closest ? target.closest('a') : null;
		if (!anchor) { return; }
		var href = anchor.getAttribute('href');
		if (!href) { return; }
		event.preventDefault();
		event.stopPropagation();
		vscode.postMessage({ type: 'did-click-link', href: href });
	}, true);
})();`;
}

export class MarkdownPreviewManager extends Disposable {
	private _webviewInput: WebviewInput | undefined;
	/** Listeners that live as long as the preview editor does. */
	private readonly _webviewDisposables = this._register(new DisposableStore());
	/** Listeners tied to the current document model, re-bound on every render. */
	private readonly _contentDisposables = this._register(new DisposableStore());
	private readonly _renderCts = this._register(new MutableDisposable<CancellationTokenSource>());
	private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
	private _currentResource: URI | undefined;
	private _lastScrollProgress: number | undefined;

	/** `markdown.preview.toggleLock` — a locked preview stops tracking its source. */
	private _locked = false;
	/** Guard so programme-driven scrolling does not bounce back and forth. */
	private _applyingEditorScroll = false;

	static readonly ID = 'workbench.contrib.markdownPreview';

	constructor(
		@IEditorService private readonly _editorService: IEditorService,
		@IWebviewWorkbenchService private readonly _webviewWorkbenchService: IWebviewWorkbenchService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@ILogService private readonly _logService: ILogService,
		@IStorageService private readonly _storageService: IStorageService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IExtensionService private readonly _extensionService: IExtensionService,
		@ILanguageService private readonly _languageService: ILanguageService,
		@ICodeEditorService private readonly _codeEditorService: ICodeEditorService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@INotificationService private readonly _notificationService: INotificationService
	) {
		super();
	}

	//#region --- public API (commands) ---

	showPreview(side?: boolean, preserveFocus = true): void {
		const resource = this._activeMarkdownResource();
		if (!resource) {
			this._logService.warn('[Markdown Preview] Active editor is not a markdown file');
			return;
		}
		this._currentResource = resource;
		this._locked = false;
		this._createOrUpdateWebview(resource, side, preserveFocus);
	}

	toggle(): void {
		if (this._webviewInput) {
			this._closePreview();
		} else {
			this.showPreview();
		}
	}

	hasActivePreview(): boolean {
		return this._webviewInput !== undefined && !this._webviewInput.isDisposed();
	}

	isLocked(): boolean {
		return this._locked;
	}

	/** `markdown.showSource` — bring the markdown text editor back to the front. */
	async showSource(): Promise<void> {
		const resource = this._currentResource;
		if (!resource) {
			return;
		}
		const existing = this._editorService.findEditors(resource)[0];
		if (existing) {
			await this._editorService.openEditor(existing.editor, { preserveFocus: false }, existing.groupId);
			return;
		}
		await this._editorService.openEditor({ resource, options: { preserveFocus: false, pinned: true } });
	}

	refresh(): void {
		this._renderContent(true);
	}

	toggleLock(): boolean {
		this._locked = !this._locked;
		this._updateLockState();
		return this._locked;
	}

	/** `markdown.showPreviewSecuritySelector` — cycle the preview trust level. */
	cycleSecurityLevel(): MarkdownPreviewSecurityLevel {
		const levels = [
			MarkdownPreviewSecurityLevel.Strict,
			MarkdownPreviewSecurityLevel.AllowInsecureContent,
			MarkdownPreviewSecurityLevel.AllowScriptsAndAllContent,
			MarkdownPreviewSecurityLevel.DisableContentSecurityWarning
		];
		if (!this._currentResource) {
			return DEFAULT_SECURITY_LEVEL;
		}
		const current = this._getSecurityLevel(this._currentResource);
		const next = levels[(levels.indexOf(current) + 1) % levels.length];
		this._setSecurityLevel(this._currentResource, next);
		this._renderContent(true);
		return next;
	}

	/** `markdown.findAllFileReferences` — list the relative paths the document points at. */
	async findAllFileReferences(): Promise<readonly URI[]> {
		const resource = this._currentResource ?? this._activeMarkdownResource();
		if (!resource) {
			return [];
		}
		const model = this._textFileService.files.get(resource);
		if (!model?.isResolved()) {
			return [];
		}
		const text = model.textEditorModel.getValue();
		const found = new Map<string, URI>();
		const linkRe = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
		let match: RegExpExecArray | null;
		while ((match = linkRe.exec(text)) !== null) {
			const href = match[1];
			if (HAS_SCHEME.test(href) || href.startsWith('#')) {
				continue;
			}
			found.set(href, resolveMarkdownUri(URI.joinPath(resource, '..'), href));
		}
		const references = [...found.values()];
		const name = resource.path.split('/').pop() ?? '';
		this._notificationService.info(
			references.length === 0
				? localize('markdownNoFileRefs', 'No file references found in {0}', name)
				: localize(
						'markdownFileRefs',
						'{0} file reference(s) in {1}: {2}',
						references.length,
						name,
						references
							.map(r => r.path.split('/').pop() ?? r.path)
							.slice(0, 10)
							.join(', ')
				  )
		);
		return references;
	}

	static wasPreviewOpen(storageService: IStorageService, resource: URI): boolean {
		const openFiles: string[] = JSON.parse(storageService.get(PREVIEW_OPEN_FILES_KEY, StorageScope.WORKSPACE, '[]'));
		return openFiles.includes(resource.toString());
	}

	//#endregion

	//#region --- webview lifecycle ---

	private _createOrUpdateWebview(resource: URI, side?: boolean, preserveFocus = true): void {
		const title = `Preview: ${resource.path.split('/').pop() || resource.path}`;
		const parentDir = URI.joinPath(resource, '..');

		if (!this._webviewInput) {
			const initInfo: WebviewInitInfo = {
				title,
				options: {
					enableFindWidget: true,
					retainContextWhenHidden: true
				},
				contentOptions: {
					allowScripts: true,
					localResourceRoots: [parentDir]
				},
				extension: undefined
			};

			const input = this._webviewWorkbenchService.openWebview(
				initInfo,
				MARKDOWN_PREVIEW_VIEW_TYPE,
				title,
				undefined,
				{ preserveFocus, group: side ? SIDE_GROUP : undefined }
			);
			if (!input) {
				this._logService.warn('[Markdown Preview] Could not open the preview editor');
				return;
			}
			this._webviewInput = input;

			this._webviewDisposables.add(
				input.onWillDispose(() => {
					this._clearDebounceTimer();
					this._renderCts.clear();
					this._webviewDisposables.clear();
					this._contentDisposables.clear();
					this._webviewInput = undefined;
					this._currentResource = undefined;
					this._locked = false;
				})
			);

			this._webviewDisposables.add(
				input.webview.onMessage(event => this._onPreviewMessage(event.message))
			);

			this._rememberOpenPreview(resource);
		} else {
			this._webviewInput.setWebviewTitle(title);
		}

		this._renderContent(true);
		this._listenToContentChanges();
		this._listenToEditorScroll();
		this._updateLockState();
	}

	private _rememberOpenPreview(resource: URI): void {
		const openFiles: string[] = JSON.parse(
			this._storageService.get(PREVIEW_OPEN_FILES_KEY, StorageScope.WORKSPACE, '[]')
		);
		if (!openFiles.includes(resource.toString())) {
			openFiles.push(resource.toString());
			this._storageService.store(PREVIEW_OPEN_FILES_KEY, openFiles, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}
	}

	private _forgetOpenPreview(resource: URI): void {
		const openFiles: string[] = JSON.parse(
			this._storageService.get(PREVIEW_OPEN_FILES_KEY, StorageScope.WORKSPACE, '[]')
		);
		const filtered = openFiles.filter((f: string) => f !== resource.toString());
		this._storageService.store(PREVIEW_OPEN_FILES_KEY, filtered, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private _updateLockState(): void {
		const name = this._currentResource?.path.split('/').pop() ?? 'Markdown';
		this._webviewInput?.setWebviewTitle(
			this._locked
				? localize('markdownPreviewLockedTitle', 'Preview (locked): {0}', name)
				: localize('markdownPreviewTitle', 'Preview: {0}', name)
		);
	}

	//#endregion

	//#region --- keeping preview, document and editor in sync ---

	private _listenToContentChanges(): void {
		this._contentDisposables.clear();

		if (!this._currentResource) {
			return;
		}

		const fileModel = this._textFileService.files.get(this._currentResource);
		if (!fileModel) {
			return;
		}

		const resource = this._currentResource;
		if (!fileModel.isResolved()) {
			this._contentDisposables.add(
				this._textFileService.files.onDidResolve(e => {
					if (e.model.resource.toString() === resource.toString()) {
						this._listenToContentChanges();
						this._renderContent(true);
					}
				})
			);
			return;
		}

		const textModel = fileModel.textEditorModel;
		this._contentDisposables.add(
			textModel.onDidChangeContent(() => {
				if (this._locked) {
					return;
				}
				if (this._debounceTimer) {
					clearTimeout(this._debounceTimer);
				}
				this._debounceTimer = setTimeout(() => this._renderContent(false), RENDER_DEBOUNCE_MS);
			})
		);
	}

	private _activeMarkdownResource(): URI | undefined {
		const editor = this._editorService.activeEditor;
		const resource = editor instanceof EditorInput ? editor.resource : undefined;
		if (!resource || !resource.path.toLowerCase().endsWith('.md')) {
			return undefined;
		}
		return resource;
	}

	private _listenToEditorScroll(): void {
		const codeEditor = this._codeEditorService.getActiveCodeEditor();
		if (!codeEditor) {
			return;
		}
		this._contentDisposables.add(
			codeEditor.onDidScrollChange(() => {
				if (this._locked || this._applyingEditorScroll) {
					return;
				}
				const max = Math.max(1, codeEditor.getScrollHeight() - codeEditor.getLayoutInfo().height);
				this._postMessage({ type: 'scrollToProgress', value: codeEditor.getScrollTop() / max });
			})
		);
	}

	private _postMessage(message: unknown): void {
		this._webviewInput?.webview.postMessage(message).catch(() => {
			/* the preview may already be gone */
		});
	}

	private _onPreviewMessage(message: any): void {
		switch (message?.type) {
			case 'onDidScrollPreview': {
				const value = typeof message.scrollYPercentage === 'number' ? message.scrollYPercentage : 0;
				this._lastScrollProgress = value;
				if (this._locked) {
					return;
				}
				const codeEditor = this._codeEditorService.getActiveCodeEditor();
				if (!codeEditor) {
					return;
				}
				const max = Math.max(0, codeEditor.getScrollHeight() - codeEditor.getLayoutInfo().height);
				this._applyingEditorScroll = true;
				codeEditor.setScrollTop(value * max);
				setTimeout(() => {
					this._applyingEditorScroll = false;
				}, SCROLL_SYNC_GUARD_MS);
				break;
			}
			case 'did-click-link':
				this._openPreviewLink(String(message.href ?? ''));
				break;
			default:
				break;
		}
	}

	private async _openPreviewLink(href: string): Promise<void> {
		const resource = this._currentResource;
		if (!resource || href.length === 0 || href.startsWith('#')) {
			return;
		}
		const uri = resolveMarkdownUri(URI.joinPath(resource, '..'), href);
		try {
			if (uri.scheme === 'file' || uri.scheme === 'vscode-file') {
				await this._editorService.openEditor({ resource: uri, options: { pinned: true } });
				return;
			}
			await this._openerService.open(uri, { openExternal: true, fromUserGesture: true });
		} catch (err) {
			this._logService.warn('[Markdown Preview] Could not open link', href, err);
		}
	}

	//#endregion

	//#region --- rendering ---

	private _renderContent(resetScroll: boolean): void {
		const input = this._webviewInput;
		const resource = this._currentResource;
		if (!input || !resource) {
			return;
		}

		const fileModel = this._textFileService.files.get(resource);
		if (!fileModel?.isResolved()) {
			return;
		}

		this._renderCts.value?.cancel();
		const cts = new CancellationTokenSource();
		this._renderCts.value = cts;

		const text = fileModel.textEditorModel.getValue();
		const baseDir = URI.joinPath(resource, '..');

		this._renderHtml(text, baseDir, cts.token).then(
			html => {
				if (cts.token.isCancellationRequested || input.isDisposed()) {
					return;
				}
				input.webview.setHtml(html);
				if (resetScroll && this._lastScrollProgress !== undefined) {
					this._postMessage({ type: 'scrollToProgress', value: this._lastScrollProgress });
				}
			},
			err => this._logService.warn('[Markdown Preview] Render failed', err)
		);
	}

	private async _renderHtml(
		text: string,
		baseDir: URI,
		token: CancellationTokenSource['token']
	): Promise<string> {
		const katexExtension = await this._getKatexExtension();

		let body: string;
		try {
			const rendered = await renderMarkdownDocument(
				text,
				this._extensionService,
				this._languageService,
				{
					markedExtensions: katexExtension ? [katexExtension] : undefined,
					sanitizerConfig: this._getSanitizerConfig()
				},
				token
			);
			body = rendered.toString();
		} catch (err) {
			this._logService.warn('[Markdown Preview] Falling back to a plain text render', err);
			body = `<pre class="sidex-preview-fallback">${escapeHtml(text)}</pre>`;
		}

		const withImages = rewriteImageSrcs(body, baseDir);
		const settings = this._getPreviewSettings();
		const katexStyles = katexExtension
			? `<link rel="stylesheet" href="${asWebviewUri(
					URI.parse(resolveAmdNodeModulePath('katex', 'dist/katex.min.css'))
			  ).toString(true)}">`
			: '';

		// Theme colours are injected by the webview host as live `--vscode-*`
		// variables; only markdown-specific fallbacks belong here.
		const previewStyles = `
			:root {
				--text-link-decoration: none;
			}
			body {
				background-color: var(--vscode-editor-background, #1e1e1e);
				color: var(--vscode-editor-foreground, #d4d4d4);
				font-family: var(--vscode-markdown-font-family, ${settings.fontFamily});
				font-size: ${settings.fontSize}px;
				line-height: ${settings.lineHeight};
				word-wrap: break-word;
			}
			pre code {
				background-color: var(--vscode-textCodeBlock-background, rgba(127, 127, 127, 0.1));
			}
			code {
				background-color: var(--vscode-textCodeBlock-background, rgba(127, 127, 127, 0.1));
				color: var(--vscode-textPreformat-foreground, inherit);
			}
			.sidex-preview-fallback {
				white-space: pre-wrap;
			}
			${settings.customStyles}`;

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src * data: blob:; media-src * data: blob:; font-src * data:; style-src * 'unsafe-inline'; script-src 'unsafe-inline';">
	${katexStyles}
	<style>${previewStyles}</style>
	<style>${DEFAULT_MARKDOWN_STYLES}</style>
</head>
<body>
	${withImages}
	<script>${previewClientSource()}</script>
</body>
</html>`;
	}

	private _katexExtensionPromise: Promise<unknown> | undefined;

	private _getKatexExtension(): Promise<unknown> {
		if (!this._katexExtensionPromise) {
			this._katexExtensionPromise = MarkedKatexSupport.loadExtension(window as never).then(
				ext => ext,
				err => {
					this._logService.warn('[Markdown Preview] KaTeX is unavailable', err);
					return undefined;
				}
			);
		}
		return this._katexExtensionPromise;
	}

	private _getPreviewSettings() {
		const config = this._configurationService;
		const fontSize = config.getValue<number>('markdown.preview.fontSize') ?? 14;
		const lineHeight = config.getValue<number>('markdown.preview.lineHeight') ?? 1.6;
		const fontFamily =
			config.getValue<string>('markdown.preview.fontFamily') ??
			'-apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, "Ubuntu", "Droid Sans", sans-serif';
		const customStyles = (config.getValue<string[]>('markdown.styles') ?? [])
			.map(uri => {
				try {
					return `@import url("${asWebviewUri(URI.parse(uri)).toString(true)}");`;
				} catch {
					return '';
				}
			})
			.filter(Boolean)
			.join('\n');
		return { fontSize, lineHeight, fontFamily, customStyles };
	}

	private _getSanitizerConfig() {
		const resource = this._currentResource;
		const level = resource ? this._getSecurityLevel(resource) : DEFAULT_SECURITY_LEVEL;
		switch (level) {
			case MarkdownPreviewSecurityLevel.AllowScriptsAndAllContent:
			case MarkdownPreviewSecurityLevel.DisableContentSecurityWarning:
				return {
					allowedLinkProtocols: { override: '*' as const },
					allowRelativeLinkPaths: true,
					allowedMediaProtocols: { override: '*' as const },
					allowRelativeMediaPaths: true
				};
			case MarkdownPreviewSecurityLevel.AllowInsecureContent:
				return {
					allowedLinkProtocols: { override: '*' as const },
					allowRelativeLinkPaths: true,
					allowRelativeMediaPaths: true
				};
			default:
				return undefined;
		}
	}

	private _getSecurityLevel(resource: URI): MarkdownPreviewSecurityLevel {
		try {
			const map = JSON.parse(this._storageService.get(PREVIEW_SECURITY_KEY, StorageScope.WORKSPACE, '{}'));
			return (map[resource.toString()] as MarkdownPreviewSecurityLevel) ?? DEFAULT_SECURITY_LEVEL;
		} catch {
			return DEFAULT_SECURITY_LEVEL;
		}
	}

	private _setSecurityLevel(resource: URI, level: MarkdownPreviewSecurityLevel): void {
		let map: Record<string, string> = {};
		try {
			map = JSON.parse(this._storageService.get(PREVIEW_SECURITY_KEY, StorageScope.WORKSPACE, '{}'));
		} catch {
			map = {};
		}
		map[resource.toString()] = level;
		this._storageService.store(
			PREVIEW_SECURITY_KEY,
			JSON.stringify(map),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE
		);
	}

	private _clearDebounceTimer(): void {
		if (this._debounceTimer) {
			clearTimeout(this._debounceTimer);
			this._debounceTimer = undefined;
		}
	}

	private _closePreview(): void {
		const input = this._webviewInput;
		if (!input) {
			return;
		}
		if (this._currentResource) {
			this._forgetOpenPreview(this._currentResource);
		}
		this._clearDebounceTimer();
		this._renderCts.clear();
		input.dispose();
		this._webviewInput = undefined;
		this._contentDisposables.clear();
		this._currentResource = undefined;
		this._locked = false;
	}
}
