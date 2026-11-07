#!/usr/bin/env bash
# Copy composed AFTER overlay files into a scratch tree. Does not recreate
# hosts, does not docker, does not bind-mount production, does not git revert.
set -euo pipefail
export LC_ALL=C

usage() {
  echo "usage: apply-to-scratch.sh --from CANDIDATE_DIR --scratch SCRATCH_DIR" >&2
  echo "CANDIDATE_DIR must contain files/{worker,api}/after and AFTER-HASHES.{worker,api}.tsv" >&2
  exit 2
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
[[ -d "$FROM/files/worker/after" && -d "$FROM/files/api/after" ]] || {
  echo "missing composed after trees under $FROM/files" >&2
  exit 1
}

sha() { sha256sum "$1" | awk '{print $1}'; }

apply_service() {
  local service="$1"
  local hashes="$FROM/AFTER-HASHES.${service}.tsv"
  local src_root="$FROM/files/${service}/after"
  [[ -f "$hashes" ]] || { echo "missing $hashes" >&2; exit 1; }
  local applied=0 rel expected src dest got
  while IFS=$'\t' read -r rel expected; do
    [[ -n "${rel:-}" && -n "${expected:-}" && "$rel" != path ]] || continue
    src="$src_root/$rel"
    dest="$SCRATCH/${service}/$rel"
    [[ -f "$src" ]] || { echo "missing after file $service $rel" >&2; exit 1; }
    got=$(sha "$src")
    [[ "$got" == "$expected" ]] || {
      echo "after hash mismatch $service $rel" >&2
      exit 1
    }
    mkdir -p "$(dirname "$dest")"
    cp -a "$src" "$dest"
    got=$(sha "$dest")
    [[ "$got" == "$expected" ]] || {
      echo "scratch hash mismatch $service $rel" >&2
      exit 1
    }
    applied=$((applied + 1))
  done < "$hashes"
  echo "applied $applied $service after files into $SCRATCH/$service"
}

mkdir -p "$SCRATCH"
apply_service worker
apply_service api
cp -a "$FROM/AFTER-HASHES.worker.tsv" "$SCRATCH/AFTER-HASHES.worker.tsv"
cp -a "$FROM/AFTER-HASHES.api.tsv" "$SCRATCH/AFTER-HASHES.api.tsv"
echo "apply-to-scratch complete; no host recreate, no docker, no production bind-mount"
