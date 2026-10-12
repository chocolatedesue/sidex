/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *
 *  SideX — Markdown Diff Editor (WYSIWYG).
 *  Completes the missing Diff path for VS Code's Markdown Editor: side-by-side
 *  WYSIWYG panes (original | modified) via SideBySideEditorInput + standalone
 *  markdown-editor-out hosts. Wired for Reopen With / SCM diffs / commands.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IResourceDiffEditorInput } from '../../../common/editor.js';
import { SideBySideEditorInput } from '../../../common/editor/sideBySideEditorInput.js';
import { MarkdownEditorManager } from './markdownEditor.js';

/** View type used when listing Markdown Diff Editor in Reopen With / associations. */
export const MARKDOWN_DIFF_EDITOR_VIEW_TYPE = 'vscode.markdown.editor';

/**
 * Opens original + modified Markdown files as side-by-side WYSIWYG editors.
 */
export class MarkdownDiffEditorManager extends Disposable {
	static readonly ID = 'workbench.contrib.markdownDiffEditor';

	constructor(
		private readonly _markdownEditorManager: MarkdownEditorManager,
		@IEditorService private readonly _editorService: IEditorService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@ILogService private readonly _logService: ILogService,
		@INotificationService private readonly _notificationService: INotificationService
	) {
		super();
	}

	async createDiffEditorInput(diff: IResourceDiffEditorInput): Promise<EditorInput | undefined> {
		const originalUri = this._resourceOf(diff.original);
		const modifiedUri = this._resourceOf(diff.modified);
		if (!originalUri || !modifiedUri) {
			this._notificationService.warn(
				localize('markdownDiffNeedBoth', 'Markdown Diff Editor needs both original and modified Markdown files.')
			);
			return undefined;
		}

		await Promise.all([this._ensureResolved(originalUri), this._ensureResolved(modifiedUri)]);

		const originalInput = await this._markdownEditorManager.createStandaloneEditorInput(originalUri, {
			readonly: true,
			titlePrefix: localize('markdownDiffOriginalPrefix', 'Original (Markdown)'),
			open: false,
		});
		const modifiedInput = await this._markdownEditorManager.createStandaloneEditorInput(modifiedUri, {
			readonly: false,
			titlePrefix: localize('markdownDiffModifiedPrefix', 'Modified (Markdown)'),
			open: false,
		});

		if (!originalInput || !modifiedInput) {
			this._logService.warn('[Markdown Diff Editor] Failed to create WYSIWYG panes');
			return undefined;
		}

		const origName = originalUri.path.split('/').pop() || 'original';
		const modName = modifiedUri.path.split('/').pop() || 'modified';
		const label = localize('markdownDiffLabel', '{0} ↔ {1}', origName, modName);
		const description = localize('markdownDiffDescription', 'Markdown Diff Editor (WYSIWYG)');

		// SideBySideEditorInput: secondary = left (original), primary = right (modified)
		return this._instantiationService.createInstance(
			SideBySideEditorInput,
			label,
			description,
			originalInput,
			modifiedInput
		);
	}

	async openFromActiveDiff(): Promise<void> {
		const active = this._editorService.activeEditor;
		const untyped = active?.toUntyped?.();
		if (untyped && typeof untyped === 'object' && 'original' in untyped && 'modified' in untyped) {
			const input = await this.createDiffEditorInput(untyped as IResourceDiffEditorInput);
			if (input) {
				await this._editorService.openEditor(input, { pinned: true });
			}
			return;
		}

		// Fallback: if a single markdown file is active, open it vs itself (locked) so the UI is reachable.
		const resource = active instanceof EditorInput ? active.resource : undefined;
		if (resource && isMarkdownPath(resource)) {
			const input = await this.createDiffEditorInput({
				original: { resource },
				modified: { resource },
			});
			if (input) {
				await this._editorService.openEditor(input, { pinned: true });
				this._notificationService.info(
					localize(
						'markdownDiffSelfHint',
						'Opened Markdown Diff Editor. From Source Control, pick a changed .md file to compare revisions.'
					)
				);
			}
			return;
		}

		this._notificationService.warn(
			localize(
				'markdownDiffNoActive',
				'Open a Markdown diff (e.g. from Source Control) or a .md file, then run Markdown: Open Markdown Diff Editor.'
			)
		);
	}

	private _resourceOf(side: IResourceDiffEditorInput['original']): URI | undefined {
		if (!side) {
			return undefined;
		}
		if (side instanceof EditorInput) {
			return side.resource ?? undefined;
		}
		if ('resource' in side && side.resource) {
			return side.resource;
		}
		return undefined;
	}

	private async _ensureResolved(resource: URI): Promise<void> {
		if (!this._textFileService.files.get(resource)) {
			try {
				await this._textFileService.files.resolve(resource);
			} catch (err) {
				this._logService.warn('[Markdown Diff Editor] Could not load', resource.toString(), err);
			}
		}
	}
}

function isMarkdownPath(resource: URI): boolean {
	const lower = resource.path.toLowerCase();
	return (
		lower.endsWith('.md') ||
		lower.endsWith('.markdown') ||
		lower.endsWith('.mdx') ||
		lower.endsWith('.mdtxt') ||
		lower.endsWith('.mdtext')
	);
}

