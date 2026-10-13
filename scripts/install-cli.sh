#!/usr/bin/env bash
# Install `sidex` (and `SideX`) onto the user PATH (~/.local/bin by default).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${SIDEX_CLI_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$BIN_DIR"

find_app_binary() {
  local candidates=(
    "${SIDEX_BINARY:-}"
    "$REPO_ROOT/target/release/SideX"
    "$REPO_ROOT/target/debug/SideX"
    "$REPO_ROOT/src-tauri/target/release/SideX"
    "$REPO_ROOT/src-tauri/target/debug/SideX"
    "/Applications/SideX.app/Contents/MacOS/SideX"
    "$HOME/Applications/SideX.app/Contents/MacOS/SideX"
  )
  # Packaged layout: this script lives next to SideX
  candidates+=("$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/SideX")
  local c
  for c in "${candidates[@]}"; do
    [[ -z "$c" ]] && continue
    if [[ -x "$c" ]]; then
      printf '%s\n' "$c"
      return 0
    fi
  done
  return 1
}

APP_BIN="$(find_app_binary)" || {
  echo "install-cli: SideX binary not found. Build first or set SIDEX_BINARY." >&2
  exit 1
}

LAUNCHER="$REPO_ROOT/scripts/sidex"
if [[ ! -x "$LAUNCHER" ]]; then
  # Packaged tarball: scripts/ may not exist — symlink the binary directly.
  ln -sfn "$APP_BIN" "$BIN_DIR/sidex"
  ln -sfn "$APP_BIN" "$BIN_DIR/SideX"
else
  # Prefer the launcher so --help works even when argv parsing changes.
  export SIDEX_BINARY="$APP_BIN"
  # Rewrite a small wrapper into ~/.local/bin that pins SIDEX_BINARY.
  cat > "$BIN_DIR/sidex" <<WRAP
#!/usr/bin/env bash
export SIDEX_BINARY=$(printf '%q' "$APP_BIN")
exec $(printf '%q' "$LAUNCHER") "\$@"
WRAP
  chmod +x "$BIN_DIR/sidex"
  ln -sfn "$BIN_DIR/sidex" "$BIN_DIR/SideX"
fi

echo "Installed:"
echo "  $BIN_DIR/sidex"
echo "  $BIN_DIR/SideX  -> sidex"
echo "Binary: $APP_BIN"

case ":$PATH:" in
  *":$BIN_DIR:"*) echo "PATH already includes $BIN_DIR" ;;
  *)
    echo ""
    echo "Add to your shell profile if needed:"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

# Smoke
if command -v sidex >/dev/null 2>&1 || [[ -x "$BIN_DIR/sidex" ]]; then
  "$BIN_DIR/sidex" --help >/dev/null && echo "OK: sidex --help"
fi
