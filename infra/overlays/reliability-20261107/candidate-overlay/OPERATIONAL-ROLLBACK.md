# Operational rollback (not git revert)

`git revert` / `git checkout` on this branch does **not** roll back a deployed overlay. Production loads bind-mounted overlay files, not this git tree. Rolling back means restoring the **preimage** files whose hashes are in `PREIMAGE-HASHES.*.tsv`, then restarting the processes that already mount those paths.

## Restore files

From this candidate bundle:

```
../ROLLBACK.sh "$PWD/rollback-backup" "$SCRATCH"
```

`ROLLBACK.sh` copies `files/` listed in `BEFORE-HASHES.tsv`, checks sha256 against that table, and writes `RESTORED-HASHES.tsv`. It does not run docker, compose, `--remove-orphans`, or prune.

The pack's `rollback-backup/` holds the unpatched overlay executors and `pi-runtime.ts` (compose without `--patch`) plus the same helpers. After restore, hashes must match `PREIMAGE-HASHES.worker.tsv` / `PREIMAGE-HASHES.api.tsv`.

## What this script does not do

- Recreate or replace api/worker hosts
- Change thinking budget, Flash-Next, or guard policy
- Mutate historical plaintext stores (`HISTORICAL_PLAINTEXT_CLEANUP_LOCKED`)
- Pretend a git revert unmounts production

Process restart after the file restore is parent-owned.
