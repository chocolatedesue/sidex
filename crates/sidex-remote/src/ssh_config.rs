//! OpenSSH client config (`~/.ssh/config`) parsing and host resolution.
//!
//! Semantics follow `ssh_config(5)` closely enough for Remote-SSH use:
//! * `Host a b *.corp !bastion` multi-pattern lines with wildcards/negation
//! * first obtained value wins (except `IdentityFile`, which accumulates)
//! * `Include` (globs, relative to `~/.ssh`, nested, inside Host/Match blocks)
//! * `Match all` / `Match host <patterns>`; other `Match` criteria never match
//! * `Key Value`, `Key=Value`, `Key = "quoted value"`
//! * tokens `%h %p %r %u %d %n %%` in `HostName`, `IdentityFile`, `ProxyCommand`
//!
//! The ProxyJump resolution logic mirrors `resolveProxyJumps` from
//! `jeanp413/open-remote-ssh` (ordering, loop detection, max length).

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

/// OpenSSH caps Include recursion at 16 levels.
pub const MAX_INCLUDE_DEPTH: usize = 16;
/// Upper bound for a ProxyJump chain (same order of magnitude as upstream).
pub const MAX_PROXY_JUMPS: usize = 10;

#[derive(Debug, Clone, Default)]
struct Block {
    /// Patterns from `Host` (or `Match host`). Empty + `match_all` = global.
    patterns: Vec<String>,
    match_all: bool,
    never: bool,
    /// (lowercased keyword, raw value)
    options: Vec<(String, String)>,
}

impl Block {
    fn matches(&self, alias: &str) -> bool {
        if self.never {
            return false;
        }
        if self.match_all {
            return true;
        }
        host_matches(&self.patterns, alias)
    }
}

/// Does `alias` match the pattern list (OpenSSH semantics: any negated match
/// rejects; otherwise any positive match accepts)?
pub fn host_matches(patterns: &[String], alias: &str) -> bool {
    let mut positive = false;
    for p in patterns {
        if let Some(neg) = p.strip_prefix('!') {
            if glob_match(neg, alias) {
                return false;
            }
        } else if glob_match(p, alias) {
            positive = true;
        }
    }
    positive
}

/// Minimal `*` / `?` glob matcher (case-insensitive like OpenSSH hostnames).
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let t: Vec<char> = text.to_lowercase().chars().collect();
    glob_inner(&p, &t)
}

fn glob_inner(p: &[char], t: &[char]) -> bool {
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut mark) = (None::<usize>, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

fn glob_match_case(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    glob_inner(&p, &t)
}

/// Split a config value into arguments, honouring double quotes.
pub fn split_args(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_q = false;
    let mut has = false;
    for ch in value.chars() {
        match ch {
            '"' => {
                in_q = !in_q;
                has = true;
            }
            c if c.is_whitespace() && !in_q => {
                if has {
                    out.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            c => {
                cur.push(c);
                has = true;
            }
        }
    }
    if has {
        out.push(cur);
    }
    out
}

/// Split one config line into `(keyword, value)`. Supports `Key=Value`.
fn split_line(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let end = line
        .find(|c: char| c.is_whitespace() || c == '=')
        .unwrap_or(line.len());
    let key = &line[..end];
    let mut rest = line[end..].trim_start();
    if let Some(r) = rest.strip_prefix('=') {
        rest = r.trim_start();
    }
    if key.is_empty() {
        return None;
    }
    Some((key.to_ascii_lowercase(), rest.trim_end().to_string()))
}

fn unquote(v: &str) -> String {
    let v = v.trim();
    if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') {
        v[1..v.len() - 1].to_string()
    } else {
        v.to_string()
    }
}

/// Expand a leading `~` / `~/`.
pub fn expand_tilde(p: &str, home: &Path) -> PathBuf {
    if p == "~" {
        home.to_path_buf()
    } else if let Some(rest) = p.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(p)
    }
}

/// Parsed client configuration.
#[derive(Debug, Clone, Default)]
pub struct SshConfig {
    blocks: Vec<Block>,
    /// Concrete host aliases in file order (from `Host` lines without globs).
    aliases: Vec<String>,
    home: PathBuf,
}

/// All settings that apply to one destination after merging every matching
/// block.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedHost {
    pub alias: String,
    pub hostname: String,
    pub port: u16,
    pub user: Option<String>,
    pub identity_files: Vec<PathBuf>,
    pub identities_only: bool,
    pub proxy_jump: Option<String>,
    pub proxy_command: Option<String>,
    pub forward_agent: bool,
    pub server_alive_interval: Option<u64>,
    pub server_alive_count_max: Option<u32>,
    pub connect_timeout: Option<u64>,
    pub strict_host_key_checking: Option<String>,
    pub user_known_hosts_file: Option<PathBuf>,
    pub send_env: Vec<String>,
    pub set_env: Vec<(String, String)>,
    pub remote_command: Option<String>,
}

impl SshConfig {
    /// Parse config text. `base_dir` is the directory relative `Include`s are
    /// resolved against (normally `~/.ssh`).
    pub fn parse_str(contents: &str, base_dir: &Path, home: &Path) -> Result<Self> {
        let mut cfg = Self {
            blocks: vec![Block {
                match_all: true,
                ..Block::default()
            }],
            aliases: Vec::new(),
            home: home.to_path_buf(),
        };
        cfg.parse_into(contents, base_dir, 0)?;
        Ok(cfg)
    }

    /// Parse a config file from disk.
    pub fn parse_file(path: &Path) -> Result<Self> {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
        let base = path
            .parent()
            .map_or_else(|| home.join(".ssh"), Path::to_path_buf);
        let text =
            std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        Self::parse_str(&text, &base, &home)
    }

    /// Load `~/.ssh/config` (or `$SIDEX_SSH_CONFIG`). Missing file = empty.
    pub fn load_default() -> Result<Self> {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
        let path = std::env::var_os("SIDEX_SSH_CONFIG")
            .map_or_else(|| home.join(".ssh/config"), PathBuf::from);
        if path.exists() {
            Self::parse_file(&path)
        } else {
            Self::parse_str("", &home.join(".ssh"), &home)
        }
    }

    fn parse_into(&mut self, contents: &str, base_dir: &Path, depth: usize) -> Result<()> {
        if depth > MAX_INCLUDE_DEPTH {
            bail!("ssh config: Include nested too deeply (> {MAX_INCLUDE_DEPTH}), possible loop");
        }
        // Lines before the first Host in an included file belong to the
        // including block; remember it so we can restore after the include.
        let entry_block = self.blocks.len() - 1;
        for raw in contents.lines() {
            let Some((key, value)) = split_line(raw) else {
                continue;
            };
            match key.as_str() {
                "host" => {
                    let patterns = split_args(&value);
                    for p in &patterns {
                        if !p.contains(['*', '?', '!']) && !self.aliases.iter().any(|a| a == p) {
                            self.aliases.push(p.clone());
                        }
                    }
                    let match_all = patterns.iter().any(|p| p == "*")
                        && patterns.iter().all(|p| !p.starts_with('!'));
                    self.blocks.push(Block {
                        patterns,
                        match_all,
                        ..Block::default()
                    });
                }
                "match" => {
                    let args = split_args(&value);
                    let mut block = Block::default();
                    match args.first().map(|s| s.to_ascii_lowercase()).as_deref() {
                        Some("all") => block.match_all = true,
                        Some("host") | Some("originalhost") => {
                            block.patterns = args
                                .get(1)
                                .map(|v| v.split(',').map(str::to_string).collect())
                                .unwrap_or_default();
                        }
                        _ => block.never = true,
                    }
                    self.blocks.push(block);
                }
                "include" => {
                    let current = self.blocks.len() - 1;
                    for pat in split_args(&value) {
                        let full = expand_tilde(&pat, &self.home);
                        let full = if full.is_absolute() {
                            full
                        } else {
                            base_dir.join(full)
                        };
                        for file in glob_paths(&full) {
                            let text = match std::fs::read_to_string(&file) {
                                Ok(t) => t,
                                Err(_) => continue,
                            };
                            // Included pre-Host lines apply to the includer's block.
                            let before = self.blocks.len();
                            self.parse_into(&text, base_dir, depth + 1)?;
                            let _ = before;
                        }
                    }
                    // Lines after Include continue the block that contained it
                    // (OpenSSH restores the active state on return).
                    let resume = self.blocks[current].clone();
                    if self.blocks.len() - 1 != current {
                        self.blocks.push(Block {
                            options: Vec::new(),
                            ..resume
                        });
                    }
                }
                _ => {
                    if let Some(b) = self.blocks.last_mut() {
                        b.options.push((key, value));
                    }
                }
            }
        }
        let _ = entry_block;
        Ok(())
    }

    /// Concrete host aliases (no wildcards), in file order, Includes expanded.
    pub fn hosts(&self) -> Vec<String> {
        self.aliases.clone()
    }

    /// Merge every matching block for `alias` (first value wins).
    pub fn resolve(&self, alias: &str) -> ResolvedHost {
        let mut r = ResolvedHost {
            alias: alias.to_string(),
            ..ResolvedHost::default()
        };
        let mut hostname: Option<String> = None;
        let mut port: Option<u16> = None;
        let mut seen = std::collections::HashSet::<String>::new();
        for b in &self.blocks {
            if !b.matches(alias) {
                continue;
            }
            for (k, v) in &b.options {
                let val = unquote(v);
                let first = !seen.contains(k);
                match k.as_str() {
                    "identityfile" => {
                        r.identity_files.push(PathBuf::from(val));
                        continue;
                    }
                    "sendenv" => {
                        r.send_env.extend(split_args(v));
                        continue;
                    }
                    _ => {}
                }
                if !first {
                    continue;
                }
                seen.insert(k.clone());
                match k.as_str() {
                    "hostname" => hostname = Some(val),
                    "port" => port = val.parse().ok(),
                    "user" => r.user = Some(val),
                    "proxyjump" => {
                        r.proxy_jump = if val.eq_ignore_ascii_case("none") {
                            None
                        } else {
                            Some(val)
                        }
                    }
                    "proxycommand" => {
                        r.proxy_command = if v.trim().eq_ignore_ascii_case("none") {
                            None
                        } else {
                            Some(v.trim().to_string())
                        }
                    }
                    "forwardagent" => r.forward_agent = val.eq_ignore_ascii_case("yes"),
                    "identitiesonly" => r.identities_only = val.eq_ignore_ascii_case("yes"),
                    "serveraliveinterval" => r.server_alive_interval = val.parse().ok(),
                    "serveralivecountmax" => r.server_alive_count_max = val.parse().ok(),
                    "connecttimeout" => r.connect_timeout = val.parse().ok(),
                    "stricthostkeychecking" => {
                        r.strict_host_key_checking = Some(val.to_ascii_lowercase())
                    }
                    "userknownhostsfile" => {
                        r.user_known_hosts_file =
                            split_args(v).first().map(|p| expand_tilde(p, &self.home))
                    }
                    "setenv" => {
                        for kv in split_args(v) {
                            if let Some((a, b)) = kv.split_once('=') {
                                r.set_env.push((a.to_string(), b.to_string()));
                            }
                        }
                    }
                    "remotecommand" => r.remote_command = Some(val),
                    _ => {}
                }
            }
        }
        r.port = port.unwrap_or(22);
        let raw_host = hostname.unwrap_or_else(|| alias.to_string());
        r.hostname = expand_tokens(
            &raw_host,
            alias,
            alias,
            r.port,
            r.user.as_deref(),
            &self.home,
        );
        let hn = r.hostname.clone();
        r.identity_files = r
            .identity_files
            .iter()
            .map(|p| {
                let s = expand_tokens(
                    &p.to_string_lossy(),
                    &hn,
                    alias,
                    r.port,
                    r.user.as_deref(),
                    &self.home,
                );
                expand_tilde(&s, &self.home)
            })
            .collect();
        if let Some(pc) = r.proxy_command.take() {
            r.proxy_command = Some(expand_tokens(
                &pc,
                &hn,
                alias,
                r.port,
                r.user.as_deref(),
                &self.home,
            ));
        }
        r
    }
}

/// Expand `%h %p %r %u %d %n %%`.
pub fn expand_tokens(
    s: &str,
    host: &str,
    alias: &str,
    port: u16,
    remote_user: Option<&str>,
    home: &Path,
) -> String {
    let local_user = std::env::var("USER").unwrap_or_default();
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('h') => out.push_str(host),
            Some('n') => out.push_str(alias),
            Some('p') => out.push_str(&port.to_string()),
            Some('r') => out.push_str(remote_user.unwrap_or(&local_user)),
            Some('u') => out.push_str(&local_user),
            Some('d') => out.push_str(&home.to_string_lossy()),
            Some('%') => out.push('%'),
            Some(o) => {
                out.push('%');
                out.push(o);
            }
            None => out.push('%'),
        }
    }
    out
}

/// Expand a path whose components may contain `*`/`?` globs. Sorted, like
/// OpenSSH's `glob(3)` usage.
fn glob_paths(path: &Path) -> Vec<PathBuf> {
    let mut acc: Vec<PathBuf> = vec![PathBuf::new()];
    for comp in path.components() {
        let s = comp.as_os_str().to_string_lossy().to_string();
        let mut next = Vec::new();
        if s.contains(['*', '?']) {
            for base in &acc {
                let Ok(rd) = std::fs::read_dir(if base.as_os_str().is_empty() {
                    Path::new(".")
                } else {
                    base
                }) else {
                    continue;
                };
                let mut names: Vec<String> = rd
                    .filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .filter(|n| !n.starts_with('.') && glob_match_case(&s, n))
                    .collect();
                names.sort();
                for n in names {
                    next.push(base.join(n));
                }
            }
        } else {
            for base in &acc {
                next.push(base.join(&s));
            }
        }
        acc = next;
    }
    acc.into_iter().filter(|p| p.is_file()).collect()
}

/// One parsed `[user@]host[:port]` (or `ssh://user@host:port`) destination.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Destination {
    pub host: String,
    pub user: Option<String>,
    pub port: Option<u16>,
}

impl Destination {
    /// Parse `user@host:port`, `host`, `[::1]:22`, `ssh://user@host:port`.
    pub fn parse(s: &str) -> Result<Self> {
        let mut s = s.trim();
        if let Some(r) = s.strip_prefix("ssh://") {
            s = r.trim_end_matches('/');
        }
        if s.is_empty() {
            bail!("empty SSH destination");
        }
        let (user, rest) = match s.rsplit_once('@') {
            Some((u, r)) if !u.is_empty() => (Some(u.to_string()), r),
            _ => (None, s),
        };
        let (host, port) = if let Some(inner) = rest.strip_prefix('[') {
            let (h, after) = inner
                .split_once(']')
                .ok_or_else(|| anyhow::anyhow!("invalid IPv6 destination: {s}"))?;
            let port = match after.strip_prefix(':') {
                Some(p) => Some(
                    p.parse::<u16>()
                        .with_context(|| format!("invalid port in {s}"))?,
                ),
                None => None,
            };
            (h.to_string(), port)
        } else if rest.matches(':').count() == 1 {
            let (h, p) = rest.split_once(':').unwrap();
            (
                h.to_string(),
                Some(
                    p.parse::<u16>()
                        .with_context(|| format!("invalid port in {s}"))?,
                ),
            )
        } else {
            (rest.to_string(), None)
        };
        if host.is_empty() {
            bail!("empty host in SSH destination {s}");
        }
        Ok(Self { host, user, port })
    }
}

/// One hop in a resolved ProxyJump chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JumpHop {
    pub dest: Destination,
    pub config: ResolvedHost,
}

/// Resolve a ProxyJump value into an ordered list of hops (first hop first).
///
/// A jump host's own ProxyJump is walked first (it must be reachable before
/// it can forward). Loops and over-long chains are rejected.
pub fn resolve_proxy_jumps(value: &str, cfg: &SshConfig) -> Result<Vec<JumpHop>> {
    let mut out = Vec::new();
    let mut stack = Vec::new();
    walk_jumps(value, cfg, &mut stack, &mut out)?;
    Ok(out)
}

fn walk_jumps(
    value: &str,
    cfg: &SshConfig,
    stack: &mut Vec<String>,
    out: &mut Vec<JumpHop>,
) -> Result<()> {
    for entry in value.split(',').map(str::trim).filter(|e| !e.is_empty()) {
        let dest = Destination::parse(entry)?;
        if stack.iter().any(|s| s == &dest.host) {
            bail!("ProxyJump chain loops back to '{}'", dest.host);
        }
        let conf = cfg.resolve(&dest.host);
        if let Some(pj) = conf.proxy_jump.clone() {
            stack.push(dest.host.clone());
            walk_jumps(&pj, cfg, stack, out)?;
            stack.pop();
        }
        out.push(JumpHop { dest, config: conf });
        if out.len() > MAX_PROXY_JUMPS {
            bail!("ProxyJump chain is longer than {MAX_PROXY_JUMPS} hops");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn home() -> PathBuf {
        PathBuf::from("/home/tester")
    }

    fn parse(s: &str) -> SshConfig {
        SshConfig::parse_str(s, &home().join(".ssh"), &home()).unwrap()
    }

    #[test]
    fn basic_fields_and_defaults() {
        let c = parse(
            "Host myserver\n  HostName 192.168.1.100\n  Port 2222\n  User deploy\n  IdentityFile ~/.ssh/deploy_key\n  ForwardAgent yes\n  ServerAliveInterval 60\n",
        );
        let r = c.resolve("myserver");
        assert_eq!(r.hostname, "192.168.1.100");
        assert_eq!(r.port, 2222);
        assert_eq!(r.user.as_deref(), Some("deploy"));
        assert_eq!(r.identity_files, vec![home().join(".ssh/deploy_key")]);
        assert!(r.forward_agent);
        assert_eq!(r.server_alive_interval, Some(60));
        let u = c.resolve("unknown.example");
        assert_eq!((u.hostname.as_str(), u.port), ("unknown.example", 22));
    }

    #[test]
    fn multi_alias_host_line() {
        let c = parse("Host web web1 \"quoted alias\"\n  HostName 10.0.0.5\n");
        assert_eq!(c.hosts(), vec!["web", "web1", "quoted alias"]);
        assert_eq!(c.resolve("web1").hostname, "10.0.0.5");
        assert_eq!(c.resolve("quoted alias").hostname, "10.0.0.5");
    }

    #[test]
    fn wildcards_negation_and_first_wins() {
        let c = parse(
            "Host bastion\n  User jump\nHost *.corp !bastion.corp\n  User corpuser\n  Port 2200\nHost *\n  User fallback\n  Port 22\n",
        );
        assert_eq!(c.hosts(), vec!["bastion"]);
        let r = c.resolve("db.corp");
        assert_eq!(r.user.as_deref(), Some("corpuser"));
        assert_eq!(r.port, 2200);
        let r = c.resolve("bastion.corp");
        assert_eq!(
            r.user.as_deref(),
            Some("fallback"),
            "negated pattern excluded"
        );
        assert_eq!(c.resolve("bastion").user.as_deref(), Some("jump"));
        assert!(glob_match("web-??", "web-01"));
        assert!(!glob_match("web-??", "web-001"));
    }

    #[test]
    fn global_options_before_host_apply_everywhere() {
        let c = parse("User globaluser\nHost a\n  HostName 1.1.1.1\n");
        assert_eq!(c.resolve("a").user.as_deref(), Some("globaluser"));
        assert_eq!(c.resolve("other").user.as_deref(), Some("globaluser"));
    }

    #[test]
    fn key_equals_value_and_case_insensitive_keywords() {
        let c = parse("Host eq\n  HostName=10.1.1.1\n  PORT = 2022\n  user=\"me\"\n");
        let r = c.resolve("eq");
        assert_eq!(
            (r.hostname.as_str(), r.port, r.user.as_deref()),
            ("10.1.1.1", 2022, Some("me"))
        );
    }

    #[test]
    fn identity_files_accumulate_and_expand_tokens() {
        let c = parse(
            "Host x\n  HostName real.example\n  User bob\n  IdentityFile ~/.ssh/id_%h\n  IdentityFile %d/.ssh/%r_key\nHost *\n  IdentityFile ~/.ssh/id_ed25519\n",
        );
        let r = c.resolve("x");
        assert_eq!(
            r.identity_files,
            vec![
                home().join(".ssh/id_real.example"),
                home().join(".ssh/bob_key"),
                home().join(".ssh/id_ed25519")
            ]
        );
    }

    #[test]
    fn hostname_percent_h() {
        let c = parse("Host *.int\n  HostName %h.example.com\n");
        assert_eq!(c.resolve("db.int").hostname, "db.int.example.com");
    }

    #[test]
    fn proxy_command_and_none() {
        let c = parse(
            "Host pc\n  HostName target\n  Port 2200\n  User u\n  ProxyCommand nc -X connect -x proxy:3128 %h %p\nHost direct\n  ProxyJump none\n  ProxyCommand none\nHost *\n  ProxyJump gw\n",
        );
        assert_eq!(
            c.resolve("pc").proxy_command.as_deref(),
            Some("nc -X connect -x proxy:3128 target 2200")
        );
        let d = c.resolve("direct");
        assert_eq!(d.proxy_jump, None);
        assert_eq!(d.proxy_command, None);
    }

    #[test]
    fn match_all_and_unsupported_match() {
        let c = parse("Match exec \"true\"\n  User never\nMatch all\n  User everyone\n");
        assert_eq!(c.resolve("h").user.as_deref(), Some("everyone"));
    }

    #[test]
    fn comments_blank_lines_and_tabs() {
        let c = parse("# top\n\nHost\ttabbed\n\t# inner\n\tHostName\t9.9.9.9\n");
        assert_eq!(c.resolve("tabbed").hostname, "9.9.9.9");
    }

    // --- Include (cases from open-remote-ssh test/ssh-config.test.ts) ---

    fn tmp_home() -> (tempfile::TempDir, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let ssh = d.path().join(".ssh");
        fs::create_dir_all(ssh.join("config.d/nested")).unwrap();
        (d, ssh)
    }

    fn parse_at(ssh: &Path, text: &str) -> SshConfig {
        fs::write(ssh.join("config"), text).unwrap();
        SshConfig::parse_str(text, ssh, ssh.parent().unwrap()).unwrap()
    }

    #[test]
    fn include_top_level() {
        let (_d, ssh) = tmp_home();
        fs::write(
            ssh.join("config.d/extra"),
            "Host included\n HostName 10.0.0.1\n",
        )
        .unwrap();
        let c = parse_at(
            &ssh,
            "Include config.d/*\n\nHost local\n HostName 127.0.0.1\n",
        );
        assert_eq!(c.hosts(), vec!["included", "local"]);
        assert_eq!(c.resolve("included").hostname, "10.0.0.1");
    }

    #[test]
    fn include_trailing_host_block() {
        let (_d, ssh) = tmp_home();
        fs::write(
            ssh.join("config.d/extra"),
            "Host included\n HostName 10.0.0.1\n",
        )
        .unwrap();
        let c = parse_at(
            &ssh,
            "Host local\n HostName 127.0.0.1\n\nInclude config.d/*\n",
        );
        assert_eq!(c.hosts(), vec!["local", "included"]);
        assert_eq!(c.resolve("local").hostname, "127.0.0.1");
        assert_eq!(c.resolve("included").hostname, "10.0.0.1");
    }

    #[test]
    fn include_trailing_match_block() {
        let (_d, ssh) = tmp_home();
        fs::write(
            ssh.join("config.d/extra"),
            "Host included\n HostName 10.0.0.1\n",
        )
        .unwrap();
        let c = parse_at(
            &ssh,
            "Host local\n HostName 127.0.0.1\n\nMatch all\nInclude config.d/*\n",
        );
        assert_eq!(c.hosts(), vec!["local", "included"]);
        assert_eq!(c.resolve("included").hostname, "10.0.0.1");
    }

    #[test]
    fn include_nested_and_sorted() {
        let (_d, ssh) = tmp_home();
        fs::write(
            ssh.join("config.d/first.conf"),
            "Host first\n HostName 10.0.0.1\n\nInclude config.d/nested/*.conf\n",
        )
        .unwrap();
        fs::write(
            ssh.join("config.d/nested/second.conf"),
            "Host second\n HostName 10.0.0.2\n",
        )
        .unwrap();
        fs::write(ssh.join("config.d/zz.conf"), "Host zz\n").unwrap();
        fs::write(ssh.join("config.d/ignored.txt"), "Host nope\n").unwrap();
        let c = parse_at(&ssh, "Match all\nInclude config.d/*.conf\n");
        assert_eq!(c.hosts(), vec!["first", "second", "zz"]);
        assert_eq!(c.resolve("second").hostname, "10.0.0.2");
    }

    #[test]
    fn include_absolute_tilde_and_missing() {
        let (d, ssh) = tmp_home();
        fs::write(ssh.join("abs.conf"), "Host abs\n HostName 1.2.3.4\n").unwrap();
        let text = format!(
            "Include {}\nInclude ~/.ssh/does-not-exist\n",
            ssh.join("abs.conf").display()
        );
        let c = SshConfig::parse_str(&text, &ssh, d.path()).unwrap();
        assert_eq!(c.resolve("abs").hostname, "1.2.3.4");
    }

    #[test]
    fn include_self_loop_is_rejected() {
        let (_d, ssh) = tmp_home();
        fs::write(
            ssh.join("config.d/loop.conf"),
            "Include config.d/loop.conf\n",
        )
        .unwrap();
        let text = "Include config.d/loop.conf\n";
        let err = SshConfig::parse_str(text, &ssh, ssh.parent().unwrap()).unwrap_err();
        assert!(err.to_string().contains("nested too deeply"));
    }

    #[test]
    fn options_after_include_stay_in_block() {
        let (_d, ssh) = tmp_home();
        fs::write(ssh.join("config.d/inc"), "Host other\n HostName 5.5.5.5\n").unwrap();
        let c = parse_at(
            &ssh,
            "Host a\n HostName 1.1.1.1\n Include config.d/inc\n User auser\n",
        );
        assert_eq!(c.resolve("a").user.as_deref(), Some("auser"));
        assert_eq!(c.resolve("other").user, None);
    }

    // --- Destinations & ProxyJump (cases from resolve-proxy-jumps.test.ts) ---

    #[test]
    fn destination_parsing() {
        assert_eq!(
            Destination::parse("me@gateway:2022").unwrap(),
            Destination {
                host: "gateway".into(),
                user: Some("me".into()),
                port: Some(2022)
            }
        );
        assert_eq!(Destination::parse("host").unwrap().port, None);
        assert_eq!(Destination::parse("[::1]:2200").unwrap().host, "::1");
        assert_eq!(Destination::parse("ssh://u@h:7").unwrap().port, Some(7));
        assert_eq!(
            Destination::parse("a@b@host").unwrap().user.as_deref(),
            Some("a@b")
        );
        assert!(Destination::parse("h:notaport").is_err());
        assert!(Destination::parse("").is_err());
    }

    fn names(v: &str, cfg: &str) -> Result<Vec<String>> {
        Ok(resolve_proxy_jumps(v, &parse(cfg))?
            .into_iter()
            .map(|h| h.dest.host)
            .collect())
    }

    #[test]
    fn jumps_keep_order_and_skip_blanks() {
        assert_eq!(names("a,b,c", "").unwrap(), ["a", "b", "c"]);
        assert_eq!(names("a,,b", "").unwrap(), ["a", "b"]);
    }

    #[test]
    fn jumps_walk_declared_proxyjump_first() {
        assert_eq!(
            names("second", "Host second\n ProxyJump first\n").unwrap(),
            ["first", "second"]
        );
        assert_eq!(
            names(
                "third",
                "Host third\n ProxyJump second\nHost second\n ProxyJump first\n"
            )
            .unwrap(),
            ["first", "second", "third"]
        );
        assert_eq!(
            names("a,b", "Host a\n ProxyJump a-gw\nHost b\n ProxyJump b-gw\n").unwrap(),
            ["a-gw", "a", "b-gw", "b"]
        );
    }

    #[test]
    fn jumps_carry_hop_configuration() {
        let hops = resolve_proxy_jumps(
            "second",
            &parse("Host second\n ProxyJump first\n Port 2022\nHost first\n HostName gateway.example.com\n"),
        )
        .unwrap();
        assert_eq!(hops[0].config.hostname, "gateway.example.com");
        assert_eq!(hops[1].config.port, 2022);
    }

    #[test]
    fn jumps_keep_user_and_port() {
        let hops = resolve_proxy_jumps("me@gateway:2022", &parse("")).unwrap();
        assert_eq!(hops[0].dest.user.as_deref(), Some("me"));
        assert_eq!(hops[0].dest.port, Some(2022));
    }

    #[test]
    fn jumps_detect_loops_and_length() {
        assert!(names("a", "Host a\n ProxyJump a\n")
            .unwrap_err()
            .to_string()
            .contains("loops back to 'a'"));
        assert!(names("a", "Host a\n ProxyJump b\nHost b\n ProxyJump a\n")
            .unwrap_err()
            .to_string()
            .contains("loops back to 'a'"));
        let mut cfg = String::new();
        for i in 0..=MAX_PROXY_JUMPS + 1 {
            cfg.push_str(&format!("Host h{i}\n ProxyJump h{}\n", i + 1));
        }
        assert!(names("h0", &cfg)
            .unwrap_err()
            .to_string()
            .contains("longer than"));
    }
}
