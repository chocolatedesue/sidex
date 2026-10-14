#!/usr/bin/env bash
# Temporary probe 3: builtin vs user extension commands in the palette.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${E2E_OUT:-$ROOT/smoke-artifacts/e2e-typst-probe3}"
D="${E2E_DISPLAY:-:99}"; N="${D#:}"
BIN="${SIDEX_BIN:-$ROOT/target/release/SideX}"
mkdir -p "$OUT"; rm -f "/tmp/.X${N}-lock" "/tmp/.X11-unix/X${N}" 2>/dev/null || true
Xvfb "$D" -screen 0 1600x1000x24 -nolisten tcp > "$OUT/xvfb.log" 2>&1 & XV=$!
for _ in $(seq 1 50); do timeout 5 env DISPLAY="$D" xdpyinfo >/dev/null 2>&1 && break; sleep 0.2; done
DISPLAY="$D" openbox > "$OUT/openbox.log" 2>&1 & OB=$!
sleep 1
export DISPLAY="$D" SIDEX_LOG=1 PATH="/home/ccds/.local/bin:$PATH"
export WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe
WS="$(mktemp -d /tmp/sidex-typ-p3.XXXXXX)"
printf '= Hello Typst\n\ntext\n' > "$WS/main.typ"
"$BIN" "$WS" > "$OUT/app.log" 2>&1 & APP=$!
WIN=""; for _ in $(seq 1 120); do WIN="$(xdotool search --onlyvisible --name SideX 2>/dev/null | head -1)"; [ -n "$WIN" ] && break; sleep 0.5; done
[ -n "$WIN" ] || { echo "no window"; exit 1; }
xdotool windowactivate --sync "$WIN" 2>/dev/null; sleep 4
shot() { timeout 15 scrot -o "$OUT/$1" >/dev/null 2>&1 || timeout 15 import -window root "$OUT/$1" >/dev/null 2>&1; }
focus() { xdotool key --clearmodifiers Escape; sleep 0.4; eval "$(xdotool getwindowgeometry --shell "$WIN")"; xdotool mousemove $((WIDTH/2)) $((HEIGHT/2)); sleep 0.2; xdotool click 1; sleep 0.8; }
pal_shot() { focus; xdotool key --clearmodifiers ctrl+shift+p; sleep 1.8; xdotool type --delay 45 "$1"; sleep 2.0; shot "$2"; xdotool key --clearmodifiers Escape; sleep 1; }

focus; xdotool key --clearmodifiers ctrl+shift+p; sleep 1.5; xdotool key --clearmodifiers Escape; sleep 1
focus; xdotool key --clearmodifiers ctrl+p; sleep 1.5; xdotool type --delay 60 "main.typ"; sleep 1.8; xdotool key --clearmodifiers Return; sleep 5
pal_shot "Markdown" "P3-markdown.png"
pal_shot "Typst" "P3-typst.png"
pal_shot "Export" "P3-export.png"
echo "=== log: contribution-ish lines ==="
grep -aiE "registered|extension point|command" "$OUT/app.log" | grep -av tailscaled | tail -15
kill "$APP" 2>/dev/null; sleep 0.5; kill -9 "$APP" 2>/dev/null; pkill -f "tinymist lsp" 2>/dev/null
kill "$OB" "$XV" 2>/dev/null
echo "probe3 done"
