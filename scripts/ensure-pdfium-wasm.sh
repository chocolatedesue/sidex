#!/usr/bin/env bash
# Ensure public/pdfium.wasm exists so Vite publicDir + postbuild always ship
# a stable `/pdfium.wasm` URL. EmbedPDF defaults to jsDelivr when wasmUrl is
# missing — that hangs or fails offline / behind CSP. (File is gitignored.)
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$REPO_ROOT/public/pdfium.wasm"
CANDIDATES=(
  "$REPO_ROOT/node_modules/@embedpdf/snippet/dist/pdfium.wasm"
  "$REPO_ROOT/node_modules/@embedpdf/pdfium/dist/pdfium.wasm"
)
if [[ -f "$DEST" && -s "$DEST" ]]; then
  echo "pdfium.wasm present ($(wc -c < "$DEST") bytes)."
  exit 0
fi
mkdir -p "$REPO_ROOT/public"
for src in "${CANDIDATES[@]}"; do
  if [[ -f "$src" ]]; then
    cp -f "$src" "$DEST"
    echo "Copied $src → public/pdfium.wasm"
    exit 0
  fi
done
echo "ERROR: pdfium.wasm not found under node_modules/@embedpdf — run npm ci" >&2
exit 1
