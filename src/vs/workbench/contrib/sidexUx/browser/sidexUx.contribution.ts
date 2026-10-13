/*---------------------------------------------------------------------------------------------
 *  SideX UX polish contribution — VS Code 1.141 density + frosted glass settings.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import {
	IConfigurationRegistry,
	Extensions as ConfigurationExtensions
} from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { workbenchConfigurationNodeBase } from '../../../common/configuration.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { SidexUxPolishController } from './sidexUx.js';

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
		}
	}
});
