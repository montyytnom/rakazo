# Isolated capture

Self-contained bundle: see `README.md` in this directory. Parent does not clone the repo. `host-launch.sh --dry-run` then `--execute`. Production merge/deploy forbidden. Gate is not met until byte acceptance.

Full HTTP bodies are the byte-diff target after declared volatile fields (`volatile-fields.json`). Unexplained mismatch voids the baseline. No live/real context export. No model network.

## The four required assembler blocks

1. `baseComputerInstruction` — `persistentComputerInstruction`
2. `renderBotCapabilityDirectory` — actual renderer output
3. `formatSkillsCatalogInstruction` — actual catalog line
4. `longWorkProgressGuidance()` — actual function output

Name + sha256 of every block is in `phases-summary.json`. group/messaging/memory/scratchpad are additional if emitted, not replacements.

## Tools

`selectBuiltinToolsForRun` against the mounted per-service `builtin-tools` / `executor`. Empty connector registry is listed as a baseline limitation. Reviewer expected worker builtins 74: verify, do not force.

Isolated sources are bind-mounted without replacing deployed runtime modules. `isolated-capture.ts` does not import `capture-harness`. Overlay `login-guard.ts` / `page-browser-session.ts` stay in the source mount set. Assist prompt env is hashed, never copied.

## Login-guard SHAPE

See `login-guard-policy.SHAPE.txt`. Production `/run/login-guard/policy.txt` is not mounted into capture containers.

## SecretStore

`secret-store-capability-check.sh` is read-only.
