/*---------------------------------------------------------------------------------------------
 *  SideX UX polish — VS Code 1.141 density + frosted-glass class wiring.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Event } from '../../../../base/common/event.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { mainWindow } from '../../../../base/browser/window.js';

const DENSITY_LAYOUT = 'window.density.layout';
const FROSTED_GLASS = 'workbench.modernUIFrostedGlass';
const FROSTED_OPACITY = 'workbench.modernUIFrostedGlassOpacity';

/**
 * Applies VS Code 1.141-aligned layout density and frosted-glass classes on the
 * workbench root. CSS in `src/styles.css` consumes these classes.
 */
export class SidexUxPolishController extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.sidexUxPolish';

	constructor(@IConfigurationService private readonly configurationService: IConfigurationService) {
		super();

		const onChange = Event.filter(configurationService.onDidChangeConfiguration, e =>
			e.affectsConfiguration(DENSITY_LAYOUT) ||
			e.affectsConfiguration(FROSTED_GLASS) ||
			e.affectsConfiguration(FROSTED_OPACITY)
		);
		this._register(onChange(() => this.apply()));
		this.apply();
	}

	private workbenchRoot(): HTMLElement | undefined {
		return mainWindow.document.querySelector('.monaco-workbench') as HTMLElement | undefined;
	}

	private apply(): void {
		const root = this.workbenchRoot();
		if (!root) {
			// Workbench may not be in the DOM yet; retry once after paint.
			mainWindow.requestAnimationFrame(() => {
				const retry = this.workbenchRoot();
				if (retry) {
					this.applyTo(retry);
				}
			});
			return;
		}
		this.applyTo(root);
	}

	private applyTo(root: HTMLElement): void {
		const density = this.configurationService.getValue<string>(DENSITY_LAYOUT) ?? 'default';
		root.classList.toggle('density-compact', density === 'compact');
		root.classList.toggle('density-default', density !== 'compact');

		const frosted = this.configurationService.getValue<boolean>(FROSTED_GLASS);
		const enabled = frosted !== false;
		root.classList.toggle('frosted-glass', enabled);
		root.classList.toggle('no-frosted-glass', !enabled);

		const opacity = this.configurationService.getValue<number>(FROSTED_OPACITY);
		const clamped = typeof opacity === 'number' && Number.isFinite(opacity)
			? Math.min(1, Math.max(0.4, opacity))
			: 0.72;
		root.style.setProperty('--sidex-frosted-opacity', String(clamped));
	}
}
