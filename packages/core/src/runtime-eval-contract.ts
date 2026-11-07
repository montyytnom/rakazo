import {
  bindOutcomeArtifact,
  collectToolEvidence,
  sanitizeFinalText,
  type CompletionLedger,
  type ToolEvidence,
} from "./completion-artifact.js";
import { resolveTurnIntent } from "./irreversible-effect.js";
import {
  redactLabeledSecretSpans,
  redactProtectedTree,
  stripSecretEchoes,
  stripSecretRequestContext,
  stripSecretTranscriptMessages,
} from "./secret-result-handle.js";

/**
 * Production overlay finalization, in call order. Each step names the overlay
 * function that actually runs — not a parallel helper.
 *
 * Eval must record `rawFinal` at assistBareDone / model `done` (before
 * sanitize). `deliveredFinal` is finalizeRun blocks + notification body.
 */
export const PRODUCTION_FINALIZATION_CALL_GRAPH = [
  {
    id: "resolveTurnIntent",
    site: "packages/adapters/src/executor.ts continueRun",
    records: "intentId+sourceMessageId+authorized",
  },
  {
    id: "recoverStaleBrowserAct",
    site: "packages/adapters/src/browser-tools.ts browserAct",
    records: "model-visible remap note",
  },
  {
    id: "protectPersistedEffectResult",
    site: "executor finish() after overlay patch",
    records: "model tool result + stored vault ref",
  },
  {
    id: "redactReplayResult",
    site: "executor duplicate-effect replay",
    records: "model-visible replay body",
  },
  {
    id: "bindOutcomeArtifact",
    site: "executor finish() and replay",
    records: "turnLedger identity/subject/action",
  },
  {
    id: "assistBareDone",
    site: "packages/adapters/src/pi-runtime.ts overlay local patch",
    records: "follow-up user turn; not a delivered final",
  },
  {
    id: "gluedConcat",
    site: "sanitizeFinalText stripGluedSuccessPrefix",
    records: "Done glued onto the next assembled final",
  },
  {
    id: "deliverAssistantFinal",
    site: "executor completionBlocks map + notification body",
    records: "rawFinal vs deliveredFinal",
  },
  {
    id: "finalizeRun",
    site: "deps.events.finalizeRun",
    records: "persisted blocks",
  },
  {
    id: "completionNotification",
    site: "executor completionNotificationPreview",
    records: "notify body from delivered text",
  },
  {
    id: "compactHistory",
    site: "packages/adapters/src/history-compaction.ts",
    records: "summary after deliverAssistantFinal",
  },
  {
    id: "protected_result_handoff",
    site: "executor tool name protected_result_handoff",
    records: "only if the bind offered the schema; 37-scratch does not",
  },
] as const;

export const RUNTIME_EVAL_CALL_ORDER = PRODUCTION_FINALIZATION_CALL_GRAPH.map(
  (step) => step.id,
);

export const ADAPTER_RUNTIME_EVAL_ENTRYPOINTS = [
  "protectPersistedEffectResult",
  "redactReplayResult",
  "recoverStaleBrowserAct",
  "assistBareDone",
  "handoffProtectedResult",
] as const;

export type DeliveredAssistantFinal = {
  rawFinal: string;
  deliveredFinal: string;
  evidence: ToolEvidence;
};

/**
 * Exact text transform used by overlay finalizeRun blocks and compaction.
 * Nudge/persist/notification/handoff wrap this; they are not a second sanitizer.
 */
export function deliverAssistantFinal(input: {
  rawText: string;
  toolResults: readonly unknown[];
  ledger?: CompletionLedger;
  secrets?: readonly string[];
}): DeliveredAssistantFinal {
  const evidence = collectToolEvidence(input.toolResults);
  let deliveredFinal = sanitizeFinalText(input.rawText, evidence, input.ledger);
  deliveredFinal = redactLabeledSecretSpans(deliveredFinal);
  if (input.secrets?.length) {
    deliveredFinal = stripSecretEchoes(deliveredFinal, input.secrets).text;
  }
  if (!deliveredFinal.trim()) deliveredFinal = "Outcome was not verified.";
  return { rawFinal: input.rawText, deliveredFinal, evidence };
}

export const EVAL_SCOPE = {
  matchedConfigCapture: "not-this-slice",
  toolBind: "37-scratch-not-run13-fleet",
  historicalPinnedImage: "12/12-does-not-validate-this-runtime",
  n1: "continue-reuses-completed-irr-v1",
  n2: "new-sourceMessageId-new-irr-v1",
  unauthorizedNudge: "UNAUTHORIZED_IRREVERSIBLE+uncertain",
  protectedResultHandoff: "offered-on-HEAD-not-on-37-bind-capture",
  window: "synthetic-131072-32768-not-live-attested",
  liveEval: "blocked-until-offline-contract-and-live-window-attestation",
  tuningExposed: ["L1", "M1", "V1"],
  heldout: "sealed",
  g1Provenance:
    "structured-field+SecretStore known values withhold regardless of shape; unlabeled SKU/pin English is not a secret; labeled history does not mine system/tools/context; common words are not globally replaced",
  g6Proof: "identity+subject+action; verified-read A does not license verified B",
} as const;

export {
  bindOutcomeArtifact,
  collectToolEvidence,
  redactProtectedTree,
  resolveTurnIntent,
  sanitizeFinalText,
  stripSecretEchoes,
  stripSecretRequestContext,
  stripSecretTranscriptMessages,
};
