/*---------------------------------------------------------------------------------------------
 *  Sidex Complete — Registers the FIM inline-completion provider.
 *--------------------------------------------------------------------------------------------*/

import {
	IWorkbenchContribution,
	registerWorkbenchContribution2,
	WorkbenchPhase
} from '../../../common/contributions.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { SidexCompleteProvider } from './sidexCompleteProvider.js';
import { ensureServerStarted, serverHttpUrl, SIDEX_CHAT_ENABLED_SETTING } from '../../sidexChat/browser/localServer.js';

class SidexCompleteContribution implements IWorkbenchContribution {
	static readonly ID = 'sidex.complete';

	private _registration: IDisposable | undefined;
	private _started = false;

	constructor(
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@IConfigurationService private readonly configurationService: IConfigurationService
	) {
		// Inline completions come from the same local agent server, so they are
		// part of the same opt-in AI stack: with the panel off there is no
		// server to talk to, and registering a provider that can only fail
		// would just add a request per keystroke. Enable the panel (or the
		// setting) and the provider appears without a reload.
		this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(SIDEX_CHAT_ENABLED_SETTING)) {
				this._apply();
			}
		});
		this._apply();
	}

	private _apply(): void {
		const enabled = this.configurationService.getValue<boolean>(SIDEX_CHAT_ENABLED_SETTING) === true;
		if (!enabled) {
			this._registration?.dispose();
			this._registration = undefined;
			this._started = false;
			return;
		}
		if (this._started) {
			return;
		}
		this._started = true;

		// Defaults to the agent server the app runs locally; an explicit
		// setting points completions somewhere else. Registration waits for
		// the port to be known, but the URL is re-read per request so a server
		// restart doesn't strand the provider on a dead port.
		const resolveUrl = () => serverHttpUrl(this.configurationService.getValue<string>('sidex.complete.serverUrl'));
		void ensureServerStarted().then(() => {
			const provider = new SidexCompleteProvider(resolveUrl);
			this._registration = this.languageFeaturesService.inlineCompletionsProvider.register('*', provider);
		});
	}
}

registerWorkbenchContribution2(SidexCompleteContribution.ID, SidexCompleteContribution, WorkbenchPhase.AfterRestored);
