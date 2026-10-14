//! Remote platform detection (OS / arch / shell), mirroring the behaviour
//! that `jeanp413/open-remote-ssh` tests in `detect-platform.test.ts`.

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemotePlatformInfo {
    /// `linux`, `darwin`, `freebsd`, `dragonfly`, `windows`.
    pub platform: String,
    /// `x64`, `arm64`, `armhf`, `ppc64le`, `riscv64`, `loong64`, `s390x`.
    pub arch: String,
    /// `bash` (POSIX), `powershell` or `cmd`.
    pub shell: String,
}

/// Map `uname -s` output to a platform id.
pub fn parse_kernel_name(name: &str) -> Result<String> {
    let n = name.trim();
    let id = match n.to_ascii_lowercase().as_str() {
        "linux" => "linux",
        "darwin" => "darwin",
        "freebsd" => "freebsd",
        "dragonfly" => "dragonfly",
        _ => bail!("platform not supported: {n}"),
    };
    Ok(id.to_string())
}

/// Map `uname -m` output to an arch id.
pub fn parse_machine_arch(arch: &str) -> Result<String> {
    let a = arch.trim();
    let id = match a {
        "x86_64" | "amd64" => "x64",
        "armv7l" | "armv8l" => "armhf",
        "arm64" | "aarch64" => "arm64",
        "ppc64le" => "ppc64le",
        "riscv64" => "riscv64",
        "loongarch64" => "loong64",
        "s390x" => "s390x",
        _ => bail!("architecture not supported: {a}"),
    };
    Ok(id.to_string())
}

/// Result of running a probe command: `(stdout, stderr)`.
pub type Probe = (String, String);

/// Detect the remote platform from `uname -s` / `uname -m` probe results.
///
/// `run` executes a command on the remote and returns `(stdout, stderr)`.
/// `override_platform` mirrors `remote.SSH.remotePlatform` (`linux`, `macos`,
/// `windows`); when set to a unix value `uname -s` is skipped.
pub async fn detect_platform<F, Fut>(
    mut run: F,
    override_platform: Option<&str>,
) -> Result<RemotePlatformInfo>
where
    F: FnMut(&'static str) -> Fut,
    Fut: std::future::Future<Output = Result<Probe>>,
{
    let forced = override_platform.map(|p| match p {
        "macos" => "darwin".to_string(),
        other => other.to_string(),
    });

    let platform = match forced.as_deref() {
        Some(p) if p != "windows" => p.to_string(),
        _ => {
            let (out, err) = run("uname -s").await?;
            let out_t = out.trim();
            if out_t.is_empty() {
                let err_t = err.trim();
                if err_t.contains("CommandNotFoundException") {
                    return Ok(windows("powershell"));
                }
                if err_t.contains("is not recognized as an internal or external command") {
                    return Ok(windows("cmd"));
                }
                if !err_t.is_empty() {
                    bail!("Cannot execute \"uname -s\", yields: {err_t}");
                }
                bail!("\"uname -s\" yields empty result");
            }
            if out_t.eq_ignore_ascii_case("windows32") {
                return Ok(windows("powershell"));
            }
            if out_t.starts_with("MINGW")
                || out_t.starts_with("MSYS")
                || out_t.starts_with("CYGWIN")
            {
                return Ok(windows("bash"));
            }
            parse_kernel_name(out_t)?
        }
    };

    let (out, err) = run("uname -m").await?;
    let out_t = out.trim();
    if out_t.is_empty() {
        let err_t = err.trim();
        if !err_t.is_empty() {
            bail!("Cannot execute \"uname -m\", yields: {err_t}");
        }
        bail!("\"uname -m\" yields empty result");
    }
    Ok(RemotePlatformInfo {
        platform,
        arch: parse_machine_arch(out_t)?,
        shell: "bash".into(),
    })
}

fn windows(shell: &str) -> RemotePlatformInfo {
    RemotePlatformInfo {
        platform: "windows".into(),
        arch: "x64".into(),
        shell: shell.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    fn fake(
        responses: &[(&'static str, &str, &str)],
    ) -> (
        impl FnMut(
            &'static str,
        )
            -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Probe>> + Send>>,
        Arc<Mutex<Vec<String>>>,
    ) {
        let map: HashMap<&'static str, (String, String)> = responses
            .iter()
            .map(|(c, o, e)| (*c, ((*o).to_string(), (*e).to_string())))
            .collect();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let calls2 = Arc::clone(&calls);
        let f = move |cmd: &'static str| {
            calls2.lock().unwrap().push(cmd.to_string());
            let r = map.get(cmd).cloned();
            Box::pin(async move { r.ok_or_else(|| anyhow::anyhow!("unexpected command: {cmd}")) })
                as std::pin::Pin<Box<dyn std::future::Future<Output = Result<Probe>> + Send>>
        };
        (f, calls)
    }

    fn block<T>(f: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(f)
    }

    #[test]
    fn kernel_names() {
        for (i, e) in [
            ("Darwin", "darwin"),
            ("Linux", "linux"),
            ("FreeBSD", "freebsd"),
            ("DragonFly", "dragonfly"),
        ] {
            assert_eq!(parse_kernel_name(i).unwrap(), e);
        }
        let err = parse_kernel_name("SunOS").unwrap_err().to_string();
        assert_eq!(err, "platform not supported: SunOS");
    }

    #[test]
    fn machine_arches() {
        for (i, e) in [
            ("x86_64", "x64"),
            ("amd64", "x64"),
            ("armv7l", "armhf"),
            ("armv8l", "armhf"),
            ("arm64", "arm64"),
            ("aarch64", "arm64"),
            ("ppc64le", "ppc64le"),
            ("riscv64", "riscv64"),
            ("loongarch64", "loong64"),
            ("s390x", "s390x"),
        ] {
            assert_eq!(parse_machine_arch(i).unwrap(), e);
        }
        assert_eq!(
            parse_machine_arch("i686").unwrap_err().to_string(),
            "architecture not supported: i686"
        );
    }

    #[test]
    fn linux_x64_trims_newlines() {
        let (f, _) = fake(&[("uname -s", "Linux\n", ""), ("uname -m", "x86_64\n", "")]);
        let r = block(detect_platform(f, None)).unwrap();
        assert_eq!(r.platform, "linux");
        assert_eq!(r.arch, "x64");
        assert_eq!(r.shell, "bash");
    }

    #[test]
    fn darwin_arm64_and_freebsd() {
        let (f, _) = fake(&[("uname -s", "Darwin\n", ""), ("uname -m", "arm64\n", "")]);
        let r = block(detect_platform(f, None)).unwrap();
        assert_eq!((r.platform.as_str(), r.arch.as_str()), ("darwin", "arm64"));
        let (f, _) = fake(&[("uname -s", "FreeBSD\n", ""), ("uname -m", "amd64\n", "")]);
        let r = block(detect_platform(f, None)).unwrap();
        assert_eq!((r.platform.as_str(), r.arch.as_str()), ("freebsd", "x64"));
    }

    #[test]
    fn unsupported_and_empty_errors() {
        let (f, _) = fake(&[("uname -s", "SunOS\n", "")]);
        assert!(block(detect_platform(f, None))
            .unwrap_err()
            .to_string()
            .contains("platform not supported: SunOS"));
        let (f, _) = fake(&[("uname -s", "Linux\n", ""), ("uname -m", "i686\n", "")]);
        assert!(block(detect_platform(f, None))
            .unwrap_err()
            .to_string()
            .contains("architecture not supported: i686"));
        let (f, _) = fake(&[("uname -s", "\n", "")]);
        assert!(block(detect_platform(f, None))
            .unwrap_err()
            .to_string()
            .contains("\"uname -s\" yields empty result"));
        let (f, _) = fake(&[("uname -s", "Linux", ""), ("uname -m", "", "")]);
        assert!(block(detect_platform(f, None))
            .unwrap_err()
            .to_string()
            .contains("\"uname -m\" yields empty result"));
        let (f, _) = fake(&[("uname -s", "", "sh: uname: not found")]);
        assert!(block(detect_platform(f, None))
            .unwrap_err()
            .to_string()
            .contains("Cannot execute \"uname -s\", yields: sh: uname: not found"));
        let (f, _) = fake(&[("uname -s", "Linux", ""), ("uname -m", "", "boom")]);
        assert!(block(detect_platform(f, None))
            .unwrap_err()
            .to_string()
            .contains("Cannot execute \"uname -m\", yields: boom"));
    }

    #[test]
    fn windows_variants() {
        let (f, calls) = fake(&[(
            "uname -s",
            "",
            "uname : The term 'uname' is not recognized...\n + FullyQualifiedErrorId : CommandNotFoundException",
        )]);
        let r = block(detect_platform(f, None)).unwrap();
        assert_eq!(
            (r.platform.as_str(), r.shell.as_str()),
            ("windows", "powershell")
        );
        assert_eq!(calls.lock().unwrap().len(), 1, "arch not probed on windows");

        let (f, _) = fake(&[(
            "uname -s",
            "",
            "'uname' is not recognized as an internal or external command,\r\noperable program or batch file.",
        )]);
        assert_eq!(block(detect_platform(f, None)).unwrap().shell, "cmd");

        let (f, _) = fake(&[("uname -s", "windows32\r\n", "")]);
        assert_eq!(block(detect_platform(f, None)).unwrap().shell, "powershell");

        let (f, _) = fake(&[("uname -s", "MINGW64_NT-10.0-19045\n", "")]);
        let r = block(detect_platform(f, None)).unwrap();
        assert_eq!((r.platform.as_str(), r.shell.as_str()), ("windows", "bash"));

        let (f, calls) = fake(&[("uname -s", "MINGW64_NT-10.0\n", "")]);
        assert_eq!(
            block(detect_platform(f, Some("windows"))).unwrap().shell,
            "bash"
        );
        assert_eq!(calls.lock().unwrap()[0], "uname -s");
    }

    #[test]
    fn remote_platform_override() {
        let (f, calls) = fake(&[("uname -m", "aarch64\n", "")]);
        let r = block(detect_platform(f, Some("linux"))).unwrap();
        assert_eq!((r.platform.as_str(), r.arch.as_str()), ("linux", "arm64"));
        assert!(!calls.lock().unwrap().iter().any(|c| c == "uname -s"));
        let (f, _) = fake(&[("uname -m", "arm64\n", "")]);
        assert_eq!(
            block(detect_platform(f, Some("macos"))).unwrap().platform,
            "darwin"
        );
    }
}
