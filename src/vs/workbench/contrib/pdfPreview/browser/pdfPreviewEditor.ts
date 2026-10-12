/*---------------------------------------------------------------------------------------------
 *  SideX — built-in PDF preview via EmbedPDF (embed-pdf-viewer / @embedpdf/snippet).
 *
 *  Matches LAB-707 / Modern-PDF-Preview: native EditorPane hosting the EmbedPDF
 *  snippet viewer (PDFium WASM), not a bare pdf.js canvas loop. Works in desktop
 *  and web builds without the extension host.
 *--------------------------------------------------------------------------------------------*/

import { $, Dimension, clearNode } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { MutableDisposable } from '../../../../base/common/lifecycle.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { PdfPreviewEditorInput } from './pdfPreviewEditorInput.js';
import pdfiumWasmUrl from '@embedpdf/snippet/dist/pdfium.wasm?url';

type EmbedPdfInit = (config: Record<string, unknown>) => { remove?: () => void } | undefined;

export class PdfPreviewEditor extends EditorPane {
	static readonly ID = 'sidex.pdf.preview';

	private _container!: HTMLElement;
	private _host!: HTMLElement;
	private _message: HTMLElement | undefined;
	private _renderCts = new MutableDisposable<CancellationTokenSource>();
	private _currentResource: PdfPreviewEditorInput['resource'] | undefined;
	private _blobUrl: string | undefined;
	private _viewer: { remove?: () => void } | undefined;
	private _embedPdf: EmbedPdfInit | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
		@INotificationService private readonly _notificationService: INotificationService
	) {
		super(PdfPreviewEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._container = $('.pdf-preview', {
			style: 'width:100%;height:100%;overflow:hidden;position:relative;'
		});
		this._host = $('.pdf-preview-embedpdf', {
			style: 'width:100%;height:100%;'
		});
		this._container.appendChild(this._host);
		parent.appendChild(this._container);

		this._register(this.themeService.onDidColorThemeChange(() => this._applyTheme()));
		this._applyTheme();
	}

	override layout(dimension: Dimension): void {
		if (!this._container) {
			return;
		}
		this._container.style.width = `${dimension.width}px`;
		this._container.style.height = `${dimension.height}px`;
		if (this._host) {
			this._host.style.width = `${dimension.width}px`;
			this._host.style.height = `${dimension.height}px`;
		}
	}

	override async setInput(
		input: PdfPreviewEditorInput,
		_options: IEditorOptions | undefined,
		_context: IEditorOpenContext,
		token: CancellationToken
	): Promise<void> {
		await super.setInput(input, _options, _context, token);
		this._currentResource = input.resource;
		await this._render(input.resource);
	}

	override clearInput(): void {
		this._renderCts.value?.cancel();
		this._teardownViewer();
		this._currentResource = undefined;
		super.clearInput();
	}

	override dispose(): void {
		this._teardownViewer();
		super.dispose();
	}

	private _teardownViewer(): void {
		try {
			this._viewer?.remove?.();
		} catch {
			/* ignore */
		}
		this._viewer = undefined;
		if (this._blobUrl) {
			URL.revokeObjectURL(this._blobUrl);
			this._blobUrl = undefined;
		}
		if (this._host) {
			clearNode(this._host);
		}
		this._message = undefined;
	}

	private _appendMessage(text: string): void {
		this._teardownViewer();
		if (!this._host) {
			return;
		}
		this._message = $('.pdf-preview-message', {
			style: 'padding:24px;opacity:.8;font-size:13px;'
		});
		this._message.textContent = text;
		this._host.appendChild(this._message);
	}

	private _applyTheme(): void {
		const theme = this.themeService.getColorTheme();
		if (this._container) {
			this._container.style.backgroundColor = theme.getColor('editor.background')?.toString() ?? 'transparent';
			this._container.style.color = theme.getColor('editor.foreground')?.toString() ?? 'inherit';
		}
	}

	private _themePreference(): 'light' | 'dark' | 'system' {
		const type = this.themeService.getColorTheme().type;
		if (type === 'dark' || type === 'hcDark') {
			return 'dark';
		}
		if (type === 'light' || type === 'hcLight') {
			return 'light';
		}
		return 'system';
	}

	private async _loadEmbedPdf(): Promise<EmbedPdfInit> {
		if (!this._embedPdf) {
			const mod: any = await import('@embedpdf/snippet');
			const api = mod?.default ?? mod;
			const init: EmbedPdfInit | undefined = typeof api?.init === 'function'
				? api.init.bind(api)
				: (typeof mod?.init === 'function' ? mod.init : undefined);
			if (typeof init !== 'function') {
				throw new Error('@embedpdf/snippet did not export EmbedPDF.init');
			}
			this._embedPdf = init;
		}
		return this._embedPdf;
	}

	/** Load the file into EmbedPDF (PDFium WASM), cancelling whatever ran before. */
	private async _render(resource: PdfPreviewEditorInput['resource'] | undefined): Promise<void> {
		if (!resource) {
			return;
		}
		this._renderCts.value?.cancel();
		const cts = new CancellationTokenSource();
		this._renderCts.value = cts;

		try {
			this._appendMessage('Loading PDF (EmbedPDF)…');
			const file = await this._fileService.readFile(resource);
			if (cts.token.isCancellationRequested) {
				return;
			}

			const data = new Uint8Array(file.value.buffer.slice(0));
			const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
			const blobUrl = URL.createObjectURL(new Blob([ab], { type: 'application/pdf' }));
			if (cts.token.isCancellationRequested) {
				URL.revokeObjectURL(blobUrl);
				return;
			}

			const init = await this._loadEmbedPdf();
			if (cts.token.isCancellationRequested) {
				URL.revokeObjectURL(blobUrl);
				return;
			}

			this._teardownViewer();
			this._blobUrl = blobUrl;

			const wasmUrl = resolveWasmUrl();
			this._viewer = init({
				type: 'container',
				target: this._host,
				src: blobUrl,
				// Vite bundles the PDFium worker into assets; forcing worker:true
				// without a resolved worker URL stalls on "Initializing plugins…".
				// Modern-PDF-Preview also defaults worker off unless the host
				// supplies a dedicated worker config.
				worker: false,
				wasmUrl,
				theme: { preference: this._themePreference() },
				tabBar: 'never',
				// Avoid Google-Fonts / jsDelivr fontFallback fetches (hang or CSP in app).
				fontFallback: null,
				fonts: { ui: null },
				// Match Modern-PDF-Preview defaults that sidestep desktop print/export plumbing.
				disabledCategories: ['print', 'export', 'redaction', 'document'],
				annotations: { autoOpenLinks: false },
				zoom: { defaultZoomLevel: 'page-width' },
				spread: { defaultSpreadMode: 'odd' },
			});

			if (!this._viewer) {
				this._appendMessage('EmbedPDF failed to mount the viewer.');
				this._notificationService.warn('EmbedPDF PDF viewer failed to initialize.');
			}
		} catch (err) {
			if (cts.token.isCancellationRequested) {
				return;
			}
			this._logService.error('[PDF Preview] EmbedPDF could not render', resource.toString(), err);
			this._appendMessage(`Could not open this PDF: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

function resolveWasmUrl(): string {
	// Prefer the Vite-emitted asset URL; fall back to public/pdfium.wasm for preview/web.
	if (typeof pdfiumWasmUrl === 'string' && pdfiumWasmUrl.length > 0) {
		return pdfiumWasmUrl;
	}
	const base = (typeof document !== 'undefined' && document.baseURI) ? document.baseURI : '/';
	try {
		return new URL('pdfium.wasm', base).href;
	} catch {
		return '/pdfium.wasm';
	}
}
