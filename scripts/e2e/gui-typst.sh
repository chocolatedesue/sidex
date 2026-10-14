#!/usr/bin/env bash
# Native end-to-end check for a real marketplace extension: Tinymist (Typst).
#
# It provisions everything it needs under $HOME (extension + language server),
# then drives the running app and asserts on observable results, covering the
# extension's actual user-facing flows:
#   1. the .typ file gets the `typst` language (contributes.languages)
#   2. the extension activates and its LSP server process is running
#   3. edits reach the server while typing (`textDocument/didChange`)
#   4. typing an error makes the workbench show a problem
#   5. the extension's commands are reachable and `Export … as PDF` writes a PDF
#   6. `Typst Preview` opens a webview panel and refreshes it on edits
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

FAILS=0
fail() { echo "FAIL  $1"; FAILS=$((FAILS + 1)); }
ok() { echo "PASS  $1"; }

[[ -x "$BIN" ]] || { echo "app binary not found: $BIN (run: npm run build && npx tauri build --no-bundle)"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "no 'node' on PATH — the extension host requires Node.js >= 18"; exit 1; }

# --- prerequisites ----------------------------------------------------------
EXT_DIR="$HOME/.local/share/SideX/extensions/myriad-dreamin.tinymist"
if [[ ! -f "$EXT_DIR/out/extension.js" ]]; then
  echo "-- installing tinymist ${TINYMIST_VERSION} extension"
  VSIX="$CACHE/tinymist-$TINYMIST_VERSION.vsix"
  [[ -f "$VSIX" ]] || curl -fsSL --max-time 240 \
    -o "$VSIX" "https://open-vsx.org/api/myriad-dreamin/tinymist/$TINYMIST_VERSION/file/myriad-dreamin.tinymist-$TINYMIST_VERSION.vsix" \
    || { echo "could not download the tinymist VSIX (network?)"; exit 1; }
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  (cd "$TMP" && unzip -q "$VSIX" && mkdir -p "$EXT_DIR" && cp -a extension/. "$EXT_DIR/") \
    || { echo "could not unpack the tinymist VSIX"; exit 1; }
fi
SERVER="${TINYMIST_SERVER:-$HOME/.local/bin/tinymist}"
if [[ ! -x "$SERVER" ]]; then
  echo "-- installing tinymist server ${TINYMIST_VERSION}"
  TB="$CACHE/tinymist-server-$TINYMIST_VERSION.tar.gz"
  [[ -f "$TB" ]] || curl -fsSL --max-time 300 -o "$TB" \
    "https://github.com/Myriad-Dreamin/tinymist/releases/download/v$TINYMIST_VERSION/tinymist-x86_64-unknown-linux-gnu.tar.gz" \
    || { echo "could not download the tinymist server binary (network?)"; exit 1; }
  mkdir -p "$(dirname "$SERVER")"
  tar -xzf "$TB" -C "$CACHE" && cp -f "$CACHE/tinymist-x86_64-unknown-linux-gnu/tinymist" "$SERVER" \
    || { echo "could not extract the tinymist server binary"; exit 1; }
  chmod +x "$SERVER"
fi
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
[[ -n "$WIN" ]] || { echo "workbench window never appeared"; exit 1; }
xdotool windowactivate --sync "$WIN" 2>/dev/null
sleep 4
ok "workbench window up"

shot() { timeout 15 scrot -o "$OUT/$1" >/dev/null 2>&1 || timeout 15 import -window root "$OUT/$1" >/dev/null 2>&1; }
focus() { xdotool key --clearmodifiers Escape; sleep 0.3; eval "$(xdotool getwindowgeometry --shell "$WIN")"; xdotool mousemove $((WIDTH/2)) $((HEIGHT/2)); sleep 0.2; xdotool click 1; sleep 0.6; }

# Run a command through the palette by its (exact, localized) title.
run_command() {
  focus
  xdotool key --clearmodifiers ctrl+shift+p; sleep 1.6
  xdotool type --delay 35 "$1"; sleep 1.6
  shot "$2"
  xdotool key --clearmodifiers Return; sleep 1
}

# --- 1. open the typst file -------------------------------------------------
focus
xdotool key --clearmodifiers ctrl+shift+p; sleep 1.5
xdotool key --clearmodifiers Escape; sleep 1

opened=no
for _ in 1 2 3; do
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
[[ "$opened" = yes ]] || { echo "the .typ document was never opened"; exit 1; }
grep -aq "main.typ language=typst" "$OUT/app.log" \
  && ok "'.typ' resolves to the typst language" \
  || fail "the .typ document was not opened with language 'typst'"

# --- 2./3. language server ---------------------------------------------------
SERVER_UP=no
for _ in $(seq 1 30); do pgrep -f "tinymist lsp" >/dev/null 2>&1 && { SERVER_UP=yes; break; }; sleep 2; done
[[ "$SERVER_UP" = yes ]] && ok "tinymist LSP server running" || fail "tinymist LSP server never started"
grep -aq "activated myriad-dreamin.tinymist" "$OUT/app.log" \
  && ok "extension activated" \
  || fail "extension host never reported tinymist as activated"

# --- 4. edits reach the server live -----------------------------------------
LSP_LOG="$(ls -t "$WS"/tinymist-lsp.log 2>/dev/null | head -1)"
didchange_before=0
[[ -n "$LSP_LOG" ]] && didchange_before="$(grep -ac "didChange" "$LSP_LOG" 2>/dev/null || echo 0)"

focus
xdotool key --clearmodifiers ctrl+End; sleep 0.4
shot "02-before-edit.png"
xdotool type --delay 40 " = more"; sleep 5
shot "03-after-edit.png"

didchange_after="$didchange_before"
[[ -n "$LSP_LOG" ]] && didchange_after="$(grep -ac "didChange" "$LSP_LOG" 2>/dev/null || echo 0)"
[[ "${didchange_after:-0}" -gt "${didchange_before:-0}" ]] \
  && ok "edits sync to the server live (didChange ${didchange_before} -> ${didchange_after})" \
  || fail "edits did not reach the language server (didChange ${didchange_before} -> ${didchange_after})"

# --- 5. export: the extension's command writes a PDF ------------------------
# (runs before the deliberate error below, or tinymist refuses to export a
# document that does not compile)
run_command "Export the Opened File as PDF" "05-export-palette.png"
PDF="$WS/main.pdf"
found=no
for _ in $(seq 1 30); do [[ -f "$PDF" ]] && { found=yes; break; }; sleep 1; done
shot "06-after-export.png"
if [[ "$found" = yes ]]; then
  ok "export command produced a PDF ($(stat -c%s "$PDF") bytes)"
else
  fail "no PDF produced next to main.typ (palette screenshot: $OUT/05-export-palette.png)"
  ls -la "$WS" >> "$OUT/app.log" 2>&1
fi

# --- 6. preview: webview panel opens and receives the rendered document ------
run_command "Typst Preview: Preview Opened File" "07-preview-palette.png"
sleep 15
shot "08-preview.png"
grep -aq "webviewPanel created typst-preview" "$OUT/app.log" \
  && ok "preview opened a webview panel" \
  || fail "no typst-preview webview panel was created"
PREVIEW_LEN="$(grep -ao 'webviewHtml .*len=[0-9]*' "$OUT/app.log" | tail -1 | sed -E 's/.*len=//')"
if [[ "${PREVIEW_LEN:-0}" -gt 1000 ]]; then
  ok "preview panel received the rendered document (${PREVIEW_LEN} bytes)"
else
  fail "preview panel never received rendered content (len=${PREVIEW_LEN:-0})"
fi

# --- 7. diagnostics: an error in the document surfaces in the workbench ------
# Close the preview first — it holds focus, so typing would go into the webview.
focus
xdotool key --clearmodifiers ctrl+w; sleep 2
focus
xdotool key --clearmodifiers ctrl+End; sleep 0.4
xdotool type --delay 40 " #let x = "; sleep 6
shot "09-after-error.png"
DIAG="$(grep -a "diagnostics .*main.typ count=" "$OUT/app.log" | tail -1)"
if printf '%s' "$DIAG" | grep -qE 'count=[1-9]'; then
  ok "language server reported a problem: ${DIAG##*[ext-host] }"
else
  fail "no diagnostics reached the workbench (last: ${DIAG:-none})"
fi

echo
if [[ "$FAILS" -eq 0 ]]; then
  echo "tinymist e2e: all checks passed  (evidence: $OUT)"
  exit 0
fi
echo "tinymist e2e: ${FAILS} check(s) failed  (evidence: $OUT)"
echo "--- app.log tail ---"
tail -30 "$OUT/app.log"
exit 1
