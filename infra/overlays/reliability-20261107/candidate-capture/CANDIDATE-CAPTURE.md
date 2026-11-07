# Exact candidate-capture commands

Sat Nov 7, 2026. Not production. Parent runs these on the connected Mac after unpacking the pack. This VM does not execute them against live. No pull, no build, no model network.

Pinned local images (unchanged):

```
export RAKAZO_WORKER_IMAGE=sha256:47d3423567b35333059f9ff55817c03656a43431539f0478e3eb959e13e9cdc6
export RAKAZO_API_IMAGE=sha256:c500071f5b2fde76d4bfca3ae883afb817c2265e2f113515cdb59c653d469f1f
```

Inspect-only (no exec/restart). Set to the live container names:

```
export RAKAZO_WORKER_CONTAINER=rakazo-worker
export RAKAZO_API_CONTAINER=rakazo-api
```

Unpack, then dry-run, then execute, then cleanup. Replace `PACK.tgz` / hashes with the transferred artifact.

```
mkdir -p /tmp/e342-pack
tar -C /tmp/e342-pack -xzf candidate-overlay-secret-completion.tgz
PACK=/tmp/e342-pack/candidate-overlay-secret-completion
STAGE=/tmp/rakazo-candidate-capture-stage
OUT=/tmp/rakazo-candidate-capture-out
LAUNCH="$PACK/candidate-capture/host-launch.sh"

# 1. Dry-run — must print 37 candidate binds; inspect dry-run-manifest.json
"$LAUNCH" \
  --candidate-overlay "$PACK" \
  --stage "$STAGE" \
  --out "$OUT" \
  --pack-sha256 PACK_SHA256 \
  --git-head GIT_HEAD \
  --dry-run

# 2. Execute — parent only, after auditing the dry-run
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
