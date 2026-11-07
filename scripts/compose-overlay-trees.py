#!/usr/bin/env python3
"""Compose production-effective api/worker trees from 926710a + overlay archive.

Does not talk to production. Overlay sources stay out of git.

Usage:
  python3 scripts/compose-overlay-trees.py --out .compose
  python3 scripts/compose-overlay-trees.py --out .compose --patch
  python3 scripts/compose-overlay-trees.py --out .compose --patch --bot-secrets /path/to/bot-secrets.ts
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(
    subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
)
BASE = "926710a09b30a6c1f83029da88dfe06656b031f2"
DEFAULT_OVERLAY = Path("/tmp/overlay-export/overlay-export")

NEW_HELPERS = [
    "packages/core/src/irreversible-effect.ts",
    "packages/core/src/secret-result-handle.ts",
    "packages/core/src/completion-artifact.ts",
    "packages/core/src/runtime-eval-contract.ts",
    "packages/core/src/compaction-provenance.ts",
    "packages/core/src/handoff-delivery.ts",
    "packages/adapters/src/stale-element-recovery.ts",
    "packages/adapters/src/desktop-tool-contract.ts",
    "packages/adapters/src/protected-result.ts",
    "packages/adapters/src/runtime-eval-backend.ts",
    "packages/adapters/src/model-stream-error.ts",
]

# Candidate file-state: patched overlay/git files plus helpers plus isolated-core closure.
TRACKED_PATHS = [
    "packages/adapters/src/executor.ts",
    "packages/adapters/src/bot-secrets.ts",
    "packages/adapters/src/computer-browser.ts",
    "packages/adapters/src/browser-tools.ts",
    "packages/adapters/src/pi-runtime.ts",
    "packages/adapters/src/history-compaction.ts",
    "packages/adapters/src/bot-messages.ts",
    "packages/adapters/src/pi-usage.ts",
    "packages/adapters/src/pi-openai-compatible-provider.ts",
    "packages/core/src/index.ts",
    "packages/core/src/approval-effect-key.ts",
    *NEW_HELPERS,
]

WORKER_BOT_SECRETS_SHA = "b22b7f69ce3a0a45c54258dc9b66134352068f3abd89fb7800b3631b88e89d53"
WORKER_BOT_SECRETS_REL = (
    "opt/docker/rakazo/patches/savedlogins-20261104/src/worker/bot-secrets.ts"
)
API_BOT_SECRETS_BASE_SHA = "e9ef81aaa20645c3ad27cd310600afae728295abc853ed602a00bf18317f6384"

REQUIRED_ARCHIVE = [
    "MOUNT-MAP.tsv",
    "FILE-HASHES.tsv",
    "COMPOSE-CHAINS.txt",
    "MANIFEST.md",
    "opt/docker/rakazo/patches/amazon-signin-verify-20261106/worker/src/worker/executor.ts",
    "opt/docker/rakazo/patches/browserextract/executor.ts",
    "opt/docker/rakazo/patches/savedlogins-20261104/src/worker/browser-tools.ts",
    "opt/docker/rakazo/patches/browserextract/browser-tools.ts",
    "opt/docker/rakazo/patches/update-20261020/build/history-compaction.ts",
    "opt/docker/rakazo/patches/update-20261020/build/bot-messages.ts",
    "opt/docker/rakazo/patches/thinkbudget/pi-openai-compatible-provider.ts",
    "opt/docker/rakazo/patches/savedlogins-20261104/src/worker/bot-secrets.ts",
    "opt/docker/rakazo/patches/savedlogins-20261104/src/worker/login-guard.ts",
    "opt/docker/rakazo/patches/savedlogins-20261104/src/worker/computer-browser.ts",
    "opt/docker/rakazo/patches/browserextract/computer-browser.ts",
]


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def missing_archive(overlay: Path) -> list[str]:
    missing = []
    if not overlay.is_dir():
        return [str(overlay)]
    for rel in REQUIRED_ARCHIVE:
        if not (overlay / rel).exists():
            missing.append(str(overlay / rel))
    return missing


def git_archive_into(dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        ["git", "archive", BASE, "packages/adapters/src", "packages/core/src", "packages/contracts/src"],
        cwd=REPO,
        stdout=subprocess.PIPE,
        check=True,
    )
    subprocess.run(["tar", "-x", "-C", str(dest)], input=proc.stdout, check=True)


def parse_mount_map(overlay: Path) -> list[dict[str, str]]:
    rows = []
    lines = (overlay / "MOUNT-MAP.tsv").read_text().splitlines()
    header = lines[0].split("\t")
    for line in lines[1:]:
        if not line.strip():
            continue
        cols = line.split("\t")
        row = {header[i]: cols[i] if i < len(cols) else "" for i in range(len(header))}
        rows.append(row)
    return rows


def overlay_file(overlay: Path, source: str) -> Path | None:
    if not source or source in {"dir", "missing"}:
        return None
    rel = source[1:] if source.startswith("/") else source
    # archive stores opt/docker/... under overlay root
    if rel.startswith("opt/docker/"):
        path = overlay / rel
    else:
        path = overlay / rel
    return path if path.is_file() else None


SKIP_MOUNT_HASHES = {"dir", "missing", "api-only", "worker-only", ""}
SKIP_SOURCE_PREFIXES = (
    "/opt/docker/rakazo/secrets/",
    "/opt/docker/rakazo/data",
    "/opt/docker/rakazo/login-guard",
    "/var/lib/docker/",
)


def apply_mounts(overlay: Path, dest: Path, service: str) -> tuple[list[dict[str, str]], list[str]]:
    applied = []
    missing = []
    for row in parse_mount_map(overlay):
        dest_in = row.get("destination_in_container", "")
        if not dest_in.startswith("/app/"):
            continue
        src_key = "worker_source" if service == "worker" else "api_source"
        hash_key = "worker_sha256" if service == "worker" else "api_sha256"
        source = row.get(src_key, "")
        expected = row.get(hash_key, "")
        if not source or expected in SKIP_MOUNT_HASHES:
            continue
        if source.startswith(SKIP_SOURCE_PREFIXES):
            continue
        src = overlay_file(overlay, source)
        if src is None:
            missing.append(f"{source} (MOUNT-MAP sha256={expected})")
            continue
        got = sha256(src)
        if expected and got != expected:
            raise SystemExit(f"preimage hash mismatch {source}: got {got} want {expected}")
        rel = dest_in[len("/app/") :]
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target)
        applied.append({"dest": rel, "source": source, "sha256": got})
    return applied, missing


def install_worker_bot_secrets(overlay: Path, extra: Path | None) -> Path:
    dest = overlay / WORKER_BOT_SECRETS_REL
    if extra is not None:
        got = sha256(extra)
        if got != WORKER_BOT_SECRETS_SHA:
            raise SystemExit(
                f"bot-secrets.ts hash mismatch: got {got} want {WORKER_BOT_SECRETS_SHA}"
            )
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(extra, dest)
    if not dest.is_file():
        raise SystemExit(
            "overlay compose blocked; missing worker bot-secrets.ts:\n"
            f"{dest}\n"
            f"MOUNT-MAP sha256={WORKER_BOT_SECRETS_SHA} (30395 bytes). "
            "Pass --bot-secrets with the exact overlay file. Do not stub."
        )
    got = sha256(dest)
    if got != WORKER_BOT_SECRETS_SHA:
        raise SystemExit(
            f"overlay bot-secrets.ts hash mismatch: got {got} want {WORKER_BOT_SECRETS_SHA}"
        )
    return dest


def copy_helpers(dest: Path) -> None:
    for rel in NEW_HELPERS:
        src = REPO / rel
        if not src.is_file():
            raise SystemExit(f"helper missing from HEAD: {rel}")
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target)


def patch_core_index(dest: Path) -> None:
    index = dest / "packages/core/src/index.ts"
    text = index.read_text()
    exports = [
        'export * from "./compaction-provenance.js";\n',
        'export * from "./completion-artifact.js";\n',
        'export * from "./handoff-delivery.js";\n',
        'export * from "./irreversible-effect.js";\n',
        'export * from "./runtime-eval-contract.js";\n',
        'export * from "./secret-result-handle.js";\n',
    ]
    for line in exports:
        if line not in text:
            text += line if text.endswith("\n") else "\n" + line
    index.write_text(text)


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: {label} matched {count} times")
    path.write_text(text.replace(old, new, 1))


def insert_after_once(path: Path, anchor: str, insertion: str, label: str) -> None:
    replace_once(path, anchor, anchor + insertion, label)


def patch_executor(path: Path) -> None:
    replace_once(
        path,
        "  userTurnMessageForRun,\n} from \"@rakazo/core\";\n",
        "  userTurnMessageForRun,\n"
        "  classifyBrowserMutation,\n"
        "  classifyIrreversibleTool,\n"
        "  irreversibleEffectRequest,\n"
        "  isThreadIrreversibleEffectKey,\n"
        "  redactProtectedTree,\n"
        "  resolveTurnIntent,\n"
        "  sameThreadIrreversibleOwner,\n"
        "  threadIrreversibleEffectKey,\n"
        "  UNAUTHORIZED_IRREVERSIBLE,\n"
        "  collectToolEvidence,\n"
        "  sanitizeFinalText,\n"
        "  secretsFromPriorAssistantText,\n"
        "  stripSecretEchoes,\n"
        "  bindOutcomeArtifact,\n"
        "  emptyCompletionLedger,\n"
        "  harvestSecretsFromUnknown,\n"
        "} from \"@rakazo/core\";\n",
        "core irreversible imports",
    )
    insert_after_once(
        path,
        'from "./browser-tools.js";\n',
        'import { DESKTOP_LAUNCH_UNSUPPORTED, sandboxLaunchUnsupported } from "./desktop-tool-contract.js";\n'
        "import {\n"
        "  createProtectedResultStore,\n"
        "  handoffProtectedResultDurable,\n"
        "  protectPersistedEffectResult,\n"
        "  redactReplayResult,\n"
        "  resolveProtectedResultVault,\n"
        '} from "./protected-result.js";\n'
        'import { browserActLabels, createRefMemory } from "./stale-element-recovery.js";\n',
        "helper module imports",
    )
    insert_after_once(
        path,
        "        const mutatingEffectOccurrences = new Map<string, number>();\n"
        "        const consumedEffectIds = new Set<string>();\n",
        "        const pageRefMemory = createRefMemory();\n"
        "        const protectedResults = createProtectedResultStore();\n"
        "        const protectedVault = resolveProtectedResultVault(deps.secretStore, context);\n"
        "        const turnToolResults: unknown[] = [];\n"
        "        const turnIntent = resolveTurnIntent(\n"
        "          { id: run.sourceMessageId, text: task.prompt },\n"
        "          history\n"
        "            .filter((message) => message.role === \"user\")\n"
        "            .map((message) => ({ id: message.id, text: message.content })),\n"
        "        );\n"
        "        const intentId = turnIntent.intentId;\n"
        "        const turnLedger = emptyCompletionLedger({\n"
        "          intentId,\n"
        "          sourceMessageId: turnIntent.sourceMessageId ?? \"\",\n"
        "          runId,\n"
        "        });\n",
        "turn intent + ref memory",
    )
    replace_once(
        path,
        "          const effectKey =\n"
        "            usesApprovalKey && occurrence === 0\n"
        "              ? approvalEffectKey(runId, replayEffectToolName, args)\n"
        "              : toolEffectIdempotencyKey(runId, replayEffectToolName, args, occurrence);\n",
        "          let irreversible = classifyIrreversibleTool(replayEffectToolName, args);\n"
        "          if (!irreversible && replayEffectToolName === \"browser_act\") {\n"
        "            irreversible = classifyBrowserMutation(\n"
        "              browserActLabels(args, pageRefMemory),\n"
        "              pageRefMemory.lastUrl ?? \"\",\n"
        "            );\n"
        "          }\n"
        "          if (\n"
        "            irreversible &&\n"
        "            !turnIntent.authorized &&\n"
        "            !requiresUnattendedApproval &&\n"
        "            !nextApprovedTool\n"
        "          ) {\n"
        "            return { error: UNAUTHORIZED_IRREVERSIBLE, uncertain: true };\n"
        "          }\n"
        "          if (irreversible) {\n"
        "            effectRequest = irreversibleEffectRequest(\n"
        "              irreversible,\n"
        "              run.threadId,\n"
        "              intentId,\n"
        "              args,\n"
        "              turnIntent.sourceMessageId,\n"
        "            );\n"
        "          }\n"
        "          const effectKey = irreversible\n"
        "            ? threadIrreversibleEffectKey({\n"
        "                threadId: run.threadId,\n"
        "                intentId,\n"
        "                class: irreversible.class,\n"
        "                subject: irreversible.subject,\n"
        "              })\n"
        "            : usesApprovalKey && occurrence === 0\n"
        "              ? approvalEffectKey(runId, replayEffectToolName, args)\n"
        "              : toolEffectIdempotencyKey(runId, replayEffectToolName, args, occurrence);\n",
        "irreversible effectKey",
    )
    replace_once(
        path,
        "              } else {\n"
        "                return gate.result;\n"
        "              }",
        "              } else {\n"
        "                const replayed = redactReplayResult(gate.result, runSecrets);\n"
        "                turnToolResults.push(replayed);\n"
        "                const artifact = bindOutcomeArtifact({\n"
        "                  result: replayed,\n"
        "                  toolName: replayEffectToolName,\n"
        "                  args,\n"
        "                  intentId,\n"
        "                  sourceMessageId: turnIntent.sourceMessageId ?? \"\",\n"
        "                  runId,\n"
        "                });\n"
        "                if (artifact) turnLedger.artifacts.push(artifact);\n"
        "                return replayed;\n"
        "              }",
        "redact duplicate replay",
    )
    replace_once(
        path,
        "                  claimedEffect ? \"executing\" : \"intended\",\n"
        "                  result,\n"
        "                )\n"
        "              : Promise.resolve(true);\n"
        "          const finish = async (result: unknown) =>\n"
        "            (await persistEffectResult(result)) ? result : uncertainEffectResult(name, args);",
        "                  claimedEffect ? \"executing\" : \"intended\",\n"
        "                  result,\n"
        "                )\n"
        "              : Promise.resolve(true);\n"
        "          const finish = async (result: unknown) => {\n"
        "            const protectedPage = await protectPersistedEffectResult({\n"
        "              result,\n"
        "              extras: runSecrets,\n"
        "              store: protectedResults,\n"
        "              vault: protectedVault,\n"
        "            });\n"
        "            for (const secret of harvestSecretsFromUnknown([result, args])) {\n"
        "              if (!runSecrets.includes(secret)) runSecrets.push(secret);\n"
        "            }\n"
        "            turnToolResults.push(protectedPage.model);\n"
        "            const artifact = bindOutcomeArtifact({\n"
        "              result: protectedPage.model,\n"
        "              toolName: name,\n"
        "              args,\n"
        "              intentId,\n"
        "              sourceMessageId: turnIntent.sourceMessageId ?? \"\",\n"
        "              runId,\n"
        "            });\n"
        "            if (artifact) turnLedger.artifacts.push(artifact);\n"
        "            return (await persistEffectResult(protectedPage.stored))\n"
        "              ? protectedPage.model\n"
        "              : uncertainEffectResult(name, args);\n"
        "          };",
        "persist/finish sanitization",
    )
    replace_once(
        path,
        "                await recordComputerAction(\"launch_app\", application, {\n"
        "                  error: error instanceof Error ? error.message : \"could not launch app\",\n"
        "                });\n"
        "                throw error;",
        "                await recordComputerAction(\"launch_app\", application, {\n"
        "                  error: error instanceof Error ? error.message : \"could not launch app\",\n"
        "                });\n"
        "                if (sandboxLaunchUnsupported(error)) {\n"
        "                  return { error: DESKTOP_LAUNCH_UNSUPPORTED };\n"
        "                }\n"
        "                throw error;",
        "launch_app unsupported recovery",
    )
    replace_once(
        path,
        "                    redactions,\n",
        "                    redactions,\n"
        "                    refMemory: pageRefMemory,\n",
        "pass refMemory into browser_act",
    )
    replace_once(
        path,
        "  if (existing && (existing.runId !== run.id || existing.spaceId !== run.spaceId)) {\n"
        "    throw new Error(\"Stored tool execution does not belong to this run.\");\n"
        "  }",
        "  if (existing && (existing.runId !== run.id || existing.spaceId !== run.spaceId)) {\n"
        "    if (\n"
        "      isThreadIrreversibleEffectKey(idempotencyKey) &&\n"
        "      sameThreadIrreversibleOwner({\n"
        "        existingSpaceId: existing.spaceId,\n"
        "        existingRequest: existing.request,\n"
        "        spaceId: run.spaceId,\n"
        "        threadId: run.threadId,\n"
        "        intentId: (() => {\n"
        "          if (!request || typeof request !== \"object\" || Array.isArray(request)) return undefined;\n"
        "          const value = (request as { intentId?: unknown }).intentId;\n"
        "          return typeof value === \"string\" && value ? value : undefined;\n"
        "        })(),\n"
        "      })\n"
        "    ) {\n"
        "      consumedIds?.add(existing.id);\n"
        "      await deps.events.append({\n"
        "        spaceId: run.spaceId,\n"
        "        threadId: run.threadId,\n"
        "        botId: run.botId,\n"
        "        type: \"effect.reconciled\",\n"
        "        runId: run.id,\n"
        "        payload: { executionId: idempotencyKey, kind, threadIntent: true },\n"
        "      });\n"
        "      return { duplicate: true, effect: existing };\n"
        "    }\n"
        "    throw new Error(\"Stored tool execution does not belong to this run.\");\n"
        "  }",
        "recordEffect thread-intent reuse",
    )
    replace_once(
        path,
        "  const effect = await deps.prisma.externalEffect.create({\n"
        "    data: {\n"
        "      spaceId: run.spaceId,\n"
        "      runId: run.id,\n"
        "      kind,\n"
        "      idempotencyKey,\n"
        "      status: \"intended\",\n"
        "      request: request as never,\n"
        "    },\n"
        "  });\n"
        "  consumedIds?.add(effect.id);\n"
        "  return { duplicate: false, effect };\n"
        "}",
        "  try {\n"
        "    const effect = await deps.prisma.externalEffect.create({\n"
        "      data: {\n"
        "        spaceId: run.spaceId,\n"
        "        runId: run.id,\n"
        "        kind,\n"
        "        idempotencyKey,\n"
        "        status: \"intended\",\n"
        "        request: request as never,\n"
        "      },\n"
        "    });\n"
        "    consumedIds?.add(effect.id);\n"
        "    return { duplicate: false, effect };\n"
        "  } catch (error) {\n"
        "    if (!isUniqueViolation(error)) throw error;\n"
        "    const raced = await deps.prisma.externalEffect.findUnique({\n"
        "      where: { idempotencyKey },\n"
        "    });\n"
        "    if (!raced) throw error;\n"
        "    consumedIds?.add(raced.id);\n"
        "    return { duplicate: true, effect: raced };\n"
        "  }\n"
        "}",
        "recordEffect unique-constraint reuse",
    )
    replace_once(
        path,
        '          if (name === "list_secrets") return listBotSecrets(deps.prisma, run);\n',
        "          if (name === \"protected_result_handoff\") {\n"
        "            const opId = String(args.op_id ?? \"\");\n"
        "            const storedRows = await deps.prisma.externalEffect.findMany({\n"
        "              where: { spaceId: run.spaceId },\n"
        "            });\n"
        "            const storedResult = storedRows\n"
        "              .map((row: { result?: unknown }) => row.result)\n"
        "              .find((result: unknown) => {\n"
        "                if (!result || typeof result !== \"object\" || Array.isArray(result)) return false;\n"
        "                const handle = (result as { protectedResult?: { handle?: unknown } }).protectedResult?.handle;\n"
        "                return handle === opId;\n"
        "              });\n"
        "            return finish(\n"
        "              await handoffProtectedResultDurable(\n"
        "                protectedResults,\n"
        "                opId,\n"
        "                protectedVault,\n"
        "                storedResult,\n"
        "              ),\n"
        "            );\n"
        "          }\n"
        '          if (name === "list_secrets") return listBotSecrets(deps.prisma, run);\n',
        "protected_result_handoff",
    )
    replace_once(
        path,
        "          const blocks = handedOff\n"
        "            ? []\n"
        "            : runtidyDropRepeatedFinalText(\n"
        "                finalBlocksAfterMidTurnProgress(\n"
        "                  redactBlocks(completionBlocks, runSecrets),\n"
        "                  publishedMidTurnUserMessage || runAllowsSilentEmpty(run.trigger),\n"
        "                ),\n"
        "                midTurnUserTexts,\n"
        "              );\n"
        "          const text = handedOff\n"
        "            ? \"\"\n"
        "            : redactSecrets(completionNotificationBody(silentReply.assembled, blocks), runSecrets);\n",
        "          const priorSecrets = secretsFromPriorAssistantText([\n"
        "            ...history\n"
        "              .filter((message) => message.role === \"assistant\")\n"
        "              .map((message) => message.content),\n"
        "            silentReply.assembled,\n"
        "          ]);\n"
        "          const evidence = collectToolEvidence(turnToolResults);\n"
        "          const blocks = handedOff\n"
        "            ? []\n"
        "            : runtidyDropRepeatedFinalText(\n"
        "                finalBlocksAfterMidTurnProgress(\n"
        "                  redactBlocks(completionBlocks, runSecrets),\n"
        "                  publishedMidTurnUserMessage || runAllowsSilentEmpty(run.trigger),\n"
        "                ),\n"
        "                midTurnUserTexts,\n"
        "              ).map((block) => {\n"
        "                if (block.kind !== \"text\") return block;\n"
        "                const sanitized = sanitizeFinalText(block.text, evidence, turnLedger);\n"
        "                return {\n"
        "                  ...block,\n"
        "                  text: stripSecretEchoes(sanitized, [...runSecrets, ...priorSecrets]).text,\n"
        "                };\n"
        "              });\n"
        "          const text = handedOff\n"
        "            ? \"\"\n"
        "            : redactSecrets(\n"
        "                completionNotificationBody(\n"
        "                  stripSecretEchoes(sanitizeFinalText(silentReply.assembled, evidence, turnLedger), [\n"
        "                    ...runSecrets,\n"
        "                    ...priorSecrets,\n"
        "                  ]).text,\n"
        "                  blocks,\n"
        "                ),\n"
        "                runSecrets,\n"
        "              );\n",
        "final reply secret/completion sanitization",
    )
    replace_once(
        path,
        "        const runtimeHistory = [...historicalContext, ...historyWithImages];\n",
        "        for (const secret of harvestSecretsFromUnknown(\n"
        "          history.filter((message) => message.role === \"assistant\").map((message) => message.content),\n"
        "        )) {\n"
        "          if (!runSecrets.includes(secret)) runSecrets.push(secret);\n"
        "        }\n"
        "        const runtimeHistory = [...historicalContext, ...historyWithImages].map((message) =>\n"
        "          typeof message.content === \"string\"\n"
        "            ? { ...message, content: stripSecretEchoes(message.content, runSecrets).text }\n"
        "            : message,\n"
        "        );\n",
        "history secret strip before model",
    )


def patch_browser_tools_worker(path: Path) -> None:
    insert_after_once(
        path,
        'import { redactConnectorPayload } from "./connector-safety.js";\n',
        'import {\n'
        "  createRefMemory,\n"
        "  type RefMemory,\n"
        "  recoverStaleBrowserAct,\n"
        '} from "./stale-element-recovery.js";\n',
        "stale recovery import",
    )
    replace_once(
        path,
        "    loginGuard?: BrowserLoginGuard;\n"
        "    resolveOtpFill?: ResolveOtpFill;\n"
        "  } = {},\n",
        "    loginGuard?: BrowserLoginGuard;\n"
        "    resolveOtpFill?: ResolveOtpFill;\n"
        "    refMemory?: RefMemory;\n"
        "  } = {},\n",
        "refMemory option",
    )
    replace_once(
        path,
        "    const result = await browser.act(\n"
        "      computer,\n"
        "      {\n"
        "        actions,\n"
        "        signal: context.signal,\n"
        "        ...(options.loginGuard ? { guard: options.loginGuard.guard } : {}),\n"
        "      } as Parameters<BrowserProvider[\"act\"]>[1],\n"
        "      context,\n"
        "    );",
        "    const memory = options.refMemory ?? createRefMemory();\n"
        "    const result = await recoverStaleBrowserAct({\n"
        "      browser,\n"
        "      computer,\n"
        "      context,\n"
        "      actions,\n"
        "      memory,\n"
        "      actExtras: options.loginGuard ? { guard: options.loginGuard.guard } : {},\n"
        "    });",
        "worker browserAct recoverStale",
    )


def patch_browser_tools_api(path: Path) -> None:
    insert_after_once(
        path,
        'import { redactConnectorPayload } from "./connector-safety.js";\n',
        'import {\n'
        "  createRefMemory,\n"
        "  type RefMemory,\n"
        "  recoverStaleBrowserAct,\n"
        '} from "./stale-element-recovery.js";\n',
        "stale recovery import",
    )
    replace_once(
        path,
        "    uploadRoots?: string[];\n"
        "  } = {},\n",
        "    uploadRoots?: string[];\n"
        "    refMemory?: RefMemory;\n"
        "  } = {},\n",
        "api refMemory option",
    )
    replace_once(
        path,
        "    const result = await browser.act(computer, { actions, signal: context.signal }, context);",
        "    const memory = options.refMemory ?? createRefMemory();\n"
        "    const result = await recoverStaleBrowserAct({\n"
        "      browser,\n"
        "      computer,\n"
        "      context,\n"
        "      actions,\n"
        "      memory,\n"
        "    });",
        "api browserAct recoverStale",
    )


def patch_history_compaction(path: Path) -> None:
    replace_once(
        path,
        "import { blocksToAgentHistoryText, escapePromptData } from \"@rakazo/core\";\n",
        "import { blocksToAgentHistoryText, collectToolEvidence, escapePromptData, rewriteUnverifiedClaims, sanitizeFinalText, secretsFromPriorAssistantText, stripSecretEchoes } from \"@rakazo/core\";\n",
        "rewriteUnverifiedClaims import",
    )
    replace_once(
        path,
        "  if (summary.length > MAX_COMPACTED_SUMMARY_CHARS) {\n"
        "    logHistoryCompactPermanentFailure(threadId, \"summary_too_large\");\n"
        "    return;\n"
        "  }\n\n"
        "  const lastSeq = batch[batch.length - 1]!.seq;",
        "  if (summary.length > MAX_COMPACTED_SUMMARY_CHARS) {\n"
        "    logHistoryCompactPermanentFailure(threadId, \"summary_too_large\");\n"
        "    return;\n"
        "  }\n"
        "  summary = stripSecretEchoes(\n"
        "    sanitizeFinalText(\n"
        "      rewriteUnverifiedClaims(summary, transcript),\n"
        "      collectToolEvidence([transcript]),\n"
        "    ),\n"
        "    secretsFromPriorAssistantText([summary, transcript]),\n"
        "  ).text;\n\n"
        "  const lastSeq = batch[batch.length - 1]!.seq;",
        "compaction transcript evidence",
    )


def patch_bot_messages(path: Path) -> None:
    replace_once(
        path,
        "      deliveryKey: `auto-outcome:${run.id}`,",
        "      deliveryKey: `auto-outcome:${run.sourceMessageId ?? run.id}:${intent}`,",
        "auto-outcome key",
    )


def patch_pi_usage(path: Path) -> None:
    if "extractOpenAiSseError" in path.read_text():
        return
    insert_after_once(
        path,
        'import { fetchPairedWithDispatcher } from "./undici-fetch.js";\n',
        'import { extractOpenAiSseError } from "./model-stream-error.js";\n',
        "sse helper import",
    )
    replace_once(
        path,
        "      if (!data || data === \"[DONE]\") return;\n"
        "      try {\n"
        "        const event = JSON.parse(data);",
        "      if (!data || data === \"[DONE]\") return;\n"
        "      const streamError = extractOpenAiSseError(`${frame}\\n\\n`);\n"
        "      if (streamError) throw new Error(streamError.message);\n"
        "      try {\n"
        "        const event = JSON.parse(data);",
        "sse fail-closed before parse",
    )


OLD_STRIP_WRAPPERS = """
function stripSecretTranscript<T>(messages: T[]): T[] {
  const secrets = harvestSecretsFromUnknown(messages);
  if (secrets.length === 0) return messages;
  return stripSecretsFromUnknown(messages, secrets) as T[];
}

function stripSecretContext(ctx: Context): Context {
  const secrets = harvestSecretsFromUnknown(ctx);
  if (secrets.length === 0) return ctx;
  return stripSecretsFromUnknown(ctx, secrets) as Context;
}
"""

NEW_STRIP_WRAPPERS = """
function stripSecretTranscript<T>(messages: T[]): T[] {
  return stripSecretTranscriptMessages(messages) as T[];
}

function stripSecretContext(ctx: Context): Context {
  return stripSecretRequestContext(ctx) as Context;
}
"""

OLD_STRIP_IMPORT = (
    "import {\n"
    "  abortableDelay,\n"
    "  harvestSecretsFromUnknown,\n"
    "  MISSING_TOOL_FINAL_RESPONSE_ERROR,\n"
    "  stripSecretsFromUnknown,\n"
    '} from "@rakazo/core";\n'
)

NEW_STRIP_IMPORT = (
    "import {\n"
    "  abortableDelay,\n"
    "  MISSING_TOOL_FINAL_RESPONSE_ERROR,\n"
    "  stripSecretRequestContext,\n"
    "  stripSecretTranscriptMessages,\n"
    '} from "@rakazo/core";\n'
)


def patch_pi_runtime(path: Path) -> None:
    text = path.read_text()
    if "return stripSecretTranscriptMessages(messages)" in text and "return stripSecretRequestContext(ctx)" in text:
        return
    if OLD_STRIP_WRAPPERS in text:
        text = text.replace(OLD_STRIP_WRAPPERS, NEW_STRIP_WRAPPERS, 1)
        if OLD_STRIP_IMPORT in text:
            text = text.replace(OLD_STRIP_IMPORT, NEW_STRIP_IMPORT, 1)
        elif "stripSecretTranscriptMessages" not in text:
            text = text.replace(
                'import { abortableDelay, MISSING_TOOL_FINAL_RESPONSE_ERROR } from "@rakazo/core";\n',
                NEW_STRIP_IMPORT,
                1,
            )
        path.write_text(text)
        return
    path.write_text(text)
    replace_once(
        path,
        'import { abortableDelay, MISSING_TOOL_FINAL_RESPONSE_ERROR } from "@rakazo/core";\n',
        NEW_STRIP_IMPORT,
        "pi-runtime secret strip import",
    )
    replace_once(
        path,
        "          transformContext: async (messages) =>\n"
        "            pruneComputerScreenshotContext(\n"
        "              assistProgressContext(pruneStalePageStateContext(messages)),\n"
        "              hasBackups\n"
        "                ? activeStreamTarget.config.maxImagesPerPrompt\n"
        "                : request.model.maxImagesPerPrompt,\n"
        "            ),\n",
        "          transformContext: async (messages) =>\n"
        "            stripSecretTranscript(\n"
        "              pruneComputerScreenshotContext(\n"
        "                assistProgressContext(pruneStalePageStateContext(messages)),\n"
        "                hasBackups\n"
        "                  ? activeStreamTarget.config.maxImagesPerPrompt\n"
        "                  : request.model.maxImagesPerPrompt,\n"
        "              ),\n"
        "            ),\n",
        "main transformContext secret strip",
    )
    replace_once(
        path,
        "    transformContext: async (messages) =>\n"
        "      pruneComputerScreenshotContext(\n"
        "        assistProgressContext(pruneStalePageStateContext(messages)),\n"
        "        requestModel.maxImagesPerPrompt,\n"
        "      ),\n",
        "    transformContext: async (messages) =>\n"
        "      stripSecretTranscript(\n"
        "        pruneComputerScreenshotContext(\n"
        "          assistProgressContext(pruneStalePageStateContext(messages)),\n"
        "          requestModel.maxImagesPerPrompt,\n"
        "        ),\n"
        "      ),\n",
        "subagent transformContext secret strip",
    )
    replace_once(
        path,
        "    return policy.prepareContext(ctx, model);\n",
        "    return stripSecretContext(policy.prepareContext(ctx, model));\n",
        "assistPrepareContext secret strip",
    )
    replace_once(
        path,
        "        return prepared;\n",
        "        return stripSecretContext(prepared);\n",
        "assist shrink secret strip",
    )
    path.write_text(path.read_text() + NEW_STRIP_WRAPPERS)


def patch_thinkbudget_fetch(path: Path) -> None:
    if "extractOpenAiSseError" in path.read_text():
        return
    insert_after_once(
        path,
        'import { dispatcherFetch, fetchPairedWithDispatcher } from "./undici-fetch.js";\n',
        'import { extractOpenAiSseError } from "./model-stream-error.js";\n',
        "thinkbudget sse import",
    )
    replace_once(
        path,
        "      return dispatcher ? await closeDispatcherWithResponse(response, dispatcher) : response;\n",
        "      const raw = dispatcher ? await closeDispatcherWithResponse(response, dispatcher) : response;\n"
        "      return inspectSseErrorFrames(raw);\n",
        "thinkbudget wrap sse inspect",
    )
    # Keep thinking kwargs untouched; append helper at EOF.
    text = path.read_text()
    if "function inspectSseErrorFrames" not in text:
        path.write_text(
            text
            + """
/** Inspect a completed SSE frame before the caller consumes the completing chunk. Thinking kwargs unchanged. */
function inspectSseErrorFrames(response: Response): Response {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    return response;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await reader.read();
      if (result.done) {
        if (buffer.trim()) {
          const err = extractOpenAiSseError(`${buffer}\\n\\n`);
          if (err) {
            controller.error(new Error(err.message));
            return;
          }
        }
        controller.close();
        return;
      }
      buffer += decoder.decode(result.value, { stream: true });
      let idx: number;
      while ((idx = buffer.search(/\\r?\\n\\r?\\n/)) !== -1) {
        const sep = buffer.slice(idx).startsWith("\\r\\n\\r\\n") ? 4 : 2;
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + sep);
        const err = extractOpenAiSseError(`${frame}\\n\\n`);
        if (err) {
          controller.error(new Error(err.message));
          return;
        }
      }
      controller.enqueue(result.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
"""
        )


def write_test_shim(dest: Path) -> None:
    path = dest / "packages/adapters/src/computer-lifecycle.ts"
    path.write_text(
        """import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
export type ComputerExecutionLease = {
  computerId: string;
  botId: string;
  runId: string;
  fence: number;
};
export class ComputerBusyError extends Error {}
export async function acquireComputerExecutionLease() {
  return null;
}
export async function acquireDedicatedScreenLeaseFence(
  _prisma: unknown,
  input: { computerId: string; botId: string; runId: string },
): Promise<ComputerExecutionLease> {
  return { computerId: input.computerId, botId: input.botId, runId: input.runId, fence: 7 };
}
export async function provisionComputer(
  _deps: unknown,
  id: string,
  _context?: AdapterContext,
): Promise<ComputerRef> {
  return { id, botId: "bot-1", kind: "desktop", providerRef: id };
}
export async function releaseComputerExecutionLease() {}
export async function renewComputerExecutionLease() { return true; }
export async function holdComputerExecutionLeaseForTakeover() {}
export function screenLeaseIdForRun(runId: string) { return `screen:${runId}`; }
export function computerSupportsUpdate() { return true; }
export function computerSupportsTerminal() { return true; }
export async function replaceComputer() { return null; }
"""
    )


def patch_computer_browser_worker(path: Path) -> None:
    replace_once(
        path,
        "    if (!live || live.ok !== true) return { ok: false, error: String(live?.error ?? \"unavailable\") };\n"
        "    return {\n"
        "      ok: true,\n"
        "      hasFocus: live.hasFocus === true,\n",
        "    if (!live || live.ok !== true) return { ok: false, error: String(live?.error ?? \"unavailable\") };\n"
        "    delete (live as { value?: unknown }).value;\n"
        "    return {\n"
        "      ok: true,\n"
        "      hasFocus: live.hasFocus === true,\n",
        "worker focused never a value",
    )


def patch_computer_browser_api(path: Path) -> None:
    replace_once(
        path,
        "    const live = await this.runLive(\n"
        "      computer,\n"
        "      { command: \"act\", actions: request.actions },\n"
        "      context,\n"
        "    );\n"
        "    if (live?.ok !== true || live.fallback === \"computer_act\") {\n",
        "    const live = await this.runLive(\n"
        "      computer,\n"
        "      { command: \"act\", actions: request.actions },\n"
        "      context,\n"
        "    );\n"
        "    if (live?.ok !== true && /LOGIN_GUARD refused/.test(String(live?.error ?? \"\"))) {\n"
        "      return {\n"
        "        ok: false,\n"
        "        completed: typeof live?.completed === \"number\" ? live.completed : 0,\n"
        "        uncertain: false,\n"
        "        url: typeof live?.url === \"string\" ? live.url : \"\",\n"
        "        title: typeof live?.title === \"string\" ? live.title : \"\",\n"
        "        error: String(live?.error),\n"
        "      };\n"
        "    }\n"
        "    if (live?.ok !== true || live.fallback === \"computer_act\") {\n",
        "api LOGIN_GUARD refusal is final",
    )


def apply_patches(dest: Path, service: str) -> None:
    adapters = dest / "packages/adapters/src"
    patch_executor(adapters / "executor.ts")
    if service == "worker":
        patch_browser_tools_worker(adapters / "browser-tools.ts")
        patch_computer_browser_worker(adapters / "computer-browser.ts")
    else:
        patch_browser_tools_api(adapters / "browser-tools.ts")
        patch_computer_browser_api(adapters / "computer-browser.ts")
    patch_history_compaction(adapters / "history-compaction.ts")
    patch_bot_messages(adapters / "bot-messages.ts")
    patch_pi_usage(adapters / "pi-usage.ts")
    patch_pi_runtime(adapters / "pi-runtime.ts")
    patch_thinkbudget_fetch(adapters / "pi-openai-compatible-provider.ts")
    patch_core_index(dest)


def bot_secrets_map(dest: Path, service: str) -> dict:
    path = dest / "packages/adapters/src/bot-secrets.ts"
    digest = sha256(path)
    if service == "worker":
        if digest != WORKER_BOT_SECRETS_SHA:
            raise SystemExit(
                f"worker bot-secrets.ts after mount is {digest}, want overlay {WORKER_BOT_SECRETS_SHA}"
            )
        return {
            "service": "worker",
            "source": WORKER_BOT_SECRETS_REL,
            "container": "/app/packages/adapters/src/bot-secrets.ts",
            "sha256": digest,
            "overlay": True,
        }
    if digest != API_BOT_SECRETS_BASE_SHA:
        raise SystemExit(
            f"api bot-secrets.ts is {digest}, want 926710a {API_BOT_SECRETS_BASE_SHA} "
            "(no overlay mount; worker-only)"
        )
    return {
        "service": "api",
        "source": "926710a:packages/adapters/src/bot-secrets.ts",
        "container": "/app/packages/adapters/src/bot-secrets.ts",
        "sha256": digest,
        "overlay": False,
    }


def emit_hashes(dest: Path, service: str, patch: bool) -> None:
    rows = ["path\tsha256"]
    missing = []
    for rel in TRACKED_PATHS:
        path = dest / rel
        if path.is_file():
            rows.append(f"{rel}\t{sha256(path)}")
        elif patch:
            missing.append(rel)
    if missing:
        raise SystemExit(f"{service} after tree missing tracked files: {missing}")
    name = "AFTER-HASHES.tsv" if patch else "PREIMAGE-HASHES.tsv"
    (dest / name).write_text("\n".join(rows) + "\n")


def compose_one(
    overlay: Path,
    dest: Path,
    service: str,
    patch: bool,
    shim: bool,
) -> dict:
    if dest.exists():
        shutil.rmtree(dest)
    git_archive_into(dest)
    (dest / "package.json").write_text('{"name":"rakazo-composed","type":"module"}\n')
    node_modules = dest / "node_modules"
    if not node_modules.exists():
        node_modules.symlink_to(REPO / "packages/adapters/node_modules")
    mounts, missing_mounts = apply_mounts(overlay, dest, service)
    secrets_map = bot_secrets_map(dest, service)
    status = {
        "service": service,
        "base": BASE,
        "patched": False,
        "testShim": False,
        "mounts": len(mounts),
        "missingMounts": missing_mounts,
        "executorPreimage": sha256(dest / "packages/adapters/src/executor.ts"),
        "botSecrets": secrets_map,
        "archiveGaps": {
            "attachtext/vendor": "Documented export exclusion; attachment-text loads it lazily.",
            "secrets/scrapling_token": "Documented export exclusion; not required to compile adapter sources.",
            "login-guard-policy-dir": "/run/login-guard is a directory mount; login-guard.ts is overlay-mounted on worker.",
        },
        "testShimRemaining": [
            "none for overlay executor import under vitest: keep real computer-lifecycle.ts and mock prisma/sandbox/browser at the harness boundary",
            "do not stub overlay executor, login-guard.ts, bot-secrets.ts, or computer-browser.ts",
        ],
    }
    if patch:
        # Helpers and core index exports belong only on the patched after tree.
        # Copying them onto before made compose-before look like HEAD and hid
        # 926710a-absent paths from rollback/preimage classification.
        copy_helpers(dest)
        apply_patches(dest, service)
        status["patched"] = True
    if shim:
        write_test_shim(dest)
        status["testShim"] = True
    status["executorAfter"] = sha256(dest / "packages/adapters/src/executor.ts")
    emit_hashes(dest, service, patch)
    (dest / "COMPOSE-STATUS.json").write_text(json.dumps(status, indent=2) + "\n")
    return status


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--overlay", default=str(DEFAULT_OVERLAY))
    parser.add_argument("--out", default=str(REPO / ".compose"))
    parser.add_argument("--patch", action="store_true")
    parser.add_argument(
        "--test-shim",
        action="store_true",
        help="Do not use for the composed gate. Stubs computer-lifecycle.ts.",
    )
    parser.add_argument("--bot-secrets", default="")
    parser.add_argument("--service", choices=["worker", "api", "both"], default="both")
    args = parser.parse_args()
    overlay = Path(args.overlay)
    extra = Path(args.bot_secrets) if args.bot_secrets else None
    if extra is not None and not extra.is_file():
        print(f"overlay compose blocked; --bot-secrets not a file: {extra}", file=sys.stderr)
        return 2
    install_worker_bot_secrets(overlay, extra)
    missing = missing_archive(overlay)
    if missing:
        print("overlay compose blocked; missing:", file=sys.stderr)
        print("\n".join(missing), file=sys.stderr)
        return 2
    out = Path(args.out)
    services = ["worker", "api"] if args.service == "both" else [args.service]
    for service in services:
        label = "after" if args.patch else "before"
        dest = out / service / label
        status = compose_one(overlay, dest, service, args.patch, args.test_shim)
        print(json.dumps(status))
    return 0


if __name__ == "__main__":
    sys.exit(main())
