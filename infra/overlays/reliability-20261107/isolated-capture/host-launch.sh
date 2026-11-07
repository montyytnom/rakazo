#!/usr/bin/env bash
# Create ephemeral api/worker capture containers from LOCAL image digests.
# Default is dry-run. Pass --execute under approval to start containers.
# Never pulls/builds, never execs/patches/restarts production, never copies .env
# or /run/login-guard policy. Overlay source files such as login-guard.ts and
# page-browser-session.ts are retained. Assist prompt strings are never copied.
set -euo pipefail
BUNDLE="$(cd "$(dirname "$0")" && pwd)"
EXECUTE=0
OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute) EXECUTE=1; shift ;;
    --dry-run) EXECUTE=0; shift ;;
    --out) OUT="${2:?}"; shift 2 ;;
    -h|--help)
      echo "usage: $0 [--dry-run|--execute] --out DIR"
      echo "env: RAKAZO_WORKER_IMAGE RAKAZO_API_IMAGE (local digest or id, --pull=never)"
      echo "optional inspect-only: RAKAZO_WORKER_CONTAINER RAKAZO_API_CONTAINER"
      exit 0
      ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done
if [[ -z "$OUT" ]]; then
  echo "--out DIR is required" >&2
  exit 2
fi
mkdir -p "$OUT"
export ISOLATED_CAPTURE_NOW="${ISOLATED_CAPTURE_NOW:-2026-11-07T00:00:00.000Z}"
exec python3 "$BUNDLE/host_launch.py" "$BUNDLE" "$OUT" "$EXECUTE"
