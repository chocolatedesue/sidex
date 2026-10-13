#!/usr/bin/env bash
# Ensure the built-in Seti file icon theme (and theme-defaults) are present.
# Called from `npm run setup` so every build ships `workbench.iconTheme: vs-seti`.
set -euo pipefail

VSCODE_VERSION="${SIDEX_VSCODE_VERSION:-1.141.0}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXTENSIONS_DIR="$REPO_ROOT/extensions"

need_seti=0
need_defaults=0
if [[ ! -f "$EXTENSIONS_DIR/theme-seti/icons/vs-seti-icon-theme.json" ]]; then
  need_seti=1
fi
if [[ ! -f "$EXTENSIONS_DIR/theme-defaults/package.json" ]]; then
  need_defaults=1
fi

if [[ "$need_seti" -eq 0 && "$need_defaults" -eq 0 ]]; then
  echo "File icon theme (theme-seti) present."
  exit 0
fi

echo "Fetching built-in themes from VS Code ${VSCODE_VERSION}…"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL \
  "https://update.code.visualstudio.com/${VSCODE_VERSION}/linux-x64/stable" \
  -o "$tmp/code.tar.gz"
mkdir -p "$EXTENSIONS_DIR"
tar -xzf "$tmp/code.tar.gz" -C "$tmp" \
  "VSCode-linux-x64/resources/app/extensions/theme-seti" \
  "VSCode-linux-x64/resources/app/extensions/theme-defaults" 2>/dev/null \
  || tar -xzf "$tmp/code.tar.gz" -C "$tmp" \
    --wildcards 'VSCode-linux-x64/resources/app/extensions/theme-seti*' \
    --wildcards 'VSCode-linux-x64/resources/app/extensions/theme-defaults*'

src="$tmp/VSCode-linux-x64/resources/app/extensions"
for name in theme-seti theme-defaults; do
  if [[ -d "$src/$name" ]]; then
    rm -rf "$EXTENSIONS_DIR/$name"
    cp -a "$src/$name" "$EXTENSIONS_DIR/"
    echo "Installed $name."
  fi
done

if [[ ! -f "$EXTENSIONS_DIR/theme-seti/icons/vs-seti-icon-theme.json" ]]; then
  echo "ERROR: theme-seti still missing after fetch" >&2
  exit 1
fi
