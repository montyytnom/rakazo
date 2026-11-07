import { describe, expect, it } from "vitest";
import {
  extractOpenAiSseError,
  isContextWindowStreamError,
  streamErrorFailsRun,
} from "./model-stream-error.js";

describe("HTTP 200 SSE error events", () => {
  it("surfaces an in-stream error instead of treating the turn as empty success", () => {
    const payload = [
      "event: error",
      'data: {"error":{"message":"This model\'s maximum context length is 131072 tokens. Your request exceeds the context window.","type":"invalid_request_error"}}',
      "",
    ].join("\n");
    const error = extractOpenAiSseError(payload);
    expect(error?.message).toMatch(/exceeds the context window/);
    expect(isContextWindowStreamError(error!)).toBe(true);
    expect(streamErrorFailsRun(error!)).toBe(true);
  });

  it("fails closed on a malformed error event and a JSON error after a tool payload", () => {
    expect(extractOpenAiSseError("event: error\ndata: not-json\n\n")?.type).toBe("error");
    const afterTool = [
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"c1"}]}}]}',
      "",
      'data: {"error":{"message":"truncated after tools"}}',
      "",
    ].join("\n");
    expect(extractOpenAiSseError(afterTool)?.message).toMatch(/truncated after tools/);
  });
});
