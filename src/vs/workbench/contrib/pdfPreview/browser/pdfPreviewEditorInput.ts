/*---------------------------------------------------------------------------------------------
 *  SideX — editor input for the built-in PDF preview.
 *
 *  A plain `EditorInput` (like `ImagePreviewEditorInput`): the pane renders the
 *  document itself, so there is no webview, no extension host and no custom
 *  editor contribution point involved. SideX ships the `customEditors`
 *  subsystem as a stub, which is why a marketplace PDF viewer can never
 *  register itself here.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { EditorModel } from '../../../common/editor/editorModel.js';
import { basename } from '../../../../base/common/resources.js';

export class PdfPreviewEditorInput extends EditorInput {
	static readonly TYPE_ID = 'workbench.editors.pdfPreviewInput';

	override get typeId(): string {
		return PdfPreviewEditorInput.TYPE_ID;
	}

	override get editorId(): string {
		return 'sidex.pdf.preview';
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	constructor(readonly resource: URI) {
		super();
	}

	override getName(): string {
		return basename(this.resource);
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return other instanceof PdfPreviewEditorInput && other.resource.toString() === this.resource.toString();
	}

	override async resolve(): Promise<EditorModel> {
		return new EditorModel();
	}
}
