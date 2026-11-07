import { describe, expect, it } from "vitest";
import { bindOutcomeArtifact, emptyCompletionLedger } from "./completion-artifact.js";
import {
  ADAPTER_RUNTIME_EVAL_ENTRYPOINTS,
  IRREVERSIBLE_EFFECT_STATES,
  MATCHED_CONFIG_INPUT_CONTRACT,
  MODEL_VISIBLE_TOOL_RESULT_SHAPES,
  assembleRawModelText,
  assistNudgeOccurred,
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
      assembledRaw: "sent to +15550100",
      toolResults: [{ sent: true }],
      ledger,
    });
    expect(delivered.assembledRaw).toBe("sent to +15550100");
    expect(delivered.deliveredFinal).toBe("sent to +15550100");
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
    expect(EVAL_SCOPE.matchedConfigCapture).toMatch(/BOX-supplies-bodies/);
    expect(EVAL_SCOPE.toolBind).toMatch(/captured-service-52/);
    expect(EVAL_SCOPE.toolBind).toMatch(/not-37-scratch/);
    expect(EVAL_SCOPE.protectedResultHandoff).toBe("eval-does-not-claim-real-model-handoff");
    expect(EVAL_SCOPE.g5).toMatch(/write authority not expanded/);
    expect(EVAL_SCOPE.liveEval).toMatch(/blocked/);
    expect(EVAL_SCOPE.heldout).toBe("sealed");
    expect(EVAL_SCOPE.historicalPinnedImage).toMatch(/does-not-validate/);
    expect(EVAL_SCOPE.tuningExposed).toEqual(["L1", "M1", "V1"]);
    expect(EVAL_SCOPE.window).toMatch(/synthetic/);
    expect(EVAL_SCOPE.g3Channels).toMatch(/evalSink/);
    expect(EVAL_SCOPE.g1Invariant).toMatch(/no-harvest AND no-rewrite/);
    expect(EVAL_SCOPE.a1).toMatch(/click ok:true is not reset proof/);
    expect(EVAL_SCOPE.a2).toMatch(/claim fallback only/);
    expect(EVAL_SCOPE.a5a6).toMatch(/proof-token identity/);
    expect(EVAL_SCOPE.nonEnglish).toBe("excluded-from-eval-explicit");
    expect(MATCHED_CONFIG_INPUT_CONTRACT.capturedService.expectedOfferedBuiltins).toBe(52);
    expect(MATCHED_CONFIG_INPUT_CONTRACT.capturedService.not37Scratch).toBe(true);
    expect(MATCHED_CONFIG_INPUT_CONTRACT.capturedService.notThisHeadCatalog).toBe(true);
    expect(MATCHED_CONFIG_INPUT_CONTRACT.bodies).toMatch(/do-not-request-private/);
    expect(MODEL_VISIBLE_TOOL_RESULT_SHAPES.clickOkTrue).toMatch(/not outcomeProof/);
    expect(IRREVERSIBLE_EFFECT_STATES.n1Continue).toMatch(/reuses completed irr:v1/);
    expect(IRREVERSIBLE_EFFECT_STATES.n2TimeoutResend).toMatch(/new sourceMessageId/);
    const recorder = createEvalTurnRecorder();
    recorder.chunk("Done");
    recorder.finish("Done");
    recorder.chunk("The bag is in the cart.");
    recorder.finish("The bag is in the cart.");
    expect(assistNudgeOccurred(recorder.snapshot())).toBe(true);
    expect(RUNTIME_EVAL_CALL_ORDER).toContain("evalSink");
    expect(ADAPTER_RUNTIME_EVAL_ENTRYPOINTS).toContain("runComposedEvalLoop");
    expect(ADAPTER_RUNTIME_EVAL_ENTRYPOINTS).not.toContain("handoffProtectedResult");
  });

  it("deliverUserVisibleText sanitizes claims on final channels and keeps operational status text", () => {
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
    expect(
      deliverUserVisibleText({
        assembledRaw: "Please complete the captcha so I can continue.",
        toolResults: [],
        channel: "takeover",
      }),
    ).toBe("Please complete the captcha so I can continue.");
    expect(
      deliverUserVisibleText({
        assembledRaw: "Step 1 done, moving on to step 2.",
        toolResults: [],
        channel: "stream",
      }),
    ).toBe("Step 1 done, moving on to step 2.");
    expect(
      deliverUserVisibleText({
        assembledRaw: "Sent message to Pat Lee",
        toolResults: [],
        channel: "activity",
      }),
    ).toBe("Sent message to Pat Lee");
    expect(
      deliverUserVisibleText({
        assembledRaw: "   ",
        toolResults: [],
        channel: "stream",
      }),
    ).toBe("   ");
  });
});
