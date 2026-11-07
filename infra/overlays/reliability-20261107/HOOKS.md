# Overlay hook points (worker-effective files)

Do not wholesale-replace overlay `executor.ts`. After rebuilding from this commit, or when bind-mounting new modules, apply these insertions to the live overlay copies:

1. `recordEffect`: reuse `irr:v1:` keys across runs in the same thread/intent.
2. Mutating send / generate tools: `threadIrreversibleEffectKey` instead of run-scoped keys.
3. `browserActFromTool`: `recoverStaleBrowserAct` (one snapshot remap).
4. Persist path: `redactProtectedTree` / `redactToolResultForModel` before `externalEffect.result` and model-visible text.
5. `launch_app` unsupported sandbox action: return the desktop catalog hint; do not retry.
6. `returnBotMessageOutcome`: `auto-outcome:<sourceMessageId>:<intent>`.
7. Compaction writer: `rewriteUnverifiedClaims` before saving the summary.
8. SSE fetch wrapper: fail the run on an in-stream `error` event even when HTTP status is 200.

Thinking: leave `RAKAZO_THINKING_BUDGET`, `RAKAZO_FAST_COMPUTER_STEPS`, and `chat_template_kwargs` unchanged until a matched capture comparison exists.
