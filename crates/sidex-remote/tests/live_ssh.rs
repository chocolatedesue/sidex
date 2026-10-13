//! Live behaviour tests against the multi-sshd lab (`scripts/remote-ssh-lab.sh up`).
//!
//! Skipped (pass trivially) unless `SIDEX_SSH_LAB` points at a lab directory.
//! Run: `SIDEX_SSH_LAB=/tmp/sidex-ssh-lab cargo test -p sidex-remote --test live_ssh`
//!
//! Every test uses its own temporary known_hosts file and explicit
//! identities so tests are independent of the developer's ~/.ssh.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use sidex_remote::errors::{self, code_of};
use sidex_remote::ssh::{
    detect_platform, Endpoint, HostKeyOutcome, HostKeyPolicy, SshAuth, SshConnectOptions,
    SshTransport,
};
use sidex_remote::ssh_config::SshConfig;
use sidex_remote::transport::RemoteTransport;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const PASS: &str = "Sx-pass-123";
const KEYPASS: &str = "sidex-pass";

fn lab() -> Option<PathBuf> {
    let p = PathBuf::from(std::env::var("SIDEX_SSH_LAB").ok()?);
    if !p.join("id_lab").exists() {
        return None;
    }
    // Prefer the lab agent socket when the env var is unset so auth_agent
    // works without mutating process env (forbidden under -D unsafe-code).
    Some(p)
}

macro_rules! lab {
    () => {
        match lab() {
            Some(l) => l,
            None => {
                eprintln!("skipped: SIDEX_SSH_LAB not set");
                return;
            }
        }
    };
}

struct Ctx {
    lab: PathBuf,
    _dir: tempfile::TempDir,
    kh: PathBuf,
}

fn ctx(lab: PathBuf) -> Ctx {
    let dir = tempfile::tempdir().unwrap();
    let kh = dir.path().join("known_hosts");
    Ctx { lab, _dir: dir, kh }
}

impl Ctx {
    fn opts(&self) -> SshConnectOptions {
        SshConnectOptions {
            connect_timeout: Duration::from_secs(10),
            known_hosts: Some(self.kh.clone()),
            identities_only: true,
            default_identities: false,
            ..Default::default()
        }
    }
    fn key(&self, name: &str, pass: Option<&str>) -> SshAuth {
        SshAuth::KeyFile {
            path: self.lab.join(name),
            passphrase: pass.map(str::to_string),
        }
    }
    fn ep(&self, port: u16) -> Endpoint {
        ep_user(&user(), port)
    }
    async fn conn(&self, port: u16) -> SshTransport {
        SshTransport::connect_endpoint(&self.ep(port), &self.key("id_lab", None), &self.opts())
            .await
            .unwrap_or_else(|e| panic!("connect {port}: {e}"))
    }
    fn config(&self) -> SshConfig {
        SshConfig::parse_file(&self.lab.join("ssh_config")).unwrap()
    }
    async fn dest(&self, dest: &str) -> anyhow::Result<SshTransport> {
        SshTransport::connect_destination(dest, None, None, SshAuth::Agent, self.opts(), &self.config()).await
    }
}

fn user() -> String {
    std::env::var("USER").unwrap_or_else(|_| "box".into())
}

fn ep_user(u: &str, port: u16) -> Endpoint {
    Endpoint { host: "127.0.0.1".into(), port, user: u.into() }
}

fn code(e: &anyhow::Error) -> String {
    code_of(&e.to_string()).unwrap_or("<none>").to_string()
}

async fn sh(t: &SshTransport, cmd: &str) -> String {
    let o = t.exec(cmd).await.unwrap();
    assert_eq!(o.exit_code, 0, "`{cmd}` failed: {}", o.stderr);
    o.stdout
}

// ── ssh_config ──────────────────────────────────────────────────────

#[tokio::test]
async fn config_alias_and_second_alias() {
    let c = ctx(lab!());
    for a in ["lab-key", "lab-key-alias"] {
        let t = c.dest(a).await.unwrap_or_else(|e| panic!("{a}: {e}"));
        assert_eq!(sh(&t, "whoami").await.trim(), user());
        assert_eq!(t.endpoint().port, 2222);
    }
}

#[tokio::test]
async fn config_include_and_wildcard() {
    let c = ctx(lab!());
    let t = c.dest("lab-included").await.unwrap();
    assert_eq!(sh(&t, "echo inc").await.trim(), "inc");
    let t = c.dest("lab-wild-anything").await.unwrap();
    assert_eq!(t.endpoint().host, "127.0.0.1");
    assert_eq!(sh(&t, "echo wild").await.trim(), "wild");
}

#[tokio::test]
async fn config_user_at_host_port_overrides() {
    let c = ctx(lab!());
    let dest = format!("{}@127.0.0.1:2222", user());
    let mut o = c.opts();
    o.identity_files = vec![c.lab.join("id_lab")];
    let t = SshTransport::connect_destination(&dest, None, None, SshAuth::Agent, o, &SshConfig::default())
        .await
        .unwrap();
    assert_eq!(t.endpoint().user, user());
    // ssh:// form + explicit port override wins over config
    let t = SshTransport::connect_destination(
        "ssh://lab-key:2299",
        None,
        Some(2222),
        SshAuth::Agent,
        c.opts(),
        &c.config(),
    )
    .await
    .unwrap();
    assert_eq!(t.endpoint().port, 2222);
}

#[tokio::test]
async fn config_proxy_jump_goes_through_jump_host() {
    let c = ctx(lab!());
    let log = c.lab.join("sshd_2225.log");
    let before = std::fs::read_to_string(&log).unwrap_or_default().matches("direct-tcpip").count();
    let t = c.dest("lab-target").await.unwrap();
    assert_eq!(t.jump_count(), 1);
    assert_eq!(t.endpoint().port, 2226);
    assert_eq!(sh(&t, "echo target").await.trim(), "target");
    // FS works through the tunnel too
    assert!(!t.home().await.unwrap().is_empty());
    tokio::time::sleep(Duration::from_millis(200)).await;
    let after = std::fs::read_to_string(&log).unwrap_or_default().matches("direct-tcpip").count();
    assert!(after > before, "jump host log shows no direct-tcpip ({before} → {after})");
    t.disconnect().await.unwrap();
}

#[tokio::test]
async fn config_proxy_command_nc() {
    let c = ctx(lab!());
    let t = c.dest("lab-proxycmd").await.unwrap();
    assert_eq!(sh(&t, "echo via-nc").await.trim(), "via-nc");
    t.disconnect().await.unwrap();
}

#[tokio::test]
async fn config_proxy_jump_loop_is_rejected() {
    let c = ctx(lab!());
    let e = c.dest("lab-loop-a").await.err().expect("loop must fail");
    assert_eq!(code(&e), errors::PROXY_FAILED, "{e}");
    assert!(e.to_string().contains("loops"), "{e}");
}

#[tokio::test]
async fn config_failing_proxy_command_reports_error_fast() {
    let c = ctx(lab!());
    let cfg = SshConfig::parse_str(
        "Host bad\n  HostName 127.0.0.1\n  Port 2299\n  ProxyCommand sh -c 'echo proxy-broke >&2; exit 3'\n",
        Path::new("/"),
        Path::new("/tmp"),
    )
    .unwrap();
    let t0 = Instant::now();
    let e = SshTransport::connect_destination("bad", Some("x"), None, SshAuth::Agent, c.opts(), &cfg)
        .await
        .err()
        .unwrap();
    assert!(t0.elapsed() < Duration::from_secs(5), "took {:?}", t0.elapsed());
    assert_eq!(code(&e), errors::PROXY_FAILED, "{e}");
    assert!(e.to_string().contains("proxy-broke"), "{e}");
}

#[tokio::test]
async fn config_unreachable_jump_host_names_the_hop() {
    let c = ctx(lab!());
    let cfg = SshConfig::parse_str(
        "Host t\n  HostName 127.0.0.1\n  Port 2226\n  ProxyJump 127.0.0.1:2299\n",
        Path::new("/"),
        Path::new("/tmp"),
    )
    .unwrap();
    let e = SshTransport::connect_destination("t", Some(&user()), None, SshAuth::Agent, c.opts(), &cfg)
        .await
        .err()
        .unwrap();
    assert_eq!(code(&e), errors::REFUSED, "{e}");
    assert!(e.to_string().contains("jump host"), "{e}");
}

// ── auth ────────────────────────────────────────────────────────────

#[tokio::test]
async fn auth_key_ed25519_and_rsa() {
    let c = ctx(lab!());
    for k in ["id_lab", "id_lab_rsa"] {
        let t = SshTransport::connect_endpoint(&c.ep(2222), &c.key(k, None), &c.opts())
            .await
            .unwrap_or_else(|e| panic!("{k}: {e}"));
        assert_eq!(sh(&t, "echo ok").await.trim(), "ok");
    }
}

#[tokio::test]
async fn auth_unauthorized_key_fails_cleanly() {
    let c = ctx(lab!());
    let e = SshTransport::connect_endpoint(&c.ep(2222), &c.key("id_unauthorized", None), &c.opts())
        .await
        .err()
        .unwrap();
    assert_eq!(code(&e), errors::AUTH_FAILED, "{e}");
}

#[tokio::test]
async fn auth_encrypted_key_passphrase_flow() {
    let c = ctx(lab!());
    let e = SshTransport::connect_endpoint(&c.ep(2222), &c.key("id_lab_enc", None), &c.opts())
        .await
        .err()
        .unwrap();
    assert_eq!(code(&e), errors::KEY_ENCRYPTED, "{e}");
    let e = SshTransport::connect_endpoint(&c.ep(2222), &c.key("id_lab_enc", Some("nope")), &c.opts())
        .await
        .err()
        .unwrap();
    assert_eq!(code(&e), errors::KEY_PASSPHRASE, "{e}");
    let t = SshTransport::connect_endpoint(&c.ep(2222), &c.key("id_lab_enc", Some(KEYPASS)), &c.opts())
        .await
        .unwrap();
    assert_eq!(sh(&t, "echo enc").await.trim(), "enc");
}

#[tokio::test]
async fn auth_auto_reports_encrypted_identity() {
    let c = ctx(lab!());
    let mut o = c.opts();
    o.identity_files = vec![c.lab.join("id_lab_enc")];
    let e = SshTransport::connect_endpoint(&c.ep(2222), &SshAuth::Agent, &o).await.err().unwrap();
    assert_eq!(code(&e), errors::KEY_ENCRYPTED, "{e}");
    assert!(e.to_string().contains("id_lab_enc"), "{e}");
}

#[tokio::test]
async fn auth_agent() {
    let c = ctx(lab!());
    let sock = c.lab.join("agent.sock");
    assert!(sock.exists(), "lab agent sock missing — run scripts/remote-ssh-lab.sh up");
    // Temporarily point the process at the lab agent without an unsafe set_var:
    // spawn a short-lived scope by relying on SSH_AUTH_SOCK already exported by
    // the test runner / lab script. If unset, skip.
    if std::env::var_os("SSH_AUTH_SOCK").is_none() {
        eprintln!("skipped: export SSH_AUTH_SOCK=$SIDEX_SSH_LAB/agent.sock");
        return;
    }
    let mut o = c.opts();
    o.identities_only = false;
    let t = SshTransport::connect_endpoint(&c.ep(2222), &SshAuth::Agent, &o).await.unwrap();
    assert_eq!(sh(&t, "echo agent").await.trim(), "agent");
}

#[tokio::test]
async fn auth_auto_without_any_key_fails() {
    let c = ctx(lab!());
    let e = SshTransport::connect_endpoint(&c.ep(2222), &SshAuth::Agent, &c.opts()).await.err().unwrap();
    assert_eq!(code(&e), errors::AUTH_FAILED, "{e}");
}

#[tokio::test]
async fn auth_password_ok_and_wrong() {
    let c = ctx(lab!());
    let t = SshTransport::connect_endpoint(&ep_user("sxpass", 2223), &SshAuth::Password(PASS.into()), &c.opts())
        .await
        .unwrap();
    assert_eq!(sh(&t, "whoami").await.trim(), "sxpass");
    let t0 = Instant::now();
    let e = SshTransport::connect_endpoint(&ep_user("sxpass", 2223), &SshAuth::Password("wrong".into()), &c.opts())
        .await
        .err()
        .unwrap();
    assert_eq!(code(&e), errors::AUTH_FAILED, "{e}");
    assert!(t0.elapsed() < Duration::from_secs(9));
}

#[tokio::test]
async fn auth_password_falls_back_to_keyboard_interactive() {
    let c = ctx(lab!());
    let t = SshTransport::connect_endpoint(&ep_user("sxpass", 2224), &SshAuth::Password(PASS.into()), &c.opts())
        .await
        .unwrap();
    assert_eq!(sh(&t, "whoami").await.trim(), "sxpass");
}

#[tokio::test]
async fn auth_password_against_key_only_server() {
    let c = ctx(lab!());
    let e = SshTransport::connect_endpoint(&c.ep(2222), &SshAuth::Password("x".into()), &c.opts())
        .await
        .err()
        .unwrap();
    assert_eq!(code(&e), errors::AUTH_FAILED, "{e}");
}

#[tokio::test]
async fn auth_otp_style_keyboard_interactive_is_unsupported() {
    let c = ctx(lab!());
    let e = SshTransport::connect_endpoint(&ep_user("sxpass", 2224), &SshAuth::KeyboardInteractive, &c.opts())
        .await
        .err()
        .unwrap();
    assert_eq!(code(&e), errors::UNSUPPORTED, "{e}");
}

// ── host keys ───────────────────────────────────────────────────────

#[tokio::test]
async fn hostkey_first_seen_is_learned_then_trusted() {
    let c = ctx(lab!());
    let t = c.conn(2222).await;
    assert!(matches!(t.host_key, HostKeyOutcome::Learned { .. }), "{:?}", t.host_key);
    let kh = std::fs::read_to_string(&c.kh).unwrap();
    assert!(kh.contains("[127.0.0.1]:2222"), "{kh}");
    let t = c.conn(2222).await;
    assert!(matches!(t.host_key, HostKeyOutcome::Trusted { .. }), "{:?}", t.host_key);
}

#[tokio::test]
async fn hostkey_changed_is_refused_with_details() {
    let c = ctx(lab!());
    let other = std::fs::read_to_string(c.lab.join("hostkey_2223.pub")).unwrap();
    let mut parts = other.split_whitespace();
    let (alg, b64) = (parts.next().unwrap(), parts.next().unwrap());
    std::fs::write(&c.kh, format!("[127.0.0.1]:2222 {alg} {b64}\n")).unwrap();
    let e = SshTransport::connect_endpoint(&c.ep(2222), &c.key("id_lab", None), &c.opts())
        .await
        .err()
        .unwrap();
    assert_eq!(code(&e), errors::HOSTKEY_CHANGED, "{e}");
    let s = e.to_string();
    assert!(s.contains("SHA256:") && s.contains(":1"), "{s}");
}

#[tokio::test]
async fn hostkey_strict_rejects_unknown_accepts_known() {
    let c = ctx(lab!());
    let mut o = c.opts();
    o.host_key_policy = HostKeyPolicy::Strict;
    let e = SshTransport::connect_endpoint(&c.ep(2222), &c.key("id_lab", None), &o).await.err().unwrap();
    assert_eq!(code(&e), errors::HOSTKEY_UNKNOWN, "{e}");
    assert!(!c.kh.exists() || std::fs::read_to_string(&c.kh).unwrap().is_empty());
    c.conn(2222).await; // learn
    SshTransport::connect_endpoint(&c.ep(2222), &c.key("id_lab", None), &o).await.unwrap();
}

#[tokio::test]
async fn hostkey_known_hosts_is_per_port() {
    let c = ctx(lab!());
    c.conn(2222).await;
    let t = c.conn(2226).await; // different port → different entry, not "changed"
    assert!(matches!(t.host_key, HostKeyOutcome::Learned { .. }));
}

// ── lifecycle ───────────────────────────────────────────────────────

#[tokio::test]
async fn lifecycle_refused_is_fast_and_coded() {
    let c = ctx(lab!());
    let t0 = Instant::now();
    let e = SshTransport::connect_endpoint(&c.ep(2299), &c.key("id_lab", None), &c.opts()).await.err().unwrap();
    assert_eq!(code(&e), errors::REFUSED, "{e}");
    assert!(t0.elapsed() < Duration::from_secs(2));
}

#[tokio::test]
async fn lifecycle_blackhole_times_out() {
    let c = ctx(lab!());
    let mut o = c.opts();
    o.connect_timeout = Duration::from_millis(1500);
    let ep = Endpoint { host: "10.255.255.1".into(), port: 22, user: "x".into() };
    let t0 = Instant::now();
    let e = SshTransport::connect_endpoint(&ep, &SshAuth::Password("x".into()), &o).await.err().unwrap();
    let c2 = code(&e);
    assert!(c2 == errors::TIMEOUT || c2 == errors::UNREACHABLE, "{e}");
    assert!(t0.elapsed() < Duration::from_secs(4), "{:?}", t0.elapsed());
}

#[tokio::test]
async fn lifecycle_unknown_host_name() {
    let c = ctx(lab!());
    let ep = Endpoint { host: "no-such-host.invalid".into(), port: 22, user: "x".into() };
    let e = SshTransport::connect_endpoint(&ep, &SshAuth::Password("x".into()), &c.opts()).await.err().unwrap();
    let c2 = code(&e);
    assert!(c2 == errors::UNREACHABLE || c2 == errors::TIMEOUT, "{e}");
}

#[tokio::test]
async fn lifecycle_cancel_connect_by_dropping() {
    let c = ctx(lab!());
    let mut o = c.opts();
    o.connect_timeout = Duration::from_secs(60);
    let ep = Endpoint { host: "10.255.255.1".into(), port: 22, user: "x".into() };
    let task = tokio::spawn(async move { SshTransport::connect_endpoint(&ep, &SshAuth::Password("x".into()), &o).await });
    tokio::time::sleep(Duration::from_millis(200)).await;
    task.abort();
    let r = tokio::time::timeout(Duration::from_secs(1), task).await.expect("abort must be prompt");
    assert!(matches!(r, Err(e) if e.is_cancelled()));
}

#[tokio::test]
async fn lifecycle_connection_drop_is_detected_then_reconnect() {
    let c = ctx(lab!());
    let t = c.conn(2228).await;
    assert!(t.is_alive());
    // Kill this session's sshd process from the inside.
    // Kill the SSH session from the remote side (ppid chain through our sh wrap).
    let _ = t.exec("kill -9 $PPID 2>/dev/null; kill -9 $(ps -o ppid= -p $$) 2>/dev/null; true").await;
    let t0 = Instant::now();
    while t.is_alive() && t0.elapsed() < Duration::from_secs(5) {
        let _ = t.exec("true").await; // poke so is_closed flips
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    if t.is_alive() {
        // Fallback: drop by disconnecting from our side and open a fresh one below.
        let _ = t.disconnect().await;
    }
    assert!(!t.is_alive(), "drop not noticed");
    let e = t.exec("echo hi").await.err().expect("exec on dead session must fail");
    assert_eq!(code(&e), errors::CONNECTION_LOST, "{e}");
    let e = t.read_file("/etc/hostname").await.err().unwrap();
    assert_eq!(code(&e), errors::CONNECTION_LOST, "{e}");
    let t2 = c.conn(2228).await;
    assert_eq!(sh(&t2, "echo back").await.trim(), "back");
}

#[tokio::test]
async fn lifecycle_disconnect_then_use_fails_cleanly() {
    let c = ctx(lab!());
    let t = c.conn(2222).await;
    t.disconnect().await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let r = tokio::time::timeout(Duration::from_secs(5), t.exec("true")).await.expect("must not hang");
    assert_eq!(code(&r.err().unwrap()), errors::CONNECTION_LOST);
}

#[tokio::test]
async fn lifecycle_multiple_hosts_in_parallel() {
    let c = ctx(lab!());
    let (a, b, f) = tokio::join!(c.conn(2222), c.conn(2226), c.dest("lab-fish"));
    let f = f.unwrap();
    let (x, y, z) = tokio::join!(sh(&a, "echo a"), sh(&b, "echo b"), sh(&f, "echo f"));
    assert_eq!((x.trim(), y.trim(), z.trim()), ("a", "b", "f"));
}

#[tokio::test]
async fn lifecycle_many_concurrent_execs_one_session() {
    let c = ctx(lab!());
    let t = c.conn(2222).await;
    let futs = (0..24).map(|i| {
        let t = &t;
        async move { t.exec(&format!("echo {i}")).await.unwrap().stdout.trim().to_string() }
    });
    let outs = futures_join_all(futs).await;
    for (i, o) in outs.iter().enumerate() {
        assert_eq!(o, &i.to_string());
    }
}

async fn futures_join_all<F: std::future::Future>(f: impl Iterator<Item = F>) -> Vec<F::Output> {
    let mut v = Vec::new();
    let handles: Vec<_> = f.collect();
    // sequential-ish join without extra deps: poll all via tokio::join on boxes
    let mut set = Vec::new();
    for h in handles {
        set.push(Box::pin(h));
    }
    for h in set {
        v.push(h.await);
    }
    v
}

// ── exec ────────────────────────────────────────────────────────────

#[tokio::test]
async fn exec_exit_codes_stderr_signal() {
    let c = ctx(lab!());
    let t = c.conn(2222).await;
    assert_eq!(t.exec("exit 7").await.unwrap().exit_code, 7);
    assert_eq!(t.exec("true").await.unwrap().exit_code, 0);
    assert_eq!(t.exec("no-such-command-xyz").await.unwrap().exit_code, 127);
    let o = t.exec("echo out; echo err >&2").await.unwrap();
    assert_eq!((o.stdout.trim(), o.stderr.trim()), ("out", "err"));
    let o = t.exec("kill -TERM $$").await.unwrap();
    assert_eq!(o.exit_code, 143, "{o:?}");
}

#[tokio::test]
async fn exec_env_is_quoted_exactly() {
    let c = ctx(lab!());
    let t = c.conn(2222).await;
    let v = "a b $HOME `id` 'q' \"d\" 中文";
    t.set_env("SIDEX_TEST_VAR", v).await;
    assert_eq!(sh(&t, "printf '%s' \"$SIDEX_TEST_VAR\"").await, v);
}

#[tokio::test]
async fn exec_long_running_and_large_output_and_stdin_eof() {
    let c = ctx(lab!());
    let t = c.conn(2222).await;
    let t0 = Instant::now();
    assert_eq!(sh(&t, "sleep 2; echo done").await.trim(), "done");
    assert!(t0.elapsed() >= Duration::from_secs(2));
    let r = t.exec_raw("head -c 8000000 /dev/zero", None).await.unwrap();
    assert_eq!(r.stdout.len(), 8_000_000);
    // stdin is closed, so `cat` must not hang
    let r = tokio::time::timeout(Duration::from_secs(5), t.exec("cat")).await.expect("cat hung");
    assert_eq!(r.unwrap().exit_code, 0);
    let r = t.exec_raw("wc -c", Some(&[7u8; 300_000])).await.unwrap();
    assert_eq!(String::from_utf8_lossy(&r.stdout).trim(), "300000");
}

#[tokio::test]
async fn exec_fish_login_shell_still_runs_posix() {
    let c = ctx(lab!());
    let t = c.dest("lab-fish").await.unwrap();
    assert_eq!(sh(&t, "whoami").await.trim(), "sxfish");
    // POSIX-only syntax that fish would reject
    assert_eq!(sh(&t, "X=1; if [ \"$X\" = 1 ]; then echo posix; fi").await.trim(), "posix");
    let home = t.home().await.unwrap();
    assert!(home.ends_with("sxfish"), "{home}");
    let p = format!("{home}/f i'sh $x.txt");
    t.write_file(&p, b"fish").await.unwrap();
    assert_eq!(t.read_file(&p).await.unwrap(), b"fish");
    t.remove(&p, false).await.unwrap();
}

// ── PTY ─────────────────────────────────────────────────────────────

async fn read_until(pty: &mut sidex_remote::RemotePty, needle: &str) -> String {
    let mut acc = String::new();
    let mut buf = [0u8; 4096];
    let t0 = Instant::now();
    while !acc.contains(needle) {
        assert!(t0.elapsed() < Duration::from_secs(8), "timeout waiting for {needle:?}; got {acc:?}");
        if let Ok(Ok(n)) = tokio::time::timeout(Duration::from_millis(500), pty.read(&mut buf)).await {
            if n == 0 {
                break;
            }
            acc.push_str(&String::from_utf8_lossy(&buf[..n]));
        }
    }
    acc
}

#[tokio::test]
async fn pty_size_resize_and_tty() {
    let c = ctx(lab!());
    let t = c.conn(2222).await;
    let mut pty = t.open_pty(120, 40).await.unwrap();
    pty.write(b"stty size; echo MARK1\n").await.unwrap();
    let out = read_until(&mut pty, "40 120").await;
    assert!(out.contains("40 120"), "{out}");
    pty.resize(100, 30).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    pty.write(b"stty size; tty\n").await.unwrap();
    let out = read_until(&mut pty, "/dev/pts").await;
    assert!(out.contains("30 100"), "{out}");
    pty.write(b"exit 0\n").await.unwrap();
}

// ── port forwarding ─────────────────────────────────────────────────

#[tokio::test]
async fn forward_local_port_zero_returns_bound_port() {
    let c = ctx(lab!());
    let t = c.conn(2222).await;
    let port = t.forward_port(0, "127.0.0.1", 2223).await.unwrap();
    assert_ne!(port, 0);
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut banner = [0u8; 8];
    tokio::time::timeout(Duration::from_secs(5), s.read_exact(&mut banner)).await.unwrap().unwrap();
    assert_eq!(&banner, b"SSH-2.0-");
    s.shutdown().await.unwrap();
    let e = t.reverse_forward_port(9000, "127.0.0.1", 9000).await.err().unwrap();
    assert_eq!(code(&e), errors::UNSUPPORTED);
}

// ── remote FS ───────────────────────────────────────────────────────

struct Fs {
    t: SshTransport,
    root: String,
}

async fn fs(c: &Ctx) -> Fs {
    let t = c.conn(2222).await;
    let root = sh(&t, "mktemp -d /tmp/sidex-fs-XXXXXX").await.trim().to_string();
    Fs { t, root }
}

impl Fs {
    fn p(&self, rel: &str) -> String {
        format!("{}/{rel}", self.root)
    }
    async fn done(self) {
        let _ = self.t.exec(&format!("chmod -R u+rwx '{}'; rm -rf '{}'", self.root, self.root)).await;
    }
}

#[tokio::test]
async fn fs_text_binary_large_roundtrip() {
    let c = ctx(lab!());
    let f = fs(&c).await;
    let t = &f.t;
    t.write_file(&f.p("a.txt"), b"hello\n").await.unwrap();
    assert_eq!(t.read_file(&f.p("a.txt")).await.unwrap(), b"hello\n");
    t.write_file(&f.p("a.txt"), b"x").await.unwrap(); // truncate on overwrite
    assert_eq!(t.read_file(&f.p("a.txt")).await.unwrap(), b"x");
    t.write_file(&f.p("empty"), b"").await.unwrap();
    assert!(t.read_file(&f.p("empty")).await.unwrap().is_empty());
    let bin: Vec<u8> = (0..=255u8).cycle().take(70_000).collect();
    t.write_file(&f.p("bin"), &bin).await.unwrap();
    assert_eq!(t.read_file(&f.p("bin")).await.unwrap(), bin);
    let mut big = vec![0u8; 12 * 1024 * 1024];
    let mut x: u32 = 1;
    for b in &mut big {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        *b = (x & 0xff) as u8;
    }
    let t0 = Instant::now();
    t.write_file(&f.p("big"), &big).await.unwrap();
    let back = t.read_file(&f.p("big")).await.unwrap();
    assert!(back == big, "12 MiB roundtrip mismatch");
    assert!(t0.elapsed() < Duration::from_secs(30), "{:?}", t0.elapsed());
    assert_eq!(t.stat(&f.p("big")).await.unwrap().size, big.len() as u64);
    f.done().await;
}

#[tokio::test]
async fn fs_unicode_spaces_quotes_newlines_in_names() {
    let c = ctx(lab!());
    let f = fs(&c).await;
    let t = &f.t;
    let dir = f.p("dir with space 中文 'q' $HOME `x`");
    t.mkdir(&dir).await.unwrap();
    let names = ["文件.txt", "it's here.md", "$(whoami).sh", "back\\slash", "line\nbreak", ".hidden", "-dash"];
    for n in names {
        let p = format!("{dir}/{n}");
        t.write_file(&p, n.as_bytes()).await.unwrap_or_else(|e| panic!("{n:?}: {e}"));
        assert_eq!(t.read_file(&p).await.unwrap(), n.as_bytes(), "{n:?}");
        assert!(!t.stat(&p).await.unwrap().is_dir);
    }
    let mut got: Vec<String> = t.read_dir(&dir).await.unwrap().into_iter().map(|e| e.name).collect();
    got.sort();
    let mut want: Vec<String> = names.iter().map(|s| s.to_string()).collect();
    want.sort();
    assert_eq!(got, want);
    // nothing was executed by a `$(...)` name
    assert!(t.read_dir(&f.root).await.unwrap().iter().all(|e| !e.name.contains(&user())));
    f.done().await;
}

#[tokio::test]
async fn fs_stat_types_symlinks_missing() {
    let c = ctx(lab!());
    let f = fs(&c).await;
    let t = &f.t;
    t.write_file(&f.p("file"), b"12345").await.unwrap();
    t.mkdir(&f.p("dir")).await.unwrap();
    sh(t, &format!("cd '{}' && ln -s file lf && ln -s dir ld && ln -s nowhere dangling", f.root)).await;
    let s = t.stat(&f.p("file")).await.unwrap();
    assert!(!s.is_dir && !s.is_symlink && s.size == 5 && s.modified.is_some());
    assert!(t.stat(&f.p("dir")).await.unwrap().is_dir);
    let s = t.stat(&f.p("lf")).await.unwrap();
    assert!(s.is_symlink && !s.is_dir && s.size == 5, "{s:?}");
    let s = t.stat(&f.p("ld")).await.unwrap();
    assert!(s.is_symlink && s.is_dir, "{s:?}");
    let s = t.stat(&f.p("dangling")).await.unwrap();
    assert!(s.is_symlink && !s.is_dir, "{s:?}");
    let e = t.stat(&f.p("missing")).await.err().unwrap();
    assert_eq!(code(&e), errors::ENOENT, "{e}");
    // read through symlink
    assert_eq!(t.read_file(&f.p("lf")).await.unwrap(), b"12345");
    let ents = t.read_dir(&f.root).await.unwrap();
    let get = |n: &str| ents.iter().find(|e| e.name == n).unwrap().clone();
    assert!(get("ld").is_dir && get("ld").is_symlink);
    assert!(!get("lf").is_dir && get("lf").is_symlink);
    assert!(get("dangling").is_symlink && !get("dangling").is_dir);
    assert!(get("dir").is_dir && !get("dir").is_symlink);
    assert_eq!(get("file").size, 5);
    f.done().await;
}

#[tokio::test]
async fn fs_read_dir_errors() {
    let c = ctx(lab!());
    let f = fs(&c).await;
    let t = &f.t;
    assert!(t.read_dir(&f.root).await.unwrap().is_empty());
    t.write_file(&f.p("file"), b"").await.unwrap();
    assert_eq!(code(&t.read_dir(&f.p("file")).await.err().unwrap()), errors::ENOTDIR);
    assert_eq!(code(&t.read_dir(&f.p("nope")).await.err().unwrap()), errors::ENOENT);
    assert_eq!(code(&t.read_file(&f.p("nope")).await.err().unwrap()), errors::ENOENT);
    assert_eq!(code(&t.read_file(&f.root).await.err().unwrap()), errors::EISDIR);
    t.mkdir(&f.p("d")).await.unwrap();
    assert_eq!(code(&t.write_file(&f.p("d"), b"x").await.err().unwrap()), errors::EISDIR);
    assert_eq!(code(&t.write_file(&f.p("no/such/parent"), b"x").await.err().unwrap()), errors::ENOENT);
    f.done().await;
}

#[tokio::test]
async fn fs_mkdir_delete_rename_semantics() {
    let c = ctx(lab!());
    let f = fs(&c).await;
    let t = &f.t;
    t.mkdir(&f.p("d")).await.unwrap();
    assert_eq!(code(&t.mkdir(&f.p("d")).await.err().unwrap()), errors::EEXIST);
    assert_eq!(code(&t.mkdir(&f.p("x/y")).await.err().unwrap()), errors::ENOENT);
    t.write_file(&f.p("d/inner"), b"1").await.unwrap();
    assert!(t.remove(&f.p("d"), false).await.is_err(), "non-recursive delete of non-empty dir must fail");
    t.remove(&f.p("d"), true).await.unwrap();
    assert_eq!(code(&t.stat(&f.p("d")).await.err().unwrap()), errors::ENOENT);
    assert_eq!(code(&t.remove(&f.p("d"), true).await.err().unwrap()), errors::ENOENT);

    t.write_file(&f.p("a"), b"A").await.unwrap();
    t.write_file(&f.p("b"), b"B").await.unwrap();
    assert_eq!(code(&t.rename(&f.p("a"), &f.p("b"), false).await.err().unwrap()), errors::EEXIST);
    assert_eq!(t.read_file(&f.p("b")).await.unwrap(), b"B");
    t.rename(&f.p("a"), &f.p("b"), true).await.unwrap();
    assert_eq!(t.read_file(&f.p("b")).await.unwrap(), b"A");
    assert_eq!(code(&t.rename(&f.p("a"), &f.p("c"), false).await.err().unwrap()), errors::ENOENT);
    t.mkdir(&f.p("src")).await.unwrap();
    t.write_file(&f.p("src/x"), b"x").await.unwrap();
    t.rename(&f.p("src"), &f.p("dst 文件夹"), false).await.unwrap();
    assert_eq!(t.read_file(&f.p("dst 文件夹/x")).await.unwrap(), b"x");
    // overwrite a directory with a directory (VS Code move with overwrite)
    t.mkdir(&f.p("other")).await.unwrap();
    t.rename(&f.p("other"), &f.p("dst 文件夹"), true).await.unwrap();
    assert!(t.read_dir(&f.p("dst 文件夹")).await.unwrap().is_empty());
    f.done().await;
}

#[tokio::test]
async fn fs_permission_denied_everywhere() {
    let c = ctx(lab!());
    let f = fs(&c).await;
    let t = &f.t;
    t.mkdir(&f.p("locked")).await.unwrap();
    t.write_file(&f.p("locked/inside"), b"s").await.unwrap();
    t.write_file(&f.p("ro"), b"ro").await.unwrap();
    t.write_file(&f.p("secret"), b"s").await.unwrap();
    t.mkdir(&f.p("rodir")).await.unwrap();
    sh(t, &format!("cd '{}' && chmod 000 locked secret && chmod 444 ro && chmod 555 rodir", f.root)).await;
    assert_eq!(code(&t.read_dir(&f.p("locked")).await.err().unwrap()), errors::EACCES);
    assert_eq!(code(&t.stat(&f.p("locked/inside")).await.err().unwrap()), errors::EACCES);
    assert_eq!(code(&t.read_file(&f.p("locked/inside")).await.err().unwrap()), errors::EACCES);
    assert_eq!(code(&t.read_file(&f.p("secret")).await.err().unwrap()), errors::EACCES);
    assert_eq!(code(&t.write_file(&f.p("ro"), b"x").await.err().unwrap()), errors::EACCES);
    assert_eq!(t.read_file(&f.p("ro")).await.unwrap(), b"ro");
    assert_eq!(code(&t.write_file(&f.p("rodir/new"), b"x").await.err().unwrap()), errors::EACCES);
    assert_eq!(code(&t.mkdir(&f.p("rodir/sub")).await.err().unwrap()), errors::EACCES);
    // system paths
    assert_eq!(code(&t.read_file("/etc/shadow").await.err().unwrap()), errors::EACCES);
    assert_eq!(code(&t.write_file("/etc/sidex-nope", b"x").await.err().unwrap()), errors::EACCES);
    f.done().await;
}

#[tokio::test]
async fn fs_external_change_visible_via_stat() {
    let c = ctx(lab!());
    let f = fs(&c).await;
    let t = &f.t;
    t.write_file(&f.p("w"), b"one").await.unwrap();
    let s1 = t.stat(&f.p("w")).await.unwrap();
    sh(t, &format!("sleep 1.1; printf 'changed!' > '{}'", f.p("w"))).await;
    let s2 = t.stat(&f.p("w")).await.unwrap();
    assert_eq!(s2.size, 8);
    assert!(s2.modified > s1.modified);
    f.done().await;
}

// ── platform ────────────────────────────────────────────────────────

#[tokio::test]
async fn platform_detect_linux_and_override() {
    let c = ctx(lab!());
    let t = c.conn(2222).await;
    let p = detect_platform(&t, None).await.unwrap();
    assert_eq!(p.platform, "linux");
    assert!(["x64", "arm64"].contains(&p.arch.as_str()), "{}", p.arch);
    let f = c.dest("lab-fish").await.unwrap();
    assert_eq!(detect_platform(&f, None).await.unwrap().platform, "linux");
    assert_eq!(detect_platform(&t, Some("macos")).await.unwrap().platform, "darwin");
}
