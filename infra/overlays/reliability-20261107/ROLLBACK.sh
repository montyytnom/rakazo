#!/usr/bin/env bash
# Restore a reliability candidate from a backup directory.
# Copies files, verifies sha256 against BEFORE-HASHES.tsv, writes restore hashes.
# Does not recreate containers, does not talk to production, does not docker compose.
set -euo pipefail
export LC_ALL=C

usage() {
  echo "usage: ROLLBACK.sh <backup-dir> [restore-root]" >&2
  echo "       ROLLBACK.sh --self-test" >&2
  echo "backup-dir must contain files/ and BEFORE-HASHES.tsv (path<TAB>sha256)." >&2
  echo "restore-root defaults to backup-dir/restored-candidate. Never runs docker." >&2
  exit 2
}

sha() { sha256sum "$1" | awk '{print $1}'; }

restore_from_backup() {
  local backup restore hashes
  backup=$(cd "$1" && pwd)
  hashes="$backup/BEFORE-HASHES.tsv"
  [[ -d "$backup/files" && -f "$hashes" ]] || {
    echo "backup must contain files/ and BEFORE-HASHES.tsv" >&2
    exit 1
  }
  restore=${2:-"$backup/restored-candidate"}
  mkdir -p "$restore"
  local restored=0 rel expected src dest got
  while IFS=$'\t' read -r rel expected; do
    [[ -n "${rel:-}" && -n "${expected:-}" && "$rel" != path ]] || continue
    src="$backup/files/$rel"
    dest="$restore/$rel"
    [[ -f "$src" ]] || { echo "missing backup file $rel" >&2; exit 1; }
    got=$(sha "$src")
    [[ "$got" == "$expected" ]] || {
      echo "backup preimage mismatch $rel" >&2
      exit 1
    }
    mkdir -p "$(dirname "$dest")"
    cp -a "$src" "$dest"
    got=$(sha "$dest")
    [[ "$got" == "$expected" ]] || {
      echo "restore hash mismatch $rel" >&2
      exit 1
    }
    restored=$((restored + 1))
  done < "$hashes"
  [[ "$restored" -gt 0 ]] || { echo "BEFORE-HASHES.tsv listed no files" >&2; exit 1; }
  {
    echo -e "path\tsha256"
    tail -n +2 "$hashes"
  } > "$restore/RESTORED-HASHES.tsv"
  echo "restored $restored files into $restore"
  echo "hashes matched BEFORE-HASHES.tsv"
  echo "no docker compose, no --remove-orphans, no prune"
}

self_test() {
  local tmp sample
  tmp=$(mktemp -d)
  sample="$tmp/workspace/sample.txt"
  mkdir -p "$(dirname "$sample")"
  printf 'candidate-preimage\n' > "$sample"
  local want
  want=$(sha "$sample")
  mkdir -p "$tmp/backup/files/workspace"
  cp -a "$sample" "$tmp/backup/files/workspace/sample.txt"
  printf 'path\tsha256\nworkspace/sample.txt\t%s\n' "$want" > "$tmp/backup/BEFORE-HASHES.tsv"
  printf 'mutated\n' > "$sample"
  restore_from_backup "$tmp/backup" "$tmp/restored"
  [[ $(sha "$tmp/restored/workspace/sample.txt") == "$want" ]]
  [[ $(sha "$sample") != "$want" ]]
  rm -rf "$tmp"
  echo "self-test ok: restore reversed the mutation in the candidate tree only"
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit 0
fi
[[ $# -ge 1 ]] || usage
restore_from_backup "$1" "${2:-}"
