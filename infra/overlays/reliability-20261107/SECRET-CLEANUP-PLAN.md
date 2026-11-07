# Historical secret cleanup (separate from this repair)

This repair only changes the **future** persist path. Do not run destructive SQL as part of this overlay.

## Scope (later, parent-owned)

1. Read-only scan of `external_effects.result`, `messages.blocks`, and `events.payload` for generated-password patterns. Export matching row ids to a sealed backup.
2. For each match: copy the plaintext into the secret store under a protected handle, then **replace** the stored JSON field with `{ handle, hash, createdAt, status: "withheld" }`. No row deletes.
3. Re-scan; confirm no plaintext remains in those columns.
4. Keep the sealed backup until the owner confirms handoff still works, then destroy the backup under the existing backup-retention policy.

## Out of scope here

- Password resets against live IdPs
- Rewriting old compaction summaries in place without a backup
- Logging scan hits at info level (those hits are secrets)
