#!/usr/bin/env bash
# Copy composed AFTER overlay files into a scratch tree. Does not recreate
# hosts, does not docker, does not bind-mount production, does not git revert.
# Refuses production roots. Requires FILE-STATE preimage match unless
# --seed-preimage copies rollback-backup first.
set -euo pipefail
export LC_ALL=C

usage() {
  echo "usage: apply-to-scratch.sh --from CANDIDATE_DIR --scratch SCRATCH_DIR [--seed-preimage]" >&2
  echo "       apply-to-scratch.sh --self-test --from CANDIDATE_DIR" >&2
  echo "CANDIDATE_DIR must contain FILE-STATE.tsv, files/{worker,api}/after, rollback-backup/" >&2
  exit 2
}

sha() { sha256sum "$1" | awk '{print $1}'; }

refuse_production_root() {
  local label="$1" path="$2"
  local resolved
  resolved=$(realpath -m "$path")
  local prefixes=(/opt/docker /app /run /var/lib/docker /opt/rakazo)
  local p
  for p in "${prefixes[@]}"; do
    if [[ "$resolved" == "$p" || "$resolved" == "$p"/* ]]; then
      echo "refusing production path ($label): $path -> $resolved" >&2
      exit 1
    fi
  done
}

FROM=""
SCRATCH=""
SEED=0
SELF_TEST=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM="${2:?}"; shift 2 ;;
    --scratch) SCRATCH="${2:?}"; shift 2 ;;
    --seed-preimage) SEED=1; shift ;;
    --self-test) SELF_TEST=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown arg $1" >&2; usage ;;
  esac
done

if [[ "$SELF_TEST" -eq 1 ]]; then
  [[ -n "$FROM" ]] || usage
  FROM=$(cd "$FROM" && pwd)
  refuse_production_root from "$FROM"
  scratch=$(mktemp -d /tmp/candidate-apply-self-test.XXXXXX)
  "$0" --from "$FROM" --scratch "$scratch" --seed-preimage
  python3 - "$FROM" "$scratch" after <<'PY'
import hashlib, sys
from pathlib import Path
from_dir, scratch, phase = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
errors = []
for line in (from_dir / "FILE-STATE.tsv").read_text().splitlines()[1:]:
    if not line.strip():
        continue
    service, rel, state, _mounted, before, after, _src = line.split("\t")
    dest = scratch / service / rel
    if phase == "after":
        if not dest.is_file():
            errors.append(f"missing after {service} {rel}")
            continue
        got = hashlib.sha256(dest.read_bytes()).hexdigest()
        if got != after:
            errors.append(f"after mismatch {service} {rel}: {got} != {after}")
    else:
        if before == "ABSENT":
            if dest.exists():
                errors.append(f"added path still present {service} {rel}")
        else:
            if not dest.is_file():
                errors.append(f"missing before {service} {rel}")
                continue
            got = hashlib.sha256(dest.read_bytes()).hexdigest()
            if got != before:
                errors.append(f"before mismatch {service} {rel}: {got} != {before}")
if errors:
    print("\n".join(errors), file=sys.stderr)
    sys.exit(1)
print(f"self-test {phase} hashes matched FILE-STATE")
PY
  "$FROM/rollback-to-preimage.sh" --from "$FROM" --scratch "$scratch"
  python3 - "$FROM" "$scratch" before <<'PY'
import hashlib, sys
from pathlib import Path
from_dir, scratch, phase = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
errors = []
for line in (from_dir / "FILE-STATE.tsv").read_text().splitlines()[1:]:
    if not line.strip():
        continue
    service, rel, state, _mounted, before, after, _src = line.split("\t")
    dest = scratch / service / rel
    if before == "ABSENT":
        if dest.exists():
            errors.append(f"added path still present {service} {rel}")
    else:
        if not dest.is_file():
            errors.append(f"missing before {service} {rel}")
            continue
        got = hashlib.sha256(dest.read_bytes()).hexdigest()
        if got != before:
            errors.append(f"before mismatch {service} {rel}: {got} != {before}")
if errors:
    print("\n".join(errors), file=sys.stderr)
    sys.exit(1)
print("self-test rollback hashes matched FILE-STATE including absent paths")
PY
  if "$0" --from "$FROM" --scratch /opt/docker/rakazo-scratch-forbid 2>/tmp/candidate-apply-forbid.err; then
    echo "expected refuse of /opt/docker" >&2
    exit 1
  fi
  grep -q "refusing production path" /tmp/candidate-apply-forbid.err
  rm -rf "$scratch"
  echo "self-test ok: apply→rollback matched FILE-STATE; production roots refused"
  exit 0
fi

[[ -n "$FROM" && -n "$SCRATCH" ]] || usage
FROM=$(cd "$FROM" && pwd)
refuse_production_root from "$FROM"
refuse_production_root scratch "$SCRATCH"
[[ -f "$FROM/FILE-STATE.tsv" ]] || { echo "missing FILE-STATE.tsv" >&2; exit 1; }
[[ -d "$FROM/files/worker/after" && -d "$FROM/files/api/after" ]] || {
  echo "missing composed after trees under $FROM/files" >&2
  exit 1
}

seed_preimage() {
  local service rel state mounted before after src dest backup
  while IFS=$'\t' read -r service rel state mounted before after src; do
    [[ "$service" != service && -n "${service:-}" ]] || continue
    dest="$SCRATCH/$service/$rel"
    if [[ "$before" == "ABSENT" ]]; then
      rm -f "$dest"
      continue
    fi
    backup="$FROM/rollback-backup/files/$service/$rel"
    [[ -f "$backup" ]] || { echo "missing rollback-backup $service $rel" >&2; exit 1; }
    mkdir -p "$(dirname "$dest")"
    cp -a "$backup" "$dest"
  done < "$FROM/FILE-STATE.tsv"
}

check_preimage() {
  local service rel state mounted before after src dest got
  while IFS=$'\t' read -r service rel state mounted before after src; do
    [[ "$service" != service && -n "${service:-}" ]] || continue
    dest="$SCRATCH/$service/$rel"
    if [[ "$before" == "ABSENT" ]]; then
      if [[ -e "$dest" ]]; then
        echo "expected absent preimage $service $rel" >&2
        exit 1
      fi
      continue
    fi
    [[ -f "$dest" ]] || {
      echo "missing expected preimage $service $rel (pass --seed-preimage to copy rollback-backup)" >&2
      exit 1
    }
    got=$(sha "$dest")
    [[ "$got" == "$before" ]] || {
      echo "preimage mismatch $service $rel ($got != $before)" >&2
      exit 1
    }
  done < "$FROM/FILE-STATE.tsv"
}

apply_after() {
  local service rel state mounted before after src dest got
  local applied=0
  while IFS=$'\t' read -r service rel state mounted before after src; do
    [[ "$service" != service && -n "${service:-}" ]] || continue
    src="$FROM/files/$service/after/$rel"
    dest="$SCRATCH/$service/$rel"
    [[ -f "$src" ]] || { echo "missing after file $service $rel" >&2; exit 1; }
    got=$(sha "$src")
    [[ "$got" == "$after" ]] || {
      echo "after pack hash mismatch $service $rel" >&2
      exit 1
    }
    mkdir -p "$(dirname "$dest")"
    cp -a "$src" "$dest"
    got=$(sha "$dest")
    [[ "$got" == "$after" ]] || {
      echo "scratch after hash mismatch $service $rel" >&2
      exit 1
    }
    applied=$((applied + 1))
  done < "$FROM/FILE-STATE.tsv"
  echo "applied $applied after files into $SCRATCH"
}

mkdir -p "$SCRATCH"
if [[ "$SEED" -eq 1 ]]; then
  seed_preimage
fi
check_preimage
apply_after
cp -a "$FROM/FILE-STATE.tsv" "$SCRATCH/FILE-STATE.tsv"
cp -a "$FROM/AFTER-HASHES.worker.tsv" "$SCRATCH/AFTER-HASHES.worker.tsv"
cp -a "$FROM/AFTER-HASHES.api.tsv" "$SCRATCH/AFTER-HASHES.api.tsv"
echo "apply-to-scratch complete; no host recreate, no docker, no production bind-mount"
