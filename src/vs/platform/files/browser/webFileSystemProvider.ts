/*---------------------------------------------------------------------------------------------
 *  SideX — HTTP-backed file system provider for the browser (web) mode.
 *
 *  Counterpart to `TauriFileSystemProvider`: same `file` / `vscode-file`
 *  schemes and the same provider capabilities, but every operation goes over
 *  `fetch()` to the dev-server bridge instead of `invoke()`.
 *
 *  The bridge only exists in `vite dev` / `vite preview` (see
 *  `scripts/vite-plugin-sidex-fs-bridge.ts`), so this provider is installed
 *  only when the page is opened without a Tauri runtime. In a packaged app the
 *  Tauri provider is used instead.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { Event } from '../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import {
	FileSystemProviderCapabilities,
	FileSystemProviderErrorCode,
	FileType,
	createFileSystemProviderError,
	IFileDeleteOptions,
	IFileOverwriteOptions,
	IFileWriteOptions,
	IStat,
	IWatchOptions,
	IFileSystemProviderWithFileReadWriteCapability,
	FilePermission
} from '../common/files.js';

const BRIDGE_PREFIX = '/__sidex_fs';

interface BridgeStat {
	size: number;
	isDir: boolean;
	isFile: boolean;
	isSymlink: boolean;
	modified: number;
	created: number;
	readonly: boolean;
}

interface BridgeDirEntry extends BridgeStat {
	name: string;
}

export class WebFileSystemProvider extends Disposable implements IFileSystemProviderWithFileReadWriteCapability {
	readonly capabilities: FileSystemProviderCapabilities =
		FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive;

	readonly onDidChangeCapabilities = Event.None;
	readonly onDidChangeFile = Event.None;

	static toPath(resource: URI): string {
		if (resource.scheme === 'vscode-file') {
			return decodeURIComponent(resource.path);
		}
		return resource.fsPath || resource.path;
	}

	private async _request<T>(route: string, init?: RequestInit): Promise<T> {
		const response = await fetch(`${BRIDGE_PREFIX}${route}`, init);
		if (!response.ok) {
			let message = `${response.status} ${response.statusText}`;
			try {
				const body = (await response.json()) as { error?: string };
				if (body?.error) {
					message = body.error;
				}
			} catch {
				// keep the status text
			}
			throw new Error(message);
		}
		return (await response.json()) as T;
	}

	private static _toError(err: unknown, code: FileSystemProviderErrorCode): Error {
		const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
		return createFileSystemProviderError(msg, code);
	}

	private static _toFileType(stat: BridgeStat): FileType {
		if (stat.isDir) {
			return FileType.Directory;
		}
		if (stat.isSymlink) {
			return FileType.SymbolicLink;
		}
		return FileType.File;
	}

	async stat(resource: URI): Promise<IStat> {
		const path = WebFileSystemProvider.toPath(resource);
		try {
			const raw = await this._request<BridgeStat>(`/stat?path=${encodeURIComponent(path)}`);
			return {
				type: WebFileSystemProvider._toFileType(raw),
				mtime: raw.modified * 1000,
				ctime: raw.created * 1000,
				size: raw.size,
				permissions: raw.readonly ? FilePermission.Readonly : undefined
			};
		} catch (err) {
			throw WebFileSystemProvider._toError(err, FileSystemProviderErrorCode.FileNotFound);
		}
	}

	async readdir(resource: URI): Promise<[string, FileType][]> {
		const path = WebFileSystemProvider.toPath(resource);
		try {
			const entries = await this._request<BridgeDirEntry[]>(`/readdir?path=${encodeURIComponent(path)}`);
			return entries.map(e => [e.name, WebFileSystemProvider._toFileType(e)] as [string, FileType]);
		} catch (err) {
			throw WebFileSystemProvider._toError(err, FileSystemProviderErrorCode.FileNotFound);
		}
	}

	async readFile(resource: URI): Promise<Uint8Array> {
		const path = WebFileSystemProvider.toPath(resource);
		const response = await fetch(`${BRIDGE_PREFIX}/read?path=${encodeURIComponent(path)}`);
		if (!response.ok) {
			throw createFileSystemProviderError(
				`Unable to read file '${path}' (${response.status})`,
				FileSystemProviderErrorCode.FileNotFound
			);
		}
		return new Uint8Array(await response.arrayBuffer());
	}

	async writeFile(resource: URI, content: Uint8Array, _opts: IFileWriteOptions): Promise<void> {
		const path = WebFileSystemProvider.toPath(resource);
		try {
			await this._request('/write', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path, contentBase64: bytesToBase64(content) })
			});
		} catch (err) {
			throw WebFileSystemProvider._toError(err, FileSystemProviderErrorCode.Unknown);
		}
	}

	async mkdir(resource: URI): Promise<void> {
		const path = WebFileSystemProvider.toPath(resource);
		try {
			await this._request('/mkdir', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path, recursive: true })
			});
		} catch (err) {
			throw WebFileSystemProvider._toError(err, FileSystemProviderErrorCode.Unknown);
		}
	}

	async delete(resource: URI, opts: IFileDeleteOptions): Promise<void> {
		const path = WebFileSystemProvider.toPath(resource);
		try {
			await this._request('/remove', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path, recursive: opts.recursive })
			});
		} catch (err) {
			throw WebFileSystemProvider._toError(err, FileSystemProviderErrorCode.Unknown);
		}
	}

	async rename(from: URI, to: URI, opts: IFileOverwriteOptions): Promise<void> {
		const oldPath = WebFileSystemProvider.toPath(from);
		const newPath = WebFileSystemProvider.toPath(to);
		try {
			await this._request('/rename', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ oldPath, newPath, overwrite: !!opts.overwrite })
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const code = /EEXIST|already exists/i.test(message)
				? FileSystemProviderErrorCode.FileExists
				: FileSystemProviderErrorCode.Unknown;
			throw WebFileSystemProvider._toError(err, code);
		}
	}

	watch(_resource: URI, _opts: IWatchOptions): IDisposable {
		// The bridge is intentionally read-through: there is no push channel in
		// the browser dev setup, so no file change events are emitted.
		return toDisposable(() => {
			/* no-op */
		});
	}
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}
