#!/usr/bin/env bash
# Build the parent-runnable tarball. No live context, no model calls.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
FLAT_PARENT="${1:-/tmp}"
OUT_TGZ="${2:-/opt/cursor/artifacts/isolated-capture-bundle.tgz}"
STAGE="$FLAT_PARENT/isolated-capture-bundle"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -a "$ROOT/infra/overlays/reliability-20261107/isolated-capture/." "$STAGE/"
cp "$ROOT/packages/adapters/src/isolated-capture.ts" "$STAGE/isolated-capture.ts"
cp "$ROOT/packages/adapters/src/pi-tool-call-guard.ts" "$STAGE/pi-tool-call-guard.ts"
rm -f "$STAGE/pack-bundle.sh"
(
  cd "$STAGE"
  find . -type f ! -name HASHMANIFEST.tsv | sort | while read -r file; do
    sha256sum "$file"
  done
) > "$STAGE/HASHMANIFEST.tsv"
mkdir -p "$(dirname "$OUT_TGZ")"
tar -C "$FLAT_PARENT" -czf "$OUT_TGZ" isolated-capture-bundle
sha256sum "$OUT_TGZ"
echo "$OUT_TGZ"
