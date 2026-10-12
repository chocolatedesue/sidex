/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../common/markdownColors.js';
import './media/markdown.css';

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import {
	IWorkbenchContribution,
	WorkbenchPhase,
	registerWorkbenchContribution2
} from '../../../common/contributions.js';
import { MARKDOWN_PREVIEW_VIEW_TYPE, MarkdownPreviewManager } from './markdownPreview.js';
import {
	IEditorResolverService,
	RegisteredEditorPriority
} from '../../../services/editor/common/editorResolverService.js';

let _previewManager: MarkdownPreviewManager | undefined;

function getOrCreateManager(accessor: ServicesAccessor): MarkdownPreviewManager {
	if (!_previewManager) {
		_previewManager = accessor.get(IInstantiationService).createInstance(MarkdownPreviewManager);
	}
	return _previewManager;
}

class MarkdownPreviewAutoReopen extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.markdownPreviewAutoReopen';

	private _didAutoReopen = false;

	constructor(
		@IEditorService editorService: IEditorService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IStorageService private readonly _storageService: IStorageService
	) {
		super();

		const startupTimer = setTimeout(() => {
			this._didAutoReopen = true;
		}, 3000);
		this._register({ dispose: () => clearTimeout(startupTimer) });

		this._register(
			editorService.onDidVisibleEditorsChange(() => {
				if (this._didAutoReopen) {
					return;
				}
				this._onVisibleEditorsChanged(editorService);
			})
		);
	}

	private _onVisibleEditorsChanged(editorService: IEditorService): void {
		const activeEditor = editorService.activeEditor;
		if (!(activeEditor instanceof EditorInput)) {
			return;
		}

		const resource = activeEditor.resource;
		if (!resource || !resource.path.endsWith('.md')) {
			return;
		}

		if (_previewManager && _previewManager.hasActivePreview()) {
			return;
		}

		if (!MarkdownPreviewManager.wasPreviewOpen(this._storageService, resource)) {
			return;
		}

		this._didAutoReopen = true;
		const manager = this._instantiationService.createInstance(MarkdownPreviewManager);
		_previewManager = manager;
		manager.showPreview(true);
	}
}

registerWorkbenchContribution2(MarkdownPreviewAutoReopen.ID, MarkdownPreviewAutoReopen, WorkbenchPhase.BlockStartup);

/**
 * Register the preview as a first-class editor so a user can change what opens
 * a markdown file: "Reopen Editor With…" lists it next to the text editor, and
 * `workbench.editorAssociations` can point `*.md` at it.
 *
 * `RegisteredEditorPriority.option` is deliberate: the resolver only picks a
 * registered editor when the user asked for one (association or picker), so
 * markdown keeps opening in the text editor until someone chooses otherwise.
 */
class MarkdownPreviewEditorContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.markdownPreviewEditor';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService
	) {
		super();
		this._register(
			editorResolverService.registerEditor(
				'*.{md,markdown,mdx}',
				{
					id: MARKDOWN_PREVIEW_VIEW_TYPE,
					label: localize('markdownPreviewEditor', 'Markdown Preview'),
					priority: RegisteredEditorPriority.option
				},
				{},
				{
					createEditorInput: async ({ resource }) => {
						if (!_previewManager) {
							_previewManager = this._instantiationService.createInstance(MarkdownPreviewManager);
						}
						const editor = await _previewManager.createPreviewInputWhenReady(resource);
						if (!editor) {
							throw new Error(`Markdown Preview could not open ${resource.toString()}`);
						}
						return { editor };
					}
				}
			)
		);
	}
}

registerWorkbenchContribution2(
	MarkdownPreviewEditorContribution.ID,
	MarkdownPreviewEditorContribution,
	WorkbenchPhase.BlockStartup
);

CommandsRegistry.registerCommand('markdown.showPreview', accessor => {
	getOrCreateManager(accessor).showPreview();
});

CommandsRegistry.registerCommand('markdown.showPreviewToSide', accessor => {
	getOrCreateManager(accessor).showPreview(true);
});

CommandsRegistry.registerCommand('markdown.showSource', accessor => {
	getOrCreateManager(accessor).showSource();
});

CommandsRegistry.registerCommand('markdown.togglePreview', accessor => {
	getOrCreateManager(accessor).toggle();
});

CommandsRegistry.registerCommand('markdown.preview.refresh', accessor => {
	getOrCreateManager(accessor).refresh();
});

CommandsRegistry.registerCommand('markdown.preview.toggleLock', accessor => {
	const locked = getOrCreateManager(accessor).toggleLock();
	accessor
		.get(INotificationService)
		.info(
			locked
				? localize('markdownPreviewLocked', 'Markdown preview locked — it no longer follows the document.')
				: localize('markdownPreviewUnlocked', 'Markdown preview unlocked — it follows the document again.')
		);
});

CommandsRegistry.registerCommand('markdown.showPreviewSecuritySelector', accessor => {
	const level = getOrCreateManager(accessor).cycleSecurityLevel();
	accessor
		.get(INotificationService)
		.info(
			localize(
				'markdownPreviewSecurity',
				'Markdown preview content security level: {0}. Run the command again to change it.',
				level
			)
		);
});

CommandsRegistry.registerCommand('markdown.findAllFileReferences', accessor => {
	getOrCreateManager(accessor).findAllFileReferences();
});

CommandsRegistry.registerCommand('markdown.reopenAsPreview', accessor => {
	getOrCreateManager(accessor).showPreview();
});

CommandsRegistry.registerCommand('markdown.reopenAsSource', accessor => {
	getOrCreateManager(accessor).showSource();
});

// The markdown preview commands normally come from the `markdown-language-features`
// built-in extension. Since that extension only registers them when its extension
// host runs, the standalone preview registers its own palette entries, editor
// title action and keybindings so the feature is reachable on its own.
//
// The `when` clause accepts the file extension as well as the language id: the
// `markdown` language itself is contributed by a built-in extension, so a plain
// `.md` file has no language id until the extension host is available.
const MARKDOWN_LANG_WHEN = ContextKeyExpr.or(
	ContextKeyExpr.equals('editorLangId', 'markdown'),
	ContextKeyExpr.equals('resourceExtname', '.md'),
	ContextKeyExpr.equals('resourceExtname', '.markdown')
);

const markdownPaletteCommands: { id: string; title: string }[] = [
	{ id: 'markdown.showPreview', title: localize2('mdShowPreview', 'Open Preview').value },
	{ id: 'markdown.showPreviewToSide', title: localize2('mdShowPreviewToSide', 'Open Preview to the Side').value },
	{ id: 'markdown.togglePreview', title: localize2('mdTogglePreview', 'Toggle Preview').value },
	{ id: 'markdown.showSource', title: localize2('mdShowSource', 'Show Source').value },
	{ id: 'markdown.preview.refresh', title: localize2('mdRefreshPreview', 'Refresh Preview').value },
	{ id: 'markdown.preview.toggleLock', title: localize2('mdToggleLock', 'Toggle Preview Lock').value },
	{
		id: 'markdown.showPreviewSecuritySelector',
		title: localize2('mdSecuritySelector', 'Change Preview Security Settings').value
	},
	{
		id: 'markdown.findAllFileReferences',
		title: localize2('mdFindFileReferences', 'Find All File References').value
	},
	{ id: 'markdown.reopenAsPreview', title: localize2('mdReopenAsPreview', 'Reopen Editor With Preview').value },
	{ id: 'markdown.reopenAsSource', title: localize2('mdReopenAsSource', 'Reopen Editor With Source').value }
];

for (const command of markdownPaletteCommands) {
	MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
		command: { id: command.id, title: command.title, category: 'Markdown' },
		when: MARKDOWN_LANG_WHEN
	});
}

MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
	command: {
		id: 'markdown.showPreviewToSide',
		title: localize2('mdOpenPreviewToSide', 'Open Preview to the Side').value,
		icon: Codicon.openPreview
	},
	group: 'navigation',
	order: 10,
	when: MARKDOWN_LANG_WHEN
});

KeybindingsRegistry.registerCommandAndKeybindingRule({
	id: 'markdown.showPreviewToSide',
	weight: KeybindingWeight.WorkbenchContrib,
	when: MARKDOWN_LANG_WHEN,
	primary: KeyMod.CtrlCmd | KeyCode.KeyK,
	secondary: [KeyMod.CtrlCmd | KeyCode.KeyV],
	mac: { primary: KeyMod.WinCtrl | KeyCode.KeyK, secondary: [KeyMod.CtrlCmd | KeyCode.KeyV] },
	handler: accessor => {
		getOrCreateManager(accessor).showPreview(true);
	}
});

KeybindingsRegistry.registerCommandAndKeybindingRule({
	id: 'markdown.togglePreview',
	weight: KeybindingWeight.WorkbenchContrib,
	when: MARKDOWN_LANG_WHEN,
	primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyV,
	mac: { primary: KeyMod.WinCtrl | KeyMod.Shift | KeyCode.KeyV },
	handler: accessor => {
		getOrCreateManager(accessor).toggle();
	}
});
