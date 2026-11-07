#!/usr/bin/env bash
# Prove packed AFTER @rakazo/core helpers resolve as source files, not dist,
# without the workspace package. Loads completion-artifact → irreversible-effect
# → approval-effect-key from the packed tree.
set -euo pipefail
export LC_ALL=C

FROM="${1:?usage: prove-isolated-core.sh CANDIDATE_DIR}"
FROM=$(cd "$FROM" && pwd)
CORE="$FROM/files/worker/after/packages/core/src"
need() { [[ -f "$1" ]] || { echo "missing $1" >&2; exit 1; }; }
need "$CORE/index.ts"
need "$CORE/completion-artifact.ts"
need "$CORE/irreversible-effect.ts"
need "$CORE/approval-effect-key.ts"
need "$CORE/secret-result-handle.ts"

grep -q 'export \* from "./completion-artifact.js";' "$CORE/index.ts"
grep -q 'export \* from "./irreversible-effect.js";' "$CORE/index.ts"
grep -q 'export \* from "./secret-result-handle.js";' "$CORE/index.ts"
grep -q 'from "./irreversible-effect.js"' "$CORE/completion-artifact.ts"
grep -q 'from "./approval-effect-key.js"' "$CORE/irreversible-effect.ts"

python3 - "$FROM" <<'PY'
import re, sys
from pathlib import Path
from_dir = Path(sys.argv[1])
core_src = from_dir / "files/worker/after/packages/core/src"
# Only the packed helper graph is in the overlay pack. Preexisting 926710a core
# modules (action-approval, prompt-data, ...) already live on the image.
packed_exports = "\n".join(p.read_text() for p in sorted(core_src.glob("*.ts")))
exported = set(re.findall(
    r"\bexport\s+(?:type\s+|async\s+)?(?:function|const|class|enum|type)\s+([A-Za-z0-9_]+)",
    packed_exports,
))
required = {
    "bindOutcomeArtifact",
    "classifyIrreversibleTool",
    "collectToolEvidence",
    "emptyCompletionLedger",
    "harvestSecretsFromUnknown",
    "rewriteUnverifiedClaims",
    "sanitizeFinalText",
    "secretsFromPriorAssistantText",
    "stripSecretEchoes",
    "stripSecretsFromUnknown",
}
missing = sorted(required - exported)
if missing:
    sys.exit(f"packed core helpers missing exports: {missing}")
for service in ("worker", "api"):
    for rel in (
        "packages/adapters/src/executor.ts",
        "packages/adapters/src/pi-runtime.ts",
        "packages/adapters/src/history-compaction.ts",
        "packages/adapters/src/protected-result.ts",
    ):
        text = (from_dir / "files" / service / "after" / rel).read_text()
        imported = set()
        for match in re.finditer(
            r'import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+"@rakazo/core"',
            text,
        ):
            for raw in match.group(1).split(","):
                name = raw.strip().split(" as ")[0].strip()
                if name:
                    imported.add(name)
        needed = sorted(imported & required)
        if rel.endswith("executor.ts") and "harvestSecretsFromUnknown" not in imported:
            sys.exit(f"{service} {rel} does not import harvestSecretsFromUnknown")
        if rel.endswith("pi-runtime.ts") and "stripSecretsFromUnknown" not in imported:
            sys.exit(f"{service} {rel} does not import stripSecretsFromUnknown")
        if rel.endswith("history-compaction.ts") and "sanitizeFinalText" not in imported:
            sys.exit(f"{service} {rel} does not import sanitizeFinalText")
        print(f"{service} {rel} new-helper imports: {', '.join(needed)}")
print("new @rakazo/core helper imports resolve from packed source, not dist")
PY

TMP=$(mktemp -d /tmp/isolated-core.XXXXXX)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT
mkdir -p "$TMP/src" "$TMP/node_modules/@rakazo"
cp -a "$CORE/completion-artifact.ts" "$TMP/src/"
cp -a "$CORE/irreversible-effect.ts" "$TMP/src/"
cp -a "$CORE/approval-effect-key.ts" "$TMP/src/"
cp -a "$CORE/secret-result-handle.ts" "$TMP/src/"
cat > "$TMP/src/index.ts" <<'EOF'
export * from "./completion-artifact.js";
export * from "./irreversible-effect.js";
export * from "./secret-result-handle.js";
EOF
cat > "$TMP/package.json" <<'EOF'
{
  "name": "isolated-core-proof",
  "type": "module"
}
EOF
mkdir -p "$TMP/fake-core"
cat > "$TMP/fake-core/package.json" <<'EOF'
{
  "name": "@rakazo/core",
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "development": "./src/index.ts",
      "default": "./src/index.ts"
    }
  }
}
EOF
cp -a "$TMP/src" "$TMP/fake-core/src"
ln -s "$TMP/fake-core" "$TMP/node_modules/@rakazo/core"

cat > "$TMP/proof.ts" <<'EOF'
import { createRequire } from "node:module";
import {
  bindOutcomeArtifact,
  harvestSecretsFromUnknown,
  classifyIrreversibleTool,
} from "./src/index.ts";

if (typeof bindOutcomeArtifact !== "function") throw new Error("bindOutcomeArtifact missing");
if (typeof harvestSecretsFromUnknown !== "function") throw new Error("harvestSecretsFromUnknown missing");
if (typeof classifyIrreversibleTool !== "function") throw new Error("classifyIrreversibleTool missing");

const artifact = bindOutcomeArtifact({
  result: { verified: true, tree: "Reset password successful." },
  toolName: "browser_extract",
  intentId: "intent-1",
  sourceMessageId: "msg-1",
  runId: "run-1",
});
if (artifact?.class !== "verified-read") throw new Error("isolated bindOutcomeArtifact failed");

const harvested = harvestSecretsFromUnknown({ password: "Cur#Rpr7xQ2mN9kL" });
if (!harvested.length) throw new Error("isolated harvest failed");

const classified = classifyIrreversibleTool("mac_messages_send", { handle: "+15550100" });
if (classified?.class !== "send") throw new Error("isolated classifyIrreversibleTool failed");

const require = createRequire(import.meta.url);
const pkg = require("./fake-core/package.json");
if (pkg.exports["."].default !== "./src/index.ts") {
  throw new Error("package default is not source index.ts");
}
const viaFile = await import(new URL("./fake-core/src/index.ts", import.meta.url).href);
if (typeof viaFile.bindOutcomeArtifact !== "function") throw new Error("file URL source index failed");
console.log(
  "isolated-core-ok source=./src/index.ts completion-artifact->irreversible-effect->approval-effect-key",
);
EOF

unset NODE_PATH
cd "$TMP"
if command -v tsx >/dev/null 2>&1; then
  tsx ./proof.ts
elif [[ -n "${REPO_TSX:-}" && -x "$REPO_TSX" ]]; then
  "$REPO_TSX" ./proof.ts
else
  node --experimental-strip-types --disable-warning=ExperimentalWarning ./proof.ts
fi
echo "prove-isolated-core: packed source exports resolved without workspace @rakazo/core"
