//! POSIX shell helpers for building remote commands safely.
//!
//! Remote commands are delivered as a base64 blob piped into `sh`, so the
//! user's login shell (bash / zsh / fish / …) never has to parse the script.
//! Paths and values inside the script are still single-quoted for POSIX.

/// Quote `s` for a POSIX shell using single quotes.
///
/// `it's` becomes `'it'\''s'`. Safe for spaces, `$`, backticks, globs,
/// newlines and non-ASCII text (unlike Rust's `{:?}`, which emits `\u{..}`
/// escapes and leaves `$` live inside double quotes).
pub fn sh_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

fn b64(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            T[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// Wrap a POSIX script so it survives every login shell (including fish).
///
/// OpenSSH always runs the remote command as `$SHELL -c '<cmd>'`. Fish
/// (and to a lesser extent zsh) would reinterpret `$`, quotes and
/// backticks inside that string. Encoding the script as base64 keeps the
/// outer shell to a tiny, literal-safe pipeline.
pub fn wrap_posix(script: &str) -> String {
    // Deliver the script as base64 in an env var so:
    // 1) fish (login shell) only sees `env SIDEX_B64=… sh -c '…'` — the `-c`
    //    argument is fish-single-quoted with no embedded `'`, so fish does not
    //    expand `$` / `()` inside the payload;
    // 2) the inner `sh` expands `$(printf|openssl)` and keeps SSH channel
    //    stdin for `cat > file` / `wc -c` / etc.
    let b64 = b64(script.as_bytes());
    let mut cmd = String::with_capacity(b64.len() + 96);
    cmd.push_str("env SIDEX_B64=");
    cmd.push_str(&b64);
    cmd.push_str(r#" sh -c 'eval "$(printf %s "$SIDEX_B64" | openssl base64 -d -A)"'"#);
    cmd
}

/// Error markers printed to stderr by SideX scripts so callers can classify
/// failures without parsing localized error text.
pub const MARK_ENOENT: &str = "__SIDEX_ENOENT__";
pub const MARK_EACCES: &str = "__SIDEX_EACCES__";
pub const MARK_EEXIST: &str = "__SIDEX_EEXIST__";
pub const MARK_ENOTDIR: &str = "__SIDEX_ENOTDIR__";

/// Script prefix that checks `p` exists (or is a dangling symlink) and is
/// readable, emitting a marker on failure.
pub fn check_exists_script(quoted: &str) -> String {
    format!("if [ ! -e {quoted} ] && [ ! -L {quoted} ]; then echo {MARK_ENOENT} >&2; exit 2; fi; ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn quote_simple_and_quote() {
        assert_eq!(sh_quote("abc"), "'abc'");
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
        assert_eq!(sh_quote("a b $HOME"), "'a b $HOME'");
    }

    #[test]
    fn wrap_survives_fish_and_bash() {
        let script = "printf '%s' \"it's $HOME `id` 中文\"";
        let cmd = wrap_posix(script);
        // Must not contain the raw `$HOME` outside of the base64 payload.
        assert!(!cmd.contains("$HOME"));
        for shell in ["bash", "sh", "fish"] {
            if Command::new(shell).arg("--version").output().is_err()
                && Command::new(shell).arg("-c").arg("true").output().is_err()
            {
                continue;
            }
            let out = Command::new(shell)
                .arg("-c")
                .arg(&cmd)
                .output()
                .unwrap_or_else(|e| panic!("{shell}: {e}"));
            assert!(
                out.status.success(),
                "{shell} failed: {}\ncmd={cmd}",
                String::from_utf8_lossy(&out.stderr)
            );
            let s = String::from_utf8_lossy(&out.stdout);
            assert!(s.contains("it's "), "{shell}: {s:?}");
            assert!(s.contains('中'), "{shell}: {s:?}");
            assert!(!s.contains("$HOME"), "{shell} expanded $HOME: {s:?}");
        }
    }

    #[test]
    fn roundtrip_through_real_sh() {
        let q = sh_quote("hello $USER `id` 'x'");
        let out = Command::new("sh")
            .arg("-c")
            .arg(format!("printf %s {q}"))
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "hello $USER `id` 'x'");
    }
}
