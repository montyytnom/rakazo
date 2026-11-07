# Candidate capture (composed executor → PiRuntime → loopback stub)

Not the run13 assembler/compactHistory baseline. Not production. Images stay `47d34235` / `c500071f`. No pull, no build, network none, in-container 127.0.0.1 stub only.

`--candidate-overlay` is the unpacked pack root (`COMPOSE-OVERRIDE.tsv` + `files/`). Matching inspected `/app` dests are **replaced** (not duplicated). New dests are added. Other allowed app-source mounts are preserved. Skip-unchanged-image rows are not bound. After-file sha256 must match the TSV. Duplicate dests refuse. Dry-run lists all **37** candidate binds. `--stage` must be a capture-only `*rakazo-candidate-capture-stage*` directory; `--cleanup-stage` removes only that directory.

Harness file: `packages/adapters/src/candidate-capture-harness.ts` (packed beside this launcher). Synthetic scenarios only: generated secret, stale secret, protected handoff (repaired path), unsupported Done, compaction current/stale secret strip. Empty fail-before handoff is a preimage invariant, not leak proof.

Exact commands: `CANDIDATE-CAPTURE.md`.
