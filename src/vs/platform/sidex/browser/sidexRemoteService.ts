/*---------------------------------------------------------------------------------------------
 *  SideX — Remote development service.
 *  Thin TypeScript wrapper over the Tauri commands backed by the
 *  `sidex-remote` crate (SSH, WSL, Dev Containers, Codespaces).
 *
 *  Registration note: VS Code's IRemoteAgentService is already served by the
 *  `NullRemoteAgentService` (workbench/services/remote/browser/
 *  nullRemoteAgentService.ts) which delegates remote listing to this bridge.
 *  We additionally expose this bridge under its own decorator so UI code can
 *  access SSH / WSL / container / codespace management directly.
 *--------------------------------------------------------------------------------------------*/

import { invoke, isTauri } from '../../../sidex-bridge.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';
import { Emitter, Event } from '../../../base/common/event.js';

export type RemoteKind = 'ssh' | 'wsl' | 'container' | 'codespace' | 'tunnel';

export interface SshHost {
	host: string;
	hostname: string | null;
	port: number | null;
	user: string | null;
	identityFile: string | null;
	proxyJump?: string | null;
	proxyCommand?: string | null;
}

export interface WslDistro {
	name: string;
	isDefault: boolean;
	version: number;
	state: string;
}

export interface ContainerEntry {
	id: string;
	name: string;
	image: string;
	status: string;
	ports: string;
}

export interface CodespaceEntry {
	name: string;
	displayName: string;
	repository: string;
	branch: string;
	machineType: string;
	state: string;
	createdAt: string;
	lastUsed: string;
}

export interface RemoteConnection {
	id: number;
	kind: RemoteKind;
	label: string;
	connectedSecs: number;
	/** VS Code-style authority, e.g. `ssh-remote+user@host`. */
	authority?: string;
}

export interface RemoteExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface RemoteDirEntry {
	name: string;
	path: string;
	isDir: boolean;
	isSymlink?: boolean;
	size: number;
	modifiedMs: number | null;
}

export interface RemoteStat {
	size: number;
	modifiedMs: number | null;
	isDir: boolean;
	isSymlink: boolean;
}

export type SshAuth =
	{ kind: 'password'; password: string } | { kind: 'keyfile'; path: string; passphrase?: string } | { kind: 'agent' };

interface RawSshHost {
	host: string;
	hostname: string | null;
	port: number | null;
	user: string | null;
	identity_file: string | null;
	proxy_jump?: string | null;
	proxy_command?: string | null;
}

interface RawWslDistro {
	name: string;
	is_default: boolean;
	version: number;
	state: string;
}

interface RawCodespace {
	name: string;
	display_name: string;
	repository: string;
	branch: string;
	machine_type: string;
	state: string;
	created_at: string;
	last_used: string;
}

interface RawConnection {
	id: number;
	kind: string;
	label: string;
	connected_secs: number;
}

interface RawExec {
	stdout: string;
	stderr: string;
	exit_code: number;
}

interface RawDirEntry {
	name: string;
	path: string;
	is_dir: boolean;
	is_symlink?: boolean;
	size: number;
	modified_ms: number | null;
}

interface RawStat {
	size: number;
	modified_ms: number | null;
	is_dir: boolean;
	is_symlink: boolean;
}

function toHost(r: RawSshHost): SshHost {
	return {
		host: r.host,
		hostname: r.hostname,
		port: r.port,
		user: r.user,
		identityFile: r.identity_file,
		proxyJump: r.proxy_jump ?? null,
		proxyCommand: r.proxy_command ?? null
	};
}

function toDistro(r: RawWslDistro): WslDistro {
	return { name: r.name, isDefault: r.is_default, version: r.version, state: r.state };
}

function toCodespace(r: RawCodespace): CodespaceEntry {
	return {
		name: r.name,
		displayName: r.display_name,
		repository: r.repository,
		branch: r.branch,
		machineType: r.machine_type,
		state: r.state,
		createdAt: r.created_at,
		lastUsed: r.last_used
	};
}

function toConnection(r: RawConnection, authority?: string): RemoteConnection {
	return {
		id: r.id,
		kind: r.kind as RemoteKind,
		label: r.label,
		connectedSecs: r.connected_secs,
		authority
	};
}

/** Lift `[SIDEX_CODE]` errors into Error.message for UI mapping. */
function mapRemoteError(e: unknown): Error {
	const msg = e instanceof Error ? e.message : String(e);
	return new Error(msg);
}

/** Build VS Code-compatible SSH remote authority (`ssh-remote+user@host`). */
export function buildSshRemoteAuthority(user: string, host: string, port?: number): string {
	const hostPart = port && port !== 22 ? `${host}:${port}` : host;
	return `ssh-remote+${user}@${hostPart}`;
}

export const ISideXRemoteService = createDecorator<ISideXRemoteService>('sidexRemoteService');

export interface ISideXRemoteService extends SideXRemoteService {
	readonly _serviceBrand: undefined;
}

export class SideXRemoteService {
	declare readonly _serviceBrand: undefined;

	constructor() {
		// Share one instance between DI (`ISideXRemoteService`) and `getSideXRemoteService()`.
		_instance = this;
	}

	private readonly _authorityToConnection = new Map<string, number>();
	private readonly _connectionToAuthority = new Map<number, string>();
	private readonly _onDidChangeConnections = new Emitter<void>();
	readonly onDidChangeConnections: Event<void> = this._onDidChangeConnections.event;

	bindAuthority(authority: string, connectionId: number): void {
		this._authorityToConnection.set(authority, connectionId);
		this._connectionToAuthority.set(connectionId, authority);
		this._onDidChangeConnections.fire();
	}

	unbindAuthority(authority: string): void {
		const id = this._authorityToConnection.get(authority);
		this._authorityToConnection.delete(authority);
		if (id !== undefined) {
			this._connectionToAuthority.delete(id);
		}
		this._onDidChangeConnections.fire();
	}

	getConnectionIdForAuthority(authority: string): number | undefined {
		return this._authorityToConnection.get(authority);
	}

	getAuthorityForConnection(connectionId: number): string | undefined {
		return this._connectionToAuthority.get(connectionId);
	}

	async listSshHosts(): Promise<SshHost[]> {
		if (!isTauri()) {
			return [];
		}
		const raw = (await invoke<RawSshHost[]>('remote_list_ssh_hosts')) ?? [];
		return raw.map(toHost);
	}

	async connectSsh(
		host: string,
		user: string,
		port: number | undefined,
		auth: SshAuth,
		opts?: { requestId?: string; timeoutSecs?: number; strictHostKey?: boolean }
	): Promise<RemoteConnection> {
		if (!isTauri()) {
			throw new Error('[SIDEX_UNSUPPORTED] Remote SSH requires the SideX desktop app');
		}
		try {
			const raw = await invoke<RawConnection>('remote_connect_ssh', {
				host,
				user,
				port: port ?? null,
				auth,
				requestId: opts?.requestId ?? null,
				timeoutSecs: opts?.timeoutSecs ?? null,
				strictHostKey: opts?.strictHostKey ?? null
			});
			const authority = buildSshRemoteAuthority(user, host, port);
			const conn = toConnection(raw, authority);
			this.bindAuthority(authority, conn.id);
			return conn;
		} catch (e) {
			throw mapRemoteError(e);
		}
	}

	async cancelConnect(requestId: string): Promise<boolean> {
		if (!isTauri()) {
			return false;
		}
		return !!(await invoke<boolean>('remote_cancel_connect', { requestId }));
	}

	async reconnect(connectionId: number): Promise<RemoteConnection> {
		const raw = await invoke<RawConnection>('remote_reconnect', { connectionId });
		const prev = this.getAuthorityForConnection(connectionId);
		if (prev) {
			this.unbindAuthority(prev);
		}
		const authority = prev ?? `ssh-remote+${raw.label}`;
		const conn = toConnection(raw, authority);
		this.bindAuthority(authority, conn.id);
		return conn;
	}

	async connectWsl(distro: string): Promise<RemoteConnection> {
		const raw = await invoke<RawConnection>('remote_connect_wsl', { distro });
		return toConnection(raw);
	}

	async connectContainer(configPath: string): Promise<RemoteConnection> {
		const raw = await invoke<RawConnection>('remote_connect_container', { configPath });
		return toConnection(raw);
	}

	async connectCodespace(name: string, githubToken: string): Promise<RemoteConnection> {
		const raw = await invoke<RawConnection>('remote_connect_codespace', { name, githubToken });
		return toConnection(raw);
	}

	async execSsh(connectionId: number, command: string): Promise<RemoteExecResult> {
		const raw = await invoke<RawExec>('remote_exec_ssh', { connectionId, command });
		return { stdout: raw.stdout, stderr: raw.stderr, exitCode: raw.exit_code };
	}

	async readDir(connectionId: number, path: string): Promise<RemoteDirEntry[]> {
		const raw = (await invoke<RawDirEntry[]>('remote_read_dir', { connectionId, path })) ?? [];
		return raw.map(e => ({
			name: e.name,
			path: e.path,
			isDir: e.is_dir,
			isSymlink: !!e.is_symlink,
			size: e.size,
			modifiedMs: e.modified_ms
		}));
	}

	async readFile(connectionId: number, path: string): Promise<Uint8Array> {
		const raw = await invoke<number[] | Uint8Array>('remote_read_file', { connectionId, path });
		return raw instanceof Uint8Array ? raw : new Uint8Array(raw ?? []);
	}

	async writeFile(connectionId: number, path: string, contents: Uint8Array): Promise<void> {
		await invoke('remote_write_file', {
			connectionId,
			path,
			contents: Array.from(contents)
		});
	}

	async stat(connectionId: number, path: string): Promise<RemoteStat> {
		const raw = await invoke<RawStat>('remote_stat', { connectionId, path });
		return {
			size: raw.size,
			modifiedMs: raw.modified_ms,
			isDir: raw.is_dir,
			isSymlink: raw.is_symlink
		};
	}

	async home(connectionId: number): Promise<string> {
		return await invoke<string>('remote_home', { connectionId });
	}

	async mkdir(connectionId: number, path: string): Promise<void> {
		await invoke('remote_mkdir', { connectionId, path });
	}

	async delete(connectionId: number, path: string, recursive: boolean): Promise<void> {
		try {
			await invoke('remote_delete', { connectionId, path, recursive });
		} catch (e) {
			throw mapRemoteError(e);
		}
	}

	async rename(connectionId: number, from: string, to: string, overwrite?: boolean): Promise<void> {
		await invoke('remote_rename', { connectionId, from, to, overwrite: overwrite ?? false });
	}

	async listWslDistros(): Promise<WslDistro[]> {
		if (!isTauri()) {
			return [];
		}
		const raw = (await invoke<RawWslDistro[]>('remote_list_wsl_distros')) ?? [];
		return raw.map(toDistro);
	}

	async listContainers(): Promise<ContainerEntry[]> {
		if (!isTauri()) {
			return [];
		}
		return (await invoke<ContainerEntry[]>('remote_list_containers')) ?? [];
	}

	async listCodespaces(githubToken: string): Promise<CodespaceEntry[]> {
		const raw = (await invoke<RawCodespace[]>('remote_codespaces_list', { githubToken })) ?? [];
		return raw.map(toCodespace);
	}

	async disconnect(connectionId: number): Promise<void> {
		const authority = this._connectionToAuthority.get(connectionId);
		await invoke('remote_disconnect', { connectionId });
		if (authority) {
			this.unbindAuthority(authority);
		} else {
			this._onDidChangeConnections.fire();
		}
	}

	async activeConnections(): Promise<RemoteConnection[]> {
		if (!isTauri()) {
			return [];
		}
		const raw = (await invoke<RawConnection[]>('remote_active_connections')) ?? [];
		return raw.map(r => toConnection(r, this._connectionToAuthority.get(r.id)));
	}
}

let _instance: SideXRemoteService | null = null;

export function getSideXRemoteService(): SideXRemoteService {
	if (!_instance) {
		_instance = new SideXRemoteService();
	}
	return _instance;
}

registerSingleton(ISideXRemoteService, SideXRemoteService, InstantiationType.Delayed);
