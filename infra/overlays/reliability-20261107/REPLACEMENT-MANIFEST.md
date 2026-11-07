# Per-service replacement manifest

Production-effective layout is image `926710a` plus the overlay chain. This branch does **not** remount live hosts. Hashes are SHA-256 of the 20 source files on this commit. Count: **20 hashes, 20 rows below**. Overlay implementation hashes stay with the private overlay export; they are not copied here.

MOUNT-MAP column `same_in_worker_and_api=NO-SKEW` means the live mounts **differ** (worker ≠ api). This document says **SKEWED** for that case.

## How to apply

Do **not** wholesale-replace overlay `executor.ts`, `browser-tools.ts`, `builtin-tools.ts`, or `computer-browser.ts`. Those overlay copies still carry saved-login, sign-in verify, and `browser_extract` customizations this 926710a-based source does not contain.

1. Bind-mount the **new** modules below onto both api and worker.
2. Apply `HOOKS.md` insertions into the live overlay copies of patched files.
3. `computer-browser.ts` remains **SKEWED**. Apply HOOKS only: worker `focused()` never returns a value; api LOGIN_GUARD refusal is final. Do not wholesale-replace. Worker login-guard + `focused()` stay.

Thinking / Flash-Next files stay untouched.

## All 20 hashed files

### New modules (bind-mount both api and worker) — 10

| # | Container path | Source | sha256 |
|---|---|---|---|
| 1 | `/app/packages/core/src/irreversible-effect.ts` | `packages/core/src/irreversible-effect.ts` | `910c0f3ec95c876b678054d85b2b02ceb4d200f6436c9ddd9ea6ce9d0b1092e1` |
| 2 | `/app/packages/core/src/secret-result-handle.ts` | `packages/core/src/secret-result-handle.ts` | `ecdffcc2ffd3de19a29479d59da8dddccb11adc14be6a107ab952fdc7be0532f` |
| 3 | `/app/packages/core/src/completion-artifact.ts` | `packages/core/src/completion-artifact.ts` | `e38de06d878f90d3a7d6571859f1351b9878bfaad3eca67ee3a98b5236d59845` |
| 4 | `/app/packages/core/src/compaction-provenance.ts` | `packages/core/src/compaction-provenance.ts` | `af1ca37ab04e39f5a64f15a5a1e2aa9c13304b1b3cebb4b0ebfcf58d10f8c696` |
| 5 | `/app/packages/core/src/handoff-delivery.ts` | `packages/core/src/handoff-delivery.ts` | `d0490795391a38df1b5e2fa24bb99ce5786a67ba3eb4b1a8ff8e24ab762b5fae` |
| 6 | `/app/packages/core/src/index.ts` | `packages/core/src/index.ts` | `15a9cceec41e55fa6c977a1eb96940da2314f0396dd350ac06e014a84cfedf62` |
| 7 | `/app/packages/adapters/src/stale-element-recovery.ts` | `packages/adapters/src/stale-element-recovery.ts` | `98899f32520f6796f04061b11788f99ffaafd8a017f78eb8d2e7b6a80f6f3e22` |
| 8 | `/app/packages/adapters/src/desktop-tool-contract.ts` | `packages/adapters/src/desktop-tool-contract.ts` | `42aa185f612934f1ba24d99d09cc78fa95550765eca83ece183f9f9a6cd65e0c` |
| 9 | `/app/packages/adapters/src/protected-result.ts` | `packages/adapters/src/protected-result.ts` | `955fcb93ed1d80735f95ad0a455f07f49480fc1755f7e42b1a524c4d34784bec` |
| 10 | `/app/packages/adapters/src/model-stream-error.ts` | `packages/adapters/src/model-stream-error.ts` | `7219e869341d3bff71893345061a08ce2691bcc4c6f12bd38729375e287364f7` |

### Offline dump only — 1 (hashed, not a production mount)

| # | Source | sha256 |
|---|---|---|
| 11 | `packages/adapters/src/capture-harness.ts` | `ccfe9df3e9d60c72f687f61256730bb6c76f79cae81105c93dd4103ee67a3e07` |

### Patch via HOOKS (do not wholesale-replace) — 9

| # | Container path | This-branch sha256 | Per-service overlay status |
|---|---|---|---|
| 12 | `/app/packages/adapters/src/executor.ts` | `050fd5504de1433565012f1d40e9d3b4a994a0303b3098564bcf881451ee5a3d` | **SKEWED** (worker amazon-signin-verify ≠ api browserextract) |
| 13 | `/app/packages/adapters/src/browser-tools.ts` | `f4b0d7d575e13c5dfc296d7e5c398abbae68e90992f9a385d0c178655e3cc2e7` | **SKEWED** (worker savedlogins ≠ api browserextract) |
| 14 | `/app/packages/adapters/src/builtin-tools.ts` | `9ee95d483069d9943724c372a109d1ab8629ad07de68b63a2c66af716d12f5e3` | **SKEWED** (worker savedlogins ≠ api browserextract) |
| 15 | `/app/packages/adapters/src/bot-messages.ts` | `7b436959e19f3409feb5fd5459e417322d0ebfc7aca3ce9311515052f3fe1b6c` | same overlay on api and worker |
| 16 | `/app/packages/adapters/src/history-compaction.ts` | `da57afef15bf010b4c2e4e1aabdd28522e9efcaf01a595755cdfb724c61c3b93` | same overlay on api and worker |
| 17 | `/app/packages/adapters/src/page-browser-session.ts` | `6c9e29ee41964cc20c81fe7c6525e5b940d12df40bcbda1870e3684df890ef8f` | same overlay on api and worker |
| 18 | `/app/packages/adapters/src/pi-usage.ts` | `c14f0b31c4de1f4d6e3f0f9b9ca429be6c426e454c17ab4ef9bdf8c822fdd3e1` | not in the skew-4; image path unless newly mounted |
| 19 | `/app/packages/adapters/src/job-reconciler.ts` | `fc9c126935e9482e1f73213b362ed0dec338ab24c3b55b953c02e2f82163024d` | same overlay on api and worker |
| 20 | `/app/packages/contracts/src/builtin-tools.ts` | `4d7a905e0879f3668150bf4ee315c4a11b9a78139e5a08cca846b04c51751cb3` | browserextract on both |

## Untouched overlays (leave mounted)

- `/app/packages/adapters/src/computer-browser.ts` — **SKEWED** (worker savedlogins ≠ api browserextract); HOOKS only, login-guard preserved
- `fast-thinking.ts`, `pi-openai-compatible-provider.ts`, thinkbudget compose — Flash-Next / thinking **unchanged**
- savedlogins worker-only: overlay `bot-secrets.ts` (`b22b7f69…`), `login-guard.ts`, `/run/login-guard`. API `bot-secrets.ts` is `926710a` (`e9ef81aa…`).
- api-only: `computer-status.ts`, `pending-card-wait.ts`, `router.ts`, `shared-logins.ts`, `thread-target.ts`, contracts `rpc.ts`
- remaining shared overlays: loop-guard, attachtext, cardtext, quiet-gate, write-guard, ctxmem, yelpguard, browserdiag, streamretry, and the rest of the compose chain

Overlay name reconstruction (not live capture): worker and api builtin-tool **names** both parse as 77, name delta empty. Overlay-only names vs this branch: `browser_extract`, `retire_fact`, `set_fact`. This branch-only: `protected_result_handoff`. Name equality is **not** implementation parity.

## Parity proof (what this is / is not)

- **Is:** this-branch file hashes (20); explicit **SKEWED** vs same-overlay vs untouched list.
- **Is not:** a live api/worker process dump, a matched production request capture, or proof the overlay copies already contain these hooks.
