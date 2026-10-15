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
			this._host.style.minHeight = dimension.height > 0 ? '' : '240px';
		}
		// EmbedPDF tiles sized at mount-time; notify after EditorPane gets real bounds.
		if (this._viewer && dimension.width > 0 && dimension.height > 0) {
			try {
				globalThis.dispatchEvent?.(new Event('resize'));
			} catch { /* ignore */ }
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
			const init: EmbedPdfInit | undefined =
				typeof api?.init === 'function' ? api.init.bind(api) : typeof mod?.init === 'function' ? mod.init : undefined;
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

			// Fresh ArrayBuffer copy — WebKit/Tauri rejects SharedArrayBuffer views,
			// and EmbedPDF `page-width` zoom paints nothing when the host is 0×0
			// (common before the first EditorPane.layout). Prefer buffer open +
			// fit-page so tiles appear without a blob: fetch round-trip.
			const src = file.value.buffer;
			const copy = new Uint8Array(src.byteLength);
			copy.set(src);
			const ab = copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength);
			if (cts.token.isCancellationRequested) {
				return;
			}

			const init = await this._loadEmbedPdf();
			if (cts.token.isCancellationRequested) {
				return;
			}

			this._teardownViewer();
			this._ensureHostSize();

			const wasmUrl = await resolveWasmUrlAsync(this._logService);
			this._logService.info('[PDF Preview] EmbedPDF wasmUrl=', wasmUrl, 'bytes=', ab.byteLength);
			const name = resource.path.split('/').pop() || 'document.pdf';
			this._viewer = init({
				type: 'container',
				target: this._host,
				// Vite bundles the PDFium worker into assets; forcing worker:true
				// without a resolved worker URL stalls on "Initializing plugins…".
				worker: false,
				wasmUrl,
				theme: { preference: this._themePreference() },
				tabBar: 'never',
				fontFallback: null,
				fonts: { ui: null },
				disabledCategories: ['print', 'export', 'redaction', 'document'],
				annotations: { autoOpenLinks: false },
				// `page-width` yields an empty dark viewport when measured against a
				// zero-sized host (SideX E2E / first paint). `fit-page` paints tiles.
				zoom: { defaultZoomLevel: 'fit-page' },
				spread: { defaultSpreadMode: 'odd' },
				documentManager: {
					initialDocuments: [{ buffer: ab, name, autoActivate: true }]
				},
			});

			if (!this._viewer) {
				this._appendMessage('EmbedPDF failed to mount the viewer.');
				this._notificationService.warn('EmbedPDF PDF viewer failed to initialize.');
			} else {
				// Nudge layout after mount — EditorPane.layout may have run with 0 size.
				queueMicrotask(() => {
					this._ensureHostSize();
					try {
						globalThis.dispatchEvent?.(new Event('resize'));
					} catch { /* ignore */ }
				});
			}
		} catch (err) {
			if (cts.token.isCancellationRequested) {
				return;
			}
			this._logService.error('[PDF Preview] EmbedPDF could not render', resource.toString(), err);
			this._appendMessage(`Could not open this PDF: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Ensure the EmbedPDF host has non-zero CSS size before / after init. */
	private _ensureHostSize(): void {
		if (!this._host || !this._container) {
			return;
		}
		const parent = this._container.parentElement;
		const pw = parent?.clientWidth || this._container.clientWidth || 0;
		const ph = parent?.clientHeight || this._container.clientHeight || 0;
		const w = Math.max(pw, this._host.clientWidth, 320);
		const h = Math.max(ph, this._host.clientHeight, 240);
		if (pw < 32 || ph < 32) {
			this._container.style.width = `${w}px`;
			this._container.style.height = `${h}px`;
			this._host.style.width = '100%';
			this._host.style.height = '100%';
			this._host.style.minHeight = '240px';
		}
	}
}

/**
 * EmbedPDF defaults `wasmUrl` to jsDelivr. Always pass a same-origin URL so the
 * viewer works offline / under CSP. Prefer `/pdfium.wasm` (publicDir + postbuild),
 * then the Vite `?url` hashed asset. Probe once so a missing file does not hang
 * the viewer on a 404 empty body.
 */
let _cachedWasmUrl: string | undefined;

function wasmCandidates(): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const push = (u: string | undefined) => {
		if (!u || seen.has(u)) {
			return;
		}
		seen.add(u);
		out.push(u);
	};
	push('/pdfium.wasm');
	try {
		const base = (typeof document !== 'undefined' && document.baseURI) ? document.baseURI : '/';
		push(new URL('pdfium.wasm', base).href);
	} catch { /* ignore */ }
	if (typeof pdfiumWasmUrl === 'string' && pdfiumWasmUrl.length > 0) {
		push(pdfiumWasmUrl);
	}
	return out;
}

async function resolveWasmUrlAsync(log?: { info: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void }): Promise<string> {
	if (_cachedWasmUrl) {
		return _cachedWasmUrl;
	}
	const candidates = wasmCandidates();
	for (const url of candidates) {
		try {
			const res = await fetch(url, { method: 'GET' });
			if (!res.ok) {
				continue;
			}
			const buf = await res.arrayBuffer();
			if (buf.byteLength < 1000) {
				continue;
			}
			// Re-serve via blob so MIME is always application/wasm under odd servers.
			const blobUrl = URL.createObjectURL(new Blob([buf], { type: 'application/wasm' }));
			_cachedWasmUrl = blobUrl;
			log?.info?.('[PDF Preview] resolved pdfium wasm', url, buf.byteLength);
			return blobUrl;
		} catch (err) {
			log?.warn?.('[PDF Preview] wasm candidate failed', url, err);
		}
	}
	_cachedWasmUrl = candidates[0] || '/pdfium.wasm';
	return _cachedWasmUrl;
}

