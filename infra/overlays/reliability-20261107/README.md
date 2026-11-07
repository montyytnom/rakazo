# Reliability repair overlay (do not deploy from this folder yet)

Parent rollout only after backup, tests, and idle drain. This branch does not merge or deploy.

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
