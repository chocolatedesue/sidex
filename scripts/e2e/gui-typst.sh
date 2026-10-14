#!/usr/bin/env bash
# Native end-to-end check for a real marketplace extension: Tinymist (Typst).
#
# It provisions everything it needs under $HOME (extension + language server),
# then drives the running app and asserts on observable results:
#   1. the .typ file gets the `typst` language (extension contributes.languages)
#   2. the tinymist extension activates and its LSP server process is running
#   3. edits reach the server while typing (`textDocument/didChange`)
#   4. typing an error makes the workbench show a problem
#
# Prereqs: network access on first run (downloads the VSIX + the server binary),
# and a system `node` (the extension host needs one).
#
#   npm run e2e:typst
#
# Env: E2E_DISPLAY (default :99), E2E_OUT, SIDEX_BIN
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${E2E_OUT:-$ROOT/smoke-artifacts/e2e-typst}"
DISPLAY_NUM="${E2E_DISPLAY:-:99}"
BIN="${SIDEX_BIN:-$ROOT/target/release/SideX}"
TINYMIST_VERSION="${TINYMIST_VERSION:-0.15.8}"
CACHE="${E2E_TYPST_CACHE:-$HOME/.cache/sidex-typst}"

mkdir -p "$OUT" "$CACHE"
DISP_NUM="${DISPLAY_NUM#:}"
rm -f "/tmp/.X${DISP_NUM}-lock" "/tmp/.X11-unix/X${DISP_NUM}" 2>/dev/null || true

fail() { echo "FAIL  $1"; exit 1; }
ok() { echo "PASS  $1"; }

[[ -x "$BIN" ]] || fail "app binary not found: $BIN (run: npm run build && npx tauri build --no-bundle)"

# --- prerequisites ----------------------------------------------------------
command -v node >/dev/null 2>&1 || fail "no 'node' on PATH — the extension host requires Node.js >= 18"

EXT_DIR="$HOME/.local/share/SideX/extensions/myriad-dreamin.tinymist"
if [[ ! -f "$EXT_DIR/out/extension.js" ]]; then
  echo "-- installing tinymist ${TINYMIST_VERSION} extension"
  VSIX="$CACHE/tinymist-$TINYMIST_VERSION.vsix"
  [[ -f "$VSIX" ]] || curl -fsSL --max-time 240 \
    -o "$VSIX" "https://open-vsx.org/api/myriad-dreamin/tinymist/$TINYMIST_VERSION/file/myriad-dreamin.tinymist-$TINYMIST_VERSION.vsix" \
    || fail "could not download the tinymist VSIX (network?)"
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  (cd "$TMP" && unzip -q "$VSIX" && mkdir -p "$EXT_DIR" && cp -a extension/. "$EXT_DIR/") \
    || fail "could not unpack the tinymist VSIX"
fi
ok "tinymist extension present"

SERVER="${TINYMIST_SERVER:-$HOME/.local/bin/tinymist}"
if [[ ! -x "$SERVER" ]]; then
  echo "-- installing tinymist server ${TINYMIST_VERSION}"
  TB="$CACHE/tinymist-server-$TINYMIST_VERSION.tar.gz"
  [[ -f "$TB" ]] || curl -fsSL --max-time 300 -o "$TB" \
    "https://github.com/Myriad-Dreamin/tinymist/releases/download/v$TINYMIST_VERSION/tinymist-x86_64-unknown-linux-gnu.tar.gz" \
    || fail "could not download the tinymist server binary (network?)"
  mkdir -p "$(dirname "$SERVER")"
  tar -xzf "$TB" -C "$CACHE" && cp -f "$CACHE/tinymist-x86_64-unknown-linux-gnu/tinymist" "$SERVER" \
    || fail "could not extract the tinymist server binary"
  chmod +x "$SERVER"
fi
ok "tinymist server present ($SERVER)"

SETTINGS_DIR="$HOME/.config/SideX/UserData/User"
mkdir -p "$SETTINGS_DIR"
printf '{ "tinymist.serverPath": "%s" }\n' "$SERVER" > "$SETTINGS_DIR/settings.json"

# --- display + app ----------------------------------------------------------
Xvfb "$DISPLAY_NUM" -screen 0 1600x1000x24 -nolisten tcp > "$OUT/xvfb.log" 2>&1 & XVFB_PID=$!
for _ in $(seq 1 50); do timeout 5 env DISPLAY="$DISPLAY_NUM" xdpyinfo >/dev/null 2>&1 && break; sleep 0.2; done
DISPLAY="$DISPLAY_NUM" openbox > "$OUT/openbox.log" 2>&1 & OB_PID=$!
sleep 1
cleanup() {
  [[ -n "${APP_PID:-}" ]] && kill "$APP_PID" 2>/dev/null
  sleep 0.3
  [[ -n "${APP_PID:-}" ]] && kill -9 "$APP_PID" 2>/dev/null
  pkill -f "tinymist lsp" 2>/dev/null
  kill "$OB_PID" "$XVFB_PID" 2>/dev/null
}
trap cleanup EXIT

export DISPLAY="$DISPLAY_NUM" SIDEX_LOG=1
export WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe
WS="$(mktemp -d /tmp/sidex-typst-ws.XXXXXX)"
cat > "$WS/main.typ" <<'TYP'
= Hello Typst

A paragraph with math: $x + y = z$.

- item one
- item two
TYP

"$BIN" "$WS" > "$OUT/app.log" 2>&1 & APP_PID=$!
WIN=""
for _ in $(seq 1 120); do WIN="$(xdotool search --onlyvisible --name SideX 2>/dev/null | head -1)"; [[ -n "$WIN" ]] && break; sleep 0.5; done
[[ -n "$WIN" ]] || fail "workbench window never appeared"
xdotool windowactivate --sync "$WIN" 2>/dev/null
sleep 4
ok "workbench window up"

shot() { timeout 15 scrot -o "$OUT/$1" >/dev/null 2>&1 || timeout 15 import -window root "$OUT/$1" >/dev/null 2>&1; }
focus() { xdotool key --clearmodifiers Escape; sleep 0.3; eval "$(xdotool getwindowgeometry --shell "$WIN")"; xdotool mousemove $((WIDTH/2)) $((HEIGHT/2)); sleep 0.2; xdotool click 1; sleep 0.6; }
diff_px() { compare -metric AE "$OUT/$1" "$OUT/$2" null: 2>&1 | tr -d '\n' || true; }

# --- open the typst file ----------------------------------------------------
# Warm up first: right after startup the very first keystroke is swallowed while
# the webview takes keyboard focus (same warm-up as gui-smoke.sh).
focus
xdotool key --clearmodifiers ctrl+shift+p; sleep 1.5
xdotool key --clearmodifiers Escape; sleep 1

# Quick open can race the file-index; retry until the host logs the document.
opened=no
for attempt in 1 2 3; do
  focus
  xdotool key --clearmodifiers ctrl+p; sleep 1.5
  xdotool type --delay 60 "main.typ"; sleep 1.8
  xdotool key --clearmodifiers Return; sleep 4
  for _ in $(seq 1 10); do
    grep -aq "main.typ language=" "$OUT/app.log" && { opened=yes; break; }
    sleep 1
  done
  [[ "$opened" = yes ]] && break
done
shot "01-opened.png"

# 2. the server process: extension activated -> tinymist spawned
SERVER_UP=no
for _ in $(seq 1 30); do pgrep -f "tinymist lsp" >/dev/null 2>&1 && { SERVER_UP=yes; break; }; sleep 2; done
[[ "$SERVER_UP" = yes ]] || { tail -20 "$OUT/app.log"; fail "tinymist LSP server never started"; }
ok "tinymist LSP server running"

# 3. activation recorded by the extension host
grep -aq "activated myriad-dreamin.tinymist" "$OUT/app.log" \
  || fail "extension host never reported tinymist as activated (see $OUT/app.log)"
ok "extension activated"
[[ "$opened" = yes ]] || fail "the .typ document was never opened (see $OUT/app.log)"
grep -aq "main.typ language=typst" "$OUT/app.log" \
  || fail "the .typ document was not opened with language 'typst'"
ok "'.typ' resolves to the typst language"

# 4. live feedback: typing must reach the server, and an error must surface
LSP_LOG="$(ls -t "$WS"/tinymist-lsp.log 2>/dev/null | head -1)"
didchange_before=0
[[ -n "$LSP_LOG" ]] && didchange_before="$(grep -ac "didChange" "$LSP_LOG" 2>/dev/null || echo 0)"

focus
xdotool key --clearmodifiers ctrl+End; sleep 0.4
shot "02-before-error.png"
xdotool type --delay 40 "#let x = "; sleep 5
shot "03-after-error.png"

didchange_after="$didchange_before"
[[ -n "$LSP_LOG" ]] && didchange_after="$(grep -ac "didChange" "$LSP_LOG" 2>/dev/null || echo 0)"
[[ "${didchange_after:-0}" -gt "${didchange_before:-0}" ]] \
  || fail "edits did not reach the language server (didChange ${didchange_before} -> ${didchange_after})"
ok "edits sync to the server live (didChange ${didchange_before} -> ${didchange_after})"

# tinymist publishes diagnostics for the error; the host forwards them to the
# workbench. The host logs each push, which is the deterministic signal.
DIAG="$(grep -a "diagnostics .*main.typ count=" "$OUT/app.log" | tail -1)"
if printf '%s' "$DIAG" | grep -qE 'count=[1-9]'; then
  ok "language server reported a problem: ${DIAG##*[ext-host] }"
else
  fail "no diagnostics reached the workbench after typing an error (last: ${DIAG:-none})"
fi

# Screenshot evidence: the error squiggle / red badge changes the pixels.
eval "$(xdotool getwindowgeometry --shell "$WIN")"
STRIP="260x26+$((X + 20))+$((Y + HEIGHT - 32))"
convert "$OUT/02-before-error.png" -crop "$STRIP" +repage "$OUT/02-strip.png" 2>/dev/null
convert "$OUT/03-after-error.png" -crop "$STRIP" +repage "$OUT/03-strip.png" 2>/dev/null
echo "      (status strip delta: $(compare -metric AE "$OUT/02-strip.png" "$OUT/03-strip.png" null: 2>&1 | tr -d '\n' || true) px)"

echo
echo "tinymist e2e: all checks passed  (evidence: $OUT)"
