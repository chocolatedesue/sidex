/*---------------------------------------------------------------------------------------------
 *  SideX — registers the built-in PDF preview (EmbedPDF / embed-pdf-viewer).
 *
 *  Registered with `RegisteredEditorPriority.default`, so a `.pdf` opens in it
 *  by default. Open With / Reopen With lists "PDF Preview" (EmbedPDF) next to
 *  Text Editor — same picker shape as VS Code, one working default (no duplicate
 *  remapped marketplace PDF stubs).
 *  Engine: @embedpdf/snippet (same stack as chocolatedesue/Modern-PDF-Preview).
 *  Marketplace PDF customEditors are not listed in Open With (they would only
 *  remap to this pane); one working default keeps hope aligned with actual.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import {
	IWorkbenchContribution,
	registerWorkbenchContribution2,
	WorkbenchPhase
} from '../../../common/contributions.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions } from '../../../common/editor.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import {
	IEditorResolverService,
	RegisteredEditorPriority
} from '../../../services/editor/common/editorResolverService.js';
import { PdfPreviewEditor } from './pdfPreviewEditor.js';
import { PdfPreviewEditorInput } from './pdfPreviewEditorInput.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(PdfPreviewEditor, PdfPreviewEditor.ID, localize('pdfPreview', 'PDF Preview')),
	[new SyncDescriptor(PdfPreviewEditorInput)]
);

class PdfPreviewContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.pdfPreview';

	constructor(@IEditorResolverService editorResolverService: IEditorResolverService) {
		super();
		this._register(
			editorResolverService.registerEditor(
				'*.pdf',
				{
					id: PdfPreviewEditor.ID,
					label: localize('pdfPreview.editor', 'PDF Preview'),
					detail: localize('pdfPreview.detail', 'EmbedPDF'),
					priority: RegisteredEditorPriority.default
				},
				{},
				{
					createEditorInput: ({ resource }) => ({ editor: new PdfPreviewEditorInput(resource) })
				}
			)
		);
	}
}

registerWorkbenchContribution2(PdfPreviewContribution.ID, PdfPreviewContribution, WorkbenchPhase.BlockStartup);
