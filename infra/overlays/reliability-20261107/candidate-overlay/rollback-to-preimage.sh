#!/usr/bin/env bash
# Restore FILE-STATE preimage in a scratch tree: copy changed/unchanged files
# from rollback-backup and delete added paths. Not git revert. Not production.
set -euo pipefail
export LC_ALL=C

usage() {
  echo "usage: rollback-to-preimage.sh --from CANDIDATE_DIR --scratch SCRATCH_DIR" >&2
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
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM="${2:?}"; shift 2 ;;
    --scratch) SCRATCH="${2:?}"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown arg $1" >&2; usage ;;
  esac
done
[[ -n "$FROM" && -n "$SCRATCH" ]] || usage
FROM=$(cd "$FROM" && pwd)
refuse_production_root from "$FROM"
refuse_production_root scratch "$SCRATCH"
[[ -f "$FROM/FILE-STATE.tsv" ]] || { echo "missing FILE-STATE.tsv" >&2; exit 1; }

restored=0
deleted=0
while IFS=$'\t' read -r service rel state mounted before after src; do
  [[ "$service" != service && -n "${service:-}" ]] || continue
  dest="$SCRATCH/$service/$rel"
  if [[ "$before" == "ABSENT" ]]; then
    if [[ -e "$dest" ]]; then
      rm -f "$dest"
      deleted=$((deleted + 1))
    fi
    if [[ -e "$dest" ]]; then
      echo "failed to remove added path $service $rel" >&2
      exit 1
    fi
    continue
  fi
  backup="$FROM/rollback-backup/files/$service/$rel"
  [[ -f "$backup" ]] || { echo "missing rollback-backup $service $rel" >&2; exit 1; }
  got=$(sha "$backup")
  [[ "$got" == "$before" ]] || {
    echo "backup preimage mismatch $service $rel" >&2
    exit 1
  }
  mkdir -p "$(dirname "$dest")"
  cp -a "$backup" "$dest"
  got=$(sha "$dest")
  [[ "$got" == "$before" ]] || {
    echo "restore hash mismatch $service $rel" >&2
    exit 1
  }
  restored=$((restored + 1))
done < "$FROM/FILE-STATE.tsv"

{
  echo -e "path\tsha256"
  while IFS=$'\t' read -r service rel state mounted before after src; do
    [[ "$service" != service && -n "${service:-}" ]] || continue
    echo -e "${service}/${rel}\t${before}"
  done < "$FROM/FILE-STATE.tsv"
} > "$SCRATCH/RESTORED-HASHES.tsv"

echo "restored $restored files, deleted $deleted added paths in $SCRATCH"
echo "hashes matched FILE-STATE before column including ABSENT"
echo "no docker compose, no --remove-orphans, no prune, no git revert"
