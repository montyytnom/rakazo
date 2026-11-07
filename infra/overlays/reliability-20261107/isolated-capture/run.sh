#!/usr/bin/env bash
# Isolated synthetic capture. Parent runs this inside the worker container, then
# again inside the api container, on the deployed image + overlay stack.
# No GX10, no live model, no browser, no DB writes, no real chat or secrets.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../../.." && pwd)"
if [[ -d /app/packages/adapters/src && ! -f "$ROOT/packages/adapters/src/isolated-capture.ts" ]]; then
  ROOT=/app
fi
ADAPTERS="${RAKAZO_ADAPTERS_SRC:-$ROOT/packages/adapters/src}"
HARNESS_SRC="${ISOLATED_CAPTURE_SRC:-$ROOT/packages/adapters/src/isolated-capture.ts}"
SERVICE="${ISOLATED_CAPTURE_SERVICE:-${1:-}}"
OUT="${ISOLATED_CAPTURE_OUT:-${2:-}}"
if [[ -z "$SERVICE" || -z "$OUT" ]]; then
  echo "usage: ISOLATED_CAPTURE_SERVICE=worker|api $0 <service> <out-dir>" >&2
  echo "run once per service container so each process imports that image's adapters tree." >&2
  exit 1
fi
if [[ "$SERVICE" != "worker" && "$SERVICE" != "api" && "$SERVICE" != "this-tree" ]]; then
  echo "service must be worker, api, or this-tree" >&2
  exit 1
fi

# Copy the harness next to the live adapters tree when parent bind-mounted the checkout or this bundle.
if [[ ! -f "$ADAPTERS/isolated-capture.ts" ]]; then
  if [[ ! -f "$HARNESS_SRC" ]]; then
    echo "isolated-capture.ts not found at $HARNESS_SRC" >&2
    echo "set ISOLATED_CAPTURE_SRC to the checkout copy of packages/adapters/src/isolated-capture.ts" >&2
    exit 1
  fi
  cp "$HARNESS_SRC" "$ADAPTERS/isolated-capture.ts"
fi

export ISOLATED_CAPTURE_NOW="${ISOLATED_CAPTURE_NOW:-2026-11-07T00:00:00.000Z}"
export ISOLATED_CAPTURE_SERVICE="$SERVICE"
# Thinking / Flash-Next env is observed, never rewritten here.

TSX_BIN="${TSX:-}"
if [[ -z "$TSX_BIN" ]]; then
  if [[ -x "$ROOT/node_modules/.bin/tsx" ]]; then
    TSX_BIN="$ROOT/node_modules/.bin/tsx"
  elif command -v tsx >/dev/null 2>&1; then
    TSX_BIN="$(command -v tsx)"
  else
    echo "tsx is required (worker/api images already start with tsx)" >&2
    exit 1
  fi
fi

mkdir -p "$OUT"
bash "$DIR/provenance.sh" "$OUT/image-provenance.json"
"$TSX_BIN" "$ADAPTERS/isolated-capture.ts" --service "$SERVICE" --out "$OUT"
echo "wrote $OUT"
