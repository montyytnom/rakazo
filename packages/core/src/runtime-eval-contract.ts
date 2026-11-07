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
    id: "evalSink",
    site: "executor continueRun after delivered text",
    records:
      "EvalChannelRecord: rawModelChunks/stops, assembledRaw, deliveredFinal, streamed, persisted, notification, publishedMessages, assistNudge",
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
    records:
      "HEAD catalog schema only; eval does not claim real-model handoff; write authority not expanded; captured 52-bind and 37-scratch do not offer it",
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
  "runComposedEvalLoop",
] as const;

/**
 * Sanitized BOX input contract. This repo does not request private prompts,
 * bodies, or overlay archives. BOX supplies those locally.
 *
 * Matched-config offered tools are the captured-service inventory: 52 builtins
 * plus fleet, computer, and connectors from that service. This HEAD catalog
 * count (and isolated-capture REVIEWER_EXPECTED_WORKER_BUILTINS) is not that
 * number. 37-scratch is not matched-config.
 */
export const MATCHED_CONFIG_INPUT_CONTRACT = {
  bodies: "BOX-supplies-locally-do-not-request-private-prompts-or-bodies",
  overlayArchive: "BOX-local-path-hard-fail-if-missing",
  capturedService: {
    expectedOfferedBuiltins: 52,
    plus: ["fleet", "computer", "connectors"] as const,
    source: "captured-service-inventory",
    notThisHeadCatalog: true,
    not37Scratch: true,
  },
  backends: {
    browser: "pluggable",
    connector: "pluggable",
    model: "recording-baseURL-stub-offline-now",
  },
  liveEval: "requires-approval-and-attested-window-later",
  productionChannels: [
    "final",
    "notification",
    "stream",
    "progress",
    "takeover",
    "activity",
    "message_user",
    "message_bot",
    "narration",
    "loop-guard",
    "attach",
  ] as const,
  evalSinkRecords: "in-process stream strings, not HTTP raw request bytes",
  volatileFields: [
    "http.headers.date",
    "http.headers.host",
    "http.headers.connection",
    "requestBody.messages[role=user] current-time sentence",
    "sse.created",
  ] as const,
} as const;

/** Model-visible tool-result shape changes on the persist/replay/protect path. */
export const MODEL_VISIBLE_TOOL_RESULT_SHAPES = {
  protectedResultNote:
    "Protected result {handle} at {createdAt}, {hash}, status {status} — value withheld.",
  protectedResultObject: "{ ...redactedTree, protectedResult: handle, note }",
  clickOkTrue: "{ok:true} is a mutation attempt, not outcomeProof or task-proof",
  withheldMarker: "[withheld] / [redacted]",
  replayCompleted: "redactReplayResult of the stored result; protectedVaultRef stripped",
  replayUncertain: "UNAUTHORIZED_IRREVERSIBLE or uncertain:true; no second write",
  desktopLaunchUnsupported: "Search installed desktop tools (model-visible hint, not a retry)",
} as const;

/** N1 Continue / N2 timeout-resend effect states. */
export const IRREVERSIBLE_EFFECT_STATES = {
  n1Continue:
    "Continue reuses completed irr:v1 for the same sourceMessageId/intentId; no second write",
  n2TimeoutResend:
    "A new sourceMessageId is a new irr:v1 even when the user text matches. Timeout replay of the same sourceMessageId reuses completed. Crash-while-executing is uncertain, not a second write.",
  unauthorizedNudge: "UNAUTHORIZED_IRREVERSIBLE + uncertain: true",
} as const;

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

export type EvalChannelRecord = {
  modelTurns: EvalModelTurn[];
  assembledRaw: string;
  deliveredFinal: string;
  streamed: string[];
  persisted: unknown;
  notification: string;
  publishedMessages: string[];
  assistNudge: boolean;
};

export function assistNudgeOccurred(turns: readonly EvalModelTurn[]): boolean {
  if (turns.length < 2) return false;
  return /^\s*done\.?\s*$/i.test(turns[0]?.rawModelText ?? "");
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
  /** Explicit NO_RESPONSE / silent-allowed empty finals stay empty. */
  allowEmpty?: boolean;
}): DeliveredAssistantFinal {
  const assembledRaw = input.assembledRaw ?? input.rawText ?? "";
  if (input.allowEmpty && !assembledRaw.trim()) {
    return {
      assembledRaw,
      deliveredFinal: "",
      modelTurns: input.modelTurns
        ? input.modelTurns.map((turn) => ({
            ...turn,
            rawModelChunks: [...turn.rawModelChunks],
          }))
        : [],
      evidence: collectToolEvidence(input.toolResults),
    };
  }
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

export type UserVisibleChannel =
  | "final"
  | "notification"
  | "message_user"
  | "message_bot"
  | "progress"
  | "stream"
  | "takeover"
  | "activity"
  | "narration"
  | "loop-guard"
  | "attach";

const CLAIM_SANITIZE_CHANNELS: ReadonlySet<UserVisibleChannel> = new Set([
  "final",
  "notification",
  "message_user",
  "loop-guard",
]);

/**
 * Secrets always. Claim sanitizing and the honest-unverified fallback only on
 * final/notification/message_user/loop-guard. Stream, takeover, activity, and
 * narration keep operational text (captcha, step progress) intact.
 */
export function deliverUserVisibleText(
  input: Parameters<typeof deliverAssistantFinal>[0] & { channel?: UserVisibleChannel },
): string {
  const channel = input.channel ?? "final";
  if (!CLAIM_SANITIZE_CHANNELS.has(channel)) {
    let next = input.assembledRaw ?? input.rawText ?? "";
    next = redactLabeledSecretSpans(next);
    if (input.secrets?.length) next = stripSecretEchoes(next, input.secrets).text;
    return next;
  }
  return deliverAssistantFinal(input).deliveredFinal;
}

export const EVAL_SCOPE = {
  matchedConfigCapture: "sanitized-input-contract-BOX-supplies-bodies-locally",
  toolBind:
    "matched-config-is-captured-service-52-plus-fleet-computer-connectors-not-37-scratch-not-this-head-catalog",
  historicalPinnedImage: "12/12-does-not-validate-this-runtime",
  n1: "continue-reuses-completed-irr-v1",
  n2: "new-sourceMessageId-new-irr-v1",
  unauthorizedNudge: "UNAUTHORIZED_IRREVERSIBLE+uncertain",
  protectedResultHandoff: "eval-does-not-claim-real-model-handoff",
  window: "synthetic-131072-32768-not-live-attested",
  liveEval: "blocked-until-offline-contract-attestation-and-approval",
  tuningExposed: ["L1", "M1", "V1"],
  heldout: "sealed",
  g1Invariant:
    "no-harvest AND no-rewrite of defs; do not mine embedded <turn_context> user envelope or untrusted page labels into the known set; structured-field+SecretStore known values echo-strip context-safe, any shape",
  g3Channels:
    "evalSink emits in-process rawModelChunks+rawModelFinish, assembledRaw, deliveredFinal, streamed, persisted, notification, publishedMessages, assistNudge; not HTTP raw request bytes",
  g5: "schema exists on HEAD catalog; captured 52-bind and 37-scratch do not offer it; write authority not expanded; live handoff is not an eval claim",
  a1:
    "click ok:true is not reset proof; reset claims need same-subject reset action AND verified-read; verified post-reset page is the production emitter (action=reset on verified-read); no fictional outcomeProof",
  a2:
    "secrets on every channel including message_bot/attach; claim fallback only on final/notification/message_user/loop-guard; stream/takeover/activity/narration/message_bot keep operational text",
  a5a6:
    "proof-token identity; send without bindable subject fail-closed; negation is not/never/n't not discourse no; glued is Done+[A-Z] only",
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
