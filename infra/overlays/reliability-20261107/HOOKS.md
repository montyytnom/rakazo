# Overlay hook points (worker-effective files)

Do not wholesale-replace overlay `executor.ts`. After rebuilding from this commit, or when bind-mounting new modules, apply these insertions to the live overlay copies:

1. `recordEffect`: reuse `irr:v1:` keys across runs in the same thread/intent. Key is thread + authorizing **source message id** + class. Recipient is stored as authorized scope, not part of the key.
2. Continue / Try again reuses that source message id. A later user message with the same text is a new id. Compacted summary without a live user message id is unauthorized; irreversible tools fail closed and do not execute.
3. Crash / `executing` / unknown: `resolveDuplicateEffectGate` returns uncertain and does **not** replay. Completed replay runs `redactReplayResult` before the model sees it.
4. `browserActFromTool`: one stale remap only when the page URL is unchanged, the role+name match is unique, and the control is not irreversible. Reset / place-order is never auto-reclicked.
5. Persist path: `redactProtectedTree` / `redactToolResultForModel` before `externalEffect.result`. Hash cannot recover plaintext; missing handle fails handoff.
6. `launch_app` unsupported sandbox action: return the desktop catalog hint; do not retry.
7. `returnBotMessageOutcome`: `auto-outcome:<sourceMessageId>:<intent>`.
8. Compaction writer: `rewriteUnverifiedClaims` using **tool transcript** as evidence. Summary text that says verified is not evidence. Verified identity present in tool output is kept.
9. SSE fetch wrapper: inspect a completed frame **before** forwarding the completing chunk. HTTP 200 in-stream `error` fails the run; the error payload is not treated as a successful model result.

Thinking: leave `RAKAZO_THINKING_BUDGET`, `RAKAZO_FAST_COMPUTER_STEPS`, and `chat_template_kwargs` unchanged until a matched capture comparison exists.
