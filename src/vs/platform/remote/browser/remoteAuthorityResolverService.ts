/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  SideX: deferred resolveAuthority so Node/UI Remote SSH resolvers (and the
 *  built-in SideX SSH bridge) can complete via _setResolvedAuthority.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { Schemas, RemoteAuthorities } from '../../../base/common/network.js';
import { URI } from '../../../base/common/uri.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { DeferredPromise } from '../../../base/common/async.js';
import {
	IRemoteAuthorityResolverService,
	IRemoteConnectionData,
	ResolvedAuthority,
	ResolvedOptions,
	ResolverResult,
	RemoteConnectionType,
	RemoteAuthorityResolverError
} from '../common/remoteAuthorityResolver.js';

class AuthorityResult {
	public readonly promise = new DeferredPromise<ResolverResult>();
}

export class RemoteAuthorityResolverService extends Disposable implements IRemoteAuthorityResolverService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeConnectionData = this._register(new Emitter<void>());
	public readonly onDidChangeConnectionData = this._onDidChangeConnectionData.event;

	private readonly _resolveAuthorityRequests = new Map<string, AuthorityResult>();
	private readonly _connectionTokens = new Map<string, string>();
	private readonly _canonicalURIRequests = new Map<string, { input: URI; result: DeferredPromise<URI> }>();
	private _canonicalURIProvider: ((uri: URI) => Promise<URI>) | undefined;

	constructor(
		_isWorkbenchOptionsBasedResolution: boolean,
		_connectionToken: Promise<string> | string | undefined,
		_resourceUriProvider: ((uri: URI) => URI) | undefined,
		_serverBasePath: string | undefined,
		@IProductService productService: IProductService,
		@ILogService private readonly _logService: ILogService
	) {
		super();
		RemoteAuthorities.setServerRootPath(productService, _serverBasePath);
		if (_resourceUriProvider) {
			RemoteAuthorities.setDelegate(_resourceUriProvider);
		}
	}

	async resolveAuthority(authority: string): Promise<ResolverResult> {
		let request = this._resolveAuthorityRequests.get(authority);
		if (!request) {
			request = new AuthorityResult();
			this._resolveAuthorityRequests.set(authority, request);
			this._logService.trace(`[RemoteAuthorityResolver] waiting for resolver of '${authority}'`);
		}
		return request.promise.p;
	}

	async getCanonicalURI(uri: URI): Promise<URI> {
		if (uri.scheme !== Schemas.vscodeRemote) {
			return uri;
		}
		const key = uri.toString();
		let pending = this._canonicalURIRequests.get(key);
		if (pending) {
			return pending.result.p;
		}
		const result = new DeferredPromise<URI>();
		this._canonicalURIRequests.set(key, { input: uri, result });
		if (this._canonicalURIProvider) {
			this._doGetCanonicalURI(uri, result);
		}
		return result.p;
	}

	private async _doGetCanonicalURI(uri: URI, result: DeferredPromise<URI>): Promise<void> {
		try {
			const out = await this._canonicalURIProvider!(uri);
			result.complete(out);
		} catch (err) {
			result.error(err);
		}
	}

	getConnectionData(authority: string): IRemoteConnectionData | null {
		const request = this._resolveAuthorityRequests.get(authority);
		if (!request || !request.promise.isResolved) {
			return null;
		}
		const resolved = request.promise.value;
		if (!resolved) {
			return null;
		}
		return {
			connectTo: resolved.authority.connectTo,
			connectionToken: this._connectionTokens.get(authority) ?? resolved.authority.connectionToken
		};
	}

	_clearResolvedAuthority(authority: string): void {
		const request = this._resolveAuthorityRequests.get(authority);
		if (!request) {
			return;
		}
		if (!request.promise.isSettled) {
			request.promise.error(new RemoteAuthorityResolverError(`Cleared remote authority '${authority}'`));
		}
		this._resolveAuthorityRequests.delete(authority);
	}

	_setResolvedAuthority(resolvedAuthority: ResolvedAuthority, resolvedOptions?: ResolvedOptions): void {
		const authority = resolvedAuthority.authority;
		let request = this._resolveAuthorityRequests.get(authority);
		if (!request) {
			request = new AuthorityResult();
			this._resolveAuthorityRequests.set(authority, request);
		}

		if (resolvedAuthority.connectTo.type === RemoteConnectionType.WebSocket) {
			RemoteAuthorities.set(authority, resolvedAuthority.connectTo.host, resolvedAuthority.connectTo.port);
		}
		if (resolvedAuthority.connectionToken) {
			RemoteAuthorities.setConnectionToken(authority, resolvedAuthority.connectionToken);
			this._connectionTokens.set(authority, resolvedAuthority.connectionToken);
		}

		request.promise.complete({ authority: resolvedAuthority, options: resolvedOptions });
		this._onDidChangeConnectionData.fire();
		this._logService.info(
			`[RemoteAuthorityResolver] resolved '${authority}' → ${resolvedAuthority.connectTo.toString()}`
		);
	}

	_setResolvedAuthorityError(authority: string, err: any): void {
		let request = this._resolveAuthorityRequests.get(authority);
		if (!request) {
			request = new AuthorityResult();
			this._resolveAuthorityRequests.set(authority, request);
		}
		request.promise.error(
			err instanceof RemoteAuthorityResolverError
				? err
				: new RemoteAuthorityResolverError(String(err?.message ?? err), undefined, err)
		);
		this._logService.error(`[RemoteAuthorityResolver] resolve error for '${authority}'`, err);
	}

	_setAuthorityConnectionToken(authority: string, connectionToken: string): void {
		this._connectionTokens.set(authority, connectionToken);
		RemoteAuthorities.setConnectionToken(authority, connectionToken);
		this._onDidChangeConnectionData.fire();
	}

	_setCanonicalURIProvider(provider: (uri: URI) => Promise<URI>): void {
		this._canonicalURIProvider = provider;
		for (const [, pending] of this._canonicalURIRequests) {
			this._doGetCanonicalURI(pending.input, pending.result);
		}
	}
}
