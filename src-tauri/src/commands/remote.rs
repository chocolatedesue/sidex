//! Tauri commands that expose the `sidex-remote` crate to the frontend.
//!
//! The [`RemoteManager`] lives behind a `tokio::Mutex`, but the lock is only
//! held for map lookups: connects and FS calls run on a cloned
//! `Arc<dyn RemoteTransport>` so several hosts can connect / work in
//! parallel and a slow host never blocks the others.
//!
//! Errors keep the `[SIDEX_<CODE>]` prefix from `sidex_remote::errors` so
//! the frontend can map them precisely.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering as AtomicOrdering};
use std::sync::Arc;
use tokio::sync::mpsc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use sidex_remote::{
    codespaces::list_codespace_info,
    errors,
    ssh::{HostKeyPolicy, SshAuth, SshConnectOptions, SshTransport},
    ssh_config::SshConfig,
    transport::RemoteTransport,
    ConnectionId, ConnectionInfo, ConnectionKind, RemoteManager,
};

// ── State ───────────────────────────────────────────────────────────

#[derive(Clone)]
struct SshParams {
    host: String,
    user: Option<String>,
    port: Option<u16>,
    auth: SshAuth,
    opts: SshConnectOptions,
}

type SshMap = HashMap<u64, (Arc<SshTransport>, SshParams)>;

pub struct RemoteManagerStore {
    inner: Arc<Mutex<RemoteManager>>,
    ssh: Arc<Mutex<SshMap>>,
    pending: Arc<std::sync::Mutex<HashMap<String, tokio::task::AbortHandle>>>,
}

impl RemoteManagerStore {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(RemoteManager::new())),
            ssh: Arc::new(Mutex::new(HashMap::new())),
            pending: Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }

    async fn transport(&self, id: u64) -> Result<Arc<dyn RemoteTransport>, String> {
        self.inner
            .lock()
            .await
            .get_arc(ConnectionId(id))
            .ok_or_else(|| {
                format!("[{}] no remote connection with id {id} (closed?)", errors::CONNECTION_LOST)
            })
    }
}

impl Default for RemoteManagerStore {
    fn default() -> Self {
        Self::new()
    }
}

// ── Response structs ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct SshHostInfo {
    pub host: String,
    pub hostname: Option<String>,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
    pub proxy_command: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WslDistroInfo {
    pub name: String,
    pub is_default: bool,
    pub version: u8,
    pub state: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ContainerListEntry {
    pub id: String,
    pub name: String,
    pub image: String,
    pub status: String,
    pub ports: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodespaceEntry {
    pub name: String,
    pub display_name: String,
    pub repository: String,
    pub branch: String,
    pub machine_type: String,
    pub state: String,
    pub created_at: String,
    pub last_used: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteConnectionEntry {
    pub id: u64,
    pub kind: String,
    pub label: String,
    pub connected_secs: u64,
    pub alive: bool,
    /// SSH only: `trusted` | `learned` | `unchecked`.
    pub host_key: Option<String>,
    pub host_key_fingerprint: Option<String>,
    pub jumps: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemotePlatformResult {
    pub platform: String,
    pub arch: String,
    pub shell: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

// ── Auth payload from the frontend ─────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SshAuthPayload {
    Password {
        password: String,
    },
    KeyFile {
        path: String,
        passphrase: Option<String>,
    },
    Agent,
}

impl From<SshAuthPayload> for SshAuth {
    fn from(p: SshAuthPayload) -> Self {
        match p {
            SshAuthPayload::Password { password } => SshAuth::Password(password),
            SshAuthPayload::KeyFile { path, passphrase } => SshAuth::KeyFile {
                path: PathBuf::from(path),
                passphrase,
            },
            SshAuthPayload::Agent => SshAuth::Agent,
        }
    }
}

fn kind_as_str(k: ConnectionKind) -> &'static str {
    match k {
        ConnectionKind::Ssh => "ssh",
        ConnectionKind::Wsl => "wsl",
        ConnectionKind::Container => "container",
        ConnectionKind::Codespace => "codespace",
        ConnectionKind::Tunnel => "tunnel",
    }
}

fn to_entry(info: ConnectionInfo) -> RemoteConnectionEntry {
    RemoteConnectionEntry {
        id: info.id.0,
        kind: kind_as_str(info.kind).to_string(),
        label: info.label,
        connected_secs: info.connected_secs,
        alive: info.alive,
        host_key: None,
        host_key_fingerprint: None,
        jumps: 0,
    }
}

// ── Commands ────────────────────────────────────────────────────────

fn load_ssh_config() -> SshConfig {
    SshConfig::load_default().unwrap_or_else(|e| {
        log::warn!("ignoring unreadable SSH config: {e}");
        SshConfig::default()
    })
}

/// Concrete (non-wildcard) hosts from `~/.ssh/config` (Include honoured).
#[tauri::command]
pub fn remote_list_ssh_hosts() -> Result<Vec<SshHostInfo>, String> {
    let cfg = SshConfig::load_default().map_err(|e| format!("failed to parse SSH config: {e}"))?;
    Ok(cfg
        .hosts()
        .into_iter()
        .map(|alias| {
            let r = cfg.resolve(&alias);
            SshHostInfo {
                host: alias,
                hostname: Some(r.hostname),
                port: Some(r.port),
                user: r.user,
                identity_file: r
                    .identity_files
                    .first()
                    .map(|p| p.to_string_lossy().into_owned()),
                proxy_jump: r.proxy_jump,
                proxy_command: r.proxy_command,
            }
        })
        .collect())
}

fn ssh_entry(info: ConnectionInfo, t: &SshTransport) -> RemoteConnectionEntry {
    use sidex_remote::ssh::HostKeyOutcome as H;
    let mut e = to_entry(info);
    let (kind, fp) = match &t.host_key {
        H::Trusted { fingerprint } => ("trusted", fingerprint),
        H::Learned { fingerprint } => ("learned", fingerprint),
        H::Unchecked { fingerprint } | H::Changed { fingerprint, .. } | H::Rejected { fingerprint } => {
            ("unchecked", fingerprint)
        }
    };
    e.host_key = Some(kind.into());
    e.host_key_fingerprint = Some(fp.clone());
    e.jumps = t.jump_count();
    e
}

async fn do_connect_ssh(
    store: &RemoteManagerStore,
    params: SshParams,
    request_id: Option<String>,
) -> Result<RemoteConnectionEntry, String> {
    let p = params.clone();
    let task = tokio::spawn(async move {
        let cfg = load_ssh_config();
        SshTransport::connect_destination(&p.host, p.user.as_deref(), p.port, p.auth, p.opts, &cfg).await
    });
    if let Some(id) = &request_id {
        store.pending.lock().unwrap().insert(id.clone(), task.abort_handle());
    }
    let res = task.await;
    if let Some(id) = &request_id {
        store.pending.lock().unwrap().remove(id);
    }
    let transport = match res {
        Ok(Ok(t)) => Arc::new(t),
        Ok(Err(e)) => return Err(format!("SSH connect failed: {e:#}")),
        Err(j) if j.is_cancelled() => {
            return Err(format!("[{}] connection to {} was cancelled", errors::CANCELLED, params.host))
        }
        Err(j) => return Err(format!("SSH connect task failed: {j}")),
    };
    let ep = transport.endpoint();
    let label = if params.host.contains('@') || params.host == ep.host {
        format!("{}@{}:{}", ep.user, ep.host, ep.port)
    } else {
        format!("{} ({}@{}:{})", params.host, ep.user, ep.host, ep.port)
    };
    let dyn_t: Arc<dyn RemoteTransport> = transport.clone();
    let (id, info) = {
        let mut mgr = store.inner.lock().await;
        let id = mgr.insert_transport(dyn_t, ConnectionKind::Ssh, label);
        let info = mgr
            .active_connections()
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| "connection disappeared immediately".to_string())?;
        (id, info)
    };
    let entry = ssh_entry(info, &transport);
    store.ssh.lock().await.insert(id.0, (transport, params));
    Ok(entry)
}

/// Connect to `host` — an ssh_config alias, `user@host[:port]` or
/// `ssh://…`. `request_id` makes the attempt cancellable via
/// [`remote_cancel_connect`].
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn remote_connect_ssh(
    host: String,
    user: String,
    port: Option<u16>,
    auth: SshAuthPayload,
    request_id: Option<String>,
    timeout_secs: Option<u64>,
    strict_host_key: Option<bool>,
    store: State<'_, RemoteManagerStore>,
) -> Result<RemoteConnectionEntry, String> {
    let mut opts = SshConnectOptions::default();
    if let Some(t) = timeout_secs {
        opts.connect_timeout = Duration::from_secs(t.clamp(1, 600));
    }
    if strict_host_key == Some(true) {
        opts.host_key_policy = HostKeyPolicy::Strict;
    }
    let params = SshParams {
        host,
        user: Some(user).filter(|u| !u.is_empty()),
        port,
        auth: auth.into(),
        opts,
    };
    do_connect_ssh(&store, params, request_id).await
}

/// Abort an in-flight [`remote_connect_ssh`].
#[tauri::command]
pub fn remote_cancel_connect(request_id: String, store: State<'_, RemoteManagerStore>) -> bool {
    store
        .pending
        .lock()
        .unwrap()
        .remove(&request_id)
        .map(|h| h.abort())
        .is_some()
}

/// Re-establish a dropped SSH connection with the original parameters.
/// Returns a **new** connection id.
#[tauri::command]
pub async fn remote_reconnect(
    connection_id: u64,
    store: State<'_, RemoteManagerStore>,
) -> Result<RemoteConnectionEntry, String> {
    let (old, params) = store
        .ssh
        .lock()
        .await
        .remove(&connection_id)
        .ok_or_else(|| format!("no SSH connection with id {connection_id}"))?;
    store.inner.lock().await.take(ConnectionId(connection_id));
    let _ = old.disconnect().await;
    do_connect_ssh(&store, params, None).await
}

/// open-remote-ssh style OS / arch detection.
#[tauri::command]
pub async fn remote_detect_platform(
    connection_id: u64,
    override_platform: Option<String>,
    store: State<'_, RemoteManagerStore>,
) -> Result<RemotePlatformResult, String> {
    let t = store
        .ssh
        .lock()
        .await
        .get(&connection_id)
        .map(|(t, _)| Arc::clone(t))
        .ok_or_else(|| format!("no SSH connection with id {connection_id}"))?;
    let p = sidex_remote::ssh::detect_platform(&t, override_platform.as_deref())
        .await
        .map_err(|e| format!("platform detection failed: {e}"))?;
    Ok(RemotePlatformResult {
        platform: p.platform,
        arch: p.arch,
        shell: p.shell,
    })
}

/// Local port forward; `local_port` 0 picks a free port. Returns the bound port.
#[tauri::command]
pub async fn remote_forward_port(
    connection_id: u64,
    local_port: u16,
    remote_host: Option<String>,
    remote_port: u16,
    store: State<'_, RemoteManagerStore>,
) -> Result<u16, String> {
    let t = store
        .ssh
        .lock()
        .await
        .get(&connection_id)
        .map(|(t, _)| Arc::clone(t))
        .ok_or_else(|| format!("no SSH connection with id {connection_id}"))?;
    t.forward_port(local_port, remote_host.as_deref().unwrap_or("127.0.0.1"), remote_port)
        .await
        .map_err(|e| format!("port forward failed: {e}"))
}

#[tauri::command]
pub async fn remote_exec_ssh(
    connection_id: u64,
    command: String,
    store: State<'_, RemoteManagerStore>,
) -> Result<RemoteExecResult, String> {
    let transport = store.transport(connection_id).await?;
    let out = transport
        .exec(&command)
        .await
        .map_err(|e| format!("remote exec failed: {e}"))?;
    Ok(RemoteExecResult {
        stdout: out.stdout,
        stderr: out.stderr,
        exit_code: out.exit_code,
    })
}

#[tauri::command]
#[allow(clippy::unnecessary_wraps)]
pub fn remote_list_wsl_distros() -> Result<Vec<WslDistroInfo>, String> {
    #[cfg(target_os = "windows")]
    {
        let distros =
            sidex_remote::wsl::list_distributions().map_err(|e| format!("WSL list failed: {e}"))?;
        Ok(distros
            .into_iter()
            .map(|d| WslDistroInfo {
                name: d.name,
                is_default: d.is_default,
                version: d.version,
                state: d.state,
            })
            .collect())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(Vec::new())
    }
}

#[tauri::command]
pub async fn remote_list_containers() -> Result<Vec<ContainerListEntry>, String> {
    let mut docker_cmd = tokio::process::Command::new("docker");
    docker_cmd.args([
        "ps",
        "-a",
        "--format",
        "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}",
    ]);
    #[cfg(windows)]
    docker_cmd.creation_flags(0x0800_0000);
    let output = docker_cmd
        .output()
        .await
        .map_err(|e| format!("failed to run docker ps: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("Cannot connect") || stderr.contains("not found") {
            return Ok(Vec::new());
        }
        return Err(format!("docker ps failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(5, '\t').collect();
            if parts.len() >= 4 {
                Some(ContainerListEntry {
                    id: parts[0].to_string(),
                    name: parts[1].to_string(),
                    image: parts[2].to_string(),
                    status: parts[3].to_string(),
                    ports: parts.get(4).unwrap_or(&"").to_string(),
                })
            } else {
                None
            }
        })
        .collect())
}

#[tauri::command]
pub async fn remote_codespaces_list(github_token: String) -> Result<Vec<CodespaceEntry>, String> {
    let items = list_codespace_info(&github_token)
        .await
        .map_err(|e| format!("listing codespaces failed: {e}"))?;

    Ok(items
        .into_iter()
        .map(|c| CodespaceEntry {
            name: c.name,
            display_name: c.display_name,
            repository: c.repository,
            branch: c.branch,
            machine_type: c.machine_type,
            state: format!("{:?}", c.state),
            created_at: c.created_at,
            last_used: c.last_used,
        })
        .collect())
}

#[tauri::command]
pub async fn remote_connect_wsl(
    distro: String,
    store: State<'_, RemoteManagerStore>,
) -> Result<RemoteConnectionEntry, String> {
    let mut mgr = store.inner.lock().await;
    let id = mgr
        .connect_wsl(&distro)
        .await
        .map_err(|e| format!("WSL connect failed: {e}"))?;
    let info = mgr
        .active_connections()
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| "connection disappeared immediately".to_string())?;
    Ok(to_entry(info))
}

#[tauri::command]
pub async fn remote_connect_container(
    config_path: String,
    store: State<'_, RemoteManagerStore>,
) -> Result<RemoteConnectionEntry, String> {
    let path = PathBuf::from(config_path);
    let mut mgr = store.inner.lock().await;
    let id = mgr
        .connect_container(&path)
        .await
        .map_err(|e| format!("container connect failed: {e}"))?;
    let info = mgr
        .active_connections()
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| "connection disappeared immediately".to_string())?;
    Ok(to_entry(info))
}

#[tauri::command]
pub async fn remote_connect_codespace(
    name: String,
    github_token: String,
    store: State<'_, RemoteManagerStore>,
) -> Result<RemoteConnectionEntry, String> {
    let mut mgr = store.inner.lock().await;
    let id = mgr
        .connect_codespace(&name, &github_token)
        .await
        .map_err(|e| format!("codespace connect failed: {e}"))?;
    let info = mgr
        .active_connections()
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| "connection disappeared immediately".to_string())?;
    Ok(to_entry(info))
}

#[tauri::command]
pub async fn remote_disconnect(
    connection_id: u64,
    store: State<'_, RemoteManagerStore>,
) -> Result<(), String> {
    store.ssh.lock().await.remove(&connection_id);
    let t = store.inner.lock().await.take(ConnectionId(connection_id));
    match t {
        Some(t) => t.disconnect().await.map_err(|e| format!("disconnect failed: {e}")),
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn remote_active_connections(
    store: State<'_, RemoteManagerStore>,
) -> Result<Vec<RemoteConnectionEntry>, String> {
    let infos = store.inner.lock().await.active_connections();
    let ssh = store.ssh.lock().await;
    Ok(infos
        .into_iter()
        .map(|i| match ssh.get(&i.id.0) {
            Some((t, _)) => ssh_entry(i, t),
            None => to_entry(i),
        })
        .collect())
}

// ── Remote filesystem (SSH / WSL / container transport) ─────────────

#[derive(Debug, Clone, Serialize)]
pub struct RemoteDirEntryInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteStatInfo {
    pub size: u64,
    pub modified_ms: Option<u64>,
    pub is_dir: bool,
    pub is_symlink: bool,
}

fn system_time_to_ms(t: Option<std::time::SystemTime>) -> Option<u64> {
    t.and_then(|st| {
        st.duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
    })
}

#[tauri::command]
pub async fn remote_read_dir(
    connection_id: u64,
    path: String,
    store: State<'_, RemoteManagerStore>,
) -> Result<Vec<RemoteDirEntryInfo>, String> {
    let entries = store
        .transport(connection_id)
        .await?
        .read_dir(&path)
        .await
        .map_err(|e| format!("remote read_dir failed: {e}"))?;
    Ok(entries
        .into_iter()
        .map(|e| RemoteDirEntryInfo {
            name: e.name,
            path: e.path,
            is_dir: e.is_dir,
            is_symlink: e.is_symlink,
            size: e.size,
            modified_ms: system_time_to_ms(e.modified),
        })
        .collect())
}

#[tauri::command]
pub async fn remote_read_file(
    connection_id: u64,
    path: String,
    store: State<'_, RemoteManagerStore>,
) -> Result<tauri::ipc::Response, String> {
    let bytes = store
        .transport(connection_id)
        .await?
        .read_file(&path)
        .await
        .map_err(|e| format!("remote read_file failed: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn remote_write_file(
    connection_id: u64,
    path: String,
    contents: Vec<u8>,
    store: State<'_, RemoteManagerStore>,
) -> Result<(), String> {
    store
        .transport(connection_id)
        .await?
        .write_file(&path, &contents)
        .await
        .map_err(|e| format!("remote write_file failed: {e}"))
}

#[tauri::command]
pub async fn remote_stat(
    connection_id: u64,
    path: String,
    store: State<'_, RemoteManagerStore>,
) -> Result<RemoteStatInfo, String> {
    let st = store
        .transport(connection_id)
        .await?
        .stat(&path)
        .await
        .map_err(|e| format!("remote stat failed: {e}"))?;
    Ok(RemoteStatInfo {
        size: st.size,
        modified_ms: system_time_to_ms(st.modified),
        is_dir: st.is_dir,
        is_symlink: st.is_symlink,
    })
}

#[tauri::command]
pub async fn remote_home(
    connection_id: u64,
    store: State<'_, RemoteManagerStore>,
) -> Result<String, String> {
    let home = store
        .transport(connection_id)
        .await?
        .home()
        .await
        .map_err(|e| format!("remote home failed: {e}"))?;
    if home.is_empty() {
        return Err("remote $HOME is empty".to_string());
    }
    Ok(home)
}

#[tauri::command]
pub async fn remote_mkdir(
    connection_id: u64,
    path: String,
    store: State<'_, RemoteManagerStore>,
) -> Result<(), String> {
    store
        .transport(connection_id)
        .await?
        .mkdir(&path)
        .await
        .map_err(|e| format!("remote mkdir failed: {e}"))
}

#[tauri::command]
pub async fn remote_delete(
    connection_id: u64,
    path: String,
    recursive: bool,
    store: State<'_, RemoteManagerStore>,
) -> Result<(), String> {
    store
        .transport(connection_id)
        .await?
        .remove(&path, recursive)
        .await
        .map_err(|e| format!("remote delete failed: {e}"))
}

#[tauri::command]
pub async fn remote_rename(
    connection_id: u64,
    from: String,
    to: String,
    overwrite: Option<bool>,
    store: State<'_, RemoteManagerStore>,
) -> Result<(), String> {
    store
        .transport(connection_id)
        .await?
        .rename(&from, &to, overwrite.unwrap_or(false))
        .await
        .map_err(|e| format!("remote rename failed: {e}"))
}

// ---------------------------------------------------------------------------
// Remote PTY (integrated terminal over SSH)
// ---------------------------------------------------------------------------

struct RemotePtySession {
    write_tx: mpsc::Sender<Vec<u8>>,
    resize_tx: mpsc::Sender<(u16, u16)>,
    kill_tx: mpsc::Sender<()>,
}

pub struct RemotePtyStore {
    next_id: AtomicU32,
    sessions: Mutex<HashMap<u32, RemotePtySession>>,
}

impl RemotePtyStore {
    pub fn new() -> Self {
        Self {
            next_id: AtomicU32::new(1),
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for RemotePtyStore {
    fn default() -> Self {
        Self::new()
    }
}

/// Open a remote interactive PTY (VS Code remote terminal).
#[tauri::command]
pub async fn remote_terminal_spawn(
    app: AppHandle,
    connection_id: u64,
    cols: Option<u16>,
    rows: Option<u16>,
    store: State<'_, RemoteManagerStore>,
    pty_store: State<'_, Arc<RemotePtyStore>>,
) -> Result<u32, String> {
    let cols = cols.unwrap_or(80);
    let rows = rows.unwrap_or(24);
    let transport = store.transport(connection_id).await?;
    let mut pty = transport
        .open_pty(cols, rows)
        .await
        .map_err(|e| format!("remote open_pty failed: {e}"))?;

    let terminal_id = pty_store.next_id.fetch_add(1, AtomicOrdering::Relaxed);
    let (write_tx, mut write_rx) = mpsc::channel::<Vec<u8>>(64);
    let (resize_tx, mut resize_rx) = mpsc::channel::<(u16, u16)>(8);
    let (kill_tx, mut kill_rx) = mpsc::channel::<()>(1);

    {
        let mut guard = pty_store.sessions.lock().await;
        guard.insert(
            terminal_id,
            RemotePtySession {
                write_tx: write_tx.clone(),
                resize_tx: resize_tx.clone(),
                kill_tx: kill_tx.clone(),
            },
        );
    }

    let app_handle = app.clone();
    let pty_store_inner = pty_store.inner().clone();
    tauri::async_runtime::spawn(async move {
        let mut buf = [0u8; 8192];
        loop {
            tokio::select! {
                biased;
                _ = kill_rx.recv() => { break; }
                msg = write_rx.recv() => {
                    match msg {
                        Some(data) => {
                            if pty.write(&data).await.is_err() { break; }
                        }
                        None => break,
                    }
                }
                r = resize_rx.recv() => {
                    if let Some((c, r)) = r {
                        let _ = pty.resize(c, r).await;
                    }
                }
                read = pty.read(&mut buf) => {
                    match read {
                        Ok(0) => break,
                        Ok(n) => {
                            let data = String::from_utf8_lossy(&buf[..n]).to_string();
                            let _ = app_handle.emit(
                                "remote-terminal-data",
                                serde_json::json!({
                                    "terminal_id": terminal_id,
                                    "connection_id": connection_id,
                                    "data": data,
                                }),
                            );
                        }
                        Err(_) => break,
                    }
                }
            }
        }
        let _ = app_handle.emit(
            "remote-terminal-exit",
            serde_json::json!({
                "terminal_id": terminal_id,
                "connection_id": connection_id,
                "exit_code": 0,
            }),
        );
        let mut guard = pty_store_inner.sessions.lock().await;
        guard.remove(&terminal_id);
    });

    Ok(terminal_id)
}

#[tauri::command]
pub async fn remote_terminal_write(
    terminal_id: u32,
    data: String,
    pty_store: State<'_, Arc<RemotePtyStore>>,
) -> Result<(), String> {
    let tx = {
        let guard = pty_store.sessions.lock().await;
        guard
            .get(&terminal_id)
            .map(|s| s.write_tx.clone())
            .ok_or_else(|| format!("remote terminal {terminal_id} not found"))?
    };
    tx.send(data.into_bytes())
        .await
        .map_err(|_| format!("remote terminal {terminal_id} closed"))?;
    Ok(())
}

#[tauri::command]
pub async fn remote_terminal_resize(
    terminal_id: u32,
    cols: u16,
    rows: u16,
    pty_store: State<'_, Arc<RemotePtyStore>>,
) -> Result<(), String> {
    let tx = {
        let guard = pty_store.sessions.lock().await;
        guard
            .get(&terminal_id)
            .map(|s| s.resize_tx.clone())
            .ok_or_else(|| format!("remote terminal {terminal_id} not found"))?
    };
    tx.send((cols, rows))
        .await
        .map_err(|_| format!("remote terminal {terminal_id} closed"))?;
    Ok(())
}

#[tauri::command]
pub async fn remote_terminal_kill(
    terminal_id: u32,
    pty_store: State<'_, Arc<RemotePtyStore>>,
) -> Result<(), String> {
    let tx = {
        let mut guard = pty_store.sessions.lock().await;
        guard
            .remove(&terminal_id)
            .map(|s| s.kill_tx)
            .ok_or_else(|| format!("remote terminal {terminal_id} not found"))?
    };
    let _ = tx.send(()).await;
    Ok(())
}
