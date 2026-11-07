#!/usr/bin/env bash
# Record git SHA, pi-ai version, pi-tool-call-guard hash, and image digests.
# Does not call GX10 or print secrets.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../../.." && pwd)"
if [[ -d /app && ! -d "$ROOT/.git" ]]; then
  ROOT=/app
fi
ADAPTERS="${RAKAZO_ADAPTERS_SRC:-$ROOT/packages/adapters/src}"
OUT="${1:-/tmp/isolated-capture-provenance.json}"

git_sha="${RAKAZO_GIT_SHA:-}"
if [[ -z "$git_sha" ]] && command -v git >/dev/null 2>&1; then
  git_sha="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
fi

pi_ai=""
if [[ -f "$ROOT/packages/adapters/package.json" ]]; then
  pi_ai="$(node -e 'const p=require(process.argv[1]); process.stdout.write(p.dependencies["@earendil-works/pi-ai"]||"")' "$ROOT/packages/adapters/package.json")"
fi
if [[ -z "$pi_ai" ]]; then
  pi_ai="$(node -e 'try{process.stdout.write(require("@earendil-works/pi-ai/package.json").version)}catch{process.stdout.write("")}' || true)"
fi

guard="$ADAPTERS/pi-tool-call-guard.ts"
guard_hash=""
if [[ -f "$guard" ]]; then
  guard_hash="$(sha256sum "$guard" | awk '{print $1}')"
fi

api_digest="${RAKAZO_API_IMAGE_DIGEST:-}"
worker_digest="${RAKAZO_WORKER_IMAGE_DIGEST:-}"
if command -v docker >/dev/null 2>&1; then
  if [[ -n "${RAKAZO_API_IMAGE:-}" && -z "$api_digest" ]]; then
    api_digest="$(docker inspect --format '{{index .RepoDigests 0}}' "$RAKAZO_API_IMAGE" 2>/dev/null || true)"
  fi
  if [[ -n "${RAKAZO_WORKER_IMAGE:-}" && -z "$worker_digest" ]]; then
    worker_digest="$(docker inspect --format '{{index .RepoDigests 0}}' "$RAKAZO_WORKER_IMAGE" 2>/dev/null || true)"
  fi
fi

GIT_SHA="$git_sha" PI_AI="$pi_ai" GUARD="$guard" GUARD_HASH="$guard_hash" \
API_DIGEST="$api_digest" WORKER_DIGEST="$worker_digest" \
python3 - "$OUT" <<'PY'
import json, os, sys
payload = {
  "gitSha": os.environ.get("GIT_SHA") or None,
  "piAiParserVersion": os.environ.get("PI_AI") or None,
  "piToolCallGuard": {
    "path": os.environ.get("GUARD"),
    "sha256": os.environ.get("GUARD_HASH") or None,
  },
  "imageDigests": {
    "api": os.environ.get("API_DIGEST") or None,
    "worker": os.environ.get("WORKER_DIGEST") or None,
    "commands": [
      "docker inspect --format '{{index .RepoDigests 0}}' \"$RAKAZO_API_IMAGE\"",
      "docker inspect --format '{{index .RepoDigests 0}}' \"$RAKAZO_WORKER_IMAGE\"",
    ],
  },
  "gx10Calls": 0,
}
open(sys.argv[1], "w", encoding="utf8").write(json.dumps(payload, indent=2) + "\n")
print(sys.argv[1])
PY
