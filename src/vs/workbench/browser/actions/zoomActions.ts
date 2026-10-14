/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../nls.js';
import { Action2, registerAction2 } from '../../../platform/actions/common/actions.js';
import { KeyMod, KeyCode } from '../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { Categories } from '../../../platform/action/common/actionCommonCategories.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../platform/layout/browser/layoutService.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import {
	IConfigurationRegistry,
	Extensions as ConfigurationExtensions
} from '../../../platform/configuration/common/configurationRegistry.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../common/contributions.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ILocalizedString } from '../../../platform/action/common/action.js';

// SideX runs the workbench inside a system webview, so there is no Electron
// native zoom to call. Zoom is applied as a CSS `zoom` on the workbench
// container (the same value VS Code web uses) and persisted in the standard
// `window.zoomLevel` setting, so Ctrl+= / Ctrl+- / Ctrl+0 and the setting UI
// agree on one number.

export const ZOOM_LEVEL_SETTING_KEY = 'window.zoomLevel';
export const MIN_ZOOM_LEVEL = -8;
export const MAX_ZOOM_LEVEL = 8;

function zoomFactorForLevel(level: number): number {
	// 20% per step, which is what a Chromium zoom level feels like.
	return Math.max(0.2, 1 + level * 0.2);
}

function applyZoom(layoutService: ILayoutService, level: number): void {
	layoutService.mainContainer.style.setProperty('zoom', String(zoomFactorForLevel(level)));
}

abstract class BaseZoomAction extends Action2 {
	constructor(
		id: string,
		title: ILocalizedString,
		private readonly delta: number | 'reset',
		keybinding: { primary: number; secondary?: number[] }
	) {
		super({
			id,
			title,
			category: Categories.View,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: keybinding.primary,
				secondary: keybinding.secondary
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		const layoutService = accessor.get(ILayoutService);

		const current = configurationService.getValue<number>(ZOOM_LEVEL_SETTING_KEY) ?? 0;
		const next = this.delta === 'reset' ? 0 : current + this.delta;

		if (next > MAX_ZOOM_LEVEL || next < MIN_ZOOM_LEVEL) {
			return;
		}

		await configurationService.updateValue(ZOOM_LEVEL_SETTING_KEY, next);
		applyZoom(layoutService, next);
	}
}

class ZoomInAction extends BaseZoomAction {
	constructor() {
		super('workbench.action.zoomIn', localize2('zoomIn', 'Zoom In'), 1, {
			primary: KeyMod.CtrlCmd | KeyCode.Equal,
			secondary: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Equal, KeyMod.CtrlCmd | KeyCode.NumpadAdd]
		});
	}
}

class ZoomOutAction extends BaseZoomAction {
	constructor() {
		super('workbench.action.zoomOut', localize2('zoomOut', 'Zoom Out'), -1, {
			primary: KeyMod.CtrlCmd | KeyCode.Minus,
			secondary: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Minus, KeyMod.CtrlCmd | KeyCode.NumpadSubtract]
		});
	}
}

class ZoomResetAction extends BaseZoomAction {
	constructor() {
		super('workbench.action.zoomReset', localize2('zoomReset', 'Reset Zoom'), 'reset', {
			primary: KeyMod.CtrlCmd | KeyCode.Digit0,
			secondary: [KeyMod.CtrlCmd | KeyCode.Numpad0]
		});
	}
}

registerAction2(ZoomInAction);
registerAction2(ZoomOutAction);
registerAction2(ZoomResetAction);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'sidexWindow',
	order: 1,
	type: 'object',
	title: localize('sidexWindowConfigurationTitle', 'Window'),
	properties: {
		[ZOOM_LEVEL_SETTING_KEY]: {
			type: 'number',
			default: 0,
			minimum: MIN_ZOOM_LEVEL,
			maximum: MAX_ZOOM_LEVEL,
			description: localize('zoomLevel', 'Adjust the zoom level. Each increment is 20%.')
		}
	}
});

// Apply the persisted zoom on startup and whenever the setting changes, so the
// number shown in Settings, the menu accelerators and the actual scale agree.
class ZoomLevelApplier extends Disposable implements IWorkbenchContribution {
	constructor(
		@ILayoutService private readonly layoutService: ILayoutService,
		@IConfigurationService private readonly configurationService: IConfigurationService
	) {
		super();
		const apply = () =>
			applyZoom(this.layoutService, this.configurationService.getValue<number>(ZOOM_LEVEL_SETTING_KEY) ?? 0);
		apply();
		this._register(
			this.configurationService.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration(ZOOM_LEVEL_SETTING_KEY)) {
					apply();
				}
			})
		);
	}
}

registerWorkbenchContribution2('sidex.zoomLevel', ZoomLevelApplier, WorkbenchPhase.AfterRestored);
