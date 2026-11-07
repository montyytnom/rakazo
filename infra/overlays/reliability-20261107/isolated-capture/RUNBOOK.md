# Isolated capture runbook

Deployed-code synthetic capture is the baseline. Historical exact live requests remain unavailable and unverified; that is not a baseline blocker. The live eval gate stays locked until these captures are byte-accepted.

This agent does not call GX10. Parent runs this bundle on an isolated deployed-image + overlay stack and shares the files.

## What the harness captures

Per service (`worker` and `api`):

1. Three synthetic cases `first` / `postbrowser` / `guard-final` as successive outbound HTTP POSTs from `PiAgentRuntime` → overlay `createOpenAiCompatibleFetch` → **local stub on 127.0.0.1**.
2. Raw request bytes, sha256, and non-auth headers.
3. Full offered builtin tools (production-shaped `selectBuiltinToolsForRun`) plus exact included/omitted `temperature` / `top_p` / `top_k` / `thinking_budget` / `enable_thinking` / `max_tokens` / `max_completion_tokens`.
4. All four runtime-only prompt blocks: group, messaging, memory, scratchpad.
5. Oversized page + four snapshot results: last-3 kept, 12K clip (`…`).
6. One compaction pass: model, params, input, stub output. No model network.
7. Stub responses through the real pi-ai parser and `pi-tool-call-guard`: valid call, malformed (nameless), two calls, four identical HTTP 500s then success (`MODEL_STREAM_MAX_RETRIES=5` for that case only).
8. Provenance: git SHA, pi-ai version, `pi-tool-call-guard.ts` sha256, image digest env/commands.
9. Declared volatile fields in `volatile-fields.json`. Unexplained mismatches void the baseline.

No real chat, secrets, browser, DB writes, or network beyond the stub.

## Parent execution (no manual code edits)

On **each** of the isolated worker and api containers (overlay files already mounted):

```bash
# bind-mount this directory to /opt/isolated-capture
# bind-mount packages/adapters/src/isolated-capture.ts into the adapters tree if it is not already on the image
export RAKAZO_API_IMAGE=...          # image reference only; digest recorded, never pulled here
export RAKAZO_WORKER_IMAGE=...
export RAKAZO_API_IMAGE_DIGEST=sha256:...     # or let provenance.sh docker inspect
export RAKAZO_WORKER_IMAGE_DIGEST=sha256:...
export RAKAZO_GIT_SHA=...            # 926710a-plus-overlays commit if git is absent in the image
export ISOLATED_CAPTURE_NOW=2026-11-07T00:00:00.000Z

# inside worker:
ISOLATED_CAPTURE_SERVICE=worker ISOLATED_CAPTURE_OUT=/tmp/capture/worker \
  bash /opt/isolated-capture/run.sh worker /tmp/capture/worker

# inside api:
ISOLATED_CAPTURE_SERVICE=api ISOLATED_CAPTURE_OUT=/tmp/capture/api \
  bash /opt/isolated-capture/run.sh api /tmp/capture/api
```

From this checkout (authoring VM, not a baseline):

```bash
ISOLATED_CAPTURE_NOW=2026-11-07T00:00:00.000Z \
  pnpm exec tsx scripts/isolated-capture.ts --service this-tree --out /tmp/capture/this-tree
```

`this-tree` is the branch adapters graph. Worker vs api byte baseline requires the two container runs above so each process imports that image's overlay mounts.

## Byte-diff replay

1. Re-run the same command on the same image digests + git SHA + pi-ai version + guard hash.
2. Exact-byte diff `phases/*.bin`, `page-trim/*.bin`, `compaction/pass.bin` after stripping declared volatile fields (`http.headers.date`, `http.headers.host`, `http.headers.connection`, current-time sentence unless `ISOLATED_CAPTURE_NOW` is pinned, `sse.created`).
3. Compare `HASHMANIFEST.tsv`.
4. Any other mismatch voids the baseline.

Thinking / Flash-Next env is **observed**, not changed.

## Login-guard policy

See `login-guard-policy.SHAPE.txt`. Production worker file `/run/login-guard/policy.txt` is the live-policy prerequisite. The synthetic SHAPE file is not that policy and is not required for the serializer baseline.

## SecretStore

`secret-store-capability-check.sh` is read-only. Existing `SecretStore.put/load/delete` already supports opaque refs; the vault uses that path. Missing store → `PROTECTED_RESULT_VAULT` fail-closed. No new keys.

## Historical exact requests

`historical-unverified.md` in the capture output. Unavailable. Not a blocker.
