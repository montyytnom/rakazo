import { describe, expect, it } from "vitest";
import {
  evaluateNonVacuous,
  SYNTHETIC_CAPTURE_CONTEXT_WINDOW,
  SYNTHETIC_CAPTURE_MAX_TOKENS,
} from "./candidate-capture-harness.js";

const vacuous729d = {
  ok: true,
  http: "",
  persist: "[]",
  final:
    '[{"outcome":"failed","error":"Required context exceeds the model context budget"}]',
  handoff: "null",
  httpBytes: 0,
  httpRequestCount: 0,
  runOutcome: "failed",
  runError: "Required context exceeds the model context budget",
  persistEffectCount: 0,
  finalCount: 1,
  executeToolNames: [],
  executeArgsHasCurrent: false,
  httpHasCurrent: false,
  persistHasCurrent: false,
  finalHasCurrent: false,
  handoffEmpty: true,
  stubEmittedDone: false,
  finalHasDoneWord: false,
  finalHasNotVerified: false,
};

describe("candidate-capture non-vacuous gate", () => {
  it("uses the documented synthetic 131072 window, not 32768/8192", () => {
    expect(SYNTHETIC_CAPTURE_MAX_TOKENS).toBe(32_768);
    expect(SYNTHETIC_CAPTURE_CONTEXT_WINDOW).toBe(131_072);
  });

  it("rejects the 729d no-throw executor rows as vacuous", () => {
    for (const name of [
      "generated-secret",
      "stale-secret",
      "protected-handoff-repaired-path",
      "false-success-done",
    ]) {
      const verdict = evaluateNonVacuous(name, vacuous729d);
      expect(verdict.ok, name).toBe(false);
      expect(verdict.vacuous, name).toBe(true);
      expect(verdict.failures).toContain("VACUOUS_ZERO_HTTP");
      expect(verdict.failures).toContain("VACUOUS_FAILED_RUN");
      expect(verdict.failures).toContain("VACUOUS_MISSING_TOOL_ROUND");
    }
  });

  it("rejects false-success-done that never emitted Done", () => {
    const verdict = evaluateNonVacuous("false-success-done", {
      ...vacuous729d,
      http: "x",
      httpBytes: 12,
      httpRequestCount: 2,
      persist: '[{"id":"effect-1"}]',
      final: '[{"outcome":"completed"}]',
      runOutcome: "completed",
      runError: null,
      executeToolNames: ["scratchpad_add"],
      persistEffectCount: 1,
      stubEmittedDone: false,
      finalHasNotVerified: false,
      finalHasDoneWord: false,
    });
    expect(verdict.failures).toContain("VACUOUS_STUB_DID_NOT_EMIT_DONE");
    expect(verdict.ok).toBe(false);
  });

  it("accepts an AFTER secret row with before-args leak and after withhold", () => {
    const verdict = evaluateNonVacuous("generated-secret", {
      http: '{"messages":[{"role":"user"}]}',
      httpBytes: 40,
      httpRequestCount: 2,
      persist: '[{"result":{"title":"[withheld]"}}]',
      final: '[{"outcome":"completed","blocks":[{"text":"Protected result"}]}]',
      handoff: "null",
      runOutcome: "completed",
      executeToolNames: ["scratchpad_add"],
      executeArgsHasCurrent: true,
      toolResultAfterHasCurrent: false,
      httpHasCurrent: false,
      persistHasCurrent: false,
      finalHasCurrent: false,
    });
    expect(verdict.failures).toEqual([]);
    expect(verdict.ok).toBe(true);
  });
});
