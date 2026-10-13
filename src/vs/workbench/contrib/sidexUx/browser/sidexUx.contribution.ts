/*---------------------------------------------------------------------------------------------
 *  SideX UX polish contribution — VS Code 1.141 density, frosted glass, tab styles.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import {
	IConfigurationRegistry,
	Extensions as ConfigurationExtensions
} from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { workbenchConfigurationNodeBase } from '../../../common/configuration.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { SidexUxPolishController } from './sidexUx.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';

registerWorkbenchContribution2(
	SidexUxPolishController.ID,
	SidexUxPolishController,
	WorkbenchPhase.AfterRestored
);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...workbenchConfigurationNodeBase,
	properties: {
		'window.density.layout': {
			type: 'string',
			enum: ['default', 'compact'],
			default: 'default',
			enumDescriptions: [
				localize('window.density.layout.default', 'Standard spacing for title bar, panes, and activity bar.'),
				localize(
					'window.density.layout.compact',
					'VS Code 1.141 Compact density: shorter title bar, tighter pane gaps, denser chrome.'
				)
			],
			description: localize(
				'window.density.layout',
				'Controls overall workbench layout density (aligned with VS Code 1.141 window.density.layout).'
			)
		},
		'workbench.modernUIFrostedGlass': {
			type: 'boolean',
			default: true,
			description: localize(
				'workbench.modernUIFrostedGlass',
				'Use softly blurred frosted-glass backgrounds for the Command Palette, menus, and hover widgets (VS Code 1.141). Disable if you notice display or performance issues. Also respects OS reduced-transparency preferences.'
			)
		},
		'workbench.modernUIFrostedGlassOpacity': {
			type: 'number',
			default: 0.72,
			minimum: 0.4,
			maximum: 1,
			description: localize(
				'workbench.modernUIFrostedGlassOpacity',
				'Opacity of frosted-glass overlays. Lower is more transparent; higher is more solid.'
			)
		},
		'workbench.experimental.modernUIEditorTabStyle': {
			type: 'string',
			enum: ['default', 'connected', 'pill'],
			default: 'default',
			enumDescriptions: [
				localize('sidex.tabStyle.default', 'Classic flat editor tabs.'),
				localize(
					'sidex.tabStyle.connected',
					'VS Code 1.141 connected style: active tab visually joins the editor content.'
				),
				localize('sidex.tabStyle.pill', 'VS Code 1.141 pill style: tabs as separate rounded pills.')
			],
			description: localize(
				'workbench.experimental.modernUIEditorTabStyle',
				'Editor tab style aligned with VS Code 1.141 modern UI (connected / pill). SideX applies CSS without requiring the full experimental modern UI surface.'
			)
		}
	}
});

registerAction2(
	class ToggleLayoutDensityAction extends Action2 {
		constructor() {
			super({
				id: 'sidex.ux.toggleLayoutDensity',
				title: {
					...localize2('sidex.toggleLayoutDensity', 'Toggle Layout Density'),
					mnemonicTitle: localize(
						{ key: 'miToggleLayoutDensity', comment: ['&& denotes a mnemonic'] },
						'Layout &&Density'
					)
				},
				category: Categories.View,
				f1: true,
				menu: [
					{
						id: MenuId.MenubarAppearanceMenu,
						group: '1_toggle_view',
						order: 4
					}
				]
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const configurationService = accessor.get(IConfigurationService);
			const current = configurationService.getValue<string>('window.density.layout') ?? 'default';
			await configurationService.updateValue(
				'window.density.layout',
				current === 'compact' ? 'default' : 'compact'
			);
		}
	}
);

registerAction2(
	class SetTabStyleConnectedAction extends Action2 {
		constructor() {
			super({
				id: 'sidex.ux.tabStyleConnected',
				title: localize2('sidex.tabStyleConnected', 'Editor Tab Style: Connected'),
				category: Categories.View,
				f1: true
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			await accessor
				.get(IConfigurationService)
				.updateValue('workbench.experimental.modernUIEditorTabStyle', 'connected');
		}
	}
);

registerAction2(
	class SetTabStylePillAction extends Action2 {
		constructor() {
			super({
				id: 'sidex.ux.tabStylePill',
				title: localize2('sidex.tabStylePill', 'Editor Tab Style: Pill'),
				category: Categories.View,
				f1: true
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			await accessor
				.get(IConfigurationService)
				.updateValue('workbench.experimental.modernUIEditorTabStyle', 'pill');
		}
	}
);

registerAction2(
	class SetTabStyleDefaultAction extends Action2 {
		constructor() {
			super({
				id: 'sidex.ux.tabStyleDefault',
				title: localize2('sidex.tabStyleDefault', 'Editor Tab Style: Default'),
				category: Categories.View,
				f1: true
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			await accessor
				.get(IConfigurationService)
				.updateValue('workbench.experimental.modernUIEditorTabStyle', 'default');
		}
	}
);
