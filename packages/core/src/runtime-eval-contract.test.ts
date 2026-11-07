import { describe, expect, it } from "vitest";
import { bindOutcomeArtifact, emptyCompletionLedger } from "./completion-artifact.js";
import {
  ADAPTER_RUNTIME_EVAL_ENTRYPOINTS,
  assembleRawModelText,
  createEvalTurnRecorder,
  deliverAssistantFinal,
  deliverUserVisibleText,
  EVAL_SCOPE,
  recordModelTurn,
  RUNTIME_EVAL_CALL_ORDER,
} from "./runtime-eval-contract.js";

const INTENT = {
  intentId: "intent-reset",
  sourceMessageId: "msg-1",
  runId: "run-1",
};

describe("runtime eval contract", () => {
  it("keeps per-turn raw model chunks separate from assembledRaw and deliveredFinal", () => {
    const recorder = createEvalTurnRecorder();
    recorder.chunk("Done");
    recorder.finish("Done");
    recorder.chunk("All ");
    recorder.chunk("set");
    recorder.finish("All set");
    const modelTurns = recorder.snapshot();
    expect(modelTurns).toHaveLength(2);
    expect(modelTurns[0]).toEqual(recordModelTurn(["Done"], "Done", 0));
    expect(modelTurns[1]?.rawModelText).toBe(assembleRawModelText(["All ", "set"]));
    expect(modelTurns[1]?.rawModelFinish).toBe("All set");
    const assembledRaw = "Done. All set";
    const delivered = deliverAssistantFinal({
      assembledRaw,
      modelTurns,
      toolResults: [],
    });
    expect(delivered.assembledRaw).toBe(assembledRaw);
    expect(delivered.assembledRaw).not.toBe(delivered.modelTurns[0]?.rawModelText);
    expect(delivered.deliveredFinal).toBe("Outcome was not verified.");
    expect(delivered.assembledRaw).not.toBe(delivered.deliveredFinal);
    expect(delivered.modelTurns.map((turn) => turn.callIndex)).toEqual([0, 1]);
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
      assembledRaw: "Text sent",
      toolResults: [{ sent: true }],
      ledger,
    });
    expect(delivered.assembledRaw).toBe("Text sent");
    expect(delivered.deliveredFinal).toBe("Text sent");
    expect(delivered.evidence.sent).toBe(true);
  });

  it("strips harvested secrets from delivered text only", () => {
    const secret = "FxNew#2207GenA";
    const delivered = deliverAssistantFinal({
      assembledRaw: `Reset complete. Temporary password: ${secret}`,
      toolResults: [],
      secrets: [secret],
    });
    expect(delivered.assembledRaw).toContain(secret);
    expect(delivered.deliveredFinal).not.toContain(secret);
    expect(delivered.deliveredFinal).toContain("[withheld]");
  });

  it("names the production finalization call order and adapter entrypoints", () => {
    expect(RUNTIME_EVAL_CALL_ORDER).toContain("recordModelTurn");
    expect(RUNTIME_EVAL_CALL_ORDER).toContain("assistBareDone");
    expect(RUNTIME_EVAL_CALL_ORDER).toContain("deliverAssistantFinal");
    expect(RUNTIME_EVAL_CALL_ORDER.indexOf("recordModelTurn")).toBeLessThan(
      RUNTIME_EVAL_CALL_ORDER.indexOf("assistBareDone"),
    );
    expect(RUNTIME_EVAL_CALL_ORDER.indexOf("gluedConcat")).toBeLessThan(
      RUNTIME_EVAL_CALL_ORDER.indexOf("deliverAssistantFinal"),
    );
    expect(RUNTIME_EVAL_CALL_ORDER).toContain("finalizeRun");
    expect(RUNTIME_EVAL_CALL_ORDER).toContain("compactHistory");
    expect(RUNTIME_EVAL_CALL_ORDER.indexOf("bindOutcomeArtifact")).toBeLessThan(
      RUNTIME_EVAL_CALL_ORDER.indexOf("deliverAssistantFinal"),
    );
    expect(RUNTIME_EVAL_CALL_ORDER.indexOf("deliverAssistantFinal")).toBeLessThan(
      RUNTIME_EVAL_CALL_ORDER.indexOf("finalizeRun"),
    );
    expect(ADAPTER_RUNTIME_EVAL_ENTRYPOINTS).toContain("protectPersistedEffectResult");
    expect(ADAPTER_RUNTIME_EVAL_ENTRYPOINTS).toContain("assistBareDone");
  });

  it("documents G2/G4/G5/G7 without claiming freeze or live attestation", () => {
    expect(EVAL_SCOPE.matchedConfigCapture).toBe("not-this-slice");
    expect(EVAL_SCOPE.toolBind).toMatch(/37-scratch/);
    expect(EVAL_SCOPE.protectedResultHandoff).toMatch(/not-on-37-bind/);
    expect(EVAL_SCOPE.liveEval).toMatch(/blocked/);
    expect(EVAL_SCOPE.heldout).toBe("sealed");
    expect(EVAL_SCOPE.historicalPinnedImage).toMatch(/does-not-validate/);
    expect(EVAL_SCOPE.tuningExposed).toEqual(["L1", "M1", "V1"]);
    expect(EVAL_SCOPE.window).toMatch(/synthetic/);
    expect(EVAL_SCOPE.g3Channels).toMatch(/assembledRaw is post-nudge/);
    expect(EVAL_SCOPE.g1Invariant).toMatch(/no-harvest AND no-rewrite/);
    expect(EVAL_SCOPE.a1).toMatch(/click ok:true is not reset proof/);
    expect(EVAL_SCOPE.a2).toMatch(/deliverUserVisibleText/);
    expect(EVAL_SCOPE.nonEnglish).toBe("excluded-from-eval-explicit");
  });

  it("deliverUserVisibleText sanitizes claims and structured secret echoes on any channel", () => {
    const leaked = deliverUserVisibleText({
      assembledRaw: "Done, the new password is sunflower",
      toolResults: [{ password: "sunflower" }],
      secrets: ["sunflower"],
    });
    expect(leaked).not.toContain("sunflower");
    expect(leaked).not.toMatch(/\bDone\b/);
    expect(
      deliverUserVisibleText({
        assembledRaw: "The bag is in the cart.",
        toolResults: [],
      }),
    ).toBe("The bag is in the cart.");
  });
});
