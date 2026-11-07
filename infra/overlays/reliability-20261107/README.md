# Reliability repair overlay (do not deploy from this folder yet)

Parent rollout only after backup, tests, and idle drain. This branch does not merge or deploy.

## What this is

Source repairs on production base `926710a`, plus bind-mount notes for a later worker/api recreate. Thinking budget and Flash-Next primary settings are **observed, not changed**.

## Backup / rollback

1. Copy the live compose chain and mounted files to a timestamped backup directory (same pattern as prior bundles).
2. Append one `ACTIVE-BUNDLE.log` line pointing at `ROLLBACK.sh`.
3. Recreate **only** the target service with its full `-f` chain. Never `--remove-orphans` or `prune`.
4. Drain first: no live non-parked run, no recent running attempt, no locked Graphile job, no computer execution lease.

Rollback: `bash infra/overlays/reliability-20261107/ROLLBACK.sh <backup-dir>`

## Migration

Forward-only. New effect keys are `irr:v1:<sha256>`. Existing run-scoped keys keep working. Protected-result handles apply to **new** tool results only.

Historical plaintext in `external_effects.result`, `messages`, and `events` is **not** deleted here. See `SECRET-CLEANUP-PLAN.md`.

## API / worker parity

Production currently mounts different `browser-tools`, `builtin-tools`, `computer-browser`, and `executor` on api vs worker. After this source lands, remount **the same repaired adapter files on both** so the advertised catalog matches execution. Do not drop saved-login, Amazon sign-in verify, or `browser_extract` customizations.
