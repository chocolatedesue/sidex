#!/usr/bin/env bash
# Packaged Linux entrypoint: serve dist/ on :1420 then exec SideX.bin
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export SIDEX_BINARY="${SIDEX_BINARY:-$HERE/SideX.bin}"
export SIDEX_FRONTEND_DIST="${SIDEX_FRONTEND_DIST:-$HERE/dist}"
if [[ -x "$HERE/bin/ensure-frontend-server.sh" ]]; then
  "$HERE/bin/ensure-frontend-server.sh" || true
fi
exec "$HERE/SideX.bin" "$@"
