# Operational rollback (not git revert)

`git revert` / `git checkout` on this branch does **not** roll back a deployed overlay. Production loads bind-mounted overlay files, not this git tree. Rolling back means restoring the **FILE-STATE** preimage, then restarting the processes that already mount those paths.

## Restore files

From this candidate bundle, against a scratch tree only:

```
./rollback-to-preimage.sh --from "$PWD" --scratch "$SCRATCH"
```

That script:

- refuses `/opt/docker`, `/app`, `/run`, `/var/lib/docker`, `/opt/rakazo`
- restores every `changed` and `unchanged` path from `rollback-backup/` (overlay-mounted files from compose-before; git-only files from `926710a`)
- **deletes** `added` paths (`before_sha256=ABSENT`), including new core helpers
- writes `RESTORED-HASHES.tsv` and checks sha256 against FILE-STATE

`ROLLBACK.sh` remains a copy-only helper for `BEFORE-HASHES.tsv`; it does not delete added helpers. Use `rollback-to-preimage.sh` for a complete file-state rollback.

Apply is also scratch-only:

```
./apply-to-scratch.sh --from "$PWD" --scratch "$SCRATCH" --seed-preimage
./apply-to-scratch.sh --self-test --from "$PWD"
```

Without `--seed-preimage`, apply requires the scratch tree to already match FILE-STATE before hashes, including absent added paths.

## What this script does not do

- Recreate or replace api/worker hosts
- Change thinking budget, Flash-Next, or guard policy
- Mutate historical plaintext stores (`HISTORICAL_PLAINTEXT_CLEANUP_LOCKED`)
- Pretend a git revert unmounts production

Process restart after the file restore is parent-owned.
