/*---------------------------------------------------------------------------------------------
 *  SideX — vscode-remote FileSystemProvider backed by sidex-remote SSH (etc.).
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../base/common/lifecycle.js';
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
	IFileChange
} from '../../files/common/files.js';
import { ISideXRemoteService } from './sidexRemoteService.js';
import { VSBuffer } from '../../../base/common/buffer.js';

export class SideXRemoteFileSystemProvider
	extends Disposable
	implements IFileSystemProviderWithFileReadWriteCapability
{
	readonly capabilities: FileSystemProviderCapabilities =
		FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive;

	readonly onDidChangeCapabilities = Event.None;

	private readonly _onDidChangeFile = this._register(new Emitter<readonly IFileChange[]>());
	readonly onDidChangeFile = this._onDidChangeFile.event;

	constructor(private readonly _remote: ISideXRemoteService) {
		super();
	}

	private connectionId(resource: URI): number {
		const id = this._remote.getConnectionIdForAuthority(resource.authority);
		if (id === undefined) {
			throw createFileSystemProviderError(
				`No SideX remote connection for authority '${resource.authority}'`,
				FileSystemProviderErrorCode.Unavailable
			);
		}
		return id;
	}

	private remotePath(resource: URI): string {
		// vscode-remote URIs use posix paths
		return resource.path || '/';
	}

	async stat(resource: URI): Promise<IStat> {
		try {
			const st = await this._remote.stat(this.connectionId(resource), this.remotePath(resource));
			let type = st.isDir ? FileType.Directory : FileType.File;
			if (st.isSymlink) {
				type |= FileType.SymbolicLink;
			}
			return {
				type,
				ctime: 0,
				mtime: st.modifiedMs ?? 0,
				size: st.size
			};
		} catch (err) {
			throw createFileSystemProviderError(String(err), FileSystemProviderErrorCode.FileNotFound);
		}
	}

	async readdir(resource: URI): Promise<[string, FileType][]> {
		const entries = await this._remote.readDir(this.connectionId(resource), this.remotePath(resource));
		return entries.map(e => [e.name, e.isDir ? FileType.Directory : FileType.File]);
	}

	async readFile(resource: URI): Promise<Uint8Array> {
		return this._remote.readFile(this.connectionId(resource), this.remotePath(resource));
	}

	async writeFile(resource: URI, content: Uint8Array, opts: IFileWriteOptions): Promise<void> {
		const path = this.remotePath(resource);
		const id = this.connectionId(resource);
		if (!opts.create || !opts.overwrite) {
			try {
				await this._remote.stat(id, path);
				if (!opts.overwrite) {
					throw createFileSystemProviderError('File exists', FileSystemProviderErrorCode.FileExists);
				}
			} catch (err) {
				if (!opts.create) {
					throw createFileSystemProviderError('File not found', FileSystemProviderErrorCode.FileNotFound);
				}
				// create path — ok
				if (String(err).includes('File exists')) {
					throw err;
				}
			}
		}
		await this._remote.writeFile(id, path, content);
	}

	async mkdir(resource: URI): Promise<void> {
		await this._remote.mkdir(this.connectionId(resource), this.remotePath(resource));
	}

	async delete(resource: URI, opts: IFileDeleteOptions): Promise<void> {
		await this._remote.delete(this.connectionId(resource), this.remotePath(resource), !!opts.recursive);
	}

	async rename(from: URI, to: URI, _opts: IFileOverwriteOptions): Promise<void> {
		const id = this.connectionId(from);
		await this._remote.rename(id, this.remotePath(from), this.remotePath(to));
	}

	watch(_resource: URI, _opts: IWatchOptions): IDisposable {
		// Polling watch not wired yet — Remote Explorer still works for open/edit.
		return Disposable.None;
	}
}

/** Convenience: read remote file as VSBuffer (editor path). */
export async function readRemoteVSBuffer(remote: ISideXRemoteService, resource: URI): Promise<VSBuffer> {
	const id = remote.getConnectionIdForAuthority(resource.authority);
	if (id === undefined) {
		throw new Error(`No remote connection for ${resource.authority}`);
	}
	const bytes = await remote.readFile(id, resource.path || '/');
	return VSBuffer.wrap(bytes);
}
