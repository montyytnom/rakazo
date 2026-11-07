#!/usr/bin/env bash
# Pack the composed AFTER overlay trees, preimage hashes, diffs, named test
# logs, apply-to-scratch launcher, and operational rollback files.
# Does not include overlay-export, production captures, or heldout fixtures.
set -euo pipefail
export LC_ALL=C

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
COMPOSE="${COMPOSE_OUT:-$ROOT/.compose}"
OUT_TGZ="${1:-/opt/cursor/artifacts/candidate-overlay-secret-completion.tgz}"
STAGE="${FLAT_PARENT:-/tmp}/candidate-overlay-secret-completion"

sha() { sha256sum "$1" | awk '{print $1}'; }

need() {
  [[ -f "$1" ]] || { echo "missing $1" >&2; exit 1; }
}

need "$COMPOSE/worker/after/AFTER-HASHES.tsv"
need "$COMPOSE/api/after/AFTER-HASHES.tsv"
need "$COMPOSE/worker/before/PREIMAGE-HASHES.tsv"
need "$COMPOSE/api/before/PREIMAGE-HASHES.tsv"
need "$HERE/apply-to-scratch.sh"
need "$ROOT/infra/overlays/reliability-20261107/ROLLBACK.sh"

rm -rf "$STAGE"
mkdir -p "$STAGE/files/worker/after" "$STAGE/files/api/after" \
  "$STAGE/rollback-backup/files" "$STAGE/DIFFS" "$STAGE/logs"

copy_listed() {
  local hashes="$1" src_root="$2" dest_root="$3"
  while IFS=$'\t' read -r rel expected; do
    [[ -n "${rel:-}" && -n "${expected:-}" && "$rel" != path ]] || continue
    local src="$src_root/$rel"
    need "$src"
    local got
    got=$(sha "$src")
    [[ "$got" == "$expected" ]] || {
      echo "hash mismatch packing $src ($got != $expected)" >&2
      exit 1
    }
    mkdir -p "$(dirname "$dest_root/$rel")"
    cp -a "$src" "$dest_root/$rel"
  done < "$hashes"
}

cp -a "$COMPOSE/worker/after/AFTER-HASHES.tsv" "$STAGE/AFTER-HASHES.worker.tsv"
cp -a "$COMPOSE/api/after/AFTER-HASHES.tsv" "$STAGE/AFTER-HASHES.api.tsv"
cp -a "$COMPOSE/worker/before/PREIMAGE-HASHES.tsv" "$STAGE/PREIMAGE-HASHES.worker.tsv"
cp -a "$COMPOSE/api/before/PREIMAGE-HASHES.tsv" "$STAGE/PREIMAGE-HASHES.api.tsv"

copy_listed "$STAGE/AFTER-HASHES.worker.tsv" "$COMPOSE/worker/after" "$STAGE/files/worker/after"
copy_listed "$STAGE/AFTER-HASHES.api.tsv" "$COMPOSE/api/after" "$STAGE/files/api/after"

# Preimage executors + pi-runtime for operational rollback (compose without --patch).
for service in worker api; do
  for rel in packages/adapters/src/executor.ts packages/adapters/src/pi-runtime.ts; do
    src="$COMPOSE/$service/before/$rel"
    need "$src"
    dest="$STAGE/rollback-backup/files/${service}/$rel"
    mkdir -p "$(dirname "$dest")"
    cp -a "$src" "$dest"
  done
done
{
  echo -e "path\tsha256"
  echo -e "worker/packages/adapters/src/executor.ts\t$(sha "$COMPOSE/worker/before/packages/adapters/src/executor.ts")"
  echo -e "worker/packages/adapters/src/pi-runtime.ts\t$(sha "$COMPOSE/worker/before/packages/adapters/src/pi-runtime.ts")"
  echo -e "api/packages/adapters/src/executor.ts\t$(sha "$COMPOSE/api/before/packages/adapters/src/executor.ts")"
  echo -e "api/packages/adapters/src/pi-runtime.ts\t$(sha "$COMPOSE/api/before/packages/adapters/src/pi-runtime.ts")"
} > "$STAGE/rollback-backup/BEFORE-HASHES.tsv"

diff -u \
  "$COMPOSE/worker/before/packages/adapters/src/executor.ts" \
  "$COMPOSE/worker/after/packages/adapters/src/executor.ts" \
  > "$STAGE/DIFFS/worker.executor.diff" || true
diff -u \
  "$COMPOSE/worker/before/packages/adapters/src/pi-runtime.ts" \
  "$COMPOSE/worker/after/packages/adapters/src/pi-runtime.ts" \
  > "$STAGE/DIFFS/worker.pi-runtime.diff" || true
diff -u \
  "$COMPOSE/api/before/packages/adapters/src/executor.ts" \
  "$COMPOSE/api/after/packages/adapters/src/executor.ts" \
  > "$STAGE/DIFFS/api.executor.diff" || true
diff -u \
  "$COMPOSE/api/before/packages/adapters/src/pi-runtime.ts" \
  "$COMPOSE/api/after/packages/adapters/src/pi-runtime.ts" \
  > "$STAGE/DIFFS/api.pi-runtime.diff" || true

cp -a "$HERE/apply-to-scratch.sh" "$STAGE/apply-to-scratch.sh"
chmod +x "$STAGE/apply-to-scratch.sh"
cp -a "$HERE/OPERATIONAL-ROLLBACK.md" "$STAGE/OPERATIONAL-ROLLBACK.md"
cp -a "$ROOT/infra/overlays/reliability-20261107/ROLLBACK.sh" "$STAGE/ROLLBACK.sh"
chmod +x "$STAGE/ROLLBACK.sh"
cp -a "$ROOT/infra/overlays/reliability-20261107/HOOKS.md" "$STAGE/HOOKS.md"
cp -a "$ROOT/infra/overlays/reliability-20261107/SECRET-CLEANUP-PLAN.md" "$STAGE/SECRET-CLEANUP-PLAN.md"

for log in \
  candidate-overlay-orchestration.log \
  candidate-isolated-capture.log \
  candidate-overlay-guard-final.log \
  candidate-overlay-guard-throw-vs-return.log \
  candidate-reliability-fixtures.log \
  candidate-python-isolated-capture.log \
  candidate-typecheck-core.log \
  candidate-typecheck-adapters.log \
  candidate-secret-completion-test.log
do
  if [[ -f "/opt/cursor/artifacts/$log" ]]; then
    cp -a "/opt/cursor/artifacts/$log" "$STAGE/logs/$log"
  fi
done

cat > "$STAGE/MANIFEST.txt" <<EOF
candidate overlay secret/completion slice
composed from 926710a + overlay archive + --patch
HEAD executor still returns raw tool results to the model.
Releasable files are the composed worker/api AFTER trees in files/.
apply-to-scratch.sh copies AFTER files into a scratch tree only.
ROLLBACK.sh restores PREIMAGE executors/pi-runtime; git revert is not deploy rollback.
Claim detection is English regex; allowing success is CompletionLedger-only.
HISTORICAL_PLAINTEXT_CLEANUP_LOCKED=true
isolated-capture baseline fixtures unchanged
no production calls, no model calls, no heldout inspection
EOF

(
  cd "$STAGE"
  find . -type f ! -name HASHMANIFEST.tsv | sort | while read -r file; do
    sha256sum "$file"
  done
) > "$STAGE/HASHMANIFEST.tsv"

mkdir -p "$(dirname "$OUT_TGZ")"
tar -C "$(dirname "$STAGE")" -czf "$OUT_TGZ" "$(basename "$STAGE")"
sha256sum "$OUT_TGZ" | tee "$OUT_TGZ.sha256"
echo "$OUT_TGZ"
