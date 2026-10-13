#!/usr/bin/env bash
# Serve packaged (or repo) `dist/` on http://127.0.0.1:1420 when the SideX
# binary was produced by `cargo build --release` and still points at Vite's
# `devUrl`. `tauri build` embeds assets and does not need this.
#
# Usage (usually called from scripts/sidex):
#   scripts/ensure-frontend-server.sh [dist-dir]
#
# Env:
#   SIDEX_FRONTEND_PORT   default 1420
#   SIDEX_SKIP_FRONTEND_SERVER=1  — do nothing
#   SIDEX_FRONTEND_DIST   — override dist directory
set -euo pipefail

if [[ "${SIDEX_SKIP_FRONTEND_SERVER:-}" == "1" ]]; then
  exit 0
fi

PORT="${SIDEX_FRONTEND_PORT:-1420}"

# Already serving?
if curl -fsS -o /dev/null --connect-timeout 0.3 "http://127.0.0.1:${PORT}/" 2>/dev/null; then
  exit 0
fi

resolve_self() {
  local src="${BASH_SOURCE[0]}"
  while [[ -L "$src" ]]; do
    local dir
    dir="$(cd -P "$(dirname "$src")" && pwd)"
    src="$(readlink "$src")"
    [[ "$src" != /* ]] && src="$dir/$src"
  done
  cd -P "$(dirname "$src")" && pwd
}

SCRIPT_DIR="$(resolve_self)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd || true)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd || true)"

# Packaged layout: <pkg>/bin/sidex → <pkg>/dist
# Dev layout:      <repo>/scripts/… → <repo>/dist or staging symlink
DIST="${1:-${SIDEX_FRONTEND_DIST:-}}"
if [[ -z "$DIST" ]]; then
  for candidate in \
    "${SIDEX_FRONTEND_DIST:-}" \
    "$SCRIPT_DIR/../dist" \
    "$PKG_ROOT/dist" \
    "$REPO_ROOT/dist" \
    "$REPO_ROOT/target/release/dist" \
    "$REPO_ROOT/smoke-artifacts/web-dist" \
    "$REPO_ROOT/release-artifacts/linux-staging/sidex-0.1.5-linux-x86_64/dist"
  do
    [[ -n "$candidate" && -f "$candidate/index.html" ]] || continue
    DIST="$candidate"
    break
  done
fi

if [[ -z "${DIST:-}" || ! -f "$DIST/index.html" ]]; then
  echo "sidex: no frontend dist/ found to serve on :${PORT}" >&2
  echo "sidex: run \`npm run build\` or use a cloud-build tarball that includes dist/." >&2
  exit 0
fi

mkdir -p "${TMPDIR:-/tmp}/sidex-frontend"
LOG="${TMPDIR:-/tmp}/sidex-frontend/server-${PORT}.log"
PIDFILE="${TMPDIR:-/tmp}/sidex-frontend/server-${PORT}.pid"

# Stale pid?
if [[ -f "$PIDFILE" ]]; then
  old="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [[ -n "$old" ]] && kill -0 "$old" 2>/dev/null; then
    exit 0
  fi
  rm -f "$PIDFILE"
fi

python3 - "$DIST" "$PORT" >>"$LOG" 2>&1 <<'PY' &
import http.server, socketserver, sys, os
root, port = sys.argv[1], int(sys.argv[2])
os.chdir(root)
class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **getattr(http.server.SimpleHTTPRequestHandler, "extensions_map", {}),
        ".wasm": "application/wasm",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
    }
    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", port), H) as httpd:
    httpd.serve_forever()
PY
echo $! >"$PIDFILE"

# Wait briefly for readiness
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS -o /dev/null --connect-timeout 0.2 "http://127.0.0.1:${PORT}/" 2>/dev/null; then
    echo "sidex: serving frontend from $DIST on http://127.0.0.1:${PORT}/" >&2
    exit 0
  fi
  sleep 0.15
done
echo "sidex: warning: frontend server on :${PORT} did not become ready (see $LOG)" >&2
exit 0
