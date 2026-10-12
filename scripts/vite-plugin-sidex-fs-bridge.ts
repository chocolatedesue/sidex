/*---------------------------------------------------------------------------------------------
 *  SideX — dev/preview file-system bridge for the browser (web) mode.
 *
 *  The desktop app routes every `file://` read/write to the Rust backend. When
 *  the frontend is opened directly in a browser there is no Tauri runtime, so
 *  `TauriFileSystemProvider` cannot work and the workbench has no usable file
 *  system at all. This middleware gives the browser build a real, read/write
 *  file system rooted at one directory, which is what makes the web mode
 *  testable (open folder, open file, markdown preview, ...).
 *
 *  Scope is deliberately narrow:
 *    - only active for `vite dev` / `vite preview`, never in a production build
 *    - every path is confined to SIDEX_FS_ROOT (defaults to the process cwd)
 *    - no symlink escaping: the resolved real path is re-checked against the root
 *
 *  See `src/vs/platform/files/browser/webFileSystemProvider.ts` for the client.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Plugin } from 'vite';

const PREFIX = '/__sidex_fs';

function rootDir(): string {
	return path.resolve(process.env.SIDEX_FS_ROOT || process.cwd());
}

/** Compare paths the way the host filesystem does (Windows is case-insensitive). */
function normalizeForCompare(value: string): string {
	return process.platform === 'win32' ? value.toLowerCase() : value;
}

/**
 * Resolve a client-supplied path and make sure it stays inside the root.
 * Throws an error that the client surfaces as a FileSystemProviderError.
 */
function resolveInRoot(requested: string): string {
	if (typeof requested !== 'string' || requested.length === 0) {
		throw new Error('missing path');
	}
	const root = rootDir();
	// A URI path arrives with forward slashes even on Windows.
	const cleaned = process.platform === 'win32' ? requested.replace(/\//g, path.sep) : requested;
	const absolute = path.resolve(root, cleaned);
	const comparableRoot = normalizeForCompare(root);
	const comparableAbsolute = normalizeForCompare(absolute);
	if (comparableAbsolute !== comparableRoot && !comparableAbsolute.startsWith(comparableRoot + path.sep)) {
		throw new Error(`path outside of workspace root: ${requested}`);
	}
	return absolute;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.statusCode = status;
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-store');
	res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(chunk as Buffer);
	}
	if (chunks.length === 0) {
		return {};
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		throw new Error('invalid JSON body');
	}
}

interface StatPayload {
	size: number;
	isDir: boolean;
	isFile: boolean;
	isSymlink: boolean;
	modified: number;
	created: number;
	readonly: boolean;
}

async function statOf(target: string): Promise<StatPayload> {
	const st = await fsp.lstat(target);
	let isSymlink = st.isSymbolicLink();
	let effective = st;
	if (isSymlink) {
		// Follow once so a symlink to a directory still lists as a directory,
		// which is what the editor expects for `file://` folder picks.
		try {
			effective = await fsp.stat(target);
		} catch {
			effective = st;
		}
	}
	return {
		size: effective.size,
		isDir: effective.isDirectory(),
		isFile: effective.isFile(),
		isSymlink,
		modified: Math.floor(effective.mtimeMs / 1000),
		created: Math.floor((effective.birthtimeMs || effective.mtimeMs) / 1000),
		readonly: false
	};
}

async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
	const route = url.pathname.slice(PREFIX.length) || '/';

	if (req.method === 'GET') {
		// `/root` takes no path argument, so it must be answered before the
		// path is resolved (resolving first would reject it as "missing path").
		if (route === '/root') {
			return sendJson(res, 200, { root: rootDir() });
		}

		const target = resolveInRoot(url.searchParams.get('path') ?? '');
		switch (route) {
			case '/stat':
				return sendJson(res, 200, await statOf(target));
			case '/readdir': {
				const entries = await fsp.readdir(target, { withFileTypes: true });
				const out = await Promise.all(
					entries.map(async e => {
						const child = path.join(target, e.name);
						try {
							const st = await statOf(child);
							return { name: e.name, ...st };
						} catch {
							return { name: e.name, size: 0, isDir: e.isDirectory(), isFile: e.isFile(), isSymlink: e.isSymbolicLink(), modified: 0, created: 0, readonly: false };
						}
					})
				);
				return sendJson(res, 200, out);
			}
			case '/read': {
				const data = await fsp.readFile(target);
				res.statusCode = 200;
				res.setHeader('Content-Type', 'application/octet-stream');
				res.setHeader('Cache-Control', 'no-store');
				res.end(data);
				return;
			}
			case '/exists': {
				try {
					await fsp.stat(target);
					return sendJson(res, 200, { exists: true });
				} catch {
					return sendJson(res, 200, { exists: false });
				}
			}
			default:
				return sendJson(res, 404, { error: `unknown route ${route}` });
		}
	}

	if (req.method === 'POST') {
		const body = await readBody(req);
		switch (route) {
			case '/write': {
				const target = resolveInRoot(body.path as string);
				const raw = (body.contentBase64 as string) ?? '';
				await fsp.mkdir(path.dirname(target), { recursive: true });
				await fsp.writeFile(target, Buffer.from(raw, 'base64'));
				return sendJson(res, 200, { ok: true });
			}
			case '/mkdir': {
				const target = resolveInRoot(body.path as string);
				await fsp.mkdir(target, { recursive: body.recursive !== false });
				return sendJson(res, 200, { ok: true });
			}
			case '/remove': {
				const target = resolveInRoot(body.path as string);
				await fsp.rm(target, { recursive: body.recursive === true, force: false });
				return sendJson(res, 200, { ok: true });
			}
			case '/rename': {
				const from = resolveInRoot(body.oldPath as string);
				const to = resolveInRoot(body.newPath as string);
				if (body.overwrite !== true) {
					try {
						await fsp.stat(to);
						return sendJson(res, 409, { error: 'EEXIST' });
					} catch {
						// target does not exist — fine
					}
				}
				await fsp.mkdir(path.dirname(to), { recursive: true });
				await fsp.rename(from, to);
				return sendJson(res, 200, { ok: true });
			}
			default:
				return sendJson(res, 404, { error: `unknown route ${route}` });
		}
	}

	return sendJson(res, 405, { error: 'method not allowed' });
}

/**
 * The connect-style middleware itself. Exported so a plain HTTP server (used
 * when we only have the pre-built `dist/`, e.g. for a Windows smoke test) can
 * run the exact same bridge code the dev server runs.
 */
export function createSidexFsMiddleware() {
	return async (req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> => {
		if (!req.url || !req.url.startsWith(PREFIX)) {
			next();
			return;
		}
		try {
			const url = new URL(req.url, 'http://localhost');
			await handle(req, res, url);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const notFound = /ENOENT|no such file/i.test(message);
			sendJson(res, notFound ? 404 : 500, { error: message });
		}
	};
}

export function sidexFsBridge(): Plugin {
	return {
		name: 'sidex-fs-bridge',
		apply: () => process.env.SIDEX_FS_BRIDGE !== 'off',
		configureServer(server) {
			server.middlewares.use(createSidexFsMiddleware());
			server.config.logger.info(`[sidex-fs] browser file system rooted at ${rootDir()}`);
		},
		configurePreviewServer(server) {
			server.middlewares.use(createSidexFsMiddleware());
		}
	};
}

export { PREFIX as SIDEX_FS_BRIDGE_PREFIX, rootDir as sidexFsRoot };
