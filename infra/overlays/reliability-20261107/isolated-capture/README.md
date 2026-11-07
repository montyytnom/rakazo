# Isolated capture bundle (no git checkout)

Self-contained. Parent does not clone the repo. Production merge/deploy remains forbidden. This does not declare the capture gate met.

## What it captures

Per ephemeral worker and api container, from the **deployed image + live source mounts**:

1. `baseComputerInstruction` = `persistentComputerInstruction(...)`
2. `renderBotCapabilityDirectory` = actual function output (synthetic peer fixture, not a live roster export)
3. `formatSkillsCatalogInstruction` = actual function output (synthetic skill catalog, not live skills)
4. `longWorkProgressGuidance()` = actual function output

Each block is named and sha256-hashed. group/messaging/memory/scratchpad are recorded only if the assembler emits them; they are not substitutes for the four.

Tool inventory comes from `selectBuiltinToolsForRun` on that service's mounted `builtin-tools` + `executor`. No handwritten schemas. Empty connector registry (network-off) is a baseline limitation and is listed. Reviewer expected worker builtins: 74 — verified, not forced.

Full HTTP body is the byte-diff target after declared volatile fields. No live/real context export. No model network. No GX10.

## Dry-run then execute

Images must already exist locally. No pull, no build.

```
export RAKAZO_WORKER_IMAGE=sha256:...    # local digest or image id
export RAKAZO_API_IMAGE=sha256:...
# optional, inspect-only (no exec/restart):
export RAKAZO_WORKER_CONTAINER=rakazo-worker
export RAKAZO_API_CONTAINER=rakazo-api

./host-launch.sh --dry-run --out /tmp/isolated-capture-out
# audit dry-run-manifest.json: retained /app source mounts, typed 0/1 assist switches, config-coverage preflight

./host-launch.sh --execute --out /tmp/isolated-capture-out
```

`--execute` starts `rakazo-isolated-capture-{worker,api}-*` with `--network none`, `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, CPU/memory/PID bounds, tmpfs `/tmp` and `/run`, writable `/out` only. It removes only those capture containers. Production containers are not exec'd, patched, or restarted.

Overlay source files under `/app/packages/adapters/src/` are retained, including worker `login-guard.ts` and api/worker `page-browser-session.ts`. State paths `/data`, `/run/login-guard`, `/run/op-data`, and `/run/secrets/scrapling_token` are not mounted. `.env` is not copied.

`RAKAZO_ASSIST_PROMPT` and `RAKAZO_ASSIST_STABLE_PREFIX` are boolean 0/1 switches (`=== "0"` off in overlay executor). Live both-services value `1` is forwarded literally. Freeform text is rejected, not treated as prompt. `RAKAZO_OPENAI_COMPAT_CHAT_TEMPLATE_KWARGS` forwards known boolean fields `enable_thinking` and `medium_effort` only. Config-coverage preflight enumerates env reads from promptbuilder/toolbuilder/serializer/parser/compaction source and blocks unexplained consumed names. Compaction is recorded UNMET: capture does not call deployed `compactHistory`. The three chat/completions phases are the serializer baseline. Secrets and realcontext are not forwarded.

## In-container

`run.sh` is invoked by the launcher. Bind-mounts this bundle's isolated sources (currently `isolated-capture.ts` only) onto `/app/packages/adapters/src/` so relative imports resolve to the live adapters tree. Deployed runtime files are not replaced.
