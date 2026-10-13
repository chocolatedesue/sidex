use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct PtyHandle {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send>,
}

pub struct TerminalStore {
    terminals: Mutex<HashMap<u32, PtyHandle>>,
    next_id: Mutex<u32>,
    /// Unacked UTF-8 bytes per terminal (flow control vs frontend).
    unacked_bytes: Mutex<HashMap<u32, Arc<AtomicUsize>>>,
}

impl TerminalStore {
    pub fn new() -> Self {
        Self {
            terminals: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
            unacked_bytes: Mutex::new(HashMap::new()),
        }
    }

    fn flow_counter(&self, id: u32) -> Arc<AtomicUsize> {
        let mut map = self.unacked_bytes.lock().expect("unacked map");
        map.entry(id)
            .or_insert_with(|| Arc::new(AtomicUsize::new(0)))
            .clone()
    }

    fn drop_flow_counter(&self, id: u32) {
        if let Ok(mut map) = self.unacked_bytes.lock() {
            map.remove(&id);
        }
    }
}

/// Coalesce window for PTY→IPC emits (ms). Matches VS Code TerminalDataBufferer ~5ms + IPC cost.
const EMIT_COALESCE_MS: u64 = 8;
/// Max bytes in one coalesced emit.
const EMIT_COALESCE_MAX_BYTES: usize = 64 * 1024;
/// Pause emitting when frontend is this far behind (bytes).
const FLOW_HIGH_WATER: usize = 256 * 1024;
/// Resume once acked down to this (bytes).
const FLOW_LOW_WATER: usize = 64 * 1024;

/// Join successive PTY chunks until deadline or size cap (unit-tested).
pub(crate) fn coalesce_chunks(chunks: &[String], max_bytes: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    for chunk in chunks {
        if !cur.is_empty() && cur.len() + chunk.len() > max_bytes {
            out.push(std::mem::take(&mut cur));
        }
        cur.push_str(chunk);
        if cur.len() >= max_bytes {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

#[derive(Debug, Clone, Serialize)]
struct TerminalDataEvent {
    terminal_id: u32,
    data: String,
}

#[derive(Debug, Clone, Serialize)]
struct TerminalExitEvent {
    terminal_id: u32,
    exit_code: i32,
}

pub(crate) fn resolve_windows_shell() -> String {
    for candidate in ["pwsh.exe", "powershell.exe"] {
        if let Ok(path) = which::which(candidate) {
            return path.to_string_lossy().to_string();
        }
    }

    std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
}

#[cfg(target_os = "windows")]
fn is_git_bash_path(path: &std::path::Path) -> bool {
    let normalized = path.to_string_lossy().replace('/', "\\").to_lowercase();
    normalized.ends_with("\\git\\bin\\bash.exe")
        || normalized.ends_with("\\git\\usr\\bin\\bash.exe")
}

#[cfg(target_os = "windows")]
fn resolve_git_bash() -> Option<String> {
    let mut candidates = Vec::new();

    for key in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(root) = std::env::var_os(key) {
            let root = std::path::PathBuf::from(root);
            candidates.push(root.join("Git").join("bin").join("bash.exe"));
            candidates.push(root.join("Git").join("usr").join("bin").join("bash.exe"));
            candidates.push(
                root.join("Programs")
                    .join("Git")
                    .join("bin")
                    .join("bash.exe"),
            );
            candidates.push(
                root.join("Programs")
                    .join("Git")
                    .join("usr")
                    .join("bin")
                    .join("bash.exe"),
            );
        }
    }

    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.push(dir.join("bash.exe"));
        }
    }

    candidates
        .into_iter()
        .find(|path| path.exists() && is_git_bash_path(path))
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
#[allow(
    clippy::too_many_lines,
    clippy::needless_pass_by_value,
    clippy::too_many_arguments
)]
pub fn terminal_spawn(
    app: AppHandle,
    state: State<'_, Arc<TerminalStore>>,
    shell: Option<String>,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<u32, String> {
    let pty_system = native_pty_system();

    let pty_cols = cols.unwrap_or(80);
    let pty_rows = rows.unwrap_or(24);

    let pair = pty_system
        .openpty(PtySize {
            rows: pty_rows,
            cols: pty_cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    #[allow(unused_mut)]
    let mut shell_path = shell.unwrap_or_else(|| {
        if cfg!(target_os = "windows") {
            resolve_windows_shell()
        } else {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
        }
    });

    #[cfg(target_os = "windows")]
    if std::path::Path::new(&shell_path)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("bash.exe"))
        && !is_git_bash_path(std::path::Path::new(&shell_path))
    {
        if let Some(git_bash) = resolve_git_bash() {
            shell_path = git_bash;
        }
    }

    if !cfg!(target_os = "windows") {
        let path = std::path::Path::new(&shell_path);
        if !path.exists() {
            let fallbacks = ["/bin/zsh", "/bin/bash", "/bin/sh"];
            for fb in &fallbacks {
                if std::path::Path::new(fb).exists() {
                    return terminal_spawn(
                        app,
                        state,
                        Some(fb.to_string()),
                        args,
                        cwd,
                        env,
                        cols,
                        rows,
                    );
                }
            }
            return Err(format!(
                "Shell '{shell_path}' not found, and no fallback shell available"
            ));
        }
    }

    let mut cmd = CommandBuilder::new(&shell_path);

    if let Some(ref shell_args) = args {
        for arg in shell_args {
            cmd.arg(arg);
        }
    } else {
        let shell_basename = std::path::Path::new(&shell_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        // Fish: VS Code default profile has no -l; login fish breaks some configs + SI inject.
        match shell_basename {
            "zsh" | "bash" | "sh" | "zsh.exe" | "bash.exe" | "sh.exe" => {
                cmd.arg("-l");
            }
            _ => {}
        }
    }

    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "SideX");

    if let Ok(home) = std::env::var("HOME") {
        cmd.env("HOME", &home);
    }
    if cfg!(target_os = "windows") {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            cmd.env("USERPROFILE", &profile);
            if std::env::var("HOME").is_err() {
                cmd.env("HOME", &profile);
            }
        }
        for key in &[
            "USERNAME",
            "APPDATA",
            "LOCALAPPDATA",
            "HOMEDRIVE",
            "HOMEPATH",
            "COMSPEC",
            "SystemRoot",
        ] {
            if let Ok(val) = std::env::var(key) {
                cmd.env(key, &val);
            }
        }
    } else if let Ok(user) = std::env::var("USER") {
        cmd.env("USER", &user);
    }
    if let Ok(path) = std::env::var("PATH") {
        cmd.env("PATH", &path);
    }
    if let Ok(lang) = std::env::var("LANG") {
        cmd.env("LANG", &lang);
    } else if !cfg!(target_os = "windows") {
        cmd.env("LANG", "en_US.UTF-8");
    }

    if let Some(ref dir) = cwd {
        if !dir.is_empty() && std::path::Path::new(dir).is_dir() {
            cmd.cwd(dir);
        } else if let Some(home) = home_dir_string() {
            cmd.cwd(&home);
        }
    } else if let Some(home) = home_dir_string() {
        cmd.cwd(&home);
    }

    if let Some(env_vars) = env {
        for (k, v) in env_vars {
            cmd.env(k, v);
        }
    }

    // Fish: inject VS Code shellIntegration.fish via --init-command when args are default.
    // Aligns with VS Code (bash/zsh/fish/pwsh SI) so suggest + cwd tracking work.
    {
        let shell_basename_owned = std::path::Path::new(&shell_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let shell_basename = shell_basename_owned
            .strip_suffix(".exe")
            .unwrap_or(shell_basename_owned.as_str());
        if shell_basename == "fish" {
            let can_inject = match &args {
                None => true,
                Some(a) if a.is_empty() || a.iter().all(|x| x == "-l" || x == "--login") => true,
                _ => false,
            };
            if can_inject {
                if let Ok(resource_dir) = app.path().resource_dir() {
                    let fish_si = resource_dir
                        .join("shell-integration")
                        .join("shellIntegration.fish");
                    if fish_si.is_file() {
                        let raw = fish_si.to_string_lossy();
                        let si_path = raw.replace('\\', "\\\\").replace('\'', "'\\''");
                        cmd.arg(format!("--init-command=source '{si_path}'"));
                    }
                }
            }
        }
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell '{shell_path}': {e}"))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to get PTY writer: {e}"))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to get PTY reader: {e}"))?;

    let id = {
        let mut next = state.next_id.lock().map_err(|e| e.to_string())?;
        let id = *next;
        *next += 1;
        id
    };

    {
        let mut terminals = state.terminals.lock().map_err(|e| e.to_string())?;
        terminals.insert(
            id,
            PtyHandle {
                writer,
                master: pair.master,
                child,
            },
        );
    }

    let terminal_id = id;
    let state_clone = state.inner().clone();
    let unacked = state.inner().flow_counter(id);
    // Reader thread → channel; emitter thread coalesces bursts into fewer IPC emits.
    let (chunk_tx, chunk_rx) = std::sync::mpsc::sync_channel::<Option<String>>(64);
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(n) if n > 0 => {
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    if chunk_tx.send(Some(text)).is_err() {
                        break;
                    }
                }
                Ok(_) | Err(_) => {
                    let _ = chunk_tx.send(None);
                    break;
                }
            }
        }
    });

    std::thread::spawn(move || {
        let coalesce = Duration::from_millis(EMIT_COALESCE_MS);
        loop {
            let first = match chunk_rx.recv() {
                Ok(Some(t)) => t,
                Ok(None) | Err(_) => break,
            };
            let mut batch = first;
            let deadline = Instant::now() + coalesce;
            while batch.len() < EMIT_COALESCE_MAX_BYTES {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                match chunk_rx.recv_timeout(remaining) {
                    Ok(Some(more)) => {
                        batch.push_str(&more);
                        if batch.len() >= EMIT_COALESCE_MAX_BYTES {
                            break;
                        }
                    }
                    Ok(None) => {
                        // EOF after partial batch — emit then exit outer after.
                        let _ = emit_with_flow(&app, &unacked, terminal_id, batch);
                        // drain done
                        let exit_code = finish_terminal(&state_clone, &app, terminal_id);
                        let _ = app.emit(
                            "terminal-exit",
                            TerminalExitEvent {
                                terminal_id,
                                exit_code,
                            },
                        );
                        state_clone.drop_flow_counter(terminal_id);
                        return;
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        let _ = emit_with_flow(&app, &unacked, terminal_id, batch);
                        let exit_code = finish_terminal(&state_clone, &app, terminal_id);
                        let _ = app.emit(
                            "terminal-exit",
                            TerminalExitEvent {
                                terminal_id,
                                exit_code,
                            },
                        );
                        state_clone.drop_flow_counter(terminal_id);
                        return;
                    }
                }
            }
            let _ = emit_with_flow(&app, &unacked, terminal_id, batch);
        }

        let exit_code = finish_terminal(&state_clone, &app, terminal_id);
        let _ = app.emit(
            "terminal-exit",
            TerminalExitEvent {
                terminal_id,
                exit_code,
            },
        );
        state_clone.drop_flow_counter(terminal_id);
    });

    Ok(id)
}

fn emit_with_flow(
    app: &AppHandle,
    unacked: &AtomicUsize,
    terminal_id: u32,
    data: String,
) -> Result<(), ()> {
    // Backpressure: wait until frontend has acked enough bytes.
    let mut spins = 0u32;
    while unacked.load(Ordering::Relaxed) > FLOW_HIGH_WATER {
        std::thread::sleep(Duration::from_millis(1));
        spins += 1;
        if spins > 5_000 {
            // ~5s stuck — emit anyway to avoid deadlock if ack path is missing.
            break;
        }
        if unacked.load(Ordering::Relaxed) <= FLOW_LOW_WATER {
            break;
        }
    }
    let n = data.len();
    unacked.fetch_add(n, Ordering::Relaxed);
    app.emit(
        "terminal-data",
        TerminalDataEvent {
            terminal_id,
            data,
        },
    )
    .map_err(|_| ())
}

fn finish_terminal(state: &TerminalStore, _app: &AppHandle, terminal_id: u32) -> i32 {
    let Ok(mut terminals) = state.terminals.lock() else {
        return -1;
    };
    let code = if let Some(handle) = terminals.get_mut(&terminal_id) {
        match handle.child.try_wait() {
            Ok(Some(status)) => i32::from(!status.success()),
            _ => 0,
        }
    } else {
        0
    };
    terminals.remove(&terminal_id);
    code
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn terminal_write(
    state: State<'_, Arc<TerminalStore>>,
    terminal_id: u32,
    data: String,
) -> Result<(), String> {
    let mut terminals = state.terminals.lock().map_err(|e| e.to_string())?;
    let handle = terminals
        .get_mut(&terminal_id)
        .ok_or_else(|| format!("Terminal {terminal_id} not found"))?;

    handle
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Failed to write to terminal {terminal_id}: {e}"))?;

    handle
        .writer
        .flush()
        .map_err(|e| format!("Failed to flush terminal {terminal_id}: {e}"))?;

    Ok(())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn terminal_resize(
    state: State<'_, Arc<TerminalStore>>,
    terminal_id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let terminals = state.terminals.lock().map_err(|e| e.to_string())?;
    let handle = terminals
        .get(&terminal_id)
        .ok_or_else(|| format!("Terminal {terminal_id} not found"))?;

    handle
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to resize terminal {terminal_id}: {e}"))?;

    Ok(())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn terminal_kill(state: State<'_, Arc<TerminalStore>>, terminal_id: u32) -> Result<(), String> {
    let mut terminals = state.terminals.lock().map_err(|e| e.to_string())?;
    let mut handle = terminals
        .remove(&terminal_id)
        .ok_or_else(|| format!("Terminal {terminal_id} not found"))?;
    drop(terminals);
    state.drop_flow_counter(terminal_id);

    handle
        .child
        .kill()
        .map_err(|e| format!("Failed to kill terminal {terminal_id}: {e}"))?;

    Ok(())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn terminal_get_pid(
    state: State<'_, Arc<TerminalStore>>,
    terminal_id: u32,
) -> Result<u32, String> {
    let terminals = state.terminals.lock().map_err(|e| e.to_string())?;
    let handle = terminals
        .get(&terminal_id)
        .ok_or_else(|| format!("Terminal {terminal_id} not found"))?;

    let pid = handle
        .child
        .process_id()
        .ok_or_else(|| "Process ID not available".to_string())?;

    Ok(pid)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn terminal_ack_data(
    state: State<'_, Arc<TerminalStore>>,
    handle: u32,
    bytes: usize,
) -> Result<(), String> {
    let counter = {
        let map = state.unacked_bytes.lock().map_err(|e| e.to_string())?;
        map.get(&handle).cloned()
    };
    if let Some(c) = counter {
        // Saturating sub without going negative.
        loop {
            let cur = c.load(Ordering::Relaxed);
            let next = cur.saturating_sub(bytes);
            if c
                .compare_exchange(cur, next, Ordering::Relaxed, Ordering::Relaxed)
                .is_ok()
            {
                break;
            }
        }
    }
    Ok(())
}


fn home_dir_string() -> Option<String> {
    if cfg!(target_os = "windows") {
        std::env::var("USERPROFILE")
            .ok()
            .or_else(|| std::env::var("HOME").ok())
    } else {
        std::env::var("HOME").ok()
    }
}

#[tauri::command]
pub fn get_default_shell() -> String {
    if cfg!(target_os = "windows") {
        return resolve_windows_shell();
    }

    // 1. Check $SHELL (same as VS Code: shell.ts getSystemShellUnixLike)
    if let Ok(shell) = std::env::var("SHELL") {
        if !shell.is_empty() && shell != "/bin/false" {
            return shell;
        }
    }

    // 2. Read from passwd via libc (same as VS Code: os.userInfo().shell)
    #[cfg(unix)]
    {
        #[allow(unsafe_code)]
        unsafe {
            let uid = libc::getuid();
            let pw = libc::getpwuid(uid);
            if !pw.is_null() {
                let shell_cstr = std::ffi::CStr::from_ptr((*pw).pw_shell);
                if let Ok(s) = shell_cstr.to_str() {
                    if !s.is_empty() && s != "/bin/false" {
                        return s.to_string();
                    }
                }
            }
        }
    }

    // 3. Fallback: zsh first on macOS, then bash
    for fb in &["/bin/zsh", "/bin/bash", "/bin/sh"] {
        if std::path::Path::new(fb).exists() {
            return fb.to_string();
        }
    }
    "/bin/sh".to_string()
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn check_shell_exists(path: String) -> bool {
    if cfg!(target_os = "windows") {
        return std::path::Path::new(&path).exists() || which::which(&path).is_ok();
    }

    std::path::Path::new(&path).exists()
}

#[tauri::command]
#[allow(clippy::too_many_lines)]
pub fn get_available_shells() -> Vec<ShellInfo> {
    #[cfg(target_os = "windows")]
    {
        let candidates: &[(&str, &str)] = &[
            ("PowerShell", "powershell.exe"),
            ("PowerShell Core", "pwsh.exe"),
            ("Command Prompt", "cmd.exe"),
            ("WSL", "wsl.exe"),
        ];
        let default_shell = get_default_shell();
        let mut seen = std::collections::HashSet::new();
        let mut shells = Vec::new();

        if let Some(resolved_path) = resolve_git_bash() {
            seen.insert("Git Bash".to_string());
            shells.push(ShellInfo {
                name: "Git Bash".to_string(),
                path: resolved_path.clone(),
                is_default: resolved_path.eq_ignore_ascii_case(&default_shell),
            });
        }

        for (name, path) in candidates {
            if let Ok(resolved_path) = which::which(path) {
                let resolved_path = resolved_path.to_string_lossy().to_string();
                if !seen.insert(name.to_string()) {
                    continue;
                }

                shells.push(ShellInfo {
                    name: name.to_string(),
                    path: resolved_path.clone(),
                    is_default: resolved_path.eq_ignore_ascii_case(&default_shell),
                });
            }
        }
        return shells;
    }

    #[cfg(not(target_os = "windows"))]
    {
        let default_shell = get_default_shell();
        let mut seen_paths = std::collections::HashSet::new();
        let mut shells = Vec::new();

        // Read /etc/shells (same as VS Code: terminalProfiles.ts detectAvailableUnixProfiles)
        if let Ok(contents) = std::fs::read_to_string("/etc/shells") {
            for line in contents.lines() {
                let trimmed = if let Some(idx) = line.find('#') {
                    &line[..idx]
                } else {
                    line
                };
                let trimmed = trimmed.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let path = std::path::Path::new(trimmed);
                if path.exists() && seen_paths.insert(trimmed.to_string()) {
                    let name = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("sh")
                        .to_string();
                    shells.push(ShellInfo {
                        name: name.clone(),
                        path: trimmed.to_string(),
                        is_default: trimmed == default_shell
                            || path.file_name().and_then(|n| n.to_str())
                                == std::path::Path::new(&default_shell)
                                    .file_name()
                                    .and_then(|n| n.to_str()),
                    });
                }
            }
        }

        // Always merge PATH/`which` candidates (Homebrew fish often missing from /etc/shells).
        let path_candidates: &[(&str, &str)] = &[
            ("zsh", "zsh"),
            ("bash", "bash"),
            ("fish", "fish"),
            ("pwsh", "pwsh"),
            ("sh", "sh"),
        ];
        let fixed_candidates: &[(&str, &str)] = &[
            ("zsh", "/bin/zsh"),
            ("bash", "/bin/bash"),
            ("fish", "/usr/bin/fish"),
            ("fish", "/usr/local/bin/fish"),
            ("fish", "/opt/homebrew/bin/fish"),
            ("sh", "/bin/sh"),
        ];
        let mut seen_names: std::collections::HashSet<String> =
            shells.iter().map(|s| s.name.clone()).collect();
        for (name, bin) in path_candidates {
            if seen_names.contains(*name) {
                continue;
            }
            if let Ok(resolved) = which::which(bin) {
                let resolved_path = resolved.to_string_lossy().to_string();
                if std::path::Path::new(&resolved_path).exists()
                    && seen_paths.insert(resolved_path.clone())
                {
                    seen_names.insert(name.to_string());
                    shells.push(ShellInfo {
                        name: name.to_string(),
                        path: resolved_path.clone(),
                        is_default: resolved_path == default_shell
                            || resolved.file_name()
                                == std::path::Path::new(&default_shell).file_name(),
                    });
                }
            }
        }
        if shells.is_empty() {
            for (name, shell_path) in fixed_candidates {
                if std::path::Path::new(shell_path).exists() && seen_names.insert(name.to_string())
                {
                    shells.push(ShellInfo {
                        name: name.to_string(),
                        path: shell_path.to_string(),
                        is_default: *shell_path == default_shell,
                    });
                }
            }
        }

        // Deduplicate by basename (prefer exact $SHELL path), then exactly one default.
        {
            let mut by_name: std::collections::HashMap<String, ShellInfo> =
                std::collections::HashMap::new();
            for s in shells.drain(..) {
                match by_name.get(&s.name) {
                    None => {
                        by_name.insert(s.name.clone(), s);
                    }
                    Some(existing) => {
                        let prefer_new = s.path == default_shell
                            || (existing.path != default_shell
                                && s.is_default
                                && !existing.is_default);
                        if prefer_new {
                            by_name.insert(s.name.clone(), s);
                        }
                    }
                }
            }
            shells = by_name.into_values().collect();
            shells.sort_by(|a, b| a.name.cmp(&b.name));
        }
        for s in &mut shells {
            s.is_default = false;
        }
        if let Some(s) = shells.iter_mut().find(|s| s.path == default_shell) {
            s.is_default = true;
        } else if let Some(s) = shells.iter_mut().find(|s| {
            std::path::Path::new(&s.path).file_name()
                == std::path::Path::new(&default_shell).file_name()
        }) {
            s.is_default = true;
        }

        shells
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ShellInfo {
    pub name: String,
    pub path: String,
    pub is_default: bool,
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn get_shell_integration_dir(app: tauri::AppHandle) -> Result<String, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {e}"))?;
    let scripts_dir = resource_dir.join("shell-integration");
    Ok(scripts_dir.to_string_lossy().to_string())
}

#[tauri::command]
#[allow(clippy::too_many_lines, clippy::needless_pass_by_value)]
pub fn setup_zsh_dotdir(app: tauri::AppHandle) -> Result<String, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?;
    let zdotdir = data_dir.join("zsh-integration");
    std::fs::create_dir_all(&zdotdir).map_err(|e| format!("Failed to create zdotdir: {e}"))?;

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {e}"))?;
    let scripts_dir = resource_dir.join("shell-integration");

    let zshrc_content = format!(
        r#"# SideX Shell Integration - Auto-generated
VSCODE_SHELL_INTEGRATION=1
VSCODE_INJECTION=1
if [[ -f "{scripts}/shellIntegration-rc.zsh" ]]; then
    USER_ZDOTDIR="${{ZDOTDIR:-$HOME}}"
    . "{scripts}/shellIntegration-rc.zsh"
fi
"#,
        scripts = scripts_dir.to_string_lossy()
    );

    let zshrc_path = zdotdir.join(".zshrc");
    std::fs::write(&zshrc_path, zshrc_content)
        .map_err(|e| format!("Failed to write .zshrc: {e}"))?;

    let zshenv_content = format!(
        r#"# SideX Shell Integration - Auto-generated
USER_ZDOTDIR="${{ZDOTDIR:-$HOME}}"
if [[ -f "{scripts}/shellIntegration-env.zsh" ]]; then
    . "{scripts}/shellIntegration-env.zsh"
fi
"#,
        scripts = scripts_dir.to_string_lossy()
    );

    let zshenv_path = zdotdir.join(".zshenv");
    std::fs::write(&zshenv_path, zshenv_content)
        .map_err(|e| format!("Failed to write .zshenv: {e}"))?;

    let zprofile_content = format!(
        r#"# SideX Shell Integration - Auto-generated
if [[ -f "{scripts}/shellIntegration-profile.zsh" ]]; then
    . "{scripts}/shellIntegration-profile.zsh"
fi
"#,
        scripts = scripts_dir.to_string_lossy()
    );

    let zprofile_path = zdotdir.join(".zprofile");
    std::fs::write(&zprofile_path, zprofile_content)
        .map_err(|e| format!("Failed to write .zprofile: {e}"))?;

    let zlogin_content = format!(
        r#"# SideX Shell Integration - Auto-generated
if [[ -f "{scripts}/shellIntegration-login.zsh" ]]; then
    . "{scripts}/shellIntegration-login.zsh"
fi
"#,
        scripts = scripts_dir.to_string_lossy()
    );

    let zlogin_path = zdotdir.join(".zlogin");
    std::fs::write(&zlogin_path, zlogin_content)
        .map_err(|e| format!("Failed to write .zlogin: {e}"))?;

    Ok(zdotdir.to_string_lossy().to_string())
}


#[cfg(test)]
mod tests {
    use super::coalesce_chunks;

    #[test]
    fn coalesce_respects_max_bytes() {
        // Does not split mid-chunk; flushes before appending when over cap.
        let chunks = vec!["aa".into(), "bb".into(), "cc".into(), "dd".into()];
        let out = coalesce_chunks(&chunks, 5);
        assert_eq!(out, vec!["aabb".to_string(), "ccdd".to_string()]);
    }

    #[test]
    fn coalesce_single_chunk_passthrough() {
        let chunks = vec!["hello".into()];
        let out = coalesce_chunks(&chunks, 64);
        assert_eq!(out, vec!["hello".to_string()]);
    }

    #[test]
    fn coalesce_reduces_emit_count() {
        let chunks: Vec<String> = (0..100).map(|i| format!("x{i}")).collect();
        let naive = chunks.len();
        let batched = coalesce_chunks(&chunks, 64);
        assert!(batched.len() < naive);
        assert_eq!(batched.concat(), chunks.concat());
        // Cross-check: 100 tiny chunks @ 64-byte cap should be well under 100 emits.
        assert!(batched.len() <= 20, "expected strong coalesce, got {}", batched.len());
    }

    #[test]
    fn detects_fish_when_present() {
        let shells = super::get_available_shells();
        let names: Vec<_> = shells.iter().map(|s| s.name.as_str()).collect();
        assert!(names.iter().any(|n| *n == "bash" || *n == "sh"), "expected bash/sh, got {names:?}");
        if std::path::Path::new("/usr/bin/fish").exists() || which::which("fish").is_ok() {
            assert!(
                shells.iter().any(|s| s.name == "fish"),
                "fish binary present but not detected: {shells:?}"
            );
        }
        assert!(
            shells.iter().filter(|s| s.is_default).count() <= 1,
            "more than one default shell: {shells:?}"
        );
    }
}
