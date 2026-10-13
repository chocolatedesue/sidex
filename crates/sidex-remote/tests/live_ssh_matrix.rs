//! Live SSH behaviour matrix. Needs `scripts/remote-ssh-lab.sh up`
//! and `SIDEX_SSH_LAB=/tmp/sidex-ssh-lab`; skipped otherwise.
use std::path::PathBuf;
use std::time::{Duration, Instant};

use sidex_remote::errors::{self, code_of};
use sidex_remote::ssh::*;
use sidex_remote::ssh_config::SshConfig;
use sidex_remote::transport::RemoteTransport;

fn lab() -> Option<PathBuf> {
    let p = PathBuf::from(std::env::var("SIDEX_SSH_LAB").ok()?);
    std::env::set_var("SSH_AUTH_SOCK", p.join("agent.sock"));
    Some(p)
}
macro_rules! lab { () => { match lab() { Some(l) => l, None => { eprintln!("skip: no lab"); return; } } }; }

fn user() -> String { std::env::var("USER").unwrap_or("box".into()) }
fn opts(l: &PathBuf, kh: &str) -> SshConnectOptions {
    let kh = l.join(format!("kh_{kh}"));
    let _ = std::fs::remove_file(&kh);
    SshConnectOptions { known_hosts: Some(kh), identities_only: true, default_identities: false,
        connect_timeout: Duration::from_secs(8), ..Default::default() }
}
fn ep(port: u16, u: &str) -> Endpoint { Endpoint { host: "127.0.0.1".into(), port, user: u.into() } }
fn key(l: &PathBuf, n: &str, pp: Option<&str>) -> SshAuth { SshAuth::KeyFile { path: l.join(n), passphrase: pp.map(Into::into) } }
fn code(r: Result<SshTransport, anyhow::Error>) -> String {
    let e = r.err().expect("expected error").to_string(); code_of(&e).unwrap_or(&e).to_string()
}
async fn key_conn(l: &PathBuf, kh: &str) -> SshTransport {
    SshTransport::connect_endpoint(&ep(2222, &user()), &key(l, "id_lab", None), &opts(l, kh)).await.unwrap()
}
fn cfg(l: &PathBuf) -> SshConfig { SshConfig::parse_file(&l.join("ssh_config")).unwrap() }

// ── auth ──
#[tokio::test] async fn auth_key_ok() { let l = lab!(); assert_eq!(key_conn(&l, "a1").await.home().await.unwrap(), std::env::var("HOME").unwrap()); }
#[tokio::test] async fn auth_rsa_key_ok() { let l = lab!(); SshTransport::connect_endpoint(&ep(2222,&user()), &key(&l,"id_lab_rsa",None), &opts(&l,"a2")).await.unwrap(); }
#[tokio::test] async fn auth_encrypted_key_needs_passphrase() { let l = lab!();
    assert_eq!(code(SshTransport::connect_endpoint(&ep(2222,&user()), &key(&l,"id_lab_enc",None), &opts(&l,"a3")).await), errors::KEY_ENCRYPTED); }
#[tokio::test] async fn auth_encrypted_key_right_passphrase() { let l = lab!();
    SshTransport::connect_endpoint(&ep(2222,&user()), &key(&l,"id_lab_enc",Some("sidex-pass")), &opts(&l,"a4")).await.unwrap(); }
#[tokio::test] async fn auth_encrypted_key_wrong_passphrase() { let l = lab!();
    let c = code(SshTransport::connect_endpoint(&ep(2222,&user()), &key(&l,"id_lab_enc",Some("nope")), &opts(&l,"a5")).await);
    assert!(c == errors::KEY_PASSPHRASE || c == errors::KEY_ENCRYPTED, "{c}"); }
#[tokio::test] async fn auth_unauthorized_key() { let l = lab!();
    assert_eq!(code(SshTransport::connect_endpoint(&ep(2222,&user()), &key(&l,"id_unauthorized",None), &opts(&l,"a6")).await), errors::AUTH_FAILED); }
#[tokio::test] async fn auth_agent() { let l = lab!(); let mut o = opts(&l,"a7"); o.identities_only = false;
    SshTransport::connect_endpoint(&ep(2222,&user()), &SshAuth::Agent, &o).await.unwrap(); }
#[tokio::test] async fn auth_agent_identityfile_fallback() { let l = lab!(); let mut o = opts(&l,"a8"); o.identity_files = vec![l.join("id_lab")];
    SshTransport::connect_endpoint(&ep(2222,&user()), &SshAuth::Agent, &o).await.unwrap(); }
#[tokio::test] async fn auth_password_ok() { let l = lab!();
    SshTransport::connect_endpoint(&ep(2223,"sxpass"), &SshAuth::Password("Sx-pass-123".into()), &opts(&l,"a9")).await.unwrap(); }
#[tokio::test] async fn auth_password_wrong() { let l = lab!();
    assert_eq!(code(SshTransport::connect_endpoint(&ep(2223,"sxpass"), &SshAuth::Password("bad".into()), &opts(&l,"a10")).await), errors::AUTH_FAILED); }
#[tokio::test] async fn auth_keyboard_interactive_via_password() { let l = lab!();
    SshTransport::connect_endpoint(&ep(2224,"sxpass"), &SshAuth::Password("Sx-pass-123".into()), &opts(&l,"a11")).await.unwrap(); }
#[tokio::test] async fn auth_key_rejected_on_password_only_host() { let l = lab!();
    assert_eq!(code(SshTransport::connect_endpoint(&ep(2223,"sxpass"), &key(&l,"id_lab",None), &opts(&l,"a12")).await), errors::AUTH_FAILED); }

// ── host keys ──
#[tokio::test] async fn hostkey_first_seen_learned_then_trusted() { let l = lab!(); let o = opts(&l,"h1");
    let a = SshTransport::connect_endpoint(&ep(2222,&user()), &key(&l,"id_lab",None), &o).await.unwrap();
    assert!(matches!(a.host_key, HostKeyOutcome::Learned{..}));
    assert!(std::fs::read_to_string(o.known_hosts.clone().unwrap()).unwrap().contains("[127.0.0.1]:2222"));
    let b = SshTransport::connect_endpoint(&ep(2222,&user()), &key(&l,"id_lab",None), &o).await.unwrap();
    assert!(matches!(b.host_key, HostKeyOutcome::Trusted{..})); }
#[tokio::test] async fn hostkey_changed_rejected() { let l = lab!(); let o = opts(&l,"h2");
    let other = std::fs::read_to_string(l.join("hostkey_2223.pub")).unwrap();
    let mut it = other.split_whitespace();
    std::fs::write(o.known_hosts.clone().unwrap(), format!("[127.0.0.1]:2222 {} {}\n", it.next().unwrap(), it.next().unwrap())).unwrap();
    assert_eq!(code(SshTransport::connect_endpoint(&ep(2222,&user()), &key(&l,"id_lab",None), &o).await), errors::HOSTKEY_CHANGED); }
#[tokio::test] async fn hostkey_strict_unknown_rejected() { let l = lab!(); let mut o = opts(&l,"h3"); o.host_key_policy = HostKeyPolicy::Strict;
    assert_eq!(code(SshTransport::connect_endpoint(&ep(2222,&user()), &key(&l,"id_lab",None), &o).await), errors::HOSTKEY_UNKNOWN); }

// ── lifecycle ──
#[tokio::test] async fn refused() { let l = lab!(); assert_eq!(code(SshTransport::connect_endpoint(&ep(2299,&user()), &key(&l,"id_lab",None), &opts(&l,"l1")).await), errors::REFUSED); }
#[tokio::test] async fn unreachable_or_timeout() { let l = lab!(); let mut o = opts(&l,"l2"); o.connect_timeout = Duration::from_secs(2);
    let t = Instant::now(); let e = Endpoint{host:"10.255.255.1".into(),port:22,user:"x".into()};
    let c = code(SshTransport::connect_endpoint(&e, &key(&l,"id_lab",None), &o).await);
    assert!(c == errors::TIMEOUT || c == errors::UNREACHABLE, "{c}"); assert!(t.elapsed() < Duration::from_secs(5)); }
#[tokio::test] async fn unknown_host_dns() { let l = lab!(); let e = Endpoint{host:"no-such-host.invalid".into(),port:22,user:"x".into()};
    // sandbox DNS may hang instead of NXDOMAIN; either way it is bounded + coded
    let c = code(SshTransport::connect_endpoint(&e, &key(&l,"id_lab",None), &opts(&l,"l3")).await);
    assert!(c == errors::UNREACHABLE || c == errors::TIMEOUT, "{c}"); }
#[tokio::test] async fn multiple_hosts_in_parallel() { let l = lab!();
    let (e1, e2, e3) = (ep(2222,&user()), ep(2223,"sxpass"), ep(2227,"sxfish"));
    let (k1, k2, k3) = (key(&l,"id_lab",None), SshAuth::Password("Sx-pass-123".into()), key(&l,"id_lab",None));
    let (o1, o2, o3) = (opts(&l,"l4a"), opts(&l,"l4b"), opts(&l,"l4c"));
    let (a, b, c) = tokio::join!(
        SshTransport::connect_endpoint(&e1, &k1, &o1),
        SshTransport::connect_endpoint(&e2, &k2, &o2),
        SshTransport::connect_endpoint(&e3, &k3, &o3));
    assert_eq!(a.unwrap().exec("whoami").await.unwrap().stdout.trim(), user());
    assert_eq!(b.unwrap().exec("whoami").await.unwrap().stdout.trim(), "sxpass");
    assert_eq!(c.unwrap().exec("whoami").await.unwrap().stdout.trim(), "sxfish"); }
#[tokio::test] async fn cancel_during_connect() { let l = lab!(); let o = opts(&l,"l5");
    let h = tokio::spawn(async move { let e = Endpoint{host:"10.255.255.1".into(),port:22,user:"x".into()};
        SshTransport::connect_endpoint(&e, &SshAuth::Agent, &o).await.map(|_|()) });
    tokio::time::sleep(Duration::from_millis(200)).await; h.abort(); assert!(h.await.unwrap_err().is_cancelled()); }
#[tokio::test] async fn disconnect_mid_session_then_reconnect() { let l = lab!(); let lab_sh = "../../scripts/remote-ssh-lab.sh";
    let o = opts(&l,"l6");
    let t = SshTransport::connect_endpoint(&ep(2228,&user()), &key(&l,"id_lab",None), &o).await.unwrap();
    assert!(t.is_alive());
    // Kill our own sshd session process while a command is running.
    let r = tokio::time::timeout(Duration::from_secs(10), t.exec("kill -9 $PPID; sleep 30; echo late")).await.expect("exec must not hang");
    let msg = r.err().map(|e| e.to_string()).unwrap_or_default();
    assert_eq!(code_of(&msg), Some(errors::CONNECTION_LOST), "{msg}");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!t.is_alive());
    let r = tokio::time::timeout(Duration::from_secs(5), t.read_file("/etc/hostname")).await.expect("no hang");
    assert_eq!(code_of(&r.unwrap_err().to_string()), Some(errors::CONNECTION_LOST));
    // Host goes down, comes back while we are backing off.
    std::process::Command::new(lab_sh).arg("kill-flaky").status().unwrap();
    let starter = tokio::spawn(async move { tokio::time::sleep(Duration::from_millis(1200)).await;
        std::process::Command::new("../../scripts/remote-ssh-lab.sh").arg("start-flaky").status().unwrap(); });
    let mut c = SshConnection::new("127.0.0.1", 2228, &user(), key(&l,"id_lab",None)); c.options = o;
    c.reconnect_with_backoff(6).await.unwrap(); starter.await.unwrap();
    assert_eq!(c.exec_command("echo back").await.unwrap().stdout.trim(), "back"); }
#[tokio::test] async fn reconnect_does_not_retry_auth_failures() { let l = lab!();
    let mut c = SshConnection::new("127.0.0.1", 2222, &user(), key(&l,"id_unauthorized",None)); c.options = opts(&l,"l7");
    let t = Instant::now(); let e = c.reconnect_with_backoff(5).await.unwrap_err().to_string();
    assert_eq!(code_of(&e), Some(errors::AUTH_FAILED)); assert!(t.elapsed() < Duration::from_secs(3)); }

// ── ssh_config driven ──
async fn via(l: &PathBuf, alias: &str, kh: &str) -> Result<SshTransport, anyhow::Error> {
    SshTransport::connect_destination(alias, None, None, SshAuth::Agent, opts(l, kh), &cfg(l)).await }
#[tokio::test] async fn config_alias_hostname_port_user_identity() { let l = lab!();
    let t = via(&l,"lab-key","c1").await.unwrap(); assert_eq!(t.endpoint().port, 2222); assert_eq!(t.exec("whoami").await.unwrap().stdout.trim(), user()); }
#[tokio::test] async fn config_second_alias_on_same_line() { let l = lab!(); via(&l,"lab-key-alias","c2").await.unwrap(); }
#[tokio::test] async fn config_include_glob() { let l = lab!(); via(&l,"lab-included","c3").await.unwrap(); }
#[tokio::test] async fn config_wildcard_block() { let l = lab!(); via(&l,"lab-wild-anything","c4").await.unwrap(); }
#[tokio::test] async fn config_user_at_override() { let l = lab!();
    // user@alias overrides the config User (lab authorizes the key for all users)
    let t = SshTransport::connect_destination("sxpass@lab-key", None, None, SshAuth::Agent, opts(&l,"c5"), &cfg(&l)).await.unwrap();
    assert_eq!(t.exec("whoami").await.unwrap().stdout.trim(), "sxpass");
    let t = SshTransport::connect_destination("lab-key", Some("sxfish"), Some(2227), SshAuth::Agent, opts(&l,"c5b"), &cfg(&l)).await.unwrap();
    assert_eq!(t.exec("whoami").await.unwrap().stdout.trim(), "sxfish"); }
#[tokio::test] async fn config_proxyjump_uses_direct_tcpip() { let l = lab!();
    let t = via(&l,"lab-target","c6").await.unwrap(); assert_eq!(t.jump_count(), 1);
    assert_eq!(t.exec("echo $SSH_CONNECTION").await.unwrap().stdout.split_whitespace().nth(3), Some("2226"));
    let log = std::process::Command::new("sudo").args(["cat"]).arg(l.join("sshd_2225.log")).output().unwrap();
    assert!(String::from_utf8_lossy(&log.stdout).contains("target 127.0.0.1 port 2226")); }
#[tokio::test] async fn config_proxyjump_loop_rejected() { let l = lab!(); assert_eq!(code(via(&l,"lab-loop-a","c7").await), errors::PROXY_FAILED); }
#[tokio::test] async fn config_proxycommand() { let l = lab!(); let t = via(&l,"lab-proxycmd","c8").await.unwrap(); assert_eq!(t.exec("echo pc").await.unwrap().stdout.trim(), "pc"); }
#[tokio::test] async fn config_proxycommand_broken() { let l = lab!(); let c = SshConfig::parse_str("Host bad\n HostName 127.0.0.1\n ProxyCommand sh -c 'echo nope >&2; exit 3'\n", &l, &l).unwrap();
    let e = SshTransport::connect_destination("bad", None, None, SshAuth::Agent, opts(&l,"c9"), &c).await.err().unwrap().to_string();
    assert!(matches!(code_of(&e), Some(errors::PROXY_FAILED | errors::CONNECTION_LOST)), "{e}"); }

// ── exec ──
#[tokio::test] async fn exec_exit_codes_stderr_env() { let l = lab!(); let t = key_conn(&l,"e1").await;
    assert_eq!(t.exec("exit 7").await.unwrap().exit_code, 7);
    let r = t.exec("echo out; echo err >&2; false").await.unwrap(); assert_eq!((r.stdout.trim(), r.stderr.trim(), r.exit_code), ("out","err",1));
    t.set_env("SIDEX_X", "a b$c'd").await; assert_eq!(t.exec("printf %s \"$SIDEX_X\"").await.unwrap().stdout, "a b$c'd");
    let r = t.exec("kill -9 $$").await.unwrap(); assert_eq!(r.exit_code, 137); }
#[tokio::test] async fn exec_fish_login_shell_is_bypassed() { let l = lab!();
    let t = SshTransport::connect_endpoint(&ep(2227,"sxfish"), &key(&l,"id_lab",None), &opts(&l,"e2")).await.unwrap();
    assert_eq!(t.exec("x=1; [ \"$x\" = 1 ] && echo posix").await.unwrap().stdout.trim(), "posix");
    let p = format!("/tmp/sx fish ü {}", std::process::id()); t.write_file(&p, b"hi").await.unwrap();
    assert_eq!(t.read_file(&p).await.unwrap(), b"hi"); t.remove(&p,false).await.unwrap(); }
#[tokio::test] async fn exec_long_running_and_concurrent() { let l = lab!(); let t = key_conn(&l,"e3").await;
    let s = Instant::now(); let (a,b) = tokio::join!(t.exec("sleep 1; echo a"), t.exec("sleep 1; echo b"));
    assert_eq!(a.unwrap().stdout.trim(),"a"); assert_eq!(b.unwrap().stdout.trim(),"b"); assert!(s.elapsed() < Duration::from_millis(1900)); }
#[tokio::test] async fn exec_large_output() { let l = lab!(); let t = key_conn(&l,"e4").await;
    assert_eq!(t.exec("head -c 5000000 /dev/zero | tr '\\0' x").await.unwrap().stdout.len(), 5_000_000); }

// ── pty ──
#[tokio::test] async fn pty_io_and_resize() { let l = lab!(); let t = key_conn(&l,"p1").await;
    let mut p = t.open_pty(80, 24).await.unwrap();
    p.resize(132, 40).await.unwrap(); tokio::time::sleep(Duration::from_millis(300)).await;
    p.write(b"stty size; tty; exit\n").await.unwrap();
    let mut all = Vec::new(); let mut buf = [0u8; 4096];
    let _ = tokio::time::timeout(Duration::from_secs(5), async { loop { let n = p.read(&mut buf).await.unwrap_or(0); if n==0 {break;} all.extend_from_slice(&buf[..n]); } }).await;
    let s = String::from_utf8_lossy(&all); assert!(s.contains("40 132"), "{s}"); assert!(s.contains("/dev/pts/"), "{s}"); }

// ── port forwarding ──
#[tokio::test] async fn local_forward_port_zero() { let l = lab!(); let t = key_conn(&l,"f1").await;
    let port = t.forward_port(0, "127.0.0.1", 2223).await.unwrap(); assert_ne!(port, 0);
    use tokio::io::AsyncReadExt; let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut b = [0u8; 7]; s.read_exact(&mut b).await.unwrap(); assert_eq!(&b, b"SSH-2.0"); }
#[tokio::test] async fn reverse_forward_unsupported() { let l = lab!(); let t = key_conn(&l,"f2").await;
    assert_eq!(code_of(&t.reverse_forward_port(9,"x",9).await.unwrap_err().to_string()), Some(errors::UNSUPPORTED)); }

// ── remote fs ──
fn tmp(n: &str) -> String { format!("/tmp/sidex-fs-{}-{n}", std::process::id()) }
fn ec(r: anyhow::Result<impl std::fmt::Debug>) -> String { let e = r.unwrap_err().to_string(); code_of(&e).unwrap_or(&e).to_string() }
#[tokio::test] async fn fs_crud_rename_mkdir() { let l = lab!(); let t = key_conn(&l,"fs1").await; let d = tmp("crud");
    t.mkdir(&d).await.unwrap(); assert_eq!(ec(t.mkdir(&d).await), errors::EEXIST);
    let f = format!("{d}/a.txt"); t.write_file(&f, b"one").await.unwrap(); assert_eq!(t.stat(&f).await.unwrap().size, 3);
    t.write_file(&f, b"").await.unwrap(); assert_eq!(t.read_file(&f).await.unwrap(), b"");
    let g = format!("{d}/b.txt"); t.write_file(&g, b"b").await.unwrap();
    assert_eq!(ec(t.rename(&f,&g,false).await), errors::EEXIST); t.rename(&f,&g,true).await.unwrap();
    assert_eq!(ec(t.stat(&f).await), errors::ENOENT);
    let names: Vec<_> = t.read_dir(&d).await.unwrap().into_iter().map(|e| e.name).collect(); assert_eq!(names, vec!["b.txt"]);
    assert_eq!(ec(t.remove(&format!("{d}/zz"),false).await), errors::ENOENT);
    assert!(t.remove(&d,false).await.is_err()); t.remove(&d,true).await.unwrap(); assert_eq!(ec(t.stat(&d).await), errors::ENOENT); }
#[tokio::test] async fn fs_binary_and_large() { let l = lab!(); let t = key_conn(&l,"fs2").await; let f = tmp("bin");
    let data: Vec<u8> = (0..8_000_000u32).map(|i| (i.wrapping_mul(2654435761) >> 13) as u8).collect();
    t.write_file(&f, &data).await.unwrap(); assert_eq!(t.read_file(&f).await.unwrap(), data);
    t.write_file(&f, &[0,0xff,0xfe,b'\n',0x80]).await.unwrap(); assert_eq!(t.read_file(&f).await.unwrap(), vec![0,0xff,0xfe,b'\n',0x80]); t.remove(&f,false).await.unwrap(); }
#[tokio::test] async fn fs_weird_names() { let l = lab!(); let t = key_conn(&l,"fs3").await; let d = tmp("weird"); t.mkdir(&d).await.unwrap();
    let names = ["sp ace.txt","dollar$HOME","quote'q\"","中文 文件.md","back`tick`","-dash","new\nline","tab\tx",".hidden","emoji😀"];
    for n in names { t.write_file(&format!("{d}/{n}"), n.as_bytes()).await.unwrap(); }
    let got: Vec<_> = t.read_dir(&d).await.unwrap().into_iter().map(|e| e.name).collect();
    for n in names { assert!(got.contains(&n.to_string()), "{n:?} missing from {got:?}"); assert_eq!(t.read_file(&format!("{d}/{n}")).await.unwrap(), n.as_bytes()); }
    t.remove(&d,true).await.unwrap(); }
#[tokio::test] async fn fs_symlinks() { let l = lab!(); let t = key_conn(&l,"fs4").await; let d = tmp("ln"); t.mkdir(&d).await.unwrap();
    t.mkdir(&format!("{d}/real")).await.unwrap(); t.write_file(&format!("{d}/f"), b"12345").await.unwrap();
    t.exec(&format!("cd '{d}' && ln -s real dl && ln -s f fl && ln -s nowhere broken")).await.unwrap();
    let s = t.stat(&format!("{d}/dl")).await.unwrap(); assert!(s.is_dir && s.is_symlink);
    let s = t.stat(&format!("{d}/fl")).await.unwrap(); assert!(!s.is_dir && s.is_symlink && s.size == 5);
    let s = t.stat(&format!("{d}/broken")).await.unwrap(); assert!(s.is_symlink && !s.is_dir);
    let e = t.read_dir(&d).await.unwrap(); let dl = e.iter().find(|e| e.name=="dl").unwrap(); assert!(dl.is_dir && dl.is_symlink);
    assert!(e.iter().any(|e| e.name=="broken" && e.is_symlink)); t.remove(&d,true).await.unwrap(); }
#[tokio::test] async fn fs_permission_denied_and_kinds() { let l = lab!(); let t = key_conn(&l,"fs5").await; let d = tmp("perm"); t.mkdir(&d).await.unwrap();
    let ro = format!("{d}/ro"); t.write_file(&ro, b"x").await.unwrap(); t.exec(&format!("chmod 000 '{ro}'")).await.unwrap();
    assert_eq!(ec(t.read_file(&ro).await), errors::EACCES); assert_eq!(ec(t.write_file(&ro, b"y").await), errors::EACCES);
    let locked = format!("{d}/locked"); t.mkdir(&locked).await.unwrap(); t.write_file(&format!("{locked}/in"), b"").await.unwrap();
    t.exec(&format!("chmod 000 '{locked}'")).await.unwrap();
    assert_eq!(ec(t.read_dir(&locked).await), errors::EACCES); assert_eq!(ec(t.stat(&format!("{locked}/in")).await), errors::EACCES);
    assert_eq!(ec(t.read_file(&d).await), errors::EISDIR); assert_eq!(ec(t.read_dir(&format!("{d}/ro")).await), errors::ENOTDIR);
    assert_eq!(ec(t.write_file(&format!("{d}/nodir/x"), b"").await), errors::ENOENT);
    assert_eq!(ec(t.read_file("/etc/shadow").await), errors::EACCES);
    t.exec(&format!("chmod -R 755 '{d}'")).await.unwrap(); t.remove(&d,true).await.unwrap(); }
#[tokio::test] async fn fs_external_change_visible() { let l = lab!(); let t = key_conn(&l,"fs6").await; let f = tmp("ext");
    t.write_file(&f, b"a").await.unwrap(); let m1 = t.stat(&f).await.unwrap();
    std::fs::write(&f, b"changed-outside").unwrap(); // same box = same fs
    let s = t.stat(&f).await.unwrap(); assert_eq!(s.size, 15); assert!(s.modified >= m1.modified);
    assert_eq!(t.read_file(&f).await.unwrap(), b"changed-outside"); std::fs::remove_file(&f).unwrap(); }
#[tokio::test] async fn platform_detect() { let l = lab!(); let t = key_conn(&l,"pl").await;
    let p = detect_platform(&t, None).await.unwrap(); assert_eq!(p.platform, "linux"); assert!(["x64","arm64"].contains(&p.arch.as_str()));
    let t2 = SshTransport::connect_endpoint(&ep(2227,"sxfish"), &key(&l,"id_lab",None), &opts(&l,"pl2")).await.unwrap();
    assert_eq!(detect_platform(&t2, None).await.unwrap().platform, "linux"); }
