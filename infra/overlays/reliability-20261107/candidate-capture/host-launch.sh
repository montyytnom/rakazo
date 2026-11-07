#!/usr/bin/env bash
# Candidate-capture launcher. Default is dry-run. Parent --execute only.
# Never pulls/builds, never execs/patches/restarts production, never copies .env
# or state/secrets mounts. Replaces matching inspected dests; adds new binds;
# preserves other app-source mounts. Staging is capture-only, not production overlay paths.
set -euo pipefail
BUNDLE="$(cd "$(dirname "$0")" && pwd)"
EXECUTE=0
CLEANUP=0
OUT=""
STAGE=""
OVERLAY=""
PACK_SHA="${CANDIDATE_PACK_SHA256:-}"
GIT_HEAD="${CANDIDATE_GIT_HEAD:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute) EXECUTE=1; shift ;;
    --dry-run) EXECUTE=0; shift ;;
    --cleanup-stage) CLEANUP=1; shift ;;
    --out) OUT="${2:?}"; shift 2 ;;
    --stage) STAGE="${2:?}"; shift 2 ;;
    --candidate-overlay) OVERLAY="${2:?}"; shift 2 ;;
    --pack-sha256) PACK_SHA="${2:?}"; shift 2 ;;
    --git-head) GIT_HEAD="${2:?}"; shift 2 ;;
    -h|--help)
      echo "usage: $0 --candidate-overlay DIR --stage DIR --out DIR [--dry-run|--execute]"
      echo "       $0 --stage DIR --cleanup-stage"
      echo "env: RAKAZO_WORKER_IMAGE RAKAZO_API_IMAGE (local digest, --pull=never)"
      echo "optional inspect-only: RAKAZO_WORKER_CONTAINER RAKAZO_API_CONTAINER"
      exit 0
      ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done
if [[ "$CLEANUP" -eq 1 ]]; then
  if [[ -z "$STAGE" ]]; then
    echo "--stage DIR is required with --cleanup-stage" >&2
    exit 2
  fi
  exec python3 "$BUNDLE/candidate_launch.py" --cleanup-stage --stage "$STAGE"
fi
if [[ -z "$OUT" || -z "$STAGE" || -z "$OVERLAY" ]]; then
  echo "--candidate-overlay DIR --stage DIR --out DIR are required" >&2
  exit 2
fi
mkdir -p "$OUT"
export ISOLATED_CAPTURE_NOW="${ISOLATED_CAPTURE_NOW:-2026-11-07T00:00:00.000Z}"
export CANDIDATE_PACK_SHA256="$PACK_SHA"
export CANDIDATE_GIT_HEAD="$GIT_HEAD"
args=(--bundle "$BUNDLE" --candidate-overlay "$OVERLAY" --stage "$STAGE" --out "$OUT")
if [[ "$EXECUTE" -eq 1 ]]; then
  args+=(--execute)
else
  args+=(--dry-run)
fi
if [[ -n "$PACK_SHA" ]]; then
  args+=(--pack-sha256 "$PACK_SHA")
fi
if [[ -n "$GIT_HEAD" ]]; then
  args+=(--git-head "$GIT_HEAD")
fi
exec python3 "$BUNDLE/candidate_launch.py" "${args[@]}"
