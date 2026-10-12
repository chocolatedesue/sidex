/*---------------------------------------------------------------------------------------------
 *  SideX - Marketplace + installed-extension bridge.
 *--------------------------------------------------------------------------------------------*/

import { invoke } from '../../../sidex-bridge.js';

export interface MarketplaceExtensionResult {
	id: string;
	name: string;
	displayName: string;
	description: string;
	version: string;
	publisher: string;
	installCount: number;
	rating: number;
	iconUrl?: string;
	downloadUrl: string;
}

interface CachedSearch {
	results: MarketplaceExtensionResult[];
	fetchedAt: number;
}

const TS_CACHE_TTL_MS = 30_000;
const DEFAULT_DEBOUNCE_MS = 150;
const OPEN_VSX_SEARCH = 'https://open-vsx.org/api/-/search';
const SIDEN_SEARCH = 'https://marketplace.siden.ai/api/-/search';

function normalizeOpenVsxItem(raw: any): MarketplaceExtensionResult {
	const namespace = raw.namespace || raw.publisher?.publisherName || raw.publisher || '';
	const name = raw.name || raw.extensionName || '';
	const id = raw.id || (namespace && name ? `${namespace}.${name}` : name);
	const files = raw.files || {};
	const downloadUrl =
		raw.downloadUrl ||
		files.download ||
		raw.download ||
		'';
	return {
		id,
		name,
		displayName: raw.displayName || raw.display_name || name,
		description: raw.shortDescription || raw.short_description || raw.description || '',
		version: raw.version || raw.versions?.[0]?.version || '',
		publisher: typeof raw.publisher === 'string'
			? raw.publisher
			: (raw.publisher?.displayName || raw.publisher?.publisherName || namespace || ''),
		installCount: raw.installCount ?? raw.downloadCount ?? raw.download_count ?? 0,
		rating: raw.rating ?? raw.averageRating ?? 0,
		iconUrl: raw.iconUrl || raw.icon_url || files.icon,
		downloadUrl,
	};
}

async function fetchOpenVsxCompat(base: string, query: string, page: number): Promise<MarketplaceExtensionResult[]> {
	const size = 20;
	const offset = page * size;
	const url = `${base}?query=${encodeURIComponent(query)}&offset=${offset}&size=${size}`;
	const res = await fetch(url, {
		headers: { accept: 'application/json', 'user-agent': 'SideX-marketplace/0.1' },
	});
	if (!res.ok) {
		throw new Error(`${base} HTTP ${res.status}`);
	}
	const json = await res.json();
	const list = json.extensions || json.results || [];
	return (list as any[]).map(normalizeOpenVsxItem);
}

export class SideXExtensionService {
	private readonly _cache = new Map<string, CachedSearch>();
	private readonly _inflight = new Map<string, Promise<MarketplaceExtensionResult[]>>();
	private _debounceTimer: ReturnType<typeof setTimeout> | undefined;

	async searchMarketplace(query: string, page = 0): Promise<MarketplaceExtensionResult[]> {
		const trimmed = query.trim();
		if (!trimmed) {
			return [];
		}
		const key = `${trimmed}|${page}`;
		const cached = this._cache.get(key);
		if (cached && Date.now() - cached.fetchedAt < TS_CACHE_TTL_MS) {
			return cached.results;
		}
		const pending = this._inflight.get(key);
		if (pending) {
			return pending;
		}
		const fetchPromise = (async () => {
			try {
				let results: MarketplaceExtensionResult[] = [];
				try {
					const raw = await invoke<unknown[]>('extension_search_marketplace', {
						query: trimmed,
						page
					});
					results = ((raw ?? []) as any[]).map(normalizeOpenVsxItem);
				} catch {
					// Web / non-Tauri: hit marketplace proxy then Open VSX directly.
					try {
						results = await fetchOpenVsxCompat(SIDEN_SEARCH, trimmed, page);
					} catch {
						results = await fetchOpenVsxCompat(OPEN_VSX_SEARCH, trimmed, page);
					}
				}
				this._cache.set(key, { results, fetchedAt: Date.now() });
				if (this._cache.size > 128) {
					const oldestKey = [...this._cache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)[0]?.[0];
					if (oldestKey) {
						this._cache.delete(oldestKey);
					}
				}
				return results;
			} catch {
				return [];
			} finally {
				this._inflight.delete(key);
			}
		})();
		this._inflight.set(key, fetchPromise);
		return fetchPromise;
	}

	/** Keystroke-friendly variant. Resolves with the results for the
	 * *final* paused query; earlier invocations resolve with `[]`. */
	async debouncedSearch(query: string, page = 0, delayMs = DEFAULT_DEBOUNCE_MS): Promise<MarketplaceExtensionResult[]> {
		return new Promise(resolve => {
			if (this._debounceTimer) {
				clearTimeout(this._debounceTimer);
			}
			this._debounceTimer = setTimeout(async () => {
				const results = await this.searchMarketplace(query, page);
				resolve(results);
			}, delayMs);
		});
	}

	async getInstalled(): Promise<unknown[]> {
		try {
			return (await invoke<unknown[]>('list_installed_extensions')) || [];
		} catch {
			return [];
		}
	}

	/**
	 * Install by publisher.name id: resolve a download URL from marketplace
	 * search, then unpack via Tauri `install_extension_from_url`.
	 * (The older path wrongly called `install_extension` with an id as if it
	 * were a local .vsix path.)
	 */
	async install(id: string): Promise<unknown> {
		const downloadUrl = await this.resolveDownloadUrl(id);
		return invoke('install_extension_from_url', { url: downloadUrl });
	}

	async installFromUrl(url: string): Promise<unknown> {
		return invoke('install_extension_from_url', { url });
	}

	async installFromVsixPath(vsixPath: string): Promise<unknown> {
		return invoke('install_extension', { vsixPath });
	}

	async uninstall(id: string): Promise<void> {
		return invoke('uninstall_extension', { extensionId: id });
	}

	async resolveDownloadUrl(idOrQuery: string): Promise<string> {
		const needle = idOrQuery.trim().toLowerCase();
		const results = await this.searchMarketplace(needle.includes('.') ? needle.split('.').pop()! : needle, 0);
		const exact = results.find(r => {
			const id = (r.id || '').toLowerCase();
			const composed = `${(r.publisher || '').toLowerCase()}.${(r.name || '').toLowerCase()}`;
			return id === needle || composed === needle || (r.name || '').toLowerCase() === needle;
		}) || results[0];
		if (!exact?.downloadUrl) {
			throw new Error(`No marketplace download URL for ${idOrQuery}`);
		}
		return exact.downloadUrl;
	}
}
