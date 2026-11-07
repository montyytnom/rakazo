import {
  bindOutcomeArtifact,
  collectToolEvidence,
  sanitizeFinalText,
  type CompletionLedger,
  type ToolEvidence,
} from "./completion-artifact.js";
import { resolveTurnIntent } from "./irreversible-effect.js";
import {
  redactProtectedTree,
  stripSecretEchoes,
  stripSecretRequestContext,
  stripSecretTranscriptMessages,
} from "./secret-result-handle.js";

/**
 * Sanctioned node post-process order for runtime-in-loop eval.
 * Record `rawFinal` before this pipeline; `deliveredFinal` is what the user sees.
 *
 * Adapter-owned steps (not imported here to keep core free of adapter deps):
 * `protectPersistedEffectResult`, `redactReplayResult`, `recoverStaleBrowserAct`.
 * Import those from `@rakazo/adapters` via `runtime-eval-backend.ts`.
 */
export const RUNTIME_EVAL_CALL_ORDER = [
  "resolveTurnIntent",
  "protectPersistedEffectResult",
  "redactProtectedTree",
  "redactReplayResult",
  "recoverStaleBrowserAct",
  "bindOutcomeArtifact",
  "collectToolEvidence",
  "sanitizeFinalText",
  "stripSecretEchoes",
  "stripSecretTranscriptMessages",
  "stripSecretRequestContext",
] as const;

export const ADAPTER_RUNTIME_EVAL_ENTRYPOINTS = [
  "protectPersistedEffectResult",
  "redactReplayResult",
  "recoverStaleBrowserAct",
] as const;

export type DeliveredAssistantFinal = {
  rawFinal: string;
  deliveredFinal: string;
  evidence: ToolEvidence;
};

export function deliverAssistantFinal(input: {
  rawText: string;
  toolResults: readonly unknown[];
  ledger?: CompletionLedger;
  secrets?: readonly string[];
}): DeliveredAssistantFinal {
  const evidence = collectToolEvidence(input.toolResults);
  let deliveredFinal = sanitizeFinalText(input.rawText, evidence, input.ledger);
  if (input.secrets?.length) {
    deliveredFinal = stripSecretEchoes(deliveredFinal, input.secrets).text;
  }
  if (!deliveredFinal.trim()) deliveredFinal = "Outcome was not verified.";
  return { rawFinal: input.rawText, deliveredFinal, evidence };
}

export const EVAL_SCOPE = {
  /**
   * G2: the 37-tool scratch capture is not the run13 fleet (52+ builtins +
   * connectors, computer attached). Matched-config capture and a volatile-field
   * manifest are required before freeze. No recapture in this slice. Private
   * request bodies stay off cloud.
   */
  matchedConfigCapture: "not-this-slice",
  toolBind: "37-scratch-not-run13-fleet",
  /**
   * G4 model-visible tool-result shapes the sim must emit from shipped code:
   * protected note + protectedResult, [withheld], UNAUTHORIZED_IRREVERSIBLE +
   * uncertain:true, redactReplayResult, DESKTOP_LAUNCH_UNSUPPORTED,
   * recoverStaleBrowserAct remaps.
   *
   * N1: Continue after a completed irr:v1 row reuses that key; no second execute.
   * N2: a new authorized sourceMessageId mints a new irr:v1 and is not suppressed.
   * Unauthorized nudge: UNAUTHORIZED_IRREVERSIBLE + uncertain:true.
   */
  n1: "continue-reuses-completed-irr-v1",
  n2: "new-sourceMessageId-new-irr-v1",
  unauthorizedNudge: "UNAUTHORIZED_IRREVERSIBLE+uncertain",
  /**
   * G5: HEAD builtin-tools offers protected_result_handoff. The 37-tool scratch
   * capture does not mount it. Do not auto-add unoffered tools. "delivered" on
   * that capture is scripted-only; drop the model-reachable delivered claim
   * until a matched bind recapture offers the schema.
   */
  protectedResultHandoff: "offered-on-HEAD-not-on-37-bind-capture",
  /**
   * G7: capture window 131072 / maxTokens 32768 is synthetic. Live eval needs
   * a live contextWindow/maxTokens attestation (hash, not printed) first.
   * L1/M1/V1 are tuning-exposed. Held-out 12 stays sealed. No assumed approval.
   */
  window: "synthetic-131072-32768-not-live-attested",
  liveEval: "blocked-until-live-window-attestation",
  tuningExposed: ["L1", "M1", "V1"],
  heldout: "sealed",
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
