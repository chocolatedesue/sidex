//! Live SSH smoke against a local sshd.
//! Default: $USER@127.0.0.1:2222 with ~/.ssh/id_ed25519

use std::path::PathBuf;
use std::time::Duration;

use sidex_remote::ssh::{Endpoint, HostKeyPolicy, SshAuth, SshConnectOptions, SshTransport};
use sidex_remote::transport::RemoteTransport;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let host = std::env::var("SIDEX_SMOKE_SSH_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port: u16 = std::env::var("SIDEX_SMOKE_SSH_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(2222);
    let user = std::env::var("SIDEX_SMOKE_SSH_USER")
        .unwrap_or_else(|_| std::env::var("USER").unwrap_or_else(|_| "box".into()));
    let key = std::env::var("SIDEX_SMOKE_SSH_KEY").unwrap_or_else(|_| {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".ssh/id_ed25519")
            .to_string_lossy()
            .into_owned()
    });

    println!("connect {user}@{host}:{port} key={key}");
    let auth = SshAuth::KeyFile {
        path: PathBuf::from(&key),
        passphrase: None,
    };
    // Isolated known_hosts so lab host-key rotation never fails the smoke.
    let kh = std::env::temp_dir().join(format!("sidex-smoke-kh-{}-{port}", std::process::id()));
    let opts = SshConnectOptions {
        connect_timeout: Duration::from_secs(10),
        known_hosts: Some(kh),
        host_key_policy: HostKeyPolicy::AcceptNew,
        keepalive_interval: Some(Duration::from_secs(10)),
        ..Default::default()
    };
    let ep = Endpoint {
        host: host.clone(),
        port,
        user: user.clone(),
    };
    let transport = SshTransport::connect_endpoint(&ep, &auth, &opts).await?;
    let home_path = transport.home().await?;
    anyhow::ensure!(!home_path.is_empty(), "empty home");
    println!("home={home_path}");

    let entries = transport.read_dir(&home_path).await?;
    println!("readdir count={}", entries.len());
    for e in entries.iter().take(8) {
        println!("  {} {}", if e.is_dir { "d" } else { "-" }, e.name);
    }

    let marker = format!("{home_path}/.sidex-remote-ssh-smoke");
    transport
        .write_file(&marker, b"sidex-remote-ssh-ok\n")
        .await?;
    let back = transport.read_file(&marker).await?;
    anyhow::ensure!(
        String::from_utf8_lossy(&back).contains("sidex-remote-ssh-ok"),
        "roundtrip mismatch"
    );
    let _ = transport.remove(&marker, false).await;
    transport.disconnect().await?;
    println!("SIDEX_REMOTE_SSH_LIVE_OK");
    Ok(())
}
