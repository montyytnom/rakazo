#!/usr/bin/env bash
# In-container candidate capture. Composed executor → PiRuntime → loopback stub SSE.
# Not the run13 assembler/compactHistory baseline harness.
set -euo pipefail
SERVICE="${ISOLATED_CAPTURE_SERVICE:?set ISOLATED_CAPTURE_SERVICE=worker|api}"
OUT="${ISOLATED_CAPTURE_OUT:-/out}"
export ISOLATED_CAPTURE_NOW="${ISOLATED_CAPTURE_NOW:-2026-11-07T00:00:00.000Z}"
export RAKAZO_ASSIST_DEFAULT_DISABLED_TOOLS="${RAKAZO_ASSIST_DEFAULT_DISABLED_TOOLS:-render_plot,skill_create,skill_update,skill_delete,create_space}"
export RAKAZO_DEFAULT_TIMEZONE="${RAKAZO_DEFAULT_TIMEZONE:-America/New_York}"
export RAKAZO_GUARD_FINAL_SUMMARY="${RAKAZO_GUARD_FINAL_SUMMARY:-1}"
export RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC="${RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC:-1}"
mkdir -p "$OUT"
ADAPTERS="${RAKAZO_ADAPTERS_SRC:-/app/packages/adapters/src}"
HARNESS="$ADAPTERS/candidate-capture-harness.ts"
if [[ ! -f "$HARNESS" ]]; then
  echo "missing $HARNESS (launcher should bind-mount it as a new dest)" >&2
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
