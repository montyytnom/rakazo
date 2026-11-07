# Exact candidate-capture commands

Sat Nov 7, 2026, 6:54 AM EST. Not production. Parent runs these on the connected Mac after unpacking the pack. This VM does not execute them against live. No pull, no build, no model network.

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

Unpack, then dry-run, then execute, then cleanup. Replace `PACK.tgz` / hashes with the transferred artifact.

```
mkdir -p /tmp/46fee0-pack
tar -C /tmp/46fee0-pack -xzf candidate-overlay-secret-completion.tgz
PACK=/tmp/46fee0-pack/candidate-overlay-secret-completion
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

# 2. Execute — parent only, after auditing dry-run-manifest.json inspectGateOk
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
