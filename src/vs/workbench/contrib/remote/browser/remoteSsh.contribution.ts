/*---------------------------------------------------------------------------------------------
 *  SideX — Built-in Remote SSH workbench bridge.
 *  Registers vscode-remote FS + resolves ssh-remote authorities after connect.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import {
	IWorkbenchContribution,
	IWorkbenchContributionsRegistry,
	Extensions as WorkbenchExtensions
} from '../../../common/contributions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ISideXRemoteService } from '../../../../platform/sidex/browser/sidexRemoteService.js';
import { SideXRemoteFileSystemProvider } from '../../../../platform/sidex/browser/sidexRemoteFileSystemProvider.js';
import {
	IRemoteAuthorityResolverService,
	ManagedRemoteConnection
} from '../../../../platform/remote/common/remoteAuthorityResolver.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceEditingService } from '../../../services/workspaces/common/workspaceEditing.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';

/**
 * Ensures `vscode-remote://` is backed by SideX's Rust SSH transport whenever a
 * connection is bound to an authority (built-in Remote-SSH path).
 * Also publishes a ManagedRemoteConnection so VS Code remote plumbing sees a
 * resolved authority (Open VSX jeanp413.open-remote-ssh can still override via
 * its own resolver when installed).
 */
class SideXRemoteSshWorkbenchContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.sidexRemoteSsh';

	private _providerRegistered = false;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@ISideXRemoteService private readonly _remote: ISideXRemoteService,
		@IRemoteAuthorityResolverService
		private readonly _authorityResolver: IRemoteAuthorityResolverService,
		@ILogService private readonly _log: ILogService
	) {
		super();
		this._ensureProvider();
		this._register(
			this._remote.onDidChangeConnections(() => {
				this._publishBoundAuthorities();
			})
		);
		this._publishBoundAuthorities();
	}

	private _ensureProvider(): void {
		if (this._providerRegistered) {
			return;
		}
		this._register(
			this._fileService.registerProvider(Schemas.vscodeRemote, new SideXRemoteFileSystemProvider(this._remote))
		);
		this._providerRegistered = true;
		this._log.info('[SideX Remote SSH] registered vscode-remote FileSystemProvider');
	}

	private _publishBoundAuthorities(): void {
		// Walk known bindings from activeConnections when available.
		void this._remote.activeConnections().then(conns => {
			for (const c of conns) {
				if (!c.authority) {
					continue;
				}
				this._authorityResolver._setResolvedAuthority({
					authority: c.authority,
					connectTo: new ManagedRemoteConnection(c.id),
					connectionToken: undefined
				});
			}
		});
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	SideXRemoteSshWorkbenchContribution,
	LifecyclePhase.Starting
);

/** After a successful SSH connect: resolve authority + open remote $HOME. */
export async function afterSshConnected(options: {
	remote: ISideXRemoteService;
	authorityResolver: IRemoteAuthorityResolverService;
	workspaceEditing: IWorkspaceEditingService;
	notifications: INotificationService;
	quickInput: IQuickInputService;
	connectionId: number;
	authority: string;
	label: string;
	openFolder?: boolean;
}): Promise<void> {
	const {
		remote,
		authorityResolver,
		workspaceEditing,
		notifications,
		quickInput,
		connectionId,
		authority,
		label,
		openFolder = true
	} = options;

	authorityResolver._setResolvedAuthority({
		authority,
		connectTo: new ManagedRemoteConnection(connectionId),
		connectionToken: undefined
	});

	notifications.notify({
		severity: Severity.Info,
		message: localize('remote.ssh.connected', 'Connected to {0}', label)
	});

	if (!openFolder) {
		return;
	}

	let home = '/';
	try {
		home = await remote.home(connectionId);
	} catch {
		home = '/';
	}

	const open = await quickInput.pick(
		[
			{
				label: localize('remote.ssh.openHome', 'Open Remote Home ({0})', home),
				description: localize('remote.ssh.openHomeDesc', 'Browse files over SSH'),
				id: 'home'
			},
			{
				label: localize('remote.ssh.openOther', 'Open Other Folder…'),
				id: 'other'
			},
			{
				label: localize('remote.ssh.skipOpen', 'Stay Connected (do not open folder)'),
				id: 'skip'
			}
		],
		{ placeHolder: localize('remote.ssh.afterConnect', 'Remote SSH connected — open a folder?') }
	);

	if (!open || open.id === 'skip') {
		return;
	}

	let folderPath = home;
	if (open.id === 'other') {
		const typed = await quickInput.input({
			prompt: localize('remote.ssh.enterFolder', 'Remote folder path'),
			value: home
		});
		if (!typed) {
			return;
		}
		folderPath = typed;
	}

	const folderUri = URI.from({
		scheme: Schemas.vscodeRemote,
		authority,
		path: folderPath.startsWith('/') ? folderPath : `/${folderPath}`
	});

	try {
		await workspaceEditing.createAndEnterWorkspace([{ uri: folderUri }]);
	} catch (err) {
		notifications.error(localize('remote.ssh.openFailed', 'Failed to open remote folder: {0}', String(err)));
	}
}
