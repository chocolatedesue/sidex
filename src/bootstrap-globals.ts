/*---------------------------------------------------------------------------------------------
 *  SideX — Tauri-based VSCode port
 *  Bootstrap: sets globals that VSCode needs BEFORE any VSCode code loads
 *--------------------------------------------------------------------------------------------*/

(globalThis as any)._VSCODE_FILE_ROOT = new URL('.', import.meta.url).href;

(globalThis as any)._VSCODE_NLS_MESSAGES = [];
(globalThis as any)._VSCODE_NLS_LANGUAGE = 'en';

(globalThis as any)._VSCODE_PRODUCT_JSON = {
	nameShort: 'SideX',
	nameLong: 'SideX',
	applicationName: 'sidex',
	dataFolderName: '.sidex',
	urlProtocol: 'sidex',
	version: '1.141.0',
	commit: '',
	date: new Date().toISOString(),
	quality: 'stable',
	// Open VSX Remote SSH (jeanp413.open-remote-ssh) needs proposed resolver APIs.
	// Built-in SideX Remote-SSH (sidex-remote) works without this; keep both paths.
	extensionEnabledApiProposals: {
		'jeanp413.open-remote-ssh': ['resolvers', 'tunnels', 'contribRemoteHelp', 'contribViewsRemote'],
		'ms-vscode-remote.remote-ssh': ['resolvers', 'tunnels', 'contribRemoteHelp', 'contribViewsRemote'],
		'ms-vscode-remote.remote-ssh-edit': ['resolvers', 'contribViewsRemote']
	}
};

(globalThis as any)._VSCODE_PACKAGE_JSON = {
	version: '1.96.0'
};
