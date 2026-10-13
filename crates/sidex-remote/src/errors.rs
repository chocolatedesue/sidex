//! Stable, machine-readable error codes for remote operations.
//!
//! Errors are plain `anyhow` errors whose message starts with `[SIDEX_<CODE>]`.
//! The prefix survives the Tauri `String` boundary so the TypeScript side can
//! map it to a `FileSystemProviderError` / a precise notification without
//! fragile message matching.

pub const TIMEOUT: &str = "SIDEX_TIMEOUT";
pub const REFUSED: &str = "SIDEX_REFUSED";
pub const UNREACHABLE: &str = "SIDEX_UNREACHABLE";
pub const HOSTKEY_CHANGED: &str = "SIDEX_HOSTKEY_CHANGED";
pub const HOSTKEY_UNKNOWN: &str = "SIDEX_HOSTKEY_UNKNOWN";
pub const AUTH_FAILED: &str = "SIDEX_AUTH_FAILED";
pub const KEY_ENCRYPTED: &str = "SIDEX_KEY_ENCRYPTED";
pub const KEY_PASSPHRASE: &str = "SIDEX_KEY_PASSPHRASE";
pub const CONNECTION_LOST: &str = "SIDEX_CONNECTION_LOST";
pub const CANCELLED: &str = "SIDEX_CANCELLED";
pub const PROXY_FAILED: &str = "SIDEX_PROXY_FAILED";
pub const ENOENT: &str = "SIDEX_ENOENT";
pub const EACCES: &str = "SIDEX_EACCES";
pub const EEXIST: &str = "SIDEX_EEXIST";
pub const ENOTDIR: &str = "SIDEX_ENOTDIR";
pub const EISDIR: &str = "SIDEX_EISDIR";
pub const UNSUPPORTED: &str = "SIDEX_UNSUPPORTED";

/// Build an error tagged with `code`.
pub fn coded(code: &str, msg: impl std::fmt::Display) -> anyhow::Error {
    anyhow::anyhow!("[{code}] {msg}")
}

/// Extract the code (without brackets) from an error message, if any.
pub fn code_of(msg: &str) -> Option<&str> {
    let start = msg.find("[SIDEX_")?;
    let rest = &msg[start + 1..];
    let end = rest.find(']')?;
    Some(&rest[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let e = coded(TIMEOUT, "took too long");
        assert_eq!(e.to_string(), "[SIDEX_TIMEOUT] took too long");
        assert_eq!(code_of(&e.to_string()), Some(TIMEOUT));
        assert_eq!(code_of(&format!("ctx: {e}")), Some(TIMEOUT));
        assert_eq!(code_of("plain"), None);
    }
}
