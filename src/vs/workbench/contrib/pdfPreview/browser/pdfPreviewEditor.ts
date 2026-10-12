/*---------------------------------------------------------------------------------------------
 *  SideX — built-in PDF preview.
 *
 *  Renders pages with pdf.js straight into this pane's DOM: no webview, no
 *  iframe and no extension host, so it works the same in the desktop app and in
 *  the web build. (The reviewer of the PDF plugin path asked for a native
 *  `EditorPane`, mirroring `ImagePreviewEditor`.)
 *--------------------------------------------------------------------------------------------*/

import { $, Dimension, addDisposableListener, EventType, clearNode } from '../../../../base/browser/dom.js';
import { DomScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { ScrollbarVisibility } from '../../../../base/common/scrollable.js';
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
// Vite turns this into the emitted asset URL; `vite/client` types the `?url`
// suffix. pdf.js runs its parser in that worker.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/** Padding around the page column, in CSS pixels. */
const PAGE_GUTTER = 16;
/** Guard against re-rendering on every pixel of a resize. */
const RELAYOUT_THRESHOLD = 24;

export class PdfPreviewEditor extends EditorPane {
	static readonly ID = 'sidex.pdf.preview';

	private _container!: HTMLElement;
	private _scrollable?: DomScrollableElement;
	private _pages!: HTMLElement;
	private _message: HTMLElement | undefined;

	private _renderCts = new MutableDisposable<CancellationTokenSource>();
	private _currentResource: PdfPreviewEditorInput['resource'] | undefined;
	private _lastRenderedWidth = 0;
	private _doc: unknown;

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
			style: 'width:100%;height:100%;overflow:hidden;'
		});
		this._pages = $('.pdf-preview-pages', {
			style: 'display:flex;flex-direction:column;align-items:center;gap:12px;padding:12px 0;'
		});
		this._container.appendChild(this._pages);
		parent.appendChild(this._container);

		this._scrollable = this._register(
			new DomScrollableElement(this._container, {
				horizontal: ScrollbarVisibility.Hidden,
				vertical: ScrollbarVisibility.Auto,
				useShadows: false
			})
		);
		const wrapper = this._scrollable.getDomNode();
		wrapper.style.width = '100%';
		wrapper.style.height = '100%';
		parent.appendChild(wrapper);
		this._scrollable.scanDomNode();

		this._register(this.themeService.onDidColorThemeChange(() => this._applyTheme()));
		this._applyTheme();
	}

	override layout(dimension: Dimension): void {
		if (!this._container || !this._pages) {
			return;
		}
		this._container.style.width = `${dimension.width}px`;
		this._container.style.height = `${dimension.height}px`;
		this._scrollable?.scanDomNode();

		// page width follows the viewport, so a real resize means re-rendering
		const available = dimension.width - PAGE_GUTTER * 2;
		if (Math.abs(available - this._lastRenderedWidth) > RELAYOUT_THRESHOLD) {
			void this._render(this._currentResource);
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
		this._doc = undefined;
		this._currentResource = undefined;
		this._clearPages();
		super.clearInput();
	}

	private _clearPages(): void {
		this._message = undefined;
		if (this._pages) {
			clearNode(this._pages);
		}
	}

	private _appendMessage(text: string): void {
		if (!this._pages) {
			return;
		}
		this._clearPages();
		this._message = $('.pdf-preview-message', {
			style: 'padding:24px;opacity:.8;font-size:13px;'
		});
		this._message.textContent = text;
		this._pages.appendChild(this._message);
	}

	private _applyTheme(): void {
		const theme = this.themeService.getColorTheme();
		if (this._container) {
			this._container.style.backgroundColor = theme.getColor('editor.background')?.toString() ?? 'transparent';
			this._container.style.color = theme.getColor('editor.foreground')?.toString() ?? 'inherit';
		}
	}

	/** Load the file and paint every page, cancelling whatever ran before. */
	private async _render(resource: PdfPreviewEditorInput['resource'] | undefined): Promise<void> {
		if (!resource) {
			return;
		}
		this._renderCts.value?.cancel();
		const cts = new CancellationTokenSource();
		this._renderCts.value = cts;

		const width = this._container
			? Math.max(120, this._container.clientWidth - PAGE_GUTTER * 2)
			: (this._pages?.clientWidth ?? 0);
		this._lastRenderedWidth = width;

		try {
			this._appendMessage('Loading PDF…');
			const file = await this._fileService.readFile(resource);
			if (cts.token.isCancellationRequested) {
				return;
			}

			const pdfjs = await this._loadPdfJs();
			if (!canvasSupported()) {
				this._appendMessage('This build cannot render PDFs (no canvas support).');
				return;
			}
			const data = new Uint8Array(file.value.buffer.slice(0));
			const doc = await pdfjs.getDocument({ data }).promise;
			if (cts.token.isCancellationRequested) {
				void doc.destroy?.();
				return;
			}
			this._doc = doc;
			this._clearPages();

			const dpr = window.devicePixelRatio || 1;
			for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
				if (cts.token.isCancellationRequested) {
					return;
				}
				const page = await doc.getPage(pageNumber);
				const base = page.getViewport({ scale: 1 });
				const scale = width > 0 ? width / base.width : 1;
				const viewport = page.getViewport({ scale: scale * dpr });

				const canvas = document.createElement('canvas');
				canvas.width = Math.floor(viewport.width);
				canvas.height = Math.floor(viewport.height);
				canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
				canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
				canvas.style.display = 'block';
				canvas.style.backgroundColor = '#fff';
				canvas.style.boxShadow = '0 1px 4px rgba(0,0,0,.35)';

				const context = canvas.getContext('2d');
				if (!context) {
					this._appendMessage('This build cannot render PDFs (no 2d context).');
					return;
				}
				await page.render({ canvasContext: context, viewport }).promise;
				if (cts.token.isCancellationRequested) {
					return;
				}
				this._pages.appendChild(canvas);
				this._scrollable?.scanDomNode();
			}
		} catch (err) {
			if (cts.token.isCancellationRequested) {
				return;
			}
			this._logService.error('[PDF Preview] Could not render', resource.toString(), err);
			this._appendMessage(`Could not open this PDF: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private _pdfJs?: PdfJsModule;

	private async _loadPdfJs(): Promise<PdfJsModule> {
		// Loaded on first use: pdf.js is a large chunk and most files are not
		// PDFs.
		if (!this._pdfJs) {
			const pdfjs = (await import('pdfjs-dist')) as unknown as PdfJsModule;
			pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
			this._pdfJs = pdfjs;
		}
		return this._pdfJs;
	}
}

interface PdfJsModule {
	GlobalWorkerOptions: { workerSrc: string };
	getDocument(options: { data: Uint8Array }): { promise: Promise<PdfDocumentLike> };
}

interface PdfDocumentLike {
	numPages: number;
	getPage(pageNumber: number): Promise<PdfPageLike>;
	destroy?(): Promise<void>;
}

interface PdfPageLike {
	getViewport(options: { scale: number }): { width: number; height: number };
	render(options: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> };
}

function canvasSupported(): boolean {
	try {
		return typeof document.createElement('canvas').getContext === 'function';
	} catch {
		return false;
	}
}
