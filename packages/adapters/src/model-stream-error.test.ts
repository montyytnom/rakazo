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

  it("ignores a completed stream", () => {
    expect(extractOpenAiSseError("data: [DONE]\n\n")).toBeUndefined();
  });
});
