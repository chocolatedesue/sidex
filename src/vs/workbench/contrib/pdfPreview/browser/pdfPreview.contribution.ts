/*---------------------------------------------------------------------------------------------
 *  SideX — registers the built-in PDF preview.
 *
 *  Registered with `RegisteredEditorPriority.default`, so a `.pdf` opens in it
 *  by default and "Reopen Editor With…" offers it next to the text editor.
 *  Nothing here depends on the extension host or on the `customEditors`
 *  contribution point, both of which SideX does not run: a marketplace PDF
 *  viewer cannot register itself, which is why the preview is built in.
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
					label: localize('pdfPreview.editor', 'Modern PDF Preview'),
					// Default: PDFs are not text, so the preview should win over
					// the text editor unless a user says otherwise.
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
