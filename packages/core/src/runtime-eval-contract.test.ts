import { describe, expect, it } from "vitest";
import { bindOutcomeArtifact, emptyCompletionLedger } from "./completion-artifact.js";
import {
  ADAPTER_RUNTIME_EVAL_ENTRYPOINTS,
  deliverAssistantFinal,
  EVAL_SCOPE,
  RUNTIME_EVAL_CALL_ORDER,
} from "./runtime-eval-contract.js";

const INTENT = {
  intentId: "intent-reset",
  sourceMessageId: "msg-1",
  runId: "run-1",
};

describe("runtime eval contract", () => {
  it("records raw model text separately from delivered post-process text", () => {
    const delivered = deliverAssistantFinal({
      rawText: "Done",
      toolResults: [],
    });
    expect(delivered.rawFinal).toBe("Done");
    expect(delivered.deliveredFinal).toBe("Outcome was not verified.");
    expect(delivered.rawFinal).not.toBe(delivered.deliveredFinal);
  });

  it("keeps a ledger-backed send claim in delivered text", () => {
    const ledger = emptyCompletionLedger(INTENT);
    const artifact = bindOutcomeArtifact({
      result: { sent: true, state: "Delivered" },
      toolName: "mac_messages_send",
      args: { handle: "+15550100", text: "Running late." },
      ...INTENT,
    });
    ledger.artifacts.push(artifact!);
    const delivered = deliverAssistantFinal({
      rawText: "Text sent",
      toolResults: [{ sent: true }],
      ledger,
    });
    expect(delivered.rawFinal).toBe("Text sent");
    expect(delivered.deliveredFinal).toBe("Text sent");
    expect(delivered.evidence.sent).toBe(true);
  });

  it("strips harvested secrets from delivered text only", () => {
    const secret = "FxNew#2207GenA";
    const delivered = deliverAssistantFinal({
      rawText: `Reset complete. Temporary password: ${secret}`,
      toolResults: [],
      secrets: [secret],
    });
    expect(delivered.rawFinal).toContain(secret);
    expect(delivered.deliveredFinal).not.toContain(secret);
    expect(delivered.deliveredFinal).toContain("[withheld]");
  });

  it("names the sanctioned call order and adapter entrypoints", () => {
    expect(RUNTIME_EVAL_CALL_ORDER).toContain("sanitizeFinalText");
    expect(RUNTIME_EVAL_CALL_ORDER).toContain("stripSecretRequestContext");
    expect(RUNTIME_EVAL_CALL_ORDER.indexOf("bindOutcomeArtifact")).toBeLessThan(
      RUNTIME_EVAL_CALL_ORDER.indexOf("sanitizeFinalText"),
    );
    expect(ADAPTER_RUNTIME_EVAL_ENTRYPOINTS).toContain("protectPersistedEffectResult");
    expect(ADAPTER_RUNTIME_EVAL_ENTRYPOINTS).toContain("redactReplayResult");
  });

  it("documents G2/G4/G5/G7 without claiming freeze or live attestation", () => {
    expect(EVAL_SCOPE.matchedConfigCapture).toBe("not-this-slice");
    expect(EVAL_SCOPE.toolBind).toMatch(/37-scratch/);
    expect(EVAL_SCOPE.protectedResultHandoff).toMatch(/not-on-37-bind/);
    expect(EVAL_SCOPE.liveEval).toMatch(/blocked/);
    expect(EVAL_SCOPE.heldout).toBe("sealed");
    expect(EVAL_SCOPE.tuningExposed).toEqual(["L1", "M1", "V1"]);
    expect(EVAL_SCOPE.window).toMatch(/synthetic/);
  });
});
