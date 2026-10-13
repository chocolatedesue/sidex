//! Live SSH smoke against a local sshd.
//! Default: box@127.0.0.1:2222 with ~/.ssh/id_ed25519

use std::path::PathBuf;

use sidex_remote::ssh::{SshAuth, SshTransport};
use sidex_remote::transport::RemoteTransport;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let host = std::env::var("SIDEX_SMOKE_SSH_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port: u16 = std::env::var("SIDEX_SMOKE_SSH_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(2222);
    let user = std::env::var("SIDEX_SMOKE_SSH_USER").unwrap_or_else(|_| {
        std::env::var("USER").unwrap_or_else(|_| "box".into())
    });
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
    let transport = SshTransport::connect_as(&user, &host, port, auth, Some(10)).await?;
    let home = transport.exec("printf %s \"$HOME\"").await?;
    anyhow::ensure!(home.exit_code == 0, "home failed exit={} stderr={}", home.exit_code, home.stderr);
    let home_path = home.stdout.trim();
    anyhow::ensure!(!home_path.is_empty(), "empty home stdout={:?}", home.stdout);
    println!("home={home_path}");

    let entries = transport.read_dir(home_path).await?;
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
    let _ = transport.exec(&format!("rm -f {marker:?}")).await;
    transport.disconnect().await?;
    println!("SIDEX_REMOTE_SSH_LIVE_OK");
    Ok(())
}
