import { describe, expect, it } from "vitest";
import {
  MATCHED_CONFIG_INPUT_CONTRACT,
  MODEL_VISIBLE_TOOL_RESULT_SHAPES,
  IRREVERSIBLE_EFFECT_STATES,
} from "@rakazo/core";
import { CAPTURED_SERVICE_OFFERED_BUILTINS, REVIEWER_EXPECTED_WORKER_BUILTINS } from "./isolated-capture.js";
import { requireOverlayArchive } from "./runtime-eval-loop.js";

describe("composed eval loop contract", () => {
  it("hard-fails when the overlay archive is missing", () => {
    expect(() => requireOverlayArchive("/tmp/definitely-missing-overlay-9fd8")).toThrow(
      /overlay compose blocked/,
    );
  });

  it("does not treat this HEAD builtin catalog as the captured-service 52", () => {
    expect(CAPTURED_SERVICE_OFFERED_BUILTINS).toBe(52);
    expect(REVIEWER_EXPECTED_WORKER_BUILTINS).not.toBe(CAPTURED_SERVICE_OFFERED_BUILTINS);
    expect(MATCHED_CONFIG_INPUT_CONTRACT.capturedService.expectedOfferedBuiltins).toBe(52);
    expect(MATCHED_CONFIG_INPUT_CONTRACT.capturedService.plus).toEqual([
      "fleet",
      "computer",
      "connectors",
    ]);
    expect(MODEL_VISIBLE_TOOL_RESULT_SHAPES.protectedResultNote).toMatch(/value withheld/);
    expect(IRREVERSIBLE_EFFECT_STATES.n1Continue).toMatch(/Continue reuses/);
  });
});
