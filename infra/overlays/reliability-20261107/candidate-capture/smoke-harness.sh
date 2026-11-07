#!/usr/bin/env bash
# Cloud-side end-to-end smoke of the actual candidate-capture harness against
# composed AFTER trees with production-forwarded env (ctxmem on). Not the
# Docker image. Limit is labeled in the log.
set -euo pipefail
export LC_ALL=C
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
COMPOSE="${COMPOSE_OUT:-$ROOT/.compose}"
OVERLAY="${OVERLAY_EXPORT:-/tmp/overlay-export/overlay-export}"
OUT="${1:-/opt/cursor/artifacts/candidate-harness-smoke}"
HARNESS_SRC="$ROOT/packages/adapters/src/candidate-capture-harness.ts"
mkdir -p "$OUT"
LOG="$OUT/smoke.log"
exec > >(tee "$LOG") 2>&1

echo "candidate-harness-smoke $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "LIMIT: not Docker image 47d34235/c500071f. Relative imports resolve to composed AFTER executor/pi-runtime/history-compaction/ctxmem. @rakazo/core package resolution is workspace HEAD."
echo "ctxmem production path is RAKAZO_CTXMEM=1; facts on unless RAKAZO_CTXMEM_FACTS=0."
echo "synthetic window 131072 / maxTokens 32768 (4*32768). Not a live encrypted secret limit. ok is not no-throw."

if [[ ! -f "$HARNESS_SRC" ]]; then
  echo "missing harness $HARNESS_SRC" >&2
  exit 1
fi

need_compose=0
for svc in worker api; do
  if ! grep -q 'memoryDocument.findFirst' "$COMPOSE/$svc/after/packages/adapters/src/history-compaction.ts" 2>/dev/null; then
    need_compose=1
  fi
done
if [[ "$need_compose" -eq 1 ]]; then
  if [[ ! -d "$OVERLAY" ]]; then
    echo "overlay archive missing; cannot compose AFTER trees for harness smoke" >&2
    exit 1
  fi
  python3 "$ROOT/scripts/compose-overlay-trees.py" --overlay "$OVERLAY" --out "$COMPOSE" --service worker --patch
  python3 "$ROOT/scripts/compose-overlay-trees.py" --overlay "$OVERLAY" --out "$COMPOSE" --service api --patch
fi

TSX="${REPO_TSX:-}"
if [[ -z "$TSX" && -x "$ROOT/node_modules/.bin/tsx" ]]; then
  TSX="$ROOT/node_modules/.bin/tsx"
fi
if [[ -z "$TSX" ]] && command -v tsx >/dev/null 2>&1; then
  TSX="$(command -v tsx)"
fi
if [[ -z "$TSX" ]]; then
  echo "tsx not found" >&2
  exit 1
fi

apply_forwarded_production_env() {
  # Typed values the launcher may forward. Production ctxmem path is ON.
  export NODE_ENV=production
  export RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC=1
  export RAKAZO_CTXMEM=1
  export RAKAZO_ASSIST_PROMPT=1
  export RAKAZO_ASSIST_STABLE_PREFIX=1
  export RAKAZO_ASSIST_HARNESS=0
  export RAKAZO_FAST_COMPUTER_STEPS=0
  export RAKAZO_GUARD_FINAL_SUMMARY=1
  export RAKAZO_BOT_DIRECTORY_CARDS=1
  export RAKAZO_THINKING_BUDGET=64
  export RAKAZO_THINKING_BUDGET_MODELS=qwen3.8-flash-next
  export RAKAZO_OPENAI_COMPAT_CHAT_TEMPLATE_KWARGS='{"enable_thinking":true,"medium_effort":true}'
  export RAKAZO_ASSIST_DEFAULT_DISABLED_TOOLS=render_plot,skill_create,skill_update,skill_delete,create_space
  export RAKAZO_DEFAULT_TIMEZONE=America/New_York
  export RAKAZO_TICKET_BOARD=0
  export RAKAZO_PHONE_CALLS=0
  export RAKAZO_SEMANTIC_MEMORY=0
  export RAKAZO_CLOUD_AGENT=0
  export RAKAZO_RELIABILITY_LEDGER=0
  export RAKAZO_PROTECTED_RESULTS=0
  export STREAMRETRY_ENABLED=1
  export ISOLATED_CAPTURE_NOW=2026-11-07T00:00:00.000Z
}

failed=0
run_one() {
  local service="$1"
  local branch="$2"
  local dest="$COMPOSE/$service/after/packages/adapters/src/candidate-capture-harness.ts"
  cp -a "$HARNESS_SRC" "$dest"
  local branch_out="$OUT/$service/$branch"
  mkdir -p "$branch_out"
  echo "==> $service $branch CTXMEM=${RAKAZO_CTXMEM:-} FACTS=${RAKAZO_CTXMEM_FACTS:-}"
  set +e
  (cd "$ROOT" && "$TSX" "$dest" --service "$service" --out "$branch_out")
  local rc=$?
  set -e
  echo "rc=$rc $service $branch"
  if [[ "$rc" -ne 0 ]]; then
    failed=1
    echo "FAIL $service $branch" >&2
  fi
  if [[ -f "$branch_out/phases-summary.json" ]]; then
    python3 - "$branch_out/phases-summary.json" "$service" "$branch" <<'PY'
import json, sys
p=json.load(open(sys.argv[1]))
print("phases", sys.argv[2], sys.argv[3], "failed", p.get("failed"), "scenarios", list((p.get("scenarios") or {}).keys()))
for name, row in (p.get("scenarios") or {}).items():
    ok = row.get("ok")
    err = (row.get("error") or {}).get("message") if isinstance(row.get("error"), dict) else None
    print(
        f"  {name} ok={ok} nonvacuous={row.get('nonvacuous')} vacuous={row.get('vacuous')} "
        f"httpBytes={row.get('httpBytes')} requests={row.get('httpRequestCount')} "
        f"outcome={row.get('runOutcome')} failures={row.get('failures')} error={err}"
    )
PY
  else
    echo "missing phases-summary.json for $service $branch" >&2
    failed=1
  fi
}

apply_forwarded_production_env
export RAKAZO_CTXMEM_FACTS=1
run_one worker ctxmem-facts-on
run_one api ctxmem-facts-on
export RAKAZO_CTXMEM_FACTS=0
run_one worker ctxmem-facts-off
run_one api ctxmem-facts-off

echo "smoke failed=$failed"
python3 "$HERE/check_nonvacuous.py" "$OUT"
checker_rc=$?
if [[ "$checker_rc" -ne 0 ]]; then
  failed=1
  echo "FAIL nonvacuous checker rc=$checker_rc" >&2
fi
if [[ "$failed" -ne 0 ]]; then
  exit 1
fi
echo "candidate-harness-smoke OK (nonvacuous checker passed)"
