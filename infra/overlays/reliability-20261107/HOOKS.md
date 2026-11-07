# Overlay hook points (worker-effective files)

Do not wholesale-replace overlay `executor.ts`. After rebuilding from this commit, or when bind-mounting new modules, apply these insertions to the live overlay copies.

Offline compose against the supplied overlay archive (hash-gated, no production):

`python3 scripts/compose-overlay-trees.py --overlay "$OVERLAY_EXPORT" --out .compose --patch`

That copies `926710a` sources, overlays MOUNT-MAP files (worker `bot-secrets.ts` is the exact overlay file, hash-gated; api keeps `926710a`), then applies the insertions below at the live `createRunExecutor` / `browserActFromTool` / compaction / SSE / computer-browser callsites. Do not stub `computer-lifecycle.ts` for this gate. Entry-path proof: `packages/adapters/src/overlay-orchestration.entry.test.ts`.

1. `recordEffect`: reuse `irr:v1:` keys across runs in the same thread/intent. Key is thread + authorizing **source message id** + class. Recipient is stored as authorized scope, not part of the key.
2. Continue / Try again reuses that source message id. A later user message with the same text is a new id. Compacted summary without a live user message id is unauthorized; irreversible tools fail closed and do not execute.
3. Crash / `executing` / unknown: `resolveDuplicateEffectGate` returns uncertain and does **not** replay. Completed replay runs `redactReplayResult` before the model sees it.
4. `browserActFromTool`: one stale remap only when the page URL is unchanged, the role+name match is unique, and the control is not irreversible. Reset / place-order is never auto-reclicked.
5. Persist path: `protectPersistedEffectResult` before `externalEffect.result`. Model sees handle+hash only. Encrypted `SecretStore` may store an opaque `protectedVaultRef` on the effect row; replay strips it. No `SecretStore` → `PROTECTED_RESULT_VAULT` fail-closed, no plaintext, no invented table. Hash cannot recover plaintext; missing handle fails handoff. Generated/current/stale passwords harvested from the raw tool result and args are added to `runSecrets` before the model-visible result is returned.
5d. Final reply persist: `sanitizeFinalText` + `stripSecretEchoes` on `finalizeRun` blocks and the notification body. Secrets come from prior assistant text, the current assembled reply, and `runSecrets`. Success claims (`Done` / `All set` / `Successfully changed` / `It is reset`) are English-regex *detection* only; allowing the original final requires a `CompletionLedger` artifact bound to this turn's intentId + sourceMessageId + runId (`verified-read` / `delivered-send` / `task-proof`). Blob `{sent:true}` / `{verified:true}`, login pages, 404s, unrelated sends, and other-run proof do not count. Without a matching artifact the final becomes `Outcome was not verified.` Claim detection is not a multilingual or semantic parser. Compaction strips the same generated-password labels from the saved summary. Historical plaintext rows stay locked (`HISTORICAL_PLAINTEXT_CLEANUP_LOCKED`); cleanup is not auto-mutation.
5e. Overlay PiRuntime `transformContext` / `assistPrepareContext`: harvest labelled secrets from the live transcript (including replayed tool-call arguments) and replace them with `[withheld]` before the next model HTTP request. Persist already vaults the tool result; this is the request-after-tool-result model boundary. HEAD executor still returns raw tool results to the model.
5b. `recordEffect` create: unique-constraint (`P2002`) reuses the persistent `irr:v1` row. Run-local `toolEffectIdempotencyKey` stays run-scoped. A new authorized `sourceMessageId` is a new `irr:v1` and is not suppressed.
5c. Worker `computer-browser` `focused()` never returns a value. LOGIN_GUARD refusal is final on worker (already) and api (patched). Do not wholesale-replace. Login-guard policy files stay worker-only.
6. `launch_app` unsupported sandbox action: return the desktop catalog hint; do not retry.
7. `returnBotMessageOutcome`: `auto-outcome:<sourceMessageId>:<intent>`.
8. Compaction writer: `rewriteUnverifiedClaims` using **tool transcript** as evidence. Summary text that says verified is not evidence. Verified identity present in tool output is kept.
9. SSE fetch wrapper: inspect a completed frame **before** forwarding the completing chunk. HTTP 200 in-stream `error` fails the run; the error payload is not treated as a successful model result.

Thinking: leave `RAKAZO_THINKING_BUDGET`, `RAKAZO_FAST_COMPUTER_STEPS`, and `chat_template_kwargs` unchanged until a matched capture comparison exists.
