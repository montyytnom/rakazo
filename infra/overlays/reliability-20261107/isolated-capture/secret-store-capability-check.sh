#!/usr/bin/env bash
# Read-only SecretStore capability check. Does not put, load, delete, mint keys,
# or print secret values.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../../.." && pwd)"
if [[ -d /app/packages/adapters/src && ! -d "$ROOT/packages/adapters/src" ]]; then
  ROOT=/app
fi
ADAPTERS="${RAKAZO_ADAPTERS_SRC:-$ROOT/packages/adapters/src}"
TSX_BIN="${TSX:-}"
if [[ -z "$TSX_BIN" ]]; then
  if [[ -x "$ROOT/node_modules/.bin/tsx" ]]; then
    TSX_BIN="$ROOT/node_modules/.bin/tsx"
  elif command -v tsx >/dev/null 2>&1; then
    TSX_BIN="$(command -v tsx)"
  else
    echo "tsx is required" >&2
    exit 1
  fi
fi
exec "$TSX_BIN" "$DIR/secret-store-capability-check.ts" "$ADAPTERS"
