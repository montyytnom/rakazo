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
 * Text channels (do not collapse):
 * - `rawModelChunks` / `rawModelFinish` / `rawModelText`: one provider call
 * - `assembledRaw`: post-nudge + concat across calls; NOT raw model output
 * - `deliveredFinal`: sanitize + labeled-span + known-secret strip
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
    id: "recordModelTurn",
    site: "executor stream text / tool / done",
    records: "rawModelChunks+rawModelFinish+rawModelText per provider call, in call order",
  },
  {
    id: "assistBareDone",
    site: "packages/adapters/src/pi-runtime.ts overlay local patch",
    records: "follow-up user turn; starts the next provider call; not a delivered final",
  },
  {
    id: "gluedConcat",
    site: "executor assembled += separator + event.text; sanitizeFinalText stripGluedSuccessPrefix",
    records: "assembledRaw only — never labeled raw model output",
  },
  {
    id: "deliverAssistantFinal",
    site: "executor completionBlocks map + notification body",
    records: "assembledRaw in, deliveredFinal out; modelTurns pass-through",
  },
  {
    id: "finalizeRun",
    site: "deps.events.finalizeRun",
    records: "persisted delivered blocks",
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

export type EvalModelTurn = {
  /** Streamed model text pieces for one provider call, in arrival order. */
  rawModelChunks: string[];
  /** Model `done` text for that call. Empty when the call ended on a tool. */
  rawModelFinish: string;
  /** Joined chunks for that call. Not post-nudge, not delivered. */
  rawModelText: string;
  callIndex: number;
};

export type EvalTurnRecorder = {
  chunk: (text: string) => void;
  finish: (finishText: string) => boolean;
  finishOrDone: (finishText: string) => void;
  snapshot: () => EvalModelTurn[];
};

export function assembleRawModelText(chunks: readonly string[]): string {
  return chunks.join("");
}

export function recordModelTurn(
  chunks: readonly string[],
  finish: string,
  callIndex: number,
): EvalModelTurn {
  return {
    rawModelChunks: [...chunks],
    rawModelFinish: finish,
    rawModelText: assembleRawModelText(chunks),
    callIndex,
  };
}

export function createEvalTurnRecorder(): EvalTurnRecorder {
  const turns: EvalModelTurn[] = [];
  let chunks: string[] = [];
  let open = false;
  const finish = (finishText: string): boolean => {
    if (!open && chunks.length === 0) return false;
    turns.push(recordModelTurn(chunks, finishText, turns.length));
    chunks = [];
    open = false;
    return true;
  };
  return {
    chunk(text: string) {
      chunks.push(text);
      open = true;
    },
    finish,
    finishOrDone(finishText: string) {
      if (finish(finishText)) return;
      if (finishText && turns.length === 0) {
        turns.push(recordModelTurn([], finishText, 0));
      }
    },
    snapshot() {
      return turns.map((turn) => ({
        ...turn,
        rawModelChunks: [...turn.rawModelChunks],
      }));
    },
  };
}

export type DeliveredAssistantFinal = {
  /** Post-nudge/concat assembled text. Not raw model output. */
  assembledRaw: string;
  deliveredFinal: string;
  modelTurns: EvalModelTurn[];
  evidence: ToolEvidence;
};

/**
 * Exact text transform used by overlay finalizeRun blocks and compaction.
 * Input is assembledRaw (post-nudge/concat). Per-turn raw model lives on
 * `modelTurns` from createEvalTurnRecorder — this helper does not invent it.
 */
export function deliverAssistantFinal(input: {
  assembledRaw?: string;
  /** @deprecated Alias of assembledRaw. Never treat as raw model output. */
  rawText?: string;
  modelTurns?: readonly EvalModelTurn[];
  toolResults: readonly unknown[];
  ledger?: CompletionLedger;
  secrets?: readonly string[];
}): DeliveredAssistantFinal {
  const assembledRaw = input.assembledRaw ?? input.rawText ?? "";
  const evidence = collectToolEvidence(input.toolResults);
  let deliveredFinal = sanitizeFinalText(assembledRaw, evidence, input.ledger);
  deliveredFinal = redactLabeledSecretSpans(deliveredFinal);
  if (input.secrets?.length) {
    deliveredFinal = stripSecretEchoes(deliveredFinal, input.secrets).text;
  }
  if (!deliveredFinal.trim()) deliveredFinal = "Outcome was not verified.";
  return {
    assembledRaw,
    deliveredFinal,
    modelTurns: input.modelTurns
      ? input.modelTurns.map((turn) => ({
          ...turn,
          rawModelChunks: [...turn.rawModelChunks],
        }))
      : [],
    evidence,
  };
}

/** Every user-visible channel (final, stream, message_user, narration) uses this. */
export function deliverUserVisibleText(
  input: Parameters<typeof deliverAssistantFinal>[0],
): string {
  return deliverAssistantFinal(input).deliveredFinal;
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
  g1Invariant:
    "no-harvest AND no-rewrite of defs; do not mine embedded <turn_context> user envelope or untrusted page labels into the known set; structured-field+SecretStore known values echo-strip context-safe, any shape",
  g3Channels:
    "rawModelChunks+rawModelFinish per provider call; assembledRaw is post-nudge+concat; deliveredFinal is sanitized; deliverAssistantFinal input is assembledRaw not raw model",
  a1:
    "click ok:true is not reset proof; reset claims need outcomeProof+same-subject verified-read; task-proof for A does not license order/license B",
  a2: "every user-visible channel including stream/message_user/narration/takeover/loop-guard uses deliverUserVisibleText",
  g6Proof: "identity+subject+action; verified-read A does not license verified B",
  nonEnglish: "excluded-from-eval-explicit",
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
