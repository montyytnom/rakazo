#!/usr/bin/env bash
# Pack the composed AFTER overlay trees, FILE-STATE, preimage hashes, diffs,
# named test logs, apply-to-scratch launcher, and complete file-state rollback.
# Does not include overlay-export, production captures, or heldout fixtures.
set -euo pipefail
export LC_ALL=C

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
COMPOSE="${COMPOSE_OUT:-$ROOT/.compose}"
OVERLAY="${OVERLAY_EXPORT:-/tmp/overlay-export/overlay-export}"
OUT_TGZ="${1:-/opt/cursor/artifacts/candidate-overlay-secret-completion.tgz}"
STAGE="${FLAT_PARENT:-/tmp}/candidate-overlay-secret-completion"
BASE="926710a09b30a6c1f83029da88dfe06656b031f2"

sha() { sha256sum "$1" | awk '{print $1}'; }

need() {
  [[ -f "$1" ]] || { echo "missing $1" >&2; exit 1; }
}

need "$COMPOSE/worker/after/AFTER-HASHES.tsv"
need "$COMPOSE/api/after/AFTER-HASHES.tsv"
need "$COMPOSE/worker/before/PREIMAGE-HASHES.tsv"
need "$COMPOSE/api/before/PREIMAGE-HASHES.tsv"
need "$HERE/apply-to-scratch.sh"
need "$HERE/rollback-to-preimage.sh"
need "$HERE/prove-isolated-core.sh"
need "$HERE/RELEASE-MOUNT-PLAN.md"
need "$OVERLAY/MOUNT-MAP.tsv"
need "$ROOT/infra/overlays/reliability-20261107/ROLLBACK.sh"

rm -rf "$STAGE"
mkdir -p "$STAGE/files/worker/after" "$STAGE/files/api/after" \
  "$STAGE/rollback-backup/files" "$STAGE/DIFFS" "$STAGE/logs"

python3 - "$ROOT" "$COMPOSE" "$OVERLAY" "$BASE" "$STAGE" <<'PY'
import hashlib, subprocess, sys
from pathlib import Path

repo, compose, overlay, base, stage = map(Path, sys.argv[1:])
sys.path.insert(0, str(repo / "scripts"))
# Import TRACKED_PATHS / NEW_HELPERS without executing compose main.
text = (repo / "scripts/compose-overlay-trees.py").read_text()
ns = {}
exec(compile(text.split("def sha256")[0] + "\n", "compose-overlay-trees.py", "exec"), ns)
tracked = ns["TRACKED_PATHS"]
new_helpers = set(ns["NEW_HELPERS"])

def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())

def git_exists(rel: str) -> bool:
    return subprocess.run(
        ["git", "cat-file", "-e", f"{base}:{rel}"],
        cwd=repo,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode == 0

def git_sha(rel: str) -> str:
    data = subprocess.check_output(["git", "show", f"{base}:{rel}"], cwd=repo)
    return sha256_bytes(data)

def parse_mount_map():
    lines = (overlay / "MOUNT-MAP.tsv").read_text().splitlines()
    header = lines[0].split("\t")
    rows = []
    for line in lines[1:]:
        if not line.strip():
            continue
        cols = line.split("\t")
        rows.append({header[i]: cols[i] if i < len(cols) else "" for i in range(len(header))})
    return rows

SKIP = {"dir", "missing", "api-only", "worker-only", ""}

def overlay_mounted(service: str, rel: str) -> bool:
    dest = f"/app/{rel}"
    src_key = "worker_source" if service == "worker" else "api_source"
    hash_key = "worker_sha256" if service == "worker" else "api_sha256"
    for row in parse_mount_map():
        if row.get("destination_in_container") != dest:
            continue
        source = row.get(src_key, "")
        expected = row.get(hash_key, "")
        if source and expected not in SKIP:
            return True
    return False

mount_rows = parse_mount_map()

def overlay_mounted(service: str, rel: str) -> bool:
    dest = f"/app/{rel}"
    src_key = "worker_source" if service == "worker" else "api_source"
    hash_key = "worker_sha256" if service == "worker" else "api_sha256"
    for row in mount_rows:
        if row.get("destination_in_container") != dest:
            continue
        source = row.get(src_key, "")
        expected = row.get(hash_key, "")
        if source and expected not in SKIP:
            return True
    return False

rows = ["service\tpath\tstate\toverlay_mounted\tbefore_sha256\tafter_sha256\tbefore_source"]
after_lines = {"worker": ["path\tsha256"], "api": ["path\tsha256"]}
preimage_lines = {"worker": ["path\tsha256"], "api": ["path\tsha256"]}
before_hashes = ["path\tsha256"]

for service in ("worker", "api"):
    before_root = compose / service / "before"
    after_root = compose / service / "after"
    for rel in tracked:
        after_path = after_root / rel
        if not after_path.is_file():
            sys.exit(f"after missing {service} {rel}")
        after_hash = sha256_file(after_path)
        dest_after = stage / "files" / service / "after" / rel
        dest_after.parent.mkdir(parents=True, exist_ok=True)
        dest_after.write_bytes(after_path.read_bytes())
        after_lines[service].append(f"{rel}\t{after_hash}")

        mounted = overlay_mounted(service, rel)
        before_path = before_root / rel
        git_present = git_exists(rel)
        if mounted:
            if not before_path.is_file():
                sys.exit(f"overlay-mounted before missing {service} {rel}")
            before_hash = sha256_file(before_path)
            before_source = "overlay-preimage"
        elif git_present:
            before_hash = git_sha(rel)
            before_source = "git-926710a"
            if before_path.is_file():
                compose_before = sha256_file(before_path)
                if compose_before != before_hash:
                    sys.exit(
                        f"compose-before polluted for {service} {rel}: "
                        f"{compose_before} != git {before_hash}"
                    )
            else:
                sys.exit(f"git-present before missing from compose-before {service} {rel}")
        else:
            if before_path.exists():
                sys.exit(
                    f"compose-before contains added helper {service} {rel}; "
                    "before tree must leave 926710a-absent paths absent"
                )
            before_hash = "ABSENT"
            before_source = "ABSENT"

        if before_hash == "ABSENT":
            state = "added"
        elif before_hash == after_hash:
            state = "unchanged"
        else:
            state = "changed"

        rows.append(
            f"{service}\t{rel}\t{state}\t{str(mounted).lower()}\t{before_hash}\t{after_hash}\t{before_source}"
        )
        preimage_lines[service].append(f"{rel}\t{before_hash}")

        if before_hash != "ABSENT":
            backup = stage / "rollback-backup" / "files" / service / rel
            backup.parent.mkdir(parents=True, exist_ok=True)
            if mounted:
                backup.write_bytes(before_path.read_bytes())
            else:
                data = subprocess.check_output(["git", "show", f"{base}:{rel}"], cwd=repo)
                backup.write_bytes(data)
            got = sha256_file(backup)
            if got != before_hash:
                sys.exit(f"backup hash mismatch {service} {rel}")
            before_hashes.append(f"{service}/{rel}\t{before_hash}")

        diff_name = f"{service}.{Path(rel).name}"
        if state == "changed":
            before_bytes = backup.read_bytes() if before_hash != "ABSENT" else b""
            # backup was written above for changed
            src_before = stage / "rollback-backup" / "files" / service / rel
            subprocess.run(
                [
                    "diff",
                    "-u",
                    "--label",
                    f"before/{service}/{rel}",
                    "--label",
                    f"after/{service}/{rel}",
                    str(src_before),
                    str(dest_after),
                ],
                stdout=(stage / "DIFFS" / f"{diff_name}.diff").open("w"),
                check=False,
            )
        elif state == "added":
            (stage / "DIFFS" / f"{diff_name}.added.diff").write_text(
                f"--- /dev/null\n+++ after/{service}/{rel}\nadded {rel} sha256={after_hash}\n"
            )

(stage / "FILE-STATE.tsv").write_text("\n".join(rows) + "\n")
(stage / "AFTER-HASHES.worker.tsv").write_text("\n".join(after_lines["worker"]) + "\n")
(stage / "AFTER-HASHES.api.tsv").write_text("\n".join(after_lines["api"]) + "\n")
(stage / "PREIMAGE-HASHES.worker.tsv").write_text("\n".join(preimage_lines["worker"]) + "\n")
(stage / "PREIMAGE-HASHES.api.tsv").write_text("\n".join(preimage_lines["api"]) + "\n")
(stage / "rollback-backup" / "BEFORE-HASHES.tsv").write_text("\n".join(before_hashes) + "\n")
override = [
    "service\tpath\tdest\taction\tbefore_sha256\tafter_sha256\thost_source"
]
for line in rows[1:]:
    service, rel, state, mounted, before, after, _src = line.split("\t")
    dest = f"/app/{rel}"
    host = f"files/{service}/after/{rel}"
    if mounted == "true":
        action = "replace-existing-bind"
    elif before == after:
        action = "skip-unchanged-image"
        host = ""
    elif before == "ABSENT":
        action = "add-bind-absent-path"
    else:
        action = "add-bind-over-image"
    override.append(f"{service}\t{rel}\t{dest}\t{action}\t{before}\t{after}\t{host}")
(stage / "COMPOSE-OVERRIDE.tsv").write_text("\n".join(override) + "\n")
print(f"FILE-STATE rows={len(rows)-1} COMPOSE-OVERRIDE rows={len(override)-1}")
PY

cp -a "$HERE/apply-to-scratch.sh" "$STAGE/apply-to-scratch.sh"
cp -a "$HERE/rollback-to-preimage.sh" "$STAGE/rollback-to-preimage.sh"
cp -a "$HERE/prove-isolated-core.sh" "$STAGE/prove-isolated-core.sh"
chmod +x "$STAGE/apply-to-scratch.sh" "$STAGE/rollback-to-preimage.sh" "$STAGE/prove-isolated-core.sh"
cp -a "$HERE/OPERATIONAL-ROLLBACK.md" "$STAGE/OPERATIONAL-ROLLBACK.md"
cp -a "$HERE/RELEASE-MOUNT-PLAN.md" "$STAGE/RELEASE-MOUNT-PLAN.md"
cp -a "$ROOT/infra/overlays/reliability-20261107/ROLLBACK.sh" "$STAGE/ROLLBACK.sh"
chmod +x "$STAGE/ROLLBACK.sh"
cp -a "$ROOT/infra/overlays/reliability-20261107/HOOKS.md" "$STAGE/HOOKS.md"
cp -a "$ROOT/infra/overlays/reliability-20261107/SECRET-CLEANUP-PLAN.md" "$STAGE/SECRET-CLEANUP-PLAN.md"

# Live runtime loading: worker/api start tsx + @rakazo/core default source index.
python3 - "$ROOT" "$STAGE" <<'PY'
import json, sys
from pathlib import Path
root, stage = map(Path, sys.argv[1:])
core = json.loads((root / "packages/core/package.json").read_text())
worker = json.loads((root / "apps/worker/package.json").read_text())
api = json.loads((root / "apps/api/package.json").read_text())
default = core["exports"]["."]["default"]
assert default == "./src/index.ts", default
assert worker["scripts"]["start"] == "tsx src/index.ts"
assert api["scripts"]["start"] == "tsx src/index.ts"
(stage / "RUNTIME-LOADING.txt").write_text(
    "worker start: tsx src/index.ts\n"
    "api start: tsx src/index.ts\n"
    "@rakazo/core exports.default: ./src/index.ts (source, not dist)\n"
    "packed after includes packages/core/src/index.ts plus helper graph\n"
    "completion-artifact.ts imports ./irreversible-effect.js which is packed\n"
)
print("runtime loading: tsx + source index.ts")
PY

for log in \
  candidate-overlay-orchestration.log \
  candidate-isolated-capture.log \
  candidate-overlay-guard-final.log \
  candidate-overlay-guard-throw-vs-return.log \
  candidate-reliability-fixtures.log \
  candidate-python-isolated-capture.log \
  candidate-typecheck-core.log \
  candidate-typecheck-adapters.log \
  candidate-secret-completion-test.log \
  candidate-adapters-full-suite.log \
  candidate-core-full-suite.log \
  candidate-history-compaction.log \
  candidate-piruntime-sse-tests.log \
  candidate-piruntime-sse-verbose.log \
  candidate-isolated-core.log \
  candidate-apply-rollback-selftest.log
do
  if [[ -f "/opt/cursor/artifacts/$log" ]]; then
    cp -a "/opt/cursor/artifacts/$log" "$STAGE/logs/$log"
  fi
done
if [[ -f /home/ubuntu/.cursor/projects/workspace/uploads/live-vs-filestate_7463.tsv ]]; then
  cp -a /home/ubuntu/.cursor/projects/workspace/uploads/live-vs-filestate_7463.tsv \
    "$STAGE/logs/live-vs-filestate-636est.tsv"
fi

cat > "$STAGE/MANIFEST.txt" <<EOF
candidate overlay secret/completion slice (closed FILE-STATE pack)
composed from 926710a + overlay archive + --patch
compose-before does not copy HEAD helpers; 926710a-absent paths stay absent
FILE-STATE.tsv classifies changed/unchanged/added with before=ABSENT for additions
rollback-to-preimage.sh restores every changed/unchanged file and deletes added paths
apply-to-scratch.sh refuses /opt/docker /app /run /var/lib/docker /opt/rakazo
apply-to-scratch.sh requires FILE-STATE preimage or --seed-preimage
HEAD executor still returns raw tool results to the model
Releasable files are the composed worker/api AFTER trees in files/
Claim detection is English regex only; not a multilingual or semantic parser. Allowing success is CompletionLedger-only.
Live hash-only 6:36 AM EST closed c7e5 preimages (22 match, 18 absent, images 47d34235/c500071f). Isolated capture uses COMPOSE-OVERRIDE.tsv: 15 replace-existing-bind, 22 add-bind, 3 skip-unchanged-image. Not production.
HEAD vitest adapters/core suites label HEAD workspace, not composed trees.
PiRuntime stub JSON measures HTTP/persist/final; named tests cover in-run handoff and composed compaction separately.
HISTORICAL_PLAINTEXT_CLEANUP_LOCKED=true
isolated-capture baseline fixtures unchanged
no production calls, no model calls, no heldout inspection
EOF

REPO_TSX="$(command -v tsx || true)"
if [[ -z "$REPO_TSX" && -x "$ROOT/node_modules/.bin/tsx" ]]; then
  REPO_TSX="$ROOT/node_modules/.bin/tsx"
fi
export REPO_TSX
"$STAGE/prove-isolated-core.sh" "$STAGE" | tee "$STAGE/logs/candidate-isolated-core.log"
"$STAGE/apply-to-scratch.sh" --self-test --from "$STAGE" | tee "$STAGE/logs/candidate-apply-rollback-selftest.log"

python3 - "$STAGE" <<'PY'
from pathlib import Path
stage = Path(__file__) if False else Path(__import__("sys").argv[1])
logs = sorted(p.name for p in (stage / "logs").glob("*") if p.is_file())
index = [
    "# Pack index",
    "",
    "Sat Nov 7, 2026, 6:36 AM EST. Scratch-only. Not production.",
    "",
    "## Recipe",
    "",
    "- `FILE-STATE.tsv` — 40 rows, live-verified preimages 6:36 AM EST",
    "- `COMPOSE-OVERRIDE.tsv` — 15 replace-existing-bind, 22 add-bind, 3 skip-unchanged-image",
    "- `RELEASE-MOUNT-PLAN.md` — isolated capture on images 47d34235 / c500071f; rollback original compose chain",
    "- `OPERATIONAL-ROLLBACK.md` / `rollback-to-preimage.sh` — scratch file-state only",
    "- `apply-to-scratch.sh` — refuses production roots; `--seed-preimage` or exact before hashes",
    "- `prove-isolated-core.sh` — packed source `completion-artifact` → `irreversible-effect`",
    "- `RUNTIME-LOADING.txt` — tsx + `@rakazo/core` default `./src/index.ts`",
    "",
    "## Labels",
    "",
    "- HEAD vitest adapters/core = workspace HEAD, not composed trees",
    "- overlay-orchestration = composed before/after trees",
    "- PiRuntime JSON measures HTTP/persist/final/handoff; compaction is a named composed-tree test",
    "- Claim detection is English regex; allowing success is CompletionLedger-only",
    "",
    "## Logs in this pack",
    "",
]
index.extend(f"- `logs/{name}`" for name in logs)
(stage / "INDEX.md").write_text("\n".join(index) + "\n")
print("INDEX.md", len(logs), "logs")
PY

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
