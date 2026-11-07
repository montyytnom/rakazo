const CONTEXT_WINDOW = /exceeds the context window|context length|maximum context/i;

export type StreamErrorEvent = {
  message: string;
  type?: string;
  code?: string;
};

export function extractOpenAiSseError(payload: string): StreamErrorEvent | undefined {
  for (const block of payload.split(/\n\n+/)) {
    const event = /(?:^|\n)event:\s*(\S+)/.exec(block)?.[1];
    const dataLines = block
      .split(/\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    if (!dataLines || dataLines === "[DONE]") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataLines);
    } catch {
      continue;
    }
    const error = streamErrorFromJson(parsed);
    if (error) return error;
    if (event === "error") {
      return { message: dataLines, type: "error" };
    }
  }
  const direct = streamErrorFromJson(tryJson(payload));
  return direct;
}

export function isContextWindowStreamError(error: StreamErrorEvent | string): boolean {
  const message = typeof error === "string" ? error : error.message;
  return CONTEXT_WINDOW.test(message);
}

export function streamErrorFailsRun(error: StreamErrorEvent | string): boolean {
  const message = typeof error === "string" ? error : error.message;
  return message.trim().length > 0;
}

function streamErrorFromJson(value: unknown): StreamErrorEvent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.error && typeof record.error === "object") {
    const inner = record.error as Record<string, unknown>;
    const message = String(inner.message ?? inner.code ?? "error");
    return {
      message,
      type: typeof inner.type === "string" ? inner.type : "error",
      code: typeof inner.code === "string" ? inner.code : undefined,
    };
  }
  if (record.object === "error" || record.type === "error") {
    return { message: String(record.message ?? "error"), type: "error" };
  }
  return undefined;
}

function tryJson(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}
