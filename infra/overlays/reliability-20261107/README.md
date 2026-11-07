# Reliability repair overlay (do not deploy from this folder yet)

Parent rollout only after backup, tests, and idle drain. This branch does not merge or deploy.

## Compose + patch (offline)

`python3 scripts/compose-overlay-trees.py --overlay /tmp/overlay-export/overlay-export --out .compose --patch`

Produces `.compose/{worker,api}/{before,after}` from `926710a` plus the supplied overlay mounts. `--patch` inserts HOOKS at the overlay orchestration entrypoints. The overlay archive is not committed.

Per-service `bot-secrets.ts`:

- worker: exact overlay `savedlogins-20261104/src/worker/bot-secrets.ts` sha256 `b22b7f69ce3a0a45c54258dc9b66134352068f3abd89fb7800b3631b88e89d53` (30395 bytes). Compose fails if that file is missing or the hash differs. No base+stub.
- api: no overlay mount (`worker-only` in MOUNT-MAP). Stays `926710a` sha256 `e9ef81aaa20645c3ad27cd310600afae728295abc853ed602a00bf18317f6384`.

`--test-shim` is not part of this gate. Keep real `computer-lifecycle.ts` and mock prisma/sandbox/browser at the harness. Do not stub overlay executor, login-guard, bot-secrets, or computer-browser.

## What this is

Source repairs on production base `926710a`, plus bind-mount notes for a later worker/api recreate. Thinking budget and Flash-Next primary settings are **observed, not changed**.

## Backup / rollback

`ROLLBACK.sh` restores files from a backup that contains `files/` plus `BEFORE-HASHES.tsv`. It verifies each sha256 and writes `RESTORED-HASHES.tsv`. Default destination is `backup-dir/restored-candidate`. It does **not** recreate containers or run docker compose.

Self-check: `bash infra/overlays/reliability-20261107/ROLLBACK.sh --self-test`

Drain first using `DRAIN.md` (windows `:08–:22` / `:38–:52`, full idle signals). Parent recreates a service only after that drain; this script never does.

## Migration

Forward-only. New effect keys are `irr:v1:<sha256>`. Existing run-scoped keys keep working. Protected-result handles apply to **new** tool results only.

Historical plaintext in `external_effects.result`, `messages`, and `events` is **not** deleted here. See `SECRET-CLEANUP-PLAN.md`.

## API / worker parity

See `REPLACEMENT-MANIFEST.md`. Four live mounts are **SKEWED** (worker ≠ api): `executor`, `browser-tools`, `builtin-tools`, `computer-browser`. The first three take HOOKS; `computer-browser.ts` is untouched. Bind-mount the new modules onto **both** api and worker. Do not drop saved-login, Amazon sign-in verify, or `browser_extract`.

A 72-tool code-derived dump is **not** a matched production capture and does not unlock live evals.

Byte baseline is the isolated local-stub harness: `isolated-capture/RUNBOOK.md`. Parent runs it on the deployed image + overlay stack. This branch does not call GX10.
