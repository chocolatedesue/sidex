//! Command-line entry handling — the piece that makes `sidex <path>` work.
//!
//! VS Code's CLI turns "open this folder/file" into a request that is either
//! handled by a fresh instance or forwarded to the instance that is already
//! running. SideX needs the same three entry points:
//!
//! 1. the process starts with paths on the command line (`sidex .`),
//! 2. a second `sidex .` is launched while an instance is running — the
//!    `single-instance` plugin hands the new argv to the running instance,
//! 3. the OS hands over a `sidex://` deep link or a document open event.
//!
//! All three are normalised into an [`OpenRequest`] and pushed to the frontend
//! through the `sidex://open` event (plus [`take_pending_request`] for the race
//! where the webview is not listening yet).
//!
//! Options mirrored from VS Code's `argv.ts`: bare paths, `--folder-uri`,
//! `--file-uri`, `--goto`, `-n/--new-window`, `-r/--reuse-window`, `-a/--add`,
//! `-w/--wait`, `-d/--diff`. Deliberately out of scope: `--extensions-dir`,
//! profile switching, `serve-web`, `tunnel` and the other service subcommands.

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Url};

/// Where an open request came from — useful for logging and for tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OpenRequestSource {
    /// Paths/URIs were passed to this process on start-up.
    Argv,
    /// A second launch forwarded its argv to this already-running instance.
    SecondInstance,
    /// The OS opened a `sidex://` URL or a document with SideX.
    DeepLink,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GotoTarget {
    pub path: String,
    pub line: u32,
    pub character: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    /// Folders to open, as `file://` URIs. The first one becomes the workspace.
    pub folders: Vec<String>,
    /// Files to open in the editor, as `file://` URIs.
    pub files: Vec<String>,
    /// `--goto file:line[:character]`
    pub goto: Option<GotoTarget>,
    /// `-n` / `--new-window`
    pub new_window: bool,
    /// `-r` / `--reuse-window`
    pub reuse_window: bool,
    /// `-a` / `--add` — add the folders to the active window instead of replacing.
    pub add_to_workspace: bool,
    /// `-w` / `--wait`
    pub wait: bool,
    /// `-d` / `--diff <file> <file>`
    pub diff: Option<[String; 2]>,
    /// The raw `sidex://` URL, when the request came from a deep link.
    pub url: Option<String>,
    pub source: Option<OpenRequestSource>,
}

impl OpenRequest {
    fn from_source(source: OpenRequestSource) -> Self {
        Self {
            source: Some(source),
            ..Self::default()
        }
    }

    /// True when the request carries nothing the frontend can act on.
    pub fn is_empty(&self) -> bool {
        self.folders.is_empty()
            && self.files.is_empty()
            && self.goto.is_none()
            && self.diff.is_none()
            && self.url.is_none()
    }
}

/// Convert a filesystem path into a `file://` URI the webview understands.
/// Relative paths are resolved against the process working directory first,
/// which is what makes `sidex .` mean "the folder I am standing in".
fn path_to_uri(raw: &str, cwd: &Path) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Already a URI (file:, vscode-remote:, ...) — pass it through.
    if let Ok(parsed) = Url::parse(trimmed) {
        if parsed.scheme().len() > 1 {
            return Some(parsed.to_string());
        }
    }
    let path = Path::new(trimmed);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    };
    Url::from_file_path(&absolute).ok().map(|u| u.to_string())
}

/// `--goto file:line[:character]`
fn parse_goto(value: &str, cwd: &Path) -> Option<GotoTarget> {
    let parts: Vec<&str> = value.split(':').collect();
    if parts.len() < 2 {
        return Some(GotoTarget {
            path: path_to_uri(value, cwd)?,
            line: 1,
            character: 1,
        });
    }

    let last = parts[parts.len() - 1].parse::<u32>().ok();
    let second_last = parts[parts.len() - 2].parse::<u32>().ok();

    // `file:line:character` / `file:line` / a path that merely contains ':'.
    // Splitting from the right keeps Windows drive letters (`C:\a\b.ts:3`) intact.
    let (path_end, line, character) = match (second_last, last) {
        (Some(line), Some(character)) => (parts.len() - 2, line, character),
        (None, Some(line)) => (parts.len() - 1, line, 1),
        _ => (parts.len(), 1, 1),
    };

    Some(GotoTarget {
        path: path_to_uri(&parts[..path_end].join(":"), cwd)?,
        line: line.max(1),
        character: character.max(1),
    })
}

/// Parse a command line (already without the executable) into an [`OpenRequest`].
pub fn parse_args(args: &[String], cwd: &Path) -> OpenRequest {
    let mut request = OpenRequest::from_source(OpenRequestSource::Argv);
    let mut expect_diff = 0usize;
    let mut index = 0usize;

    while index < args.len() {
        let arg = args[index].as_str();

        match arg {
            "-n" | "--new-window" => request.new_window = true,
            "-r" | "--reuse-window" => request.reuse_window = true,
            "-a" | "--add" => request.add_to_workspace = true,
            "-w" | "--wait" => request.wait = true,
            "-d" | "--diff" => expect_diff = 2,
            "-g" | "--goto" => {
                if let Some(value) = args.get(index + 1) {
                    request.goto = parse_goto(value, cwd);
                    index += 1;
                }
            }
            "--folder-uri" => {
                if let Some(value) = args.get(index + 1) {
                    if let Some(uri) = path_to_uri(value, cwd) {
                        request.folders.push(uri);
                    }
                    index += 1;
                }
            }
            "--file-uri" => {
                if let Some(value) = args.get(index + 1) {
                    if let Some(uri) = path_to_uri(value, cwd) {
                        request.files.push(uri);
                    }
                    index += 1;
                }
            }
            // Options that take a value and are not part of folder interop.
            "--user-data-dir"
            | "--extensions-dir"
            | "--locale"
            | "--profile"
            | "--log"
            | "--extensions-download-dir"
            | "--shared-data-dir" => {
                index += 1;
            }
            _ if arg.starts_with('-') => {
                // Unknown/ignored flag (e.g. `--disable-extensions`).
            }
            _ => {
                if expect_diff > 0 {
                    if let Some(uri) = path_to_uri(arg, cwd) {
                        let slot = 2 - expect_diff;
                        match &mut request.diff {
                            Some(pair) => pair[slot] = uri,
                            None => {
                                let mut pair = [String::new(), String::new()];
                                pair[slot] = uri;
                                request.diff = Some(pair);
                            }
                        }
                    }
                    expect_diff -= 1;
                } else if let Some(uri) = path_to_uri(arg, cwd) {
                    // A directory becomes the workspace, anything else opens as a file.
                    // A path that does not exist yet is treated as a file, like `code new.ts`.
                    let is_dir = Path::new(arg).is_dir() || cwd.join(arg).is_dir();
                    if is_dir {
                        request.folders.push(uri);
                    } else {
                        request.files.push(uri);
                    }
                }
            }
        }
        index += 1;
    }

    request
}

/// `sidex://open?folder=...&file=...` — the form the OS and the website use.
pub fn parse_deep_link(url: &str) -> OpenRequest {
    let mut request = OpenRequest::from_source(OpenRequestSource::DeepLink);
    request.url = Some(url.to_string());

    let Ok(parsed) = Url::parse(url) else {
        return request;
    };
    if parsed.scheme() != "sidex" {
        return request;
    }

    for (key, value) in parsed.query_pairs() {
        match key.as_ref() {
            "folder" | "workspace" => {
                if let Some(uri) = path_to_uri(&value, Path::new(".")) {
                    request.folders.push(uri);
                }
            }
            "file" => {
                if let Some(uri) = path_to_uri(&value, Path::new(".")) {
                    request.files.push(uri);
                }
            }
            "newWindow" => request.new_window = value == "1" || value == "true",
            _ => {}
        }
    }

    // `sidex://file/<path>` and `sidex://folder/<path>` (path style URLs).
    if request.folders.is_empty() && request.files.is_empty() {
        let host = parsed.host_str().unwrap_or_default();
        let raw_path = parsed.path();
        if raw_path.len() > 1 {
            // Keep the leading slash: `sidex://folder/tmp/x` means the absolute
            // path `/tmp/x`, not one relative to the current directory. A
            // Windows drive path (`/C:/x`) loses the artificial leading slash.
            let without_slash = &raw_path[1..];
            let is_windows_drive = without_slash.len() >= 2 && without_slash.as_bytes()[1] == b':';
            let decoded = percent_decode(if is_windows_drive {
                without_slash
            } else {
                raw_path
            });
            match host {
                "folder" | "workspace" => {
                    if let Some(uri) = path_to_uri(&decoded, Path::new(".")) {
                        request.folders.push(uri);
                    }
                }
                "file" | "open" | "" => {
                    if let Some(uri) = path_to_uri(&decoded, Path::new(".")) {
                        request.files.push(uri);
                    }
                }
                _ => {}
            }
        }
    }

    request
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(value) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub const OPEN_EVENT: &str = "sidex://open";

/// Holds the most recent open request until the frontend asks for it. The
/// event can fire before the webview has registered its listener, so the
/// request is also retrievable on demand.
#[derive(Default)]
pub struct CliState {
    pending: Mutex<Option<OpenRequest>>,
}

impl CliState {
    pub fn set(&self, request: OpenRequest) {
        if let Ok(mut slot) = self.pending.lock() {
            *slot = Some(request);
        }
    }

    pub fn take(&self) -> Option<OpenRequest> {
        self.pending.lock().ok().and_then(|mut slot| slot.take())
    }
}

/// Store the request and notify the frontend. Safe to call from any thread.
pub fn dispatch(app: &AppHandle, request: OpenRequest) {
    if request.is_empty() {
        return;
    }
    log::info!(
        "open request: {} folder(s), {} file(s), source={:?}",
        request.folders.len(),
        request.files.len(),
        request.source
    );
    if let Some(state) = app.try_state::<CliState>() {
        state.set(request.clone());
    }
    if let Err(err) = app.emit(OPEN_EVENT, &request) {
        log::warn!("could not emit {OPEN_EVENT}: {err}");
    }
}

/// `sidex_take_open_request` — the frontend calls this once on start-up to pick
/// up a request that arrived before it was listening.
#[tauri::command]
pub fn sidex_take_open_request(state: tauri::State<'_, CliState>) -> Option<OpenRequest> {
    state.take()
}

/// Parse this process' own command line and queue the result, if it carries one.
pub fn dispatch_own_args(app: &AppHandle) {
    let cwd = std::env::current_dir().unwrap_or_else(|_| Path::new(".").to_path_buf());
    let args: Vec<String> = std::env::args().skip(1).collect();
    let request = parse_args(&args, &cwd);
    dispatch(app, request);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn cwd() -> PathBuf {
        PathBuf::from("/work")
    }

    #[test]
    fn bare_directory_becomes_a_folder() {
        let request = parse_args(&["src".to_string()], &cwd());
        assert_eq!(request.folders, vec!["file:///work/src".to_string()]);
        assert!(request.files.is_empty());
    }

    #[test]
    fn absolute_uri_passthrough() {
        let request = parse_args(
            &["file:///tmp/demo.md".to_string()],
            &PathBuf::from("/work"),
        );
        assert_eq!(request.files, vec!["file:///tmp/demo.md".to_string()]);
    }

    #[test]
    fn folder_uri_and_file_uri_flags() {
        let request = parse_args(
            &[
                "--folder-uri".to_string(),
                "file:///tmp/ws".to_string(),
                "--file-uri".to_string(),
                "file:///tmp/a.ts".to_string(),
            ],
            &cwd(),
        );
        assert_eq!(request.folders, vec!["file:///tmp/ws".to_string()]);
        assert_eq!(request.files, vec!["file:///tmp/a.ts".to_string()]);
    }

    #[test]
    fn window_flags() {
        let request = parse_args(&["-n".to_string(), ".".to_string()], &cwd());
        assert!(request.new_window);
        assert_eq!(request.folders, vec!["file:///work".to_string()]);
    }

    #[test]
    fn goto_parses_line_and_character() {
        let request = parse_args(
            &["--goto".to_string(), "src/main.ts:12:5".to_string()],
            &cwd(),
        );
        let goto = request.goto.expect("goto target");
        assert_eq!(goto.path, "file:///work/src/main.ts");
        assert_eq!(goto.line, 12);
        assert_eq!(goto.character, 5);
    }

    #[test]
    fn diff_collects_two_files() {
        let request = parse_args(
            &["--diff".to_string(), "a.ts".to_string(), "b.ts".to_string()],
            &cwd(),
        );
        assert_eq!(
            request.diff,
            Some([
                "file:///work/a.ts".to_string(),
                "file:///work/b.ts".to_string()
            ])
        );
    }

    #[test]
    fn deep_link_with_query() {
        let request = parse_deep_link("sidex://open?folder=/tmp/ws&file=/tmp/ws/a.md");
        assert_eq!(request.folders, vec!["file:///tmp/ws".to_string()]);
        assert_eq!(request.files, vec!["file:///tmp/ws/a.md".to_string()]);
        assert_eq!(request.source, Some(OpenRequestSource::DeepLink));
    }

    #[test]
    fn deep_link_path_style_decodes_percent_escapes() {
        let request = parse_deep_link("sidex://folder/tmp/my%20project");
        assert_eq!(
            request.folders,
            vec!["file:///tmp/my%20project".to_string()]
        );
    }

    #[test]
    fn empty_argv_produces_nothing_to_do() {
        let request = parse_args(&[], &cwd());
        assert!(request.is_empty());
    }
}
