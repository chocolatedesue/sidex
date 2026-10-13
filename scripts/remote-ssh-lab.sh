#!/usr/bin/env bash
# Multi-sshd lab for SideX Remote SSH tests (Linux, needs sudo + openssh-server).
#
#   scripts/remote-ssh-lab.sh up     # start everything, prints env to export
#   scripts/remote-ssh-lab.sh down   # stop all lab sshd + agent
#   scripts/remote-ssh-lab.sh kill-flaky / start-flaky   # for reconnect tests
#
# Ports (127.0.0.1):
#   2222 key-only            (user $USER)
#   2223 password-only       (user sxpass / Sx-pass-123)
#   2224 keyboard-interactive only via PAM (user sxpass)
#   2225 jump host, key-only, DEBUG log -> $LAB/jump.log (proves direct-tcpip)
#   2226 target behind jump  (key-only)
#   2227 key-only, user sxfish whose login shell is fish
#   2228 "flaky" key-only host that tests stop/start
#   2299 nothing listening   (connection refused)
set -euo pipefail
LAB=${SIDEX_SSH_LAB:-/tmp/sidex-ssh-lab}
SSHD=$(command -v sshd || echo /usr/sbin/sshd)
PASS='Sx-pass-123'
KEYPASS='sidex-pass'

conf() { # port extra...
  local port=$1; shift
  # sshd uses the FIRST value of each keyword, so overrides go first.
  cat > "$LAB/sshd_$port.conf" <<CONF
$(printf '%s\n' "$@")
Port $port
ListenAddress 127.0.0.1
HostKey $LAB/hostkey_$port
PidFile $LAB/sshd_$port.pid
AuthorizedKeysFile $LAB/authorized_keys
StrictModes no
UsePAM yes
AllowTcpForwarding yes
PermitUserEnvironment no
AcceptEnv LANG LC_* SIDEX_*
PrintMotd no
LogLevel INFO
CONF
  [ -f "$LAB/hostkey_$port" ] || ssh-keygen -q -t ed25519 -N '' -f "$LAB/hostkey_$port"
}

start() { # port
  local port=$1; local log=$LAB/sshd_$1.log
  stop "$port"
  sudo "$SSHD" -f "$LAB/sshd_$port.conf" -E "$log"
  sudo chmod a+r "$log" 2>/dev/null || true
  for _ in $(seq 50); do
    if [ -f "$LAB/sshd_$port.pid" ] && (exec 3<>/dev/tcp/127.0.0.1/$port) 2>/dev/null; then
      sudo chmod 644 "$log"; return 0
    fi; sleep 0.1
  done
  echo "sshd on $port did not start; see $log" >&2; return 1
}

stop() {
  local pidf=$LAB/sshd_$1.pid
  if [ -f "$pidf" ]; then sudo kill "$(cat "$pidf")" 2>/dev/null || true; sudo rm -f "$pidf"; fi
  # sshd we started by hand earlier (phase 1 smoke)
  sudo pkill -f "sshd -p $1 " 2>/dev/null || true
  sudo fuser -k -n tcp "$1" >/dev/null 2>&1 || true
  sleep 0.2
}

KEYONLY=("PubkeyAuthentication yes" "PasswordAuthentication no" "KbdInteractiveAuthentication no")

up() {
  mkdir -p "$LAB"; chmod 755 "$LAB"
  for u in sxpass sxfish; do
    id "$u" >/dev/null 2>&1 || sudo useradd -m -s /bin/bash "$u"
  done
  sudo usermod -s "$(command -v fish)" sxfish
  echo "sxpass:$PASS" | sudo chpasswd
  [ -f "$LAB/id_lab" ] || ssh-keygen -q -t ed25519 -N '' -C sidex-lab -f "$LAB/id_lab"
  [ -f "$LAB/id_lab_enc" ] || ssh-keygen -q -t ed25519 -N "$KEYPASS" -C sidex-lab-enc -f "$LAB/id_lab_enc"
  [ -f "$LAB/id_lab_agent" ] || ssh-keygen -q -t ed25519 -N '' -C sidex-lab-agent -f "$LAB/id_lab_agent"
  [ -f "$LAB/id_lab_rsa" ] || ssh-keygen -q -t rsa -b 2048 -N '' -C sidex-lab-rsa -f "$LAB/id_lab_rsa"
  [ -f "$LAB/id_unauthorized" ] || ssh-keygen -q -t ed25519 -N '' -f "$LAB/id_unauthorized"
  cat "$LAB"/id_lab.pub "$LAB"/id_lab_enc.pub "$LAB"/id_lab_agent.pub "$LAB"/id_lab_rsa.pub > "$LAB/authorized_keys"
  # keep the default smoke (~/.ssh/id_* on :2222) working
  for k in "$HOME"/.ssh/id_*.pub; do [ -f "$k" ] && cat "$k" >> "$LAB/authorized_keys"; done
  chmod 644 "$LAB/authorized_keys" "$LAB"/*.pub; chmod 600 "$LAB"/id_lab "$LAB"/id_lab_enc "$LAB"/id_lab_agent "$LAB"/id_lab_rsa "$LAB"/id_unauthorized

  conf 2222 "${KEYONLY[@]}"
  conf 2223 "PubkeyAuthentication no" "PasswordAuthentication yes" "KbdInteractiveAuthentication no"
  conf 2224 "PubkeyAuthentication no" "PasswordAuthentication no" "KbdInteractiveAuthentication yes"
  conf 2225 "${KEYONLY[@]}" "LogLevel DEBUG1"
  conf 2226 "${KEYONLY[@]}"
  conf 2227 "${KEYONLY[@]}"
  conf 2228 "${KEYONLY[@]}"
  for p in 2222 2223 2224 2225 2226 2227 2228; do start $p; done

  # ssh-agent holding only id_lab_agent
  if [ -f "$LAB/agent.pid" ]; then kill "$(cat "$LAB/agent.pid")" 2>/dev/null || true; fi
  rm -f "$LAB/agent.sock"
  eval "$(ssh-agent -a "$LAB/agent.sock" -s)" >/dev/null
  echo "$SSH_AGENT_PID" > "$LAB/agent.pid"
  SSH_AUTH_SOCK=$LAB/agent.sock ssh-add -q "$LAB/id_lab_agent"

  # ssh_config exercising aliases / Include / wildcards / ProxyJump / ProxyCommand
  mkdir -p "$LAB/conf.d"
  cat > "$LAB/conf.d/extra.conf" <<CONF
Host lab-included
  HostName 127.0.0.1
  Port 2222
  User $USER
  IdentityFile $LAB/id_lab
CONF
  cat > "$LAB/ssh_config" <<CONF
Include $LAB/conf.d/*.conf

Host lab-key lab-key-alias
  HostName 127.0.0.1
  Port 2222
  User $USER
  IdentityFile $LAB/id_lab
  IdentitiesOnly yes

Host lab-pass
  HostName 127.0.0.1
  Port 2223
  User sxpass

Host lab-jump
  HostName 127.0.0.1
  Port 2225
  User $USER
  IdentityFile $LAB/id_lab

Host lab-target
  HostName 127.0.0.1
  Port 2226
  User $USER
  IdentityFile $LAB/id_lab
  ProxyJump lab-jump

Host lab-proxycmd
  HostName 127.0.0.1
  Port 2222
  User $USER
  IdentityFile $LAB/id_lab
  ProxyCommand nc %h %p

Host lab-fish
  HostName 127.0.0.1
  Port 2227
  User sxfish
  IdentityFile $LAB/id_lab

Host lab-wild-*
  HostName 127.0.0.1
  Port 2222
  User $USER
  IdentityFile $LAB/id_lab

Host lab-loop-a
  ProxyJump lab-loop-b
Host lab-loop-b
  ProxyJump lab-loop-a
CONF
  # ProxyCommand needs nc
  command -v nc >/dev/null || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q netcat-openbsd >/dev/null

  echo "export SIDEX_SSH_LAB=$LAB"
  echo "export SIDEX_SSH_CONFIG=$LAB/ssh_config"
  echo "# lab up: ports 2222-2228"
}

down() {
  for p in 2222 2223 2224 2225 2226 2227 2228; do stop $p; done
  if [ -f "$LAB/agent.pid" ]; then kill "$(cat "$LAB/agent.pid")" 2>/dev/null || true; rm -f "$LAB/agent.pid"; fi
}

case "${1:-up}" in
  up) up ;;
  down) down ;;
  kill-flaky) stop 2228 ;;
  start-flaky) start 2228 ;;
  *) echo "usage: $0 up|down|kill-flaky|start-flaky" >&2; exit 2 ;;
esac
