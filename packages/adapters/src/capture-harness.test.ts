import { describe, expect, it } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import {
  CAPTURE_LABEL,
  captureBuiltinToolsJson,
  captureCallLimits,
  PRODUCTION_CAPTURE,
  RECONSTRUCTION,
  reconstructOfflinePhases,
  serializeToolsWire,
} from "./capture-harness.js";

describe("capture harness", () => {
  it("returns model-visible builtin tool JSON without secrets", () => {
    const dump = captureBuiltinToolsJson();
    expect(dump.label).toBe(CAPTURE_LABEL);
    expect(dump.variant).toBe("base");
    expect(dump.tools.length).toBe(builtinAgentTools.length);
    expect(dump.tools.every((tool) => tool.type === "function")).toBe(true);
    expect(JSON.stringify(dump)).not.toMatch(/sk-|BEGIN PRIVATE|password=/i);
    const names = dump.tools.map((tool) => tool.function.name);
    expect(names).toContain("browser_act");
    expect(names).toContain("launch_app");
    expect(new Set(names).size).toBe(names.length);
  });

  it("reports per-call limits and leaves thinking unmarked as changed", () => {
    const limits = captureCallLimits({
      RAKAZO_THINKING_BUDGET: "64",
      RAKAZO_THINKING_BUDGET_MODELS: "qwen3.8-flash-next",
      RAKAZO_FAST_COMPUTER_STEPS: "1",
      RAKAZO_OPENAI_COMPAT_CHAT_TEMPLATE_KWARGS: '{"enable_thinking":true,"medium_effort":true}',
      MAX_TOOL_CALLS_PER_TURN: "150",
    });
    expect(limits.thinking.unchanged).toBe(true);
    expect(limits.thinking.budget).toBe("64");
    expect(limits.parallelToolCalls).toBeNull();
    expect(limits.maxTokensDefault).toBe(32768);
    expect(serializeToolsWire(builtinAgentTools.slice(0, 1))[0]?.function.parameters).toBeTruthy();
    const phases = reconstructOfflinePhases({
      apiToolNames: ["browser_act"],
      workerToolNames: ["browser_act", "browser_extract"],
      limits,
      baseTools: captureBuiltinToolsJson().tools,
    });
    expect(phases.productionCapture).toBe(false);
    expect(phases.productionFaithful).toBe(false);
    expect(phases.liveGate).toBe("locked");
    expect(phases.kind).toBe(RECONSTRUCTION);
    expect(phases.productionLiveCapture).toBe(PRODUCTION_CAPTURE);
    expect(phases.apiWorkerNameDelta).toEqual(["browser_extract"]);
    const shaped = captureCallLimits(
      {
        RAKAZO_MODEL_STREAM_TIMEOUT_MS: "600000",
        MAX_TOOL_CALLS_PER_TURN: "150",
        RAKAZO_THINKING_BUDGET: "64",
        RAKAZO_THINKING_BUDGET_MODELS: "qwen3.8-flash-next",
      },
      "sanitized-production-shaped",
    );
    expect(shaped.envSource).toBe("sanitized-production-shaped");
    expect(shaped.productionFaithful).toBe(false);
    expect(shaped.streamTimeoutMs).toBe(600000);
    expect(shaped.maxToolCallsPerTurn).toBe("150");
    expect(captureCallLimits().envSource).toBe("agent-vm-defaults");
  });
});
