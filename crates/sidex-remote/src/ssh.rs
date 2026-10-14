//! SSH remote transport backend.
//!
//! * host keys verified against `known_hosts` (TOFU / strict / accept-all)
//! * bounded connect timeout with coded errors (see [`crate::errors`])
//! * real ssh-agent auth, default identity files, password with
//!   keyboard-interactive fallback, encrypted keys with passphrase
//! * `ProxyJump` chains over `direct-tcpip` and `ProxyCommand` via a child
//!   process, both resolved from `~/.ssh/config` ([`crate::ssh_config`])
//! * every command runs under `sh -c` with single-quoted arguments, so fish /
//!   zsh login shells and paths with spaces, `$`, quotes or unicode are safe
//! * binary-safe file transfer (raw stdout / stdin streaming, no base64 args)
//! * PTY with working resize, local port forwarding (port 0 → returns bound)

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result};
use russh::client;
use russh::ChannelMsg;
use russh_keys::key;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

use crate::errors::{self, coded};
use crate::shell::{
    check_exists_script, sh_quote, wrap_posix, MARK_EACCES, MARK_EEXIST, MARK_ENOENT, MARK_ENOTDIR,
};
use crate::ssh_config::{resolve_proxy_jumps, Destination, ResolvedHost, SshConfig};
use crate::transport::{DirEntry, ExecOutput, FileStat, RemotePty, RemoteTransport};

const MARK_EISDIR: &str = "__SIDEX_EISDIR__";

// ---------------------------------------------------------------------------
// Auth & options
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum SshAuth {
    Password(String),
    KeyFile {
        path: PathBuf,
        passphrase: Option<String>,
    },
    /// ssh-agent first, then the configured / default identity files.
    Agent,
    /// Keyboard-interactive with non-password prompts (OTP etc.): unsupported.
    KeyboardInteractive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Platform {
    Linux,
    MacOS,
    Windows,
}

/// How unknown / changed host keys are treated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HostKeyPolicy {
    /// Trust on first use: unknown keys are learned, changed keys rejected.
    AcceptNew,
    /// Unknown and changed keys are rejected (`StrictHostKeyChecking yes`).
    Strict,
    /// Never check (`StrictHostKeyChecking no`). Changed keys still rejected
    /// unless explicitly accepted, matching OpenSSH's behaviour.
    AcceptAll,
}

impl HostKeyPolicy {
    pub fn from_ssh_option(v: Option<&str>) -> Self {
        match v.map(str::to_ascii_lowercase).as_deref() {
            Some("yes") => Self::Strict,
            Some("no" | "off") => Self::AcceptAll,
            _ => Self::AcceptNew,
        }
    }
}

/// What happened to the server host key during the handshake.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum HostKeyOutcome {
    Trusted { fingerprint: String },
    Learned { fingerprint: String },
    Unchecked { fingerprint: String },
    Changed { fingerprint: String, line: usize },
    Rejected { fingerprint: String },
}

#[derive(Debug, Clone)]
pub struct SshConnectOptions {
    pub connect_timeout: Duration,
    /// `None` → `$SIDEX_SSH_KNOWN_HOSTS` or `~/.ssh/known_hosts`.
    pub known_hosts: Option<PathBuf>,
    pub host_key_policy: HostKeyPolicy,
    pub keepalive_interval: Option<Duration>,
    pub keepalive_max: usize,
    /// Identity files tried (after the agent) for [`SshAuth::Agent`].
    pub identity_files: Vec<PathBuf>,
    /// Skip agent keys (`IdentitiesOnly yes`).
    pub identities_only: bool,
    /// Also try `~/.ssh/id_{ed25519,ecdsa,rsa}`.
    pub default_identities: bool,
}

impl Default for SshConnectOptions {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_secs(15),
            known_hosts: None,
            host_key_policy: HostKeyPolicy::AcceptNew,
            keepalive_interval: Some(Duration::from_secs(15)),
            keepalive_max: 3,
            identity_files: Vec::new(),
            identities_only: false,
            default_identities: true,
        }
    }
}

impl SshConnectOptions {
    fn known_hosts_path(&self) -> PathBuf {
        if let Some(p) = &self.known_hosts {
            return p.clone();
        }
        if let Ok(p) = std::env::var("SIDEX_SSH_KNOWN_HOSTS") {
            if !p.is_empty() {
                return PathBuf::from(p);
            }
        }
        home_dir().join(".ssh").join("known_hosts")
    }

    /// Apply `~/.ssh/config` derived settings.
    pub fn apply_config(&mut self, r: &ResolvedHost) {
        if let Some(t) = r.connect_timeout {
            self.connect_timeout = Duration::from_secs(t.max(1));
        }
        if let Some(k) = &r.user_known_hosts_file {
            self.known_hosts = Some(k.clone());
        }
        if r.strict_host_key_checking.is_some() {
            self.host_key_policy =
                HostKeyPolicy::from_ssh_option(r.strict_host_key_checking.as_deref());
        }
        if let Some(i) = r.server_alive_interval {
            self.keepalive_interval = (i > 0).then(|| Duration::from_secs(i));
        }
        if let Some(m) = r.server_alive_count_max {
            self.keepalive_max = usize::try_from(m).unwrap_or(3);
        }
        self.identity_files.clone_from(&r.identity_files);
        self.identities_only = r.identities_only;
    }
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map_or_else(|| PathBuf::from("."), PathBuf::from)
}

fn default_user() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "root".into())
}

// ---------------------------------------------------------------------------
// Client handler (host key verification)
// ---------------------------------------------------------------------------

pub struct ClientHandler {
    host: String,
    port: u16,
    known_hosts: PathBuf,
    policy: HostKeyPolicy,
    outcome: Arc<std::sync::Mutex<Option<HostKeyOutcome>>>,
}

#[async_trait::async_trait]
impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = format!("SHA256:{}", server_public_key.fingerprint());
        let checked = russh_keys::check_known_hosts_path(
            &self.host,
            self.port,
            server_public_key,
            &self.known_hosts,
        );
        let (ok, outcome) = match checked {
            Ok(true) => (true, HostKeyOutcome::Trusted { fingerprint }),
            Err(russh_keys::Error::KeyChanged { line }) => {
                (false, HostKeyOutcome::Changed { fingerprint, line })
            }
            Ok(false) | Err(_) => match self.policy {
                HostKeyPolicy::Strict => (false, HostKeyOutcome::Rejected { fingerprint }),
                HostKeyPolicy::AcceptAll => (true, HostKeyOutcome::Unchecked { fingerprint }),
                HostKeyPolicy::AcceptNew => {
                    if let Err(e) = russh_keys::known_hosts::learn_known_hosts_path(
                        &self.host,
                        self.port,
                        server_public_key,
                        &self.known_hosts,
                    ) {
                        log::warn!("could not record host key: {e}");
                    }
                    (true, HostKeyOutcome::Learned { fingerprint })
                }
            },
        };
        *self.outcome.lock().unwrap() = Some(outcome);
        Ok(ok)
    }
}

type Session = client::Handle<ClientHandler>;

/// Any bidirectional byte stream an SSH session can run over.
pub trait IoStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> IoStream for T {}

#[derive(Debug, Clone)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
    pub user: String,
}

impl std::fmt::Display for Endpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}@{}:{}", self.user, self.host, self.port)
    }
}

fn map_io_error(e: &std::io::Error, ep: &Endpoint) -> anyhow::Error {
    use std::io::ErrorKind as K;
    match e.kind() {
        K::ConnectionRefused => coded(
            errors::REFUSED,
            format!(
                "connection refused by {}:{} (is sshd running?)",
                ep.host, ep.port
            ),
        ),
        K::TimedOut => coded(
            errors::TIMEOUT,
            format!("connecting to {}:{} timed out", ep.host, ep.port),
        ),
        _ => coded(
            errors::UNREACHABLE,
            format!("cannot reach {}:{}: {e}", ep.host, ep.port),
        ),
    }
}

/// Establish + authenticate one SSH session (optionally over `via`).
async fn connect_session(
    ep: &Endpoint,
    auth: &SshAuth,
    opts: &SshConnectOptions,
    via: Option<Box<dyn IoStream>>,
) -> Result<(Session, HostKeyOutcome)> {
    let config = Arc::new(client::Config {
        keepalive_interval: opts.keepalive_interval,
        keepalive_max: opts.keepalive_max,
        inactivity_timeout: None,
        ..Default::default()
    });
    let outcome = Arc::new(std::sync::Mutex::new(None));
    let handler = ClientHandler {
        host: ep.host.clone(),
        port: ep.port,
        known_hosts: opts.known_hosts_path(),
        policy: opts.host_key_policy,
        outcome: Arc::clone(&outcome),
    };

    let deadline = opts.connect_timeout;
    let fut = async {
        let stream: Box<dyn IoStream> = match via {
            Some(s) => s,
            None => {
                let tcp = tokio::net::TcpStream::connect((ep.host.as_str(), ep.port))
                    .await
                    .map_err(|e| map_io_error(&e, ep))?;
                let _ = tcp.set_nodelay(true);
                Box::new(tcp)
            }
        };
        let mut session = client::connect_stream(config, stream, handler)
            .await
            .map_err(|e| handshake_error(&e, ep, &outcome, opts))?;
        authenticate(&mut session, ep, auth, opts).await?;
        Ok::<_, anyhow::Error>(session)
    };
    let session = match tokio::time::timeout(deadline, fut).await {
        Ok(r) => r?,
        Err(_) => {
            return Err(coded(
                errors::TIMEOUT,
                format!(
                    "connecting to {ep} timed out after {}s",
                    deadline.as_secs_f32()
                ),
            ))
        }
    };
    let o = outcome
        .lock()
        .unwrap()
        .clone()
        .unwrap_or(HostKeyOutcome::Unchecked {
            fingerprint: String::new(),
        });
    Ok((session, o))
}

fn handshake_error(
    e: &russh::Error,
    ep: &Endpoint,
    outcome: &std::sync::Mutex<Option<HostKeyOutcome>>,
    opts: &SshConnectOptions,
) -> anyhow::Error {
    let kh = opts.known_hosts_path();
    match outcome.lock().unwrap().clone() {
        Some(HostKeyOutcome::Changed { fingerprint, line }) => coded(
            errors::HOSTKEY_CHANGED,
            format!(
                "REMOTE HOST IDENTIFICATION HAS CHANGED for {}:{} (now {fingerprint}). \
                 Offending key in {}:{line}. Remove it if the change is expected.",
                ep.host,
                ep.port,
                kh.display()
            ),
        ),
        Some(HostKeyOutcome::Rejected { fingerprint }) => coded(
            errors::HOSTKEY_UNKNOWN,
            format!(
                "host key for {}:{} ({fingerprint}) is not in {} and StrictHostKeyChecking is on",
                ep.host,
                ep.port,
                kh.display()
            ),
        ),
        _ => match e {
            russh::Error::IO(io) => map_io_error(io, ep),
            other => coded(
                errors::CONNECTION_LOST,
                format!("SSH handshake with {}:{} failed: {other}", ep.host, ep.port),
            ),
        },
    }
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

async fn authenticate(
    session: &mut Session,
    ep: &Endpoint,
    auth: &SshAuth,
    opts: &SshConnectOptions,
) -> Result<()> {
    let user = ep.user.as_str();
    let ok = match auth {
        SshAuth::Password(pw) => auth_password(session, user, pw).await?,
        SshAuth::KeyFile { path, passphrase } => {
            let path = expand_home(path);
            let kp = load_key(&path, passphrase.as_deref())?;
            session
                .authenticate_publickey(user, Arc::new(kp))
                .await
                .context("publickey auth")?
        }
        SshAuth::Agent => auth_auto(session, user, opts).await?,
        SshAuth::KeyboardInteractive => {
            return Err(coded(
                errors::UNSUPPORTED,
                "keyboard-interactive prompts other than a password (OTP/2FA) are not supported; use password auth",
            ))
        }
    };
    if ok {
        Ok(())
    } else {
        Err(coded(
            errors::AUTH_FAILED,
            format!("permission denied for {ep} ({})", auth_label(auth)),
        ))
    }
}

fn auth_label(a: &SshAuth) -> &'static str {
    match a {
        SshAuth::Password(_) => "password/keyboard-interactive",
        SshAuth::KeyFile { .. } => "publickey",
        SshAuth::Agent => "agent + default keys",
        SshAuth::KeyboardInteractive => "keyboard-interactive",
    }
}

fn expand_home(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix("~/") {
        home_dir().join(rest)
    } else {
        p.to_path_buf()
    }
}

fn load_key(path: &Path, passphrase: Option<&str>) -> Result<key::KeyPair> {
    match russh_keys::load_secret_key(path, passphrase) {
        Ok(k) => Ok(k),
        Err(russh_keys::Error::KeyIsEncrypted) => Err(coded(
            errors::KEY_ENCRYPTED,
            format!(
                "key {} is encrypted; a passphrase is required",
                path.display()
            ),
        )),
        Err(e) if passphrase.is_some() => Err(coded(
            errors::KEY_PASSPHRASE,
            format!(
                "cannot decrypt key {} (wrong passphrase?): {e}",
                path.display()
            ),
        )),
        Err(e) => Err(anyhow::anyhow!("loading key {}: {e}", path.display())),
    }
}

async fn auth_password(session: &mut Session, user: &str, pw: &str) -> Result<bool> {
    // Prefer keyboard-interactive first: after a failed `authenticate_password`,
    // russh 0.46 can hang on the subsequent INFO_REQUEST against OpenSSH 9+/10
    // with PasswordAuthentication=no. Trying kbd first avoids that, and empty
    // follow-up prompts (PAM) are answered too.
    match tokio::time::timeout(
        Duration::from_secs(4),
        session.authenticate_keyboard_interactive_start(user, None),
    )
    .await
    {
        Ok(Ok(mut resp)) => {
            for _ in 0..8 {
                match resp {
                    client::KeyboardInteractiveAuthResponse::Success => return Ok(true),
                    client::KeyboardInteractiveAuthResponse::Failure => break,
                    client::KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                        let answers = prompts.iter().map(|_| pw.to_string()).collect::<Vec<_>>();
                        resp = match tokio::time::timeout(
                            Duration::from_secs(4),
                            session.authenticate_keyboard_interactive_respond(answers),
                        )
                        .await
                        {
                            Ok(Ok(r)) => r,
                            Ok(Err(_)) | Err(_) => break,
                        };
                    }
                }
            }
        }
        Ok(Err(_)) | Err(_) => {}
    }
    Ok(session
        .authenticate_password(user, pw)
        .await
        .context("password auth")?)
}

/// ssh-agent identities, then configured identity files, then defaults.
async fn auth_auto(session: &mut Session, user: &str, opts: &SshConnectOptions) -> Result<bool> {
    #[cfg(unix)]
    if !opts.identities_only && std::env::var_os("SSH_AUTH_SOCK").is_some() {
        if let Ok(mut agent) = russh_keys::agent::client::AgentClient::connect_env().await {
            let ids = agent.request_identities().await.unwrap_or_default();
            for id in ids {
                let (a, res) = session.authenticate_future(user, id, agent).await;
                agent = a;
                if matches!(res, Ok(true)) {
                    return Ok(true);
                }
            }
        }
    }

    let mut candidates: Vec<PathBuf> = opts.identity_files.iter().map(|p| expand_home(p)).collect();
    if opts.default_identities {
        let ssh = home_dir().join(".ssh");
        for n in ["id_ed25519", "id_ecdsa", "id_rsa"] {
            let p = ssh.join(n);
            if !candidates.contains(&p) {
                candidates.push(p);
            }
        }
    }
    let mut encrypted: Option<PathBuf> = None;
    for path in candidates.iter().filter(|p| p.exists()) {
        match load_key(path, None) {
            Ok(kp) => {
                if session
                    .authenticate_publickey(user, Arc::new(kp))
                    .await
                    .unwrap_or(false)
                {
                    return Ok(true);
                }
            }
            Err(e) if errors::code_of(&e.to_string()) == Some(errors::KEY_ENCRYPTED) => {
                encrypted.get_or_insert_with(|| path.clone());
            }
            Err(e) => log::debug!("skipping identity {}: {e}", path.display()),
        }
    }
    if let Some(p) = encrypted {
        // Let the UI prompt for this key's passphrase.
        return Err(coded(
            errors::KEY_ENCRYPTED,
            format!("key {} is encrypted; a passphrase is required", p.display()),
        ));
    }
    Ok(false)
}

// ---------------------------------------------------------------------------
// SshTransport
// ---------------------------------------------------------------------------

/// Raw command result with byte-exact output.
#[derive(Debug, Clone)]
pub struct RawExec {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
    pub signal: Option<String>,
}

/// SSH implementation of [`RemoteTransport`].
pub struct SshTransport {
    session: Arc<Session>,
    /// Sessions for each ProxyJump hop (kept alive for the tunnel).
    jumps: Vec<Arc<Session>>,
    proxy_child: std::sync::Mutex<Option<tokio::process::Child>>,
    host: String,
    port: u16,
    user: String,
    env_vars: Mutex<HashMap<String, String>>,
    forwards: std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>,
    pub host_key: HostKeyOutcome,
}

impl SshTransport {
    pub async fn connect(host: &str, port: u16, auth: SshAuth) -> Result<Self> {
        Self::connect_as(&default_user(), host, port, auth, None).await
    }

    pub async fn connect_as(
        user: &str,
        host: &str,
        port: u16,
        auth: SshAuth,
        keepalive_secs: Option<u64>,
    ) -> Result<Self> {
        let mut opts = SshConnectOptions::default();
        if let Some(k) = keepalive_secs {
            opts.keepalive_interval = (k > 0).then(|| Duration::from_secs(k));
        }
        let ep = Endpoint {
            host: host.into(),
            port,
            user: user.into(),
        };
        Self::connect_endpoint(&ep, &auth, &opts).await
    }

    /// Direct TCP connection.
    pub async fn connect_endpoint(
        ep: &Endpoint,
        auth: &SshAuth,
        opts: &SshConnectOptions,
    ) -> Result<Self> {
        let (s, hk) = connect_session(ep, auth, opts, None).await?;
        Ok(Self::from_parts(ep, s, Vec::new(), None, hk))
    }

    /// Connect through a chain of jump hosts (`ProxyJump a,b`).
    pub async fn connect_chain(
        hops: &[(Endpoint, SshAuth, SshConnectOptions)],
        target: &Endpoint,
        auth: &SshAuth,
        opts: &SshConnectOptions,
    ) -> Result<Self> {
        let mut sessions: Vec<Arc<Session>> = Vec::new();
        let mut all: Vec<(&Endpoint, &SshAuth, &SshConnectOptions)> =
            hops.iter().map(|(e, a, o)| (e, a, o)).collect();
        all.push((target, auth, opts));
        let mut last_hk = None;
        for (i, (ep, a, o)) in all.iter().enumerate() {
            let via: Option<Box<dyn IoStream>> = match sessions.last() {
                None => None,
                Some(prev) => {
                    let ch = prev
                        .channel_open_direct_tcpip(
                            ep.host.clone(),
                            u32::from(ep.port),
                            "127.0.0.1",
                            0,
                        )
                        .await
                        .map_err(|e| {
                            coded(
                                errors::PROXY_FAILED,
                                format!(
                                    "jump host {} could not open a tunnel to {}:{}: {e}",
                                    all[i - 1].0,
                                    ep.host,
                                    ep.port
                                ),
                            )
                        })?;
                    Some(Box::new(ch.into_stream()))
                }
            };
            let (s, hk) = connect_session(ep, a, o, via).await.map_err(|e| {
                if i + 1 < all.len() {
                    anyhow::anyhow!("{e} (while connecting to jump host {ep})")
                } else {
                    e
                }
            })?;
            last_hk = Some(hk);
            sessions.push(Arc::new(s));
        }
        let session = sessions.pop().expect("target session");
        let mut t = Self::from_parts(
            target,
            Arc::try_unwrap(session).ok().expect("unique"),
            sessions,
            None,
            last_hk.unwrap(),
        );
        t.host = target.host.clone();
        Ok(t)
    }

    /// Connect over the stdio of a `ProxyCommand`.
    pub async fn connect_proxy_command(
        command: &str,
        target: &Endpoint,
        auth: &SshAuth,
        opts: &SshConnectOptions,
    ) -> Result<Self> {
        let mut cmd = if cfg!(windows) {
            let mut c = tokio::process::Command::new("cmd");
            c.arg("/C").arg(command);
            c
        } else {
            let mut c = tokio::process::Command::new("sh");
            c.arg("-c").arg(command);
            c
        };
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| {
            coded(
                errors::PROXY_FAILED,
                format!("cannot start ProxyCommand `{command}`: {e}"),
            )
        })?;
        let stdin = child.stdin.take().context("proxy stdin")?;
        let stdout = child.stdout.take().context("proxy stdout")?;
        let mut stderr = child.stderr.take().context("proxy stderr")?;
        let stream = tokio::io::join(stdout, stdin);
        match connect_session(target, auth, opts, Some(Box::new(stream))).await {
            Ok((s, hk)) => Ok(Self::from_parts(target, s, Vec::new(), Some(child), hk)),
            Err(e) => {
                let _ = child.start_kill();
                let mut buf = Vec::new();
                let _ =
                    tokio::time::timeout(Duration::from_millis(500), stderr.read_to_end(&mut buf))
                        .await;
                let msg = String::from_utf8_lossy(&buf).trim().to_string();
                if msg.is_empty() {
                    Err(e)
                } else {
                    Err(coded(
                        errors::PROXY_FAILED,
                        format!("ProxyCommand `{command}` failed: {msg} ({e})"),
                    ))
                }
            }
        }
    }

    /// Resolve `dest` (alias, `user@host:port`, `ssh://…`) through
    /// `~/.ssh/config` and connect with ProxyJump / ProxyCommand honoured.
    pub async fn connect_destination(
        dest: &str,
        user_override: Option<&str>,
        port_override: Option<u16>,
        auth: SshAuth,
        base_opts: SshConnectOptions,
        config: &SshConfig,
    ) -> Result<Self> {
        let d = Destination::parse(dest).map_err(|e| anyhow::anyhow!("{e}"))?;
        let r = config.resolve(&d.host);
        let mut opts = base_opts.clone();
        opts.apply_config(&r);
        let target = Endpoint {
            host: r.hostname.clone(),
            port: port_override.or(d.port).unwrap_or(r.port),
            user: user_override
                .map(str::to_string)
                .or(d.user.clone())
                .or(r.user.clone())
                .unwrap_or_else(default_user),
        };
        let mut t = if let Some(pc) = r
            .proxy_command
            .as_deref()
            .filter(|p| !p.eq_ignore_ascii_case("none"))
        {
            let pc = crate::ssh_config::expand_tokens(
                pc,
                &target.host,
                &d.host,
                target.port,
                Some(&target.user),
                &home_dir(),
            );
            Self::connect_proxy_command(&pc, &target, &auth, &opts).await?
        } else if r
            .proxy_jump
            .as_deref()
            .is_some_and(|p| !p.eq_ignore_ascii_case("none"))
        {
            let jumps = resolve_proxy_jumps(r.proxy_jump.as_deref().unwrap_or_default(), config)
                .map_err(|e| coded(errors::PROXY_FAILED, e))?;
            let mut hops = Vec::new();
            for j in jumps {
                let mut o = base_opts.clone();
                o.apply_config(&j.config);
                hops.push((
                    Endpoint {
                        host: j.config.hostname.clone(),
                        port: j.dest.port.unwrap_or(j.config.port),
                        user: j
                            .dest
                            .user
                            .clone()
                            .or(j.config.user.clone())
                            .unwrap_or_else(default_user),
                    },
                    SshAuth::Agent,
                    o,
                ));
            }
            Self::connect_chain(&hops, &target, &auth, &opts).await?
        } else {
            Self::connect_endpoint(&target, &auth, &opts).await?
        };
        for (k, v) in &r.set_env {
            t.env_vars.get_mut().insert(k.clone(), v.clone());
        }
        Ok(t)
    }

    fn from_parts(
        ep: &Endpoint,
        session: Session,
        jumps: Vec<Arc<Session>>,
        child: Option<tokio::process::Child>,
        host_key: HostKeyOutcome,
    ) -> Self {
        Self {
            session: Arc::new(session),
            jumps,
            proxy_child: std::sync::Mutex::new(child),
            host: ep.host.clone(),
            port: ep.port,
            user: ep.user.clone(),
            env_vars: Mutex::new(HashMap::new()),
            forwards: std::sync::Mutex::new(Vec::new()),
            host_key,
        }
    }

    pub fn endpoint(&self) -> Endpoint {
        Endpoint {
            host: self.host.clone(),
            port: self.port,
            user: self.user.clone(),
        }
    }

    pub fn jump_count(&self) -> usize {
        self.jumps.len()
    }

    pub async fn set_env(&self, key: &str, value: &str) {
        self.env_vars
            .lock()
            .await
            .insert(key.to_string(), value.to_string());
    }

    fn lost(&self) -> anyhow::Error {
        coded(
            errors::CONNECTION_LOST,
            format!(
                "connection to {}@{}:{} was lost",
                self.user, self.host, self.port
            ),
        )
    }

    /// Local forward `127.0.0.1:local_port` → `remote_host:remote_port`.
    /// `local_port == 0` picks a free port; the bound port is returned.
    pub async fn forward_port(
        &self,
        local_port: u16,
        remote_host: &str,
        remote_port: u16,
    ) -> Result<u16> {
        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], local_port)))
            .await
            .with_context(|| format!("binding local port {local_port}"))?;
        let bound = listener.local_addr()?.port();
        let session = Arc::clone(&self.session);
        let rh = remote_host.to_string();
        let task = tokio::spawn(async move {
            while let Ok((mut local, peer)) = listener.accept().await {
                let session = Arc::clone(&session);
                let rh = rh.clone();
                tokio::spawn(async move {
                    match session
                        .channel_open_direct_tcpip(
                            rh,
                            u32::from(remote_port),
                            peer.ip().to_string(),
                            u32::from(peer.port()),
                        )
                        .await
                    {
                        Ok(ch) => {
                            let mut remote = ch.into_stream();
                            let _ = tokio::io::copy_bidirectional(&mut local, &mut remote).await;
                        }
                        Err(e) => log::warn!("port-forward channel open failed: {e}"),
                    }
                });
            }
        });
        self.forwards.lock().unwrap().push(task);
        Ok(bound)
    }

    /// Remote → local forwarding needs a `tcpip-forward` global request
    /// handler; not implemented.
    #[allow(clippy::unused_async)]
    pub async fn reverse_forward_port(
        &self,
        _remote_port: u16,
        _local_host: &str,
        _local_port: u16,
    ) -> Result<()> {
        Err(coded(
            errors::UNSUPPORTED,
            "remote (reverse) port forwarding is not supported yet",
        ))
    }

    async fn env_prefix(&self) -> String {
        let env = self.env_vars.lock().await;
        let mut keys: Vec<_> = env.keys().collect();
        keys.sort();
        keys.iter()
            .filter(|k| k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
            .map(|k| format!("export {k}={}; ", sh_quote(&env[*k])))
            .collect()
    }

    /// Run a POSIX script (wrapped in `sh -c`) with optional stdin bytes.
    pub async fn exec_raw(&self, script: &str, stdin: Option<&[u8]>) -> Result<RawExec> {
        if self.session.is_closed() {
            return Err(self.lost());
        }
        let full = wrap_posix(&format!("{}{script}", self.env_prefix().await));
        let mut ch = self.session.channel_open_session().await.map_err(|e| {
            if self.session.is_closed() {
                self.lost()
            } else {
                anyhow::anyhow!("opening SSH channel: {e}")
            }
        })?;
        ch.exec(true, full).await.map_err(|_| self.lost())?;
        if let Some(data) = stdin {
            ch.data(data).await.map_err(|_| self.lost())?;
        }
        let _ = ch.eof().await;

        let mut out = RawExec {
            stdout: Vec::new(),
            stderr: Vec::new(),
            exit_code: -1,
            signal: None,
        };
        let mut done = false;
        while let Some(msg) = ch.wait().await {
            match msg {
                ChannelMsg::Data { data } => out.stdout.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, ext } if ext == 1 => {
                    out.stderr.extend_from_slice(&data)
                }
                ChannelMsg::ExitStatus { exit_status } => {
                    out.exit_code = i32::try_from(exit_status).unwrap_or(-1);
                    done = true;
                }
                ChannelMsg::ExitSignal { signal_name, .. } => {
                    out.signal = Some(format!("{signal_name:?}"));
                    out.exit_code = 128 + signal_number(&format!("{signal_name:?}"));
                    done = true;
                }
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        if !done {
            return Err(self.lost());
        }
        Ok(out)
    }

    /// Run a SideX FS script and turn its marker / exit code into a coded error.
    async fn fs_script(
        &self,
        script: &str,
        stdin: Option<&[u8]>,
        what: &str,
        path: &str,
    ) -> Result<Vec<u8>> {
        let r = self.exec_raw(script, stdin).await?;
        if r.exit_code == 0 {
            return Ok(r.stdout);
        }
        let err = String::from_utf8_lossy(&r.stderr).to_string();
        let code = if err.contains(MARK_ENOENT) || err.contains("No such file") {
            errors::ENOENT
        } else if err.contains(MARK_EACCES) || err.contains("Permission denied") {
            errors::EACCES
        } else if err.contains(MARK_EEXIST) || err.contains("File exists") {
            errors::EEXIST
        } else if err.contains(MARK_ENOTDIR) || err.contains("Not a directory") {
            errors::ENOTDIR
        } else if err.contains(MARK_EISDIR) || err.contains("Is a directory") {
            errors::EISDIR
        } else {
            return Err(anyhow::anyhow!(
                "{what} {path} failed (exit {}): {}",
                r.exit_code,
                err.trim()
            ));
        };
        let detail: String = err
            .lines()
            .filter(|l| !l.contains("__SIDEX_"))
            .collect::<Vec<_>>()
            .join(" ");
        Err(coded(
            code,
            format!(
                "{what} {path}{}",
                if detail.trim().is_empty() {
                    String::new()
                } else {
                    format!(": {}", detail.trim())
                }
            ),
        ))
    }
}

fn signal_number(name: &str) -> i32 {
    match name.to_ascii_uppercase().as_str() {
        s if s.contains("HUP") => 1,
        s if s.contains("INT") => 2,
        s if s.contains("QUIT") => 3,
        s if s.contains("KILL") => 9,
        s if s.contains("SEGV") => 11,
        s if s.contains("PIPE") => 13,
        s if s.contains("TERM") => 15,
        _ => 0,
    }
}

impl Drop for SshTransport {
    fn drop(&mut self) {
        for t in self.forwards.lock().unwrap().drain(..) {
            t.abort();
        }
    }
}

fn parent_check(q: &str) -> String {
    format!(
        "D=$(dirname -- {q}); if [ -d \"$D\" ] && [ ! -x \"$D\" ]; then echo {MARK_EACCES} >&2; exit 13; fi; "
    )
}

#[async_trait::async_trait]
impl RemoteTransport for SshTransport {
    async fn exec(&self, command: &str) -> Result<ExecOutput> {
        let r = self.exec_raw(command, None).await?;
        Ok(ExecOutput {
            stdout: String::from_utf8_lossy(&r.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&r.stderr).into_owned(),
            exit_code: r.exit_code,
        })
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>> {
        let q = sh_quote(path);
        let script = format!(
            "{}{}if [ -d {q} ]; then echo {MARK_EISDIR} >&2; exit 21; fi; \
             if [ ! -r {q} ]; then echo {MARK_EACCES} >&2; exit 13; fi; exec cat -- {q}",
            parent_check(&q),
            check_exists_script(&q)
        );
        self.fs_script(&script, None, "read", path).await
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> Result<()> {
        let q = sh_quote(path);
        let script = format!(
            "D=$(dirname -- {q}); if [ ! -d \"$D\" ]; then echo {MARK_ENOENT} >&2; exit 2; fi; \
             if [ -d {q} ]; then echo {MARK_EISDIR} >&2; exit 21; fi; \
             if [ -e {q} ] && [ ! -w {q} ]; then echo {MARK_EACCES} >&2; exit 13; fi; \
             if [ ! -e {q} ] && [ ! -w \"$D\" ]; then echo {MARK_EACCES} >&2; exit 13; fi; \
             cat > {q}"
        );
        self.fs_script(&script, Some(data), "write", path)
            .await
            .map(|_| ())
    }

    async fn read_dir(&self, path: &str) -> Result<Vec<DirEntry>> {
        let q = sh_quote(path);
        // Records: type \t target-type \t size \t mtime \t name \0
        let script = format!(
            "{}{}if [ ! -d {q} ]; then echo {MARK_ENOTDIR} >&2; exit 20; fi; \
             if [ ! -r {q} ] || [ ! -x {q} ]; then echo {MARK_EACCES} >&2; exit 13; fi; \
             if find {q} -maxdepth 0 -printf '' >/dev/null 2>&1; then \
               find {q} -mindepth 1 -maxdepth 1 -printf '%y\\t%Y\\t%s\\t%T@\\t%f\\0'; \
             else cd {q} || exit 13; for f in * .[!.]* ..?*; do \
               if [ -e \"$f\" ] || [ -L \"$f\" ]; then \
                 if [ -L \"$f\" ]; then y=l; else y=x; fi; \
                 if [ -d \"$f\" ]; then Y=d; elif [ -e \"$f\" ]; then Y=f; else Y=N; fi; \
                 [ \"$y\" = x ] && y=$Y; \
                 printf '%s\\t%s\\t0\\t0\\t%s\\0' \"$y\" \"$Y\" \"$f\"; fi; done; fi",
            parent_check(&q),
            check_exists_script(&q)
        );
        let raw = self.fs_script(&script, None, "readdir", path).await?;
        let base = path.trim_end_matches('/');
        let mut entries = Vec::new();
        for rec in raw.split(|b| *b == 0).filter(|r| !r.is_empty()) {
            let rec = String::from_utf8_lossy(rec);
            let mut it = rec.splitn(5, '\t');
            let (Some(y), Some(t), Some(size), Some(mtime), Some(name)) =
                (it.next(), it.next(), it.next(), it.next(), it.next())
            else {
                continue;
            };
            let modified = mtime
                .split('.')
                .next()
                .and_then(|s| s.parse::<u64>().ok())
                .filter(|s| *s > 0)
                .map(|s| SystemTime::UNIX_EPOCH + Duration::from_secs(s));
            entries.push(DirEntry {
                name: name.to_string(),
                path: format!("{base}/{name}"),
                is_dir: t == "d",
                is_symlink: y == "l",
                size: size.parse().unwrap_or(0),
                modified,
            });
        }
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(entries)
    }

    async fn stat(&self, path: &str) -> Result<FileStat> {
        let q = sh_quote(path);
        let script = format!(
            "{}{}if [ -L {q} ]; then L=1; else L=0; fi; \
             if [ ! -e {q} ]; then printf '0|0|broken|%s' \"$L\"; exit 0; fi; \
             S=$(stat -L -c '%s|%Y|%F' -- {q} 2>/dev/null || stat -L -f '%z|%m|%HT' {q}) || exit 1; \
             printf '%s|%s' \"$S\" \"$L\"",
            parent_check(&q),
            check_exists_script(&q)
        );
        let raw = self.fs_script(&script, None, "stat", path).await?;
        let s = String::from_utf8_lossy(&raw).replace('\n', "");
        let parts: Vec<&str> = s.split('|').collect();
        if parts.len() < 4 {
            anyhow::bail!("unexpected stat output for {path}: {s:?}");
        }
        let mtime: u64 = parts[1].trim().parse().unwrap_or(0);
        Ok(FileStat {
            size: parts[0].trim().parse().unwrap_or(0),
            modified: (mtime > 0).then(|| SystemTime::UNIX_EPOCH + Duration::from_secs(mtime)),
            is_dir: parts[2].to_ascii_lowercase().contains("directory"),
            is_symlink: parts[3].trim() == "1",
        })
    }

    async fn open_pty(&self, cols: u16, rows: u16) -> Result<RemotePty> {
        if self.session.is_closed() {
            return Err(self.lost());
        }
        let mut ch = self.session.channel_open_session().await?;
        ch.request_pty(
            true,
            "xterm-256color",
            u32::from(cols),
            u32::from(rows),
            0,
            0,
            &[],
        )
        .await?;
        ch.request_shell(true).await?;

        let (client_side, task_side) = tokio::io::duplex(64 * 1024);
        let (mut task_read, mut task_write) = tokio::io::split(task_side);
        let (client_read, client_write) = tokio::io::split(client_side);
        let (resize_tx, mut resize_rx) = tokio::sync::mpsc::channel::<(u16, u16)>(8);

        let mut writer = ch.make_writer();
        tokio::spawn(async move {
            let _ = tokio::io::copy(&mut task_read, &mut writer).await;
            let _ = writer.shutdown().await;
        });
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    msg = ch.wait() => match msg {
                        Some(ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. }) => {
                            if task_write.write_all(&data).await.is_err() { break; }
                        }
                        Some(ChannelMsg::Close) | None => break,
                        _ => {}
                    },
                    r = resize_rx.recv() => match r {
                        Some((c, r)) => { let _ = ch.window_change(u32::from(c), u32::from(r), 0, 0).await; }
                        None => {}
                    },
                }
            }
            let _ = task_write.shutdown().await;
        });

        Ok(RemotePty::new(
            Box::new(client_write),
            Box::new(client_read),
            resize_tx,
        ))
    }

    async fn upload(&self, local: &Path, remote: &str) -> Result<()> {
        let data = tokio::fs::read(local)
            .await
            .with_context(|| format!("reading local file {}", local.display()))?;
        self.write_file(remote, &data).await
    }

    async fn download(&self, remote: &str, local: &Path) -> Result<()> {
        let data = self.read_file(remote).await?;
        tokio::fs::write(local, &data)
            .await
            .with_context(|| format!("writing local file {}", local.display()))
    }

    async fn home(&self) -> Result<String> {
        let r = self.exec_raw("printf '%s' \"$HOME\"", None).await?;
        Ok(String::from_utf8_lossy(&r.stdout).trim().to_string())
    }

    async fn mkdir(&self, path: &str) -> Result<()> {
        let q = sh_quote(path);
        let script = format!(
            "if [ -e {q} ]; then echo {MARK_EEXIST} >&2; exit 17; fi; \
             D=$(dirname -- {q}); if [ ! -d \"$D\" ]; then echo {MARK_ENOENT} >&2; exit 2; fi; \
             if [ ! -w \"$D\" ]; then echo {MARK_EACCES} >&2; exit 13; fi; mkdir -- {q}"
        );
        self.fs_script(&script, None, "mkdir", path)
            .await
            .map(|_| ())
    }

    async fn remove(&self, path: &str, recursive: bool) -> Result<()> {
        let q = sh_quote(path);
        let rm = if recursive {
            format!("rm -rf -- {q}")
        } else {
            format!("if [ -d {q} ] && [ ! -L {q} ]; then rmdir -- {q}; else rm -f -- {q}; fi")
        };
        let script = format!(
            "{}D=$(dirname -- {q}); if [ ! -w \"$D\" ]; then echo {MARK_EACCES} >&2; exit 13; fi; {rm}",
            check_exists_script(&q)
        );
        self.fs_script(&script, None, "delete", path)
            .await
            .map(|_| ())
    }

    async fn rename(&self, from: &str, to: &str, overwrite: bool) -> Result<()> {
        let (a, b) = (sh_quote(from), sh_quote(to));
        let guard = if overwrite {
            format!("if [ -d {b} ] && [ ! -L {b} ]; then rm -rf -- {b}; fi; ")
        } else {
            format!("if [ -e {b} ] || [ -L {b} ]; then echo {MARK_EEXIST} >&2; exit 17; fi; ")
        };
        let script = format!(
            "{}{guard}D=$(dirname -- {b}); if [ ! -d \"$D\" ]; then echo {MARK_ENOENT} >&2; exit 2; fi; mv -f -- {a} {b}",
            check_exists_script(&a)
        );
        self.fs_script(&script, None, "rename", from)
            .await
            .map(|_| ())
    }

    fn is_alive(&self) -> bool {
        !self.session.is_closed() && self.jumps.iter().all(|j| !j.is_closed())
    }

    async fn disconnect(&self) -> Result<()> {
        for t in self.forwards.lock().unwrap().drain(..) {
            t.abort();
        }
        let _ = self
            .session
            .disconnect(russh::Disconnect::ByApplication, "bye", "en")
            .await;
        for j in self.jumps.iter().rev() {
            let _ = j
                .disconnect(russh::Disconnect::ByApplication, "bye", "en")
                .await;
        }
        if let Some(mut c) = self.proxy_child.lock().unwrap().take() {
            let _ = c.start_kill();
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// High level connection wrapper (kept for API compatibility)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting { attempt: u32 },
}

pub struct SshConnection {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
    pub state: ConnectionState,
    pub options: SshConnectOptions,
    pub home_dir: Option<String>,
    pub remote_platform: Option<crate::platform::RemotePlatformInfo>,
    transport: Option<SshTransport>,
}

impl SshConnection {
    pub fn new(host: &str, port: u16, username: &str, auth: SshAuth) -> Self {
        Self {
            host: host.into(),
            port,
            username: username.into(),
            auth,
            state: ConnectionState::Disconnected,
            options: SshConnectOptions::default(),
            home_dir: None,
            remote_platform: None,
            transport: None,
        }
    }

    pub async fn connect(&mut self) -> Result<()> {
        self.state = ConnectionState::Connecting;
        let ep = Endpoint {
            host: self.host.clone(),
            port: self.port,
            user: self.username.clone(),
        };
        match SshTransport::connect_endpoint(&ep, &self.auth, &self.options).await {
            Ok(t) => {
                self.home_dir = t.home().await.ok();
                self.remote_platform = detect_platform(&t, None).await.ok();
                self.transport = Some(t);
                self.state = ConnectionState::Connected;
                Ok(())
            }
            Err(e) => {
                self.state = ConnectionState::Disconnected;
                Err(e)
            }
        }
    }

    /// Retry with exponential backoff. Auth / host key errors are not retried.
    pub async fn reconnect_with_backoff(&mut self, max_attempts: u32) -> Result<()> {
        let mut last = None;
        for attempt in 1..=max_attempts {
            self.state = ConnectionState::Reconnecting { attempt };
            match self.connect().await {
                Ok(()) => return Ok(()),
                Err(e) => {
                    let code = errors::code_of(&e.to_string()).map(str::to_string);
                    if matches!(
                        code.as_deref(),
                        Some(
                            errors::AUTH_FAILED
                                | errors::HOSTKEY_CHANGED
                                | errors::HOSTKEY_UNKNOWN
                                | errors::KEY_ENCRYPTED
                        )
                    ) {
                        return Err(e);
                    }
                    last = Some(e);
                }
            }
            tokio::time::sleep(Duration::from_millis(250 * 2u64.pow(attempt.min(5)))).await;
        }
        Err(last.unwrap_or_else(|| anyhow::anyhow!("reconnection exhausted")))
    }

    pub async fn exec_command(&self, cmd: &str) -> Result<ExecOutput> {
        self.transport
            .as_ref()
            .context("not connected")?
            .exec(cmd)
            .await
    }

    pub async fn disconnect(&mut self) -> Result<()> {
        if let Some(t) = self.transport.take() {
            t.disconnect().await?;
        }
        self.state = ConnectionState::Disconnected;
        Ok(())
    }

    pub fn transport(&self) -> Option<&SshTransport> {
        self.transport.as_ref()
    }
}

/// Detect remote OS / arch the way open-remote-ssh does.
pub async fn detect_platform(
    t: &SshTransport,
    override_platform: Option<&str>,
) -> Result<crate::platform::RemotePlatformInfo> {
    crate::platform::detect_platform(
        |cmd: &'static str| async move {
            // Use the login shell here on purpose: Windows OpenSSH has no `sh`.
            let mut ch = t.session.channel_open_session().await?;
            ch.exec(true, cmd).await?;
            let _ = ch.eof().await;
            let (mut out, mut err) = (Vec::new(), Vec::new());
            while let Some(m) = ch.wait().await {
                match m {
                    ChannelMsg::Data { data } => out.extend_from_slice(&data),
                    ChannelMsg::ExtendedData { data, .. } => err.extend_from_slice(&data),
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
            Ok::<_, anyhow::Error>((
                String::from_utf8_lossy(&out).into_owned(),
                String::from_utf8_lossy(&err).into_owned(),
            ))
        },
        override_platform,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_key_policy_from_option() {
        assert_eq!(
            HostKeyPolicy::from_ssh_option(Some("yes")),
            HostKeyPolicy::Strict
        );
        assert_eq!(
            HostKeyPolicy::from_ssh_option(Some("No")),
            HostKeyPolicy::AcceptAll
        );
        assert_eq!(
            HostKeyPolicy::from_ssh_option(Some("accept-new")),
            HostKeyPolicy::AcceptNew
        );
        assert_eq!(
            HostKeyPolicy::from_ssh_option(None),
            HostKeyPolicy::AcceptNew
        );
    }

    #[test]
    fn signal_numbers() {
        assert_eq!(signal_number("KILL"), 9);
        assert_eq!(signal_number("TERM"), 15);
        assert_eq!(signal_number("Custom(\"USR1\")"), 0);
    }

    #[test]
    fn options_apply_config() {
        let cfg = SshConfig::parse_str(
            "Host a\n  ConnectTimeout 3\n  StrictHostKeyChecking yes\n  ServerAliveInterval 0\n  IdentityFile /k\n  IdentitiesOnly yes\n",
            Path::new("/"),
            Path::new("/home/u"),
        )
        .unwrap();
        let mut o = SshConnectOptions::default();
        o.apply_config(&cfg.resolve("a"));
        assert_eq!(o.connect_timeout, Duration::from_secs(3));
        assert_eq!(o.host_key_policy, HostKeyPolicy::Strict);
        assert_eq!(o.keepalive_interval, None);
        assert_eq!(o.identity_files, vec![PathBuf::from("/k")]);
        assert!(o.identities_only);
    }

    #[tokio::test]
    async fn refused_is_coded() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        let err =
            SshTransport::connect_as("u", "127.0.0.1", port, SshAuth::Password("x".into()), None)
                .await
                .err()
                .unwrap()
                .to_string();
        assert_eq!(errors::code_of(&err), Some(errors::REFUSED), "{err}");
    }

    #[tokio::test]
    async fn silent_server_times_out() {
        // Accepts TCP but never speaks SSH → must hit the connect timeout.
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _keep = l.accept().await;
            tokio::time::sleep(Duration::from_secs(30)).await;
        });
        let opts = SshConnectOptions {
            connect_timeout: Duration::from_millis(700),
            ..Default::default()
        };
        let ep = Endpoint {
            host: "127.0.0.1".into(),
            port,
            user: "u".into(),
        };
        let t0 = std::time::Instant::now();
        let err = SshTransport::connect_endpoint(&ep, &SshAuth::Password("x".into()), &opts)
            .await
            .err()
            .unwrap()
            .to_string();
        assert_eq!(errors::code_of(&err), Some(errors::TIMEOUT), "{err}");
        assert!(t0.elapsed() < Duration::from_secs(3));
    }
}
