#!/usr/bin/env bash
#
# SideX native GUI end-to-end smoke.
#
# Boots the real Tauri binary under Xvfb (with openbox so the webview gets
# focus), drives it with xdotool, screenshots every step, and asserts on
# observable results — the strongest being that Ctrl+S actually writes the
# typed text to disk.
#
# Usage:
#   SIDEX_BIN=/path/to/SideX scripts/e2e/gui-smoke.sh
#
# Env:
#   SIDEX_BIN     path to the release binary (default src-tauri/target/release/SideX)
#   E2E_OUT       evidence directory (default smoke-artifacts/e2e-native)
#   E2E_DISPLAY   X display to use (default :99)
#   E2E_KEEP      set to 1 to leave the app running for inspection
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${E2E_OUT:-$ROOT/smoke-artifacts/e2e-native}"
DISPLAY_NUM="${E2E_DISPLAY:-:99}"
MARKER="GUI_E2E_MARKER_$(date +%s)"

# Resolve the release binary: env override, then the two cargo target layouts.
BIN="${SIDEX_BIN:-}"
if [ -z "$BIN" ]; then
  for candidate in \
    "$ROOT/target/release/SideX" \
    "$ROOT/src-tauri/target/release/SideX" \
    "$ROOT/release-artifacts/linux-staging/SideX"; do
    if [ -x "$candidate" ]; then BIN="$candidate"; break; fi
  done
fi

mkdir -p "$OUT"
: > "$OUT/steps.tsv"

PASS=0
FAIL=0
step() { # step <name> <ok|fail> <detail>
  local name="$1" ok="$2" detail="${3:-}"
  if [ "$ok" = "ok" ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi
  printf '%s\t%s\t%s\n' "$name" "$ok" "$detail" >> "$OUT/steps.tsv"
  printf '%s  %s%s\n' "$([ "$ok" = ok ] && echo PASS || echo FAIL)" "$name" "${detail:+ — $detail}"
}

require() {
  for c in "$@"; do
    if ! command -v "$c" >/dev/null 2>&1; then
      echo "missing required tool: $c" >&2
      exit 2
    fi
  done
}

require Xvfb openbox xdotool scrot wmctrl identify compare

if [ ! -x "$BIN" ]; then
  echo "SideX binary not found or not executable: $BIN" >&2
  echo "build it with: npm run build && npx tauri build --no-bundle" >&2
  echo "(a plain 'cargo build --release' produces a binary that still loads the dev URL)" >&2
  exit 2
fi

WORKSPACE="$(mktemp -d /tmp/sidex-e2e-ws.XXXXXX)"
NOTE="$WORKSPACE/note.md"
printf '# e2e note\n\noriginal line\n' > "$NOTE"

XVFB_PID=""
OB_PID=""
APP_PID=""
cleanup() {
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null
  sleep 0.5
  [ -n "$APP_PID" ] && kill -9 "$APP_PID" 2>/dev/null
  [ -n "$OB_PID" ] && kill "$OB_PID" 2>/dev/null
  [ -n "$XVFB_PID" ] && kill "$XVFB_PID" 2>/dev/null
}
trap cleanup EXIT

echo "== SideX native GUI e2e =="
echo "binary   : $BIN"
echo "display  : $DISPLAY_NUM"
echo "workspace: $WORKSPACE"

# --- 1. display + window manager -------------------------------------------
Xvfb "$DISPLAY_NUM" -screen 0 1600x1000x24 -nolisten tcp > "$OUT/xvfb.log" 2>&1 &
XVFB_PID=$!
for _ in $(seq 1 50); do
  DISPLAY="$DISPLAY_NUM" xdpyinfo >/dev/null 2>&1 && break
  sleep 0.2
done
if DISPLAY="$DISPLAY_NUM" xdpyinfo >/dev/null 2>&1; then
  step "xvfb.ready" ok "$DISPLAY_NUM"
else
  step "xvfb.ready" fail "Xvfb did not come up"
  exit 1
fi

DISPLAY="$DISPLAY_NUM" openbox > "$OUT/openbox.log" 2>&1 &
OB_PID=$!
sleep 1
step "openbox.ready" ok "pid=$OB_PID"

# --- 2. launch the app ------------------------------------------------------
export DISPLAY="$DISPLAY_NUM"
export SIDEX_CHAT_ENABLED=false
export SIDEX_STARTUP_TRACE=1
# Xvfb has no GPU. WebKitGTK needs compositing off and a software GL stack,
# otherwise the window maps but never paints (a blank rectangle).
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export LIBGL_ALWAYS_SOFTWARE=1
export GALLIUM_DRIVER=llvmpipe

"$BIN" "$WORKSPACE" > "$OUT/app.log" 2>&1 &
APP_PID=$!
step "app.spawned" ok "pid=$APP_PID"

WIN=""
for _ in $(seq 1 120); do
  WIN="$(xdotool search --onlyvisible --name 'SideX' 2>/dev/null | head -1)"
  [ -n "$WIN" ] && break
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    step "app.window" fail "process exited early; see $OUT/app.log"
    tail -20 "$OUT/app.log" >&2
    exit 1
  fi
  sleep 0.5
done

if [ -n "$WIN" ]; then
  step "app.window" ok "window=$WIN title=$(xdotool getwindowname "$WIN" 2>/dev/null)"
else
  step "app.window" fail "no SideX window after 60s"
  exit 1
fi

xdotool windowactivate --sync "$WIN" 2>/dev/null || xdotool windowfocus "$WIN" 2>/dev/null
sleep 1

shot() { scrot -o "$OUT/$1" >/dev/null 2>&1 || import -window root "$OUT/$1" >/dev/null 2>&1; }

# Number of distinct colours on screen — a cheap "did the UI actually paint?"
# probe. A blank window is a handful of colours; a mounted workbench is hundreds.
ui_colors() {
  local probe="$OUT/.probe.png"
  scrot -o "$probe" >/dev/null 2>&1 || import -window root "$probe" >/dev/null 2>&1
  identify -format '%k' "$probe" 2>/dev/null || echo 0
}

# --- 2b. wait for the workbench to actually render --------------------------
WORKBENCH_OK=0
for _ in $(seq 1 60); do
  if grep -q 'setup complete' "$OUT/app.log" 2>/dev/null; then WORKBENCH_OK=1; break; fi
  sleep 1
done
step "app.workbench" "$([ "$WORKBENCH_OK" = 1 ] && echo ok || echo fail)" "startup trace 'setup complete'"

PAINTED=0
COLORS=0
for _ in $(seq 1 60); do
  COLORS="$(ui_colors)"
  if [ "${COLORS:-0}" -gt 100 ] 2>/dev/null; then PAINTED=1; break; fi
  sleep 1
done
shot "01-startup.png"
step "app.painted" "$([ "$PAINTED" = 1 ] && echo ok || echo fail)" "distinct colours on screen=$COLORS"
if [ "$PAINTED" != 1 ]; then
  echo "workbench never painted; see $OUT/01-startup.png and $OUT/app.log" >&2
  exit 1
fi

# --- 3. quick open the note -------------------------------------------------
# Do this before the palette check: with a real file loaded the editor content
# is static, so a before/after pixel diff later can only be the palette. While
# the welcome editor is showing, its rotating hint text ("Show All Commands" /
# "Find in Files" / ...) changes on its own and makes any diff meaningless.
#
# Click first: right after startup the webview has not taken keyboard focus, so
# Ctrl+P would go nowhere and no file would open.
eval "$(xdotool getwindowgeometry --shell "$WIN")"
xdotool mousemove $((WIDTH / 2)) $((HEIGHT / 2))
xdotool click 1
sleep 1

xdotool key --clearmodifiers ctrl+p
sleep 1.5
xdotool type --delay 60 "note.md"
sleep 1.2
shot "03-quick-open.png"
xdotool key --clearmodifiers Return
sleep 2.5
shot "04-opened.png"

TITLE="$(xdotool getwindowname "$WIN" 2>/dev/null)"
# SideX keeps a static window title ("SideX"), so the title is recorded as
# evidence rather than asserted on. The real proof that the file opened is the
# save check below: the marker must land in note.md while its original line
# survives — that can only happen if quick open loaded this file into the editor.
step "editor.opened" ok "window title: $TITLE (informational; save check below is authoritative)"

# --- 4. command palette -----------------------------------------------------
# Focus the editor, then check that Ctrl+Shift+P changes what is on screen. The
# editor content is static here, so a large diff means the palette rendered.
eval "$(xdotool getwindowgeometry --shell "$WIN")"
xdotool mousemove $((WIDTH / 2)) $((HEIGHT / 2))
xdotool click 1
sleep 1
shot "04a-before-palette.png"

xdotool key --clearmodifiers ctrl+shift+p
sleep 2
xdotool type --delay 40 "markdown"
sleep 1
shot "04b-command-palette.png"
PIXDIFF="$(compare -metric AE "$OUT/04a-before-palette.png" "$OUT/04b-command-palette.png" null: 2>&1 | tr -d '\n' || true)"
# ImageMagick prints this in scientific notation once it gets large, so let awk
# do the numeric comparison.
PALETTE_CHANGED="$(awk -v d="${PIXDIFF:-0}" 'BEGIN { print (d + 0 > 2000) ? "yes" : "no" }')"
if [ "$PALETTE_CHANGED" = "yes" ]; then
  step "ui.commandPalette" ok "screen changed by ${PIXDIFF} px after ctrl+shift+p"
else
  step "ui.commandPalette" fail "screen barely changed (${PIXDIFF:-0} px); palette did not open"
fi
xdotool key --clearmodifiers Escape
sleep 0.8

# --- 5. edit + save (the hard assertion) ------------------------------------
# Click into the middle of the editor so keystrokes land there.
eval "$(xdotool getwindowgeometry --shell "$WIN")"
xdotool mousemove $((WIDTH / 2)) $((HEIGHT / 2))
xdotool click 1
sleep 1
xdotool key --clearmodifiers ctrl+End
sleep 0.5
xdotool type --delay 30 "$MARKER"
sleep 1
shot "05-typed.png"

BEFORE="$(cat "$NOTE")"
xdotool key --clearmodifiers ctrl+s
sleep 3
AFTER="$(cat "$NOTE")"
shot "06-saved.png"

if printf '%s' "$AFTER" | grep -q "$MARKER" && printf '%s' "$AFTER" | grep -q 'original line'; then
  step "editor.saveWroteToDisk" ok "Ctrl+S persisted '$MARKER' into $NOTE (original line intact)"
else
  step "editor.saveWroteToDisk" fail "marker not on disk. before=$(printf '%s' "$BEFORE" | tr '\n' '|') after=$(printf '%s' "$AFTER" | tr '\n' '|')"
fi

# --- 6. wrap up -------------------------------------------------------------
if [ "${E2E_KEEP:-0}" != "1" ]; then
  kill "$APP_PID" 2>/dev/null
  sleep 1
fi

cat > "$OUT/evidence.json" <<JSON
{
  "at": "$(date -Iseconds)",
  "binary": "$BIN",
  "display": "$DISPLAY_NUM",
  "workspace": "$WORKSPACE",
  "windowTitle": "$TITLE",
  "marker": "$MARKER",
  "passed": $PASS,
  "failed": $FAIL,
  "screenshots": [
    "01-startup.png",
    "03-quick-open.png",
    "04-opened.png",
    "04a-before-palette.png",
    "04b-command-palette.png",
    "05-typed.png",
    "06-saved.png"
  ]
}
JSON

echo
echo "$PASS passed, $FAIL failed  (evidence: $OUT)"
[ "$FAIL" -eq 0 ]
