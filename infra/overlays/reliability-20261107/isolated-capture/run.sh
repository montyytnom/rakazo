#!/usr/bin/env bash
# In-container entry. Host launcher starts an ephemeral container and execs this.
# No git checkout. No GX10. No live policy/.env. Writable output is /out.
set -euo pipefail
SERVICE="${ISOLATED_CAPTURE_SERVICE:?set ISOLATED_CAPTURE_SERVICE=worker|api}"
OUT="${ISOLATED_CAPTURE_OUT:-/out}"
export ISOLATED_CAPTURE_NOW="${ISOLATED_CAPTURE_NOW:-2026-11-07T00:00:00.000Z}"
mkdir -p "$OUT"
ADAPTERS="${RAKAZO_ADAPTERS_SRC:-/app/packages/adapters/src}"
HARNESS="$ADAPTERS/isolated-capture.ts"
if [[ ! -f "$HARNESS" ]]; then
  echo "missing $HARNESS (host launcher should bind-mount it from this bundle)" >&2
  exit 1
fi
TSX_BIN="${TSX:-}"
if [[ -z "$TSX_BIN" ]]; then
  for candidate in /app/node_modules/.bin/tsx /app/apps/worker/node_modules/.bin/tsx /usr/local/bin/tsx; do
    if [[ -x "$candidate" ]]; then
      TSX_BIN="$candidate"
      break
    fi
  done
fi
if [[ -z "$TSX_BIN" ]] && command -v tsx >/dev/null 2>&1; then
  TSX_BIN="$(command -v tsx)"
fi
if [[ -z "$TSX_BIN" ]]; then
  echo "tsx not found in the image" >&2
  exit 1
fi
cd /app
exec "$TSX_BIN" "$HARNESS" --service "$SERVICE" --out "$OUT"
