/*---------------------------------------------------------------------------------------------
 *  SideX — Remote (ssh-remote+) terminal backend.
 *  Bridges VS Code remote terminals to Rust `remote_terminal_*` PTY commands (VS Code–aligned).
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { OperatingSystem } from '../../../../base/common/platform.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Codicon } from '../../../../base/common/codicons.js';
import {
	IProcessDataEvent,
	IProcessProperty,
	IProcessReadyEvent,
	IShellLaunchConfig,
	ITerminalBackend,
	ITerminalChildProcess,
	ITerminalLaunchError,
	ITerminalProfile,
	ITerminalBackendRegistry,
	TerminalExtensions,
	IPtyHostLatencyMeasurement,
	ITerminalsLayoutInfo,
	ITerminalsLayoutInfoById,
	ITerminalProcessOptions,
	TitleEventSource,
	TerminalIcon,
	ProcessPropertyType,
	IProcessPropertyMap,
	ITerminalLaunchResult
} from '../../../../platform/terminal/common/terminal.js';
import type { IProcessDetails } from '../../../../platform/terminal/common/terminalProcess.js';
import type { IProcessEnvironment } from '../../../../base/common/platform.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ITerminalInstanceService, ITerminalService } from './terminal.js';
import { ISideXRemoteService } from '../../../../platform/sidex/browser/sidexRemoteService.js';
import { ILogService } from '../../../../platform/log/common/log.js';

let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | undefined;
let _listen: ((event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>) | undefined;

async function ensureTauri(): Promise<boolean> {
	if (_invoke && _listen) {
		return true;
	}
	try {
		const core = await import('@tauri-apps/api/core');
		const events = await import('@tauri-apps/api/event');
		_invoke = core.invoke;
		_listen = events.listen as typeof _listen;
		return true;
	} catch (e) {
		console.error('[SideX Remote Terminal] Failed to load Tauri APIs:', e);
		return false;
	}
}

let nextPtyId = 1;

class TauriRemotePty extends Disposable implements ITerminalChildProcess {
	readonly id: number;
	readonly shouldPersist = false;

	private readonly _onProcessData = this._register(new Emitter<IProcessDataEvent | string>());
	readonly onProcessData = this._onProcessData.event;

	private readonly _onProcessReady = this._register(new Emitter<IProcessReadyEvent>());
	readonly onProcessReady = this._onProcessReady.event;

	private readonly _onDidChangeProperty = this._register(new Emitter<IProcessProperty<any>>());
	readonly onDidChangeProperty = this._onDidChangeProperty.event;

	private readonly _onProcessExit = this._register(new Emitter<number | undefined>());
	readonly onProcessExit = this._onProcessExit.event;

	private _backendId: number | undefined;
	private _unlisten: (() => void) | undefined;
	private _unlistenExit: (() => void) | undefined;
	private _trackedCwd: string;
	private _oscPartial = '';

	constructor(
		private readonly _connectionId: number,
		private readonly _shellLaunchConfig: IShellLaunchConfig,
		private readonly _cwd: string,
		private _cols: number,
		private _rows: number
	) {
		super();
		this.id = nextPtyId++;
		this._trackedCwd = _cwd;
	}

	private _consumeOsc7(chunk: string): void {
		const text = this._oscPartial + chunk;
		this._oscPartial = '';
		const re = /\x1b\]7;file:\/\/[^\x07\x1b]*(?:\x07|\x1b\\)/g;
		let lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = re.exec(text)) !== null) {
			lastIndex = re.lastIndex;
			const raw = match[0];
			const fileUri = raw
				.replace(/^\x1b\]7;/, '')
				.replace(/\x07$/, '')
				.replace(/\x1b\\$/, '');
			try {
				const u = new URL(fileUri);
				const path = decodeURIComponent(u.pathname || '');
				if (path && path !== this._trackedCwd) {
					this._trackedCwd = path;
					this._onDidChangeProperty.fire({ type: ProcessPropertyType.Cwd, value: path });
				}
			} catch {
				/* ignore */
			}
		}
		const tail = text.slice(Math.max(lastIndex, text.length - 512));
		if (/\x1b\]7;?[^\x07\x1b]*$/.test(tail)) {
			this._oscPartial = tail.match(/\x1b\]7;?[^\x07\x1b]*$/)?.[0] ?? '';
		}
	}

	async start(): Promise<ITerminalLaunchError | ITerminalLaunchResult | undefined> {
		const ok = await ensureTauri();
		if (!ok || !_invoke || !_listen) {
			return { message: 'Tauri APIs not available' };
		}

		try {
			const dataBuffer: string[] = [];
			let attached = false;

			this._unlisten = await _listen('remote-terminal-data', event => {
				const payload = event.payload as { terminal_id: number; data: string };
				if (this._backendId !== undefined && payload.terminal_id === this._backendId) {
					this._consumeOsc7(payload.data);
					if (attached) {
						this._onProcessData.fire(payload.data);
					} else {
						dataBuffer.push(payload.data);
					}
				}
			});

			this._unlistenExit = await _listen('remote-terminal-exit', event => {
				const payload = event.payload as { terminal_id: number; exit_code: number };
				if (this._backendId !== undefined && payload.terminal_id === this._backendId) {
					this._onProcessExit.fire(payload.exit_code);
				}
			});

			const backendId = (await _invoke('remote_terminal_spawn', {
				connectionId: this._connectionId,
				cols: this._cols,
				rows: this._rows
			})) as number;
			this._backendId = backendId;

			// Best-effort: cd into workspace cwd after login shell starts.
			if (this._cwd && this._cwd !== '/') {
				const escaped = this._cwd.replace(/'/g, `'\\''`);
				void _invoke('remote_terminal_write', {
					terminalId: backendId,
					data: `cd '${escaped}'\n`
				});
			}

			attached = true;
			for (const data of dataBuffer) {
				this._onProcessData.fire(data);
			}

			this._onProcessReady.fire({ pid: backendId, cwd: this._cwd, windowsPty: undefined });
			this._onDidChangeProperty.fire({ type: ProcessPropertyType.InitialCwd, value: this._cwd });
			this._onDidChangeProperty.fire({
				type: ProcessPropertyType.Title,
				value: 'bash'
			} as IProcessProperty<ProcessPropertyType.Title>);

			return undefined;
		} catch (e: any) {
			console.error('[SideX Remote Terminal] Failed to spawn:', e);
			return { message: e?.message || 'Failed to spawn remote terminal' };
		}
	}

	shutdown(_immediate: boolean): void {
		try {
			if (this._backendId !== undefined && _invoke) {
				_invoke('remote_terminal_kill', { terminalId: this._backendId }).catch(() => {});
			}
			this._unlisten?.();
			this._unlistenExit?.();
		} catch {
			/* ignore */
		}
		this._unlisten = undefined;
		this._unlistenExit = undefined;
	}

	input(data: string): void {
		if (this._backendId !== undefined && _invoke) {
			_invoke('remote_terminal_write', { terminalId: this._backendId, data }).catch(() => {});
		}
	}

	resize(cols: number, rows: number): void {
		this._cols = cols;
		this._rows = rows;
		if (this._backendId !== undefined && _invoke) {
			_invoke('remote_terminal_resize', { terminalId: this._backendId, cols, rows }).catch(() => {});
		}
	}

	acknowledgeDataEvent(_charCount: number): void {}
	async processBinary(_data: string): Promise<void> {}
	async getInitialCwd(): Promise<string> {
		return this._cwd;
	}
	async getCwd(): Promise<string> {
		return this._trackedCwd || this._cwd;
	}
	sendSignal(signal: string): void {
		if (this._backendId === undefined || !_invoke) {
			return;
		}
		const upper = (signal || '').toUpperCase();
		if (upper === 'SIGINT' || upper === '2') {
			_invoke('remote_terminal_write', { terminalId: this._backendId, data: '\u0003' }).catch(() => {});
			return;
		}
		if (upper === 'SIGQUIT' || upper === '3') {
			_invoke('remote_terminal_write', { terminalId: this._backendId, data: '\u001c' }).catch(() => {});
			return;
		}
		if (upper === 'SIGTSTP' || upper === '20') {
			_invoke('remote_terminal_write', { terminalId: this._backendId, data: '\u001a' }).catch(() => {});
			return;
		}
		_invoke('remote_terminal_kill', { terminalId: this._backendId }).catch(() => {});
	}
	clearBuffer(): void {
		if (this._backendId !== undefined && _invoke) {
			_invoke('remote_terminal_write', { terminalId: this._backendId, data: '\u000c' }).catch(() => {});
		}
	}
	async setUnicodeVersion(_version: '6' | '11'): Promise<void> {}

	async refreshProperty<T extends ProcessPropertyType>(property: T): Promise<IProcessPropertyMap[T]> {
		if (property === ProcessPropertyType.InitialCwd) {
			return this._cwd as IProcessPropertyMap[T];
		}
		if (property === ProcessPropertyType.Cwd) {
			return (this._trackedCwd || this._cwd) as IProcessPropertyMap[T];
		}
		if (property === ProcessPropertyType.Title) {
			return 'bash' as IProcessPropertyMap[T];
		}
		return '' as IProcessPropertyMap[T];
	}

	async updateProperty<T extends ProcessPropertyType>(_property: T, _value: IProcessPropertyMap[T]): Promise<void> {}

	override dispose(): void {
		this.shutdown(true);
		super.dispose();
	}
}

class TauriRemoteTerminalBackend extends Disposable implements ITerminalBackend {
	readonly isResponsive = true;

	private readonly _whenReadyPromise: Promise<void>;
	private _resolveReady!: () => void;

	get whenReady(): Promise<void> {
		return this._whenReadyPromise;
	}

	private readonly _onPtyHostUnresponsive = this._register(new Emitter<void>());
	readonly onPtyHostUnresponsive = this._onPtyHostUnresponsive.event;
	private readonly _onPtyHostResponsive = this._register(new Emitter<void>());
	readonly onPtyHostResponsive = this._onPtyHostResponsive.event;
	private readonly _onPtyHostRestart = this._register(new Emitter<void>());
	readonly onPtyHostRestart = this._onPtyHostRestart.event;
	private readonly _onDidRequestDetach = this._register(
		new Emitter<{ requestId: number; workspaceId: string; instanceId: number }>()
	);
	readonly onDidRequestDetach = this._onDidRequestDetach.event;

	constructor(
		readonly remoteAuthority: string,
		private readonly _remote: ISideXRemoteService
	) {
		super();
		this._whenReadyPromise = new Promise<void>(resolve => {
			this._resolveReady = resolve;
		});
		void ensureTauri().then(() => this._resolveReady());
	}

	setReady(): void {
		this._resolveReady();
	}

	private _connectionId(): number {
		const id = this._remote.getConnectionIdForAuthority(this.remoteAuthority);
		if (id === undefined) {
			throw new Error(`No remote connection bound for authority '${this.remoteAuthority}'`);
		}
		return id;
	}

	async createProcess(
		shellLaunchConfig: IShellLaunchConfig,
		cwd: string,
		cols: number,
		rows: number,
		_unicodeVersion: '6' | '11',
		_env: IProcessEnvironment,
		_options: ITerminalProcessOptions,
		_shouldPersist: boolean
	): Promise<ITerminalChildProcess> {
		let resolvedCwd = cwd;
		if (!resolvedCwd && typeof shellLaunchConfig.cwd === 'string') {
			resolvedCwd = shellLaunchConfig.cwd;
		} else if (!resolvedCwd && shellLaunchConfig.cwd && typeof shellLaunchConfig.cwd === 'object') {
			resolvedCwd = (shellLaunchConfig.cwd as { path?: string }).path || '';
		}
		if (!resolvedCwd) {
			try {
				resolvedCwd = await this._remote.home(this._connectionId());
			} catch {
				resolvedCwd = '/';
			}
		}
		return new TauriRemotePty(this._connectionId(), shellLaunchConfig, resolvedCwd, cols, rows);
	}

	async attachToProcess(_id: number): Promise<ITerminalChildProcess | undefined> {
		return undefined;
	}
	async attachToRevivedProcess(_id: number): Promise<ITerminalChildProcess | undefined> {
		return undefined;
	}
	async listProcesses(): Promise<IProcessDetails[]> {
		return [];
	}
	async getLatency(): Promise<IPtyHostLatencyMeasurement[]> {
		return [];
	}

	async getDefaultSystemShell(_osOverride?: OperatingSystem): Promise<string> {
		return '/bin/bash';
	}

	async getProfiles(
		_profiles: unknown,
		_defaultProfile: unknown,
		_includeDetectedProfiles?: boolean
	): Promise<ITerminalProfile[]> {
		return [
			{
				profileName: 'bash',
				path: '/bin/bash',
				isDefault: true,
				isAutoDetected: false,
				icon: Codicon.terminalBash
			},
			{
				profileName: 'zsh',
				path: '/bin/zsh',
				isDefault: false,
				isAutoDetected: false,
				icon: Codicon.terminal
			}
		];
	}

	async getWslPath(original: string, _direction: 'unix-to-win' | 'win-to-unix'): Promise<string> {
		return original;
	}

	async getEnvironment(): Promise<IProcessEnvironment> {
		try {
			const result = await this._remote.execSsh(this._connectionId(), 'env');
			const env: IProcessEnvironment = {};
			for (const line of (result.stdout || '').split('\n')) {
				const i = line.indexOf('=');
				if (i > 0) {
					env[line.slice(0, i)] = line.slice(i + 1);
				}
			}
			return env;
		} catch {
			return {};
		}
	}
	async getShellEnvironment(): Promise<IProcessEnvironment | undefined> {
		return this.getEnvironment();
	}
	async setTerminalLayoutInfo(_layoutInfo?: ITerminalsLayoutInfoById): Promise<void> {}
	async updateTitle(_id: number, _title: string, _titleSource: TitleEventSource): Promise<void> {}
	async updateIcon(_id: number, _userInitiated: boolean, _icon: TerminalIcon, _color?: string): Promise<void> {}
	async setNextCommandId(_id: number, _commandLine: string, _commandId: string): Promise<void> {}
	async getTerminalLayoutInfo(): Promise<ITerminalsLayoutInfo | undefined> {
		return undefined;
	}
	async getPerformanceMarks(): Promise<any[]> {
		return [];
	}
	async reduceConnectionGraceTime(): Promise<void> {}
	async requestDetachInstance(_workspaceId: string, _instanceId: number): Promise<IProcessDetails | undefined> {
		return undefined;
	}
	async acceptDetachInstanceReply(_requestId: number, _persistentProcessId?: number): Promise<void> {}
	async persistTerminalState(): Promise<void> {}
	restartPtyHost(): void {}

	async installAutoReply(_match: string, _reply: string): Promise<void> {}
	async uninstallAllAutoReplies(): Promise<void> {}
	async getAutoReplies(): Promise<Map<string, string>> {
		return new Map();
	}
}

export class TauriRemoteTerminalBackendContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.tauriRemoteTerminalBackend';

	private readonly _registered = new Set<string>();

	constructor(
		@ISideXRemoteService private readonly _remote: ISideXRemoteService,
		@ITerminalInstanceService private readonly _terminalInstanceService: ITerminalInstanceService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@ILogService private readonly _log: ILogService
	) {
		super();
		if (!(globalThis as any).__SIDEX_TAURI__) {
			return;
		}

		this._register(
			this._remote.onDidChangeConnections(() => {
				void this._syncBackends();
			})
		);
		void this._syncBackends();
	}

	private async _syncBackends(): Promise<void> {
		const conns = await this._remote.activeConnections().catch(() => []);
		const registry = Registry.as<ITerminalBackendRegistry>(TerminalExtensions.Backend);

		for (const c of conns) {
			let authority = c.authority || this._remote.getAuthorityForConnection(c.id);
			if (!authority && c.kind === 'ssh' && c.label) {
				// Reconstruct VS Code-style authority from connection label (user@host:port).
				const label = c.label.replace(/ \(.+\)$/, '');
				authority = label.startsWith('ssh-remote+') ? label : `ssh-remote+${label}`;
			}
			if (!authority) {
				continue;
			}
			const key = authority.toLowerCase();
			if (this._registered.has(key)) {
				continue;
			}
			// Ensure authority→id binding exists (reload / reconnect paths).
			if (this._remote.getConnectionIdForAuthority(authority) === undefined) {
				this._remote.bindAuthority(authority, c.id);
			}
			try {
				const backend = new TauriRemoteTerminalBackend(authority, this._remote);
				registry.registerTerminalBackend(backend);
				this._terminalInstanceService.didRegisterBackend(backend);
				this._terminalService.registerProcessSupport(true);
				this._registered.add(key);
				this._log.info(`[SideX Remote Terminal] registered backend for ${authority}`);
			} catch (e) {
				this._log.warn(`[SideX Remote Terminal] skip register ${authority}: ${String(e)}`);
			}
		}
	}
}

registerWorkbenchContribution2(
	TauriRemoteTerminalBackendContribution.ID,
	TauriRemoteTerminalBackendContribution,
	WorkbenchPhase.BlockStartup
);
