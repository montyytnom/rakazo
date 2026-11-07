# Isolated-candidate compose override (not production)

Sat Nov 7, 2026, 6:36 AM EST. Live hash-only on `.67` closed the c7e5 **preimage** gate: 22 existing before hashes matched FILE-STATE, 18 additions ABSENT, 40 mount classifications matched, bound RO host source = container bytes. Worker image `47d34235` / api `c500071f` unchanged. This pack does not docker, drain, restart, or mutate live. No new live permission. Parent isolated capture is next, not production.

Claim detection is English regex only; allowing success is CompletionLedger-only.

## Do not rebuild images

Keep worker `47d34235` and api `c500071f`. Keep original `COMPOSE-CHAINS.txt` + `MOUNT-MAP.tsv`. Capture is an **additive compose override** on those images. Rollback is drop the override and restore the 15 existing bind host files.

## 15 existing binds — same destinations, AFTER bytes

Container dest = `/app/<path>`. Replace the **host source file** already listed in MOUNT-MAP with `files/<service>/after/<path>` from this pack (RO). Then recreate/restart **that** service after drain/approval. Destinations do not change.

Worker: executor, bot-secrets, computer-browser, browser-tools, pi-runtime, history-compaction, bot-messages, pi-openai-compatible-provider.

Api: executor, computer-browser, browser-tools, pi-runtime, history-compaction, bot-messages, pi-openai-compatible-provider.

Rollback: copy `rollback-backup/files/<service>/<path>` back onto those same host sources; recreate/restart. Images stay `47d34235` / `c500071f`.

## 22 new RO binds — required for tsx + `@rakazo/core` source index

These are `pack_mounted=false`. Restart of the 15 binds cannot load them.

**Add bind over image (4)** — live file exists in image, AFTER differs:

- worker+api `/app/packages/adapters/src/pi-usage.ts`
- worker+api `/app/packages/core/src/index.ts`

**Add bind for absent path (18)** — live `test ! -e` passed:

- worker+api `/app/packages/core/src/{irreversible-effect,secret-result-handle,completion-artifact,compaction-provenance,handoff-delivery}.ts`
- worker+api `/app/packages/adapters/src/{stale-element-recovery,desktop-tool-contract,protected-result,model-stream-error}.ts`

Host source for each new bind: `files/<service>/after/<path>` from this pack, RO, dest `/app/<path>`.

## 3 image rows — skip

AFTER hash equals live/image; no bind:

- worker+api `/app/packages/core/src/approval-effect-key.ts`
- api `/app/packages/adapters/src/bot-secrets.ts`

## Isolated capture (parent)

Network none, `--rm`, same images. Mount the 15 replaced binds + 22 new binds. Do not use production compose as the running stack. Do not mutate `.67` host sources in place if that would be production; copy AFTER files to a capture-only host dir and point the override there.

See `COMPOSE-OVERRIDE.tsv` in this pack (action per FILE-STATE row).

## Rollback original compose chain

1. Remove the 22 additive binds (18 paths become absent; 4 revert to image bytes, which match FILE-STATE before).
2. Restore the 15 existing bind host files from `rollback-backup/` (c7e5 live-verified preimages).
3. Recreate/restart with original `COMPOSE-CHAINS.txt` + `MOUNT-MAP.tsv` only.
4. Do not retag or rebuild `47d34235` / `c500071f`.

Scratch `rollback-to-preimage.sh` proves file-state only. It is not this compose rollback.

Drain/approval remain parent-owned. Not authorization to deploy.
