# Exact candidate-capture commands

Sat Nov 7, 2026. Not production. This VM does not execute against live. No pull, no build, no model network.

Do **not** rerun host capture from `ok` / rc=0 flags. The 729d execute was vacuous (zero HTTP, context-budget failed runs). Cloud smoke plus `check_nonvacuous.py` must pass, including raw HTTP byte counts, before any later isolated image run.

Pinned local images (unchanged):

```
export RAKAZO_WORKER_IMAGE=sha256:47d3423567b35333059f9ff55817c03656a43431539f0478e3eb959e13e9cdc6
export RAKAZO_API_IMAGE=sha256:c500071f5b2fde76d4bfca3ae883afb817c2265e2f113515cdb59c653d469f1f
```

Inspect-only (no exec/restart). Live compose replicas on .67, confirmed 6:36 and 6:52 AM EST:

```
export RAKAZO_WORKER_CONTAINER=rakazo-worker-1
export RAKAZO_API_CONTAINER=rakazo-api-1
```

Do not use `rakazo-worker` / `rakazo-api`. Those names do not exist. Dry-run and execute both fail-closed when `docker inspect` fails or when a `replace-existing-bind` dest is not on the inspected container. Unset container env resolves unique `com.docker.compose.service=worker|api` labels from live metadata; it does not retry a guessed `-1` suffix.

Keep `/tmp/46fee0-pack` and `/tmp/9427b1-pack` on .67 as evidence. Unpack this pack to a new directory.

Cloud smoke (this VM, not Docker image 47d34235/c500071f): actual `candidate-capture-harness.ts` copied into composed AFTER trees so relative imports hit composed executor/pi-runtime/history-compaction. `RAKAZO_CTXMEM=1` with `RAKAZO_CTXMEM_FACTS=1` and `=0` on both worker and api. Fake DB supplies `memoryDocument.findFirst`, `botMcpServer.findMany`, `botSecret.findMany`. Overlay-orchestration tests do not exercise this harness. `@rakazo/core` package resolution is workspace HEAD.

Unpack, then dry-run, then execute, then cleanup. Replace `PACK.tgz` / hashes with the transferred artifact.

```
mkdir -p /tmp/NEWPACK-pack
tar -C /tmp/NEWPACK-pack -xzf candidate-overlay-secret-completion.tgz
PACK=/tmp/NEWPACK-pack/candidate-overlay-secret-completion
STAGE=/tmp/rakazo-candidate-capture-stage
OUT=/tmp/rakazo-candidate-capture-out
LAUNCH="$PACK/candidate-capture/host-launch.sh"

# 1. Dry-run — must inspect rakazo-worker-1 / rakazo-api-1, list 37 binds,
#    15 replace-existing-bind rows matched to inspected dests, preserved mounts > 0.
#    Nonzero if inspect fails.
"$LAUNCH" \
  --candidate-overlay "$PACK" \
  --stage "$STAGE" \
  --out "$OUT" \
  --pack-sha256 PACK_SHA256 \
  --git-head GIT_HEAD \
  --dry-run

# 2. Execute — parent only, after auditing dry-run-manifest.json inspectGateOk.
#    Production-forwarded RAKAZO_CTXMEM stays on. Worker failure still starts api.
#    /out/scenario-*.json and phases-partial.json are written before the next scenario.
"$LAUNCH" \
  --candidate-overlay "$PACK" \
  --stage "$STAGE" \
  --out "$OUT" \
  --pack-sha256 PACK_SHA256 \
  --git-head GIT_HEAD \
  --execute

# 3. Dedicated staging cleanup (not production overlay paths)
"$LAUNCH" --stage "$STAGE" --cleanup-stage
```

`--execute` starts `rakazo-candidate-capture-{worker,api}-*` with `--rm --pull=never --network none --read-only`, tmpfs `/tmp` and `/run`, `--cap-drop ALL`, `no-new-privileges`, CPU 2 / memory 2g / pids 256. Writable `/out` only. Production containers are not exec'd, patched, or restarted. State/secrets mounts are not copied.
