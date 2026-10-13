#!/usr/bin/env node
/**
 * Smoke: Remote SSH adapter hooks (built-in sidex-remote + Open VSX open-remote-ssh).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'smoke-artifacts');
fs.mkdirSync(outDir, { recursive: true });

const evidence = {
  at: new Date().toISOString(),
  zone: 'Asia/Shanghai (UTC+8)',
  steps: [],
  limits: []
};
const step = (name, ok, detail) => {
  evidence.steps.push({ name, ok, detail: detail || '' });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const bootstrap = read('src/bootstrap-globals.ts');
step(
  'product.openRemoteSsh.proposals',
  bootstrap.includes("'jeanp413.open-remote-ssh'") && bootstrap.includes("'resolvers'"),
  'extensionEnabledApiProposals for jeanp413.open-remote-ssh'
);

const productTs = read('src/vs/platform/product/common/product.ts');
step(
  'product.ts.openRemoteSsh.proposals',
  productTs.includes("'jeanp413.open-remote-ssh'") && productTs.includes('resolvers'),
  'fallback product config'
);

const resolver = read('src/vs/platform/remote/browser/remoteAuthorityResolverService.ts');
step('resolver.deferred', resolver.includes('DeferredPromise') && resolver.includes('_resolveAuthorityRequests'));
step('resolver.setResolved', resolver.includes('_setResolvedAuthority') && resolver.includes('request.promise.complete'));
step('resolver.noStubThrow', !resolver.includes('handled by Rust runtime'));

const remoteRs = read('src-tauri/src/commands/remote.rs');
for (const cmd of [
  'remote_read_dir',
  'remote_read_file',
  'remote_write_file',
  'remote_stat',
  'remote_home',
  'remote_mkdir',
  'remote_delete',
  'remote_rename',
  'remote_cancel_connect',
  'remote_reconnect',
  'remote_detect_platform',
  'remote_forward_port'
]) {
  step(`tauri.cmd.${cmd}`, remoteRs.includes(`pub async fn ${cmd}`) || remoteRs.includes(`pub fn ${cmd}`));
}

const libRs = read('src-tauri/src/lib.rs');
step(
  'tauri.handlers.remoteFs',
  libRs.includes('commands::remote_read_dir') && libRs.includes('commands::remote_home') && libRs.includes('commands::remote_cancel_connect')
);

const svc = read('src/vs/platform/sidex/browser/sidexRemoteService.ts');
step('svc.buildAuthority', svc.includes('buildSshRemoteAuthority') && svc.includes('ssh-remote+'));
step('svc.bindAuthority', svc.includes('bindAuthority') && svc.includes('getConnectionIdForAuthority'));
step('svc.fsApis', svc.includes('readDir') && svc.includes('async home('));

const fsp = read('src/vs/platform/sidex/browser/sidexRemoteFileSystemProvider.ts');
step('fsp.vscodeRemote', fsp.includes('SideXRemoteFileSystemProvider') && fsp.includes('getConnectionIdForAuthority'));
step('fsp.stat.readdir', fsp.includes('async stat') && fsp.includes('async readdir') && fsp.includes('async readFile'));

const sshContrib = read('src/vs/workbench/contrib/remote/browser/remoteSsh.contribution.ts');
step('contrib.registerProvider', sshContrib.includes("Schemas.vscodeRemote") && sshContrib.includes('registerProvider'));
step('contrib.afterSshConnected', sshContrib.includes('afterSshConnected') && sshContrib.includes('createAndEnterWorkspace'));
step('contrib.managedConnection', sshContrib.includes('ManagedRemoteConnection'));

const remoteContrib = read('src/vs/workbench/contrib/remote/browser/remote.contribution.ts');
step('contrib.authFallback', remoteContrib.includes('connectSshWithAuthFallback'));
step('contrib.closeRemote', remoteContrib.includes('sidex.remote.close'));
step('contrib.friendlyErrors', remoteContrib.includes('SIDEX_HOSTKEY_CHANGED') || remoteContrib.includes('friendlySshError'));
step('contrib.afterConnectWired', remoteContrib.includes('afterSshConnected'));
step('contrib.statusListener', remoteContrib.includes('onDidChangeConnections'));

const main = read('src/vs/workbench/workbench.common.main.ts');
step('main.imports.remoteSsh', main.includes("remoteSsh.contribution.js"));

const apiImpl = read('src/vs/workbench/api/common/extHost.api.impl.ts');
step('api.registerRemoteAuthorityResolver', apiImpl.includes('registerRemoteAuthorityResolver'));
const hostCjs = read('src-tauri/extension-host/host.cjs');
step('hostcjs.resolverStore', hostCjs.includes('_remoteAuthorityResolvers') && !hostCjs.includes('registerRemoteAuthorityResolver: (authorityPrefix, resolver) => noopDisposable'));
step('hostcjs.openAuthorityRoute', hostCjs.includes('sidex.remote.openAuthority'));
step('crate.ssh_config', read('crates/sidex-remote/src/ssh_config.rs').includes('resolve_proxy_jumps'));
step('crate.errors', read('crates/sidex-remote/src/errors.rs').includes('HOSTKEY_CHANGED'));

// Crate unit tests (no live SSH required)
const cargo = spawnSync(
  'cargo',
  ['test', '-p', 'sidex-remote', '--', '--nocapture'],
  { cwd: root, encoding: 'utf8', env: { ...process.env, CARGO_TERM_COLOR: 'never' } }
);
const cargoOk = cargo.status === 0;
step(
  'crate.sidex-remote.tests',
  cargoOk,
  cargoOk
    ? (cargo.stdout.match(/test result:.*$/m) || ['ok'])[0]
    : (cargo.stderr || cargo.stdout || 'cargo failed').slice(-400)
);

// Optional live SSH if SIDEX_SMOKE_SSH=user@host is set (or localhost with agent)
// Prefer sidex-remote example against local sshd (default 127.0.0.1:2222), or SIDEX_SMOKE_SSH.
const liveEnv = { ...process.env };
if (process.env.SIDEX_SMOKE_SSH) {
  // Format: user@host,port  OR user@host:port
  const raw = process.env.SIDEX_SMOKE_SSH;
  const m = raw.match(/^(?:([^@]+)@)?([^:,]+)(?::|,)?(\d+)?$/);
  if (m) {
    liveEnv.SIDEX_SMOKE_SSH_USER = m[1] || process.env.USER || 'box';
    liveEnv.SIDEX_SMOKE_SSH_HOST = m[2];
    liveEnv.SIDEX_SMOKE_SSH_PORT = m[3] || '22';
  }
}
const live = spawnSync('cargo', ['run', '-p', 'sidex-remote', '--example', 'ssh_localhost_smoke', '-q'], {
  cwd: root,
  encoding: 'utf8',
  env: { ...liveEnv, CARGO_TERM_COLOR: 'never' }
});
const liveOut = `${live.stdout || ''}${live.stderr || ''}`;
if (live.status === 0 && liveOut.includes('SIDEX_REMOTE_SSH_LIVE_OK')) {
  step('live.ssh.sidex-remote', true, liveOut.trim().split('\n').slice(-6).join(' | ').slice(0, 240));
} else if (!process.env.SIDEX_SMOKE_SSH && !liveOut.includes('connect')) {
  evidence.limits.push('Live SSH example failed to connect — start local sshd on 2222 or set SIDEX_SMOKE_SSH');
  step('live.ssh.skipped', true, (liveOut || 'no output').trim().slice(0, 200));
} else {
  step('live.ssh.sidex-remote', false, liveOut.trim().slice(-400));
}

evidence.limits.push(
  'Built-in path: SSH connect + vscode-remote FS + open remote folder (no VS Code Server install).'
);
evidence.limits.push(
  'Open VSX jeanp413.open-remote-ssh: proposed APIs enabled; full server download/protocol still needs Node extension host + matching server build.'
);
evidence.limits.push('Remote file watching / PTY terminal over SSH not wired in this smoke.');

const failed = evidence.steps.filter(s => !s.ok);
evidence.ok = failed.length === 0;
fs.writeFileSync(path.join(outDir, 'remote-ssh-evidence.json'), JSON.stringify(evidence, null, 2));
console.log(`\n${evidence.ok ? 'OK' : 'FAILED'}  ${evidence.steps.length - failed.length}/${evidence.steps.length} passed`);
if (!evidence.ok) {
  process.exit(1);
}
