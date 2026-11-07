import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import type { ConnectorTool } from "@rakazo/adapter-kit";
import { builtinAgentTools } from "./builtin-tools.js";
import { captureCallLimits } from "./capture-harness.js";
import { formatCurrentTimeInstruction } from "./current-time.js";
import {
  persistentComputerInstruction,
  selectBuiltinToolsForRun,
  userTurnInstructions,
} from "./executor.js";
import {
  compactionSummarizerInstructions,
  compactionSummarizerPrompt,
} from "./history-compaction.js";
import { PiAgentRuntime } from "./pi-runtime.js";
import { TOOL_RESULT_TEXT_LIMIT } from "./pi-runtime-limits.js";
import { withoutNamelessToolCalls } from "./pi-tool-call-guard.js";

const require = createRequire(import.meta.url);

export const ISOLATED_CAPTURE_KIND = "deployed-code-synthetic-http";
export const STALE_PAGE_STATE_NOTE =
  "[Earlier page state trimmed to save context. Facts you still need from that page should already be in your notes or tracker; otherwise take a fresh snapshot.]";
export const OVERSIZED_PAGE_CHARS = 40_000;
export const CAPTURE_CLOCK_DEFAULT = "2026-11-07T00:00:00.000Z";

/** Volatile fields the byte-diff replay may exclude. Anything else must byte-match. */
export const VOLATILE_FIELDS = [
  {
    path: "http.headers.date",
    reason: "HTTP Date from the Node listener",
  },
  {
    path: "http.headers.host",
    reason: "ephemeral 127.0.0.1 stub port",
  },
  {
    path: "http.headers.connection",
    reason: "keep-alive vs close",
  },
  {
    path: "requestBody.messages[role=user] current-time sentence",
    reason: "formatCurrentTimeInstruction ISO, unless ISOLATED_CAPTURE_NOW is pinned",
  },
  {
    path: "sse.created",
    reason: "stub may stamp 0; live gateways stamp unix time",
  },
] as const;

export const RUNTIME_ONLY_PROMPT_BLOCKS = {
  groupContext: "Group context: synthetic-capture-group.",
  messagingContext: "Messaging context: synthetic-capture-channel.",
  redactedMemoryContext: "Memory: synthetic-capture-memory-block.",
  redactedScratchpadContext: "Scratchpad: synthetic-capture-scratchpad-block.",
} as const;

export const SAMPLING_KEYS = [
  "temperature",
  "top_p",
  "top_k",
  "thinking_budget",
  "enable_thinking",
  "max_tokens",
  "max_completion_tokens",
] as const;

export type SamplingRecord = {
  included: Record<string, unknown>;
  omitted: string[];
  chat_template_kwargs: unknown;
};

export type CapturedHttp = {
  seq: number;
  caseName: string;
  phase: string;
  method: string;
  url: string;
  nonAuthHeaders: Record<string, string>;
  rawSha256: string;
  rawByteLength: number;
  sampling: SamplingRecord;
  toolNames: string[];
};

type StubReply =
  | { kind: "sse"; events: unknown[]; finish: string | null }
  | { kind: "http-error"; status: number; body: string };

const AUTH_HEADER_NAMES = new Set(["authorization", "proxy-authorization", "cookie", "x-api-key"]);

export function captureClock(): Date {
  const raw = process.env.ISOLATED_CAPTURE_NOW?.trim() || CAPTURE_CLOCK_DEFAULT;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`ISOLATED_CAPTURE_NOW is not a date: ${raw}`);
  }
  return date;
}

export function offeredToolsForSyntheticCapture(): ConnectorTool[] {
  return selectBuiltinToolsForRun({
    ticketBoardEnabled: true,
    phoneCallsEnabled: false,
    historyRetrievalEnabled: true,
    graphicalToolsAllowed: true,
    pageBrowserAllowed: true,
    groupId: null,
    trigger: "message",
    semanticMemoryEnabled: true,
    cloudAgentEnabled: false,
    mediaImagesEnabled: false,
    mediaVideoEnabled: false,
    messagingChannelRun: false,
    voiceCall: false,
    fleetManagement: false,
    followUpFromUser: true,
  });
}

export function syntheticTurnInstructions(): string {
  return userTurnInstructions({
    botInstructions: "Synthetic capture bot. No live chat.",
    groupContext: RUNTIME_ONLY_PROMPT_BLOCKS.groupContext,
    messagingContext: RUNTIME_ONLY_PROMPT_BLOCKS.messagingContext,
    redactedMemoryContext: RUNTIME_ONLY_PROMPT_BLOCKS.redactedMemoryContext,
    redactedScratchpadContext: RUNTIME_ONLY_PROMPT_BLOCKS.redactedScratchpadContext,
    hasHistoricalContext: false,
    historyRetrievalEnabled: true,
    computerInstruction: persistentComputerInstruction({
      heldForTakeover: false,
      graphicalToolsAllowed: true,
      graphical: true,
    }),
    pageBrowserAllowed: true,
    workspaceInstruction: "Workspace: synthetic-capture-workspace.",
    agentEnvironmentInstruction: undefined,
    botDirectory: undefined,
    pluginLine: undefined,
    agentSkillsLine: undefined,
    taughtSkillsLine: undefined,
    replyGuidance: "Be concise.",
    offeredFleetTools: [],
  })
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

export function syntheticUserPrompt(): string {
  return [
    "Synthetic capture turn. No live accounts, secrets, or browsing.",
    formatCurrentTimeInstruction(captureClock()),
  ].join("\n\n");
}

export function samplingFromBody(body: Record<string, unknown> | null): SamplingRecord {
  const included: Record<string, unknown> = {};
  const omitted: string[] = [];
  const kwargs =
    body && typeof body.chat_template_kwargs === "object" && body.chat_template_kwargs !== null
      ? (body.chat_template_kwargs as Record<string, unknown>)
      : undefined;
  for (const key of SAMPLING_KEYS) {
    if (key === "enable_thinking") {
      if (kwargs && "enable_thinking" in kwargs) included.enable_thinking = kwargs.enable_thinking;
      else omitted.push("enable_thinking");
      continue;
    }
    if (body && key in body) included[key] = body[key];
    else omitted.push(key);
  }
  return { included, omitted, chat_template_kwargs: kwargs ?? null };
}

export function oversizedPage(index: number): Record<string, unknown> {
  return {
    url: `https://capture.example.test/page-${index}`,
    title: `synthetic-oversized-page-${index}`,
    tree: `BEGIN_PAGE_${index}_`.padEnd(OVERSIZED_PAGE_CHARS, "x"),
    elements: [],
  };
}

function toolNamesFromBody(body: Record<string, unknown> | null): string[] {
  if (!body || !Array.isArray(body.tools)) return [];
  return body.tools.flatMap((tool) => {
    if (!tool || typeof tool !== "object") return [];
    const fn = (tool as { function?: { name?: unknown } }).function;
    return typeof fn?.name === "string" ? [fn.name] : [];
  });
}

function nonAuthHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (AUTH_HEADER_NAMES.has(name.toLowerCase())) continue;
    if (typeof value === "string") headers[name] = value;
    else if (Array.isArray(value)) headers[name] = value.join(", ");
  }
  return headers;
}

function ssePayload(modelId: string, events: unknown[], finish: string | null): string {
  const chunks: string[] = [];
  const emit = (delta: unknown, finishReason: string | null = null) => {
    chunks.push(
      `data: ${JSON.stringify({
        id: "synthetic-capture",
        object: "chat.completion.chunk",
        created: 0,
        model: modelId,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`,
    );
  };
  emit({ role: "assistant" });
  for (const event of events) emit(event);
  emit({}, finish);
  chunks.push("data: [DONE]\n\n");
  return chunks.join("");
}

function toolCallDelta(id: string, name: string, args: Record<string, unknown>, index = 0) {
  return [
    {
      tool_calls: [
        {
          index,
          id,
          type: "function",
          function: { name, arguments: "" },
        },
      ],
    },
    {
      tool_calls: [{ index, function: { arguments: JSON.stringify(args) } }],
    },
  ];
}

export async function startCaptureStub(options: {
  modelId: string;
  replies: StubReply[];
  caseName: string;
}): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  captures: CapturedHttp[];
  rawBodies: Buffer[];
  parsedBodies: Array<Record<string, unknown> | null>;
}> {
  const captures: CapturedHttp[] = [];
  const rawBodies: Buffer[] = [];
  const parsedBodies: Array<Record<string, unknown> | null> = [];
  let seq = 0;
  const server: Server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      rawBodies.push(raw);
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      parsedBodies.push(parsed);
      const phase =
        options.caseName === "phases"
          ? seq === 0
            ? "first"
            : seq === 1
              ? "postbrowser"
              : "guard-final"
          : options.caseName;
      captures.push({
        seq,
        caseName: options.caseName,
        phase,
        method: request.method ?? "POST",
        url: request.url ?? "",
        nonAuthHeaders: nonAuthHeaders(request),
        rawSha256: createHash("sha256").update(raw).digest("hex"),
        rawByteLength: raw.byteLength,
        sampling: samplingFromBody(parsed),
        toolNames: toolNamesFromBody(parsed),
      });
      const reply = options.replies[seq];
      seq += 1;
      if (!reply) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "stub exhausted", type: "stub" } }));
        return;
      }
      if (reply.kind === "http-error") {
        response.writeHead(reply.status, { "content-type": "application/json" });
        response.end(reply.body);
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.end(ssePayload(options.modelId, reply.events, reply.finish));
    })().catch(() => response.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    captures,
    rawBodies,
    parsedBodies,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

async function drainRuntime(
  runtime: PiAgentRuntime,
  request: Parameters<PiAgentRuntime["run"]>[0],
): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of runtime.run(request, {
    signal: AbortSignal.timeout(30_000),
  })) {
    events.push(event);
  }
  return events;
}

function syntheticModel(baseUrl: string, modelId: string) {
  return {
    provider: "openai-compatible" as const,
    id: modelId,
    baseUrl,
  };
}

function executeSyntheticTool(name: string, snapshotCount: { value: number }): unknown {
  if (name === "browser_snapshot") {
    snapshotCount.value += 1;
    return oversizedPage(snapshotCount.value);
  }
  if (name === "browser_act") {
    return {
      error: "LOGIN_GUARD refused kind=password rule=default origin=https://capture.example.test",
    };
  }
  return { ok: true, synthetic: true, tool: name };
}

export async function capturePhaseTurn(service: string): Promise<{
  service: string;
  caseName: "phases";
  captures: CapturedHttp[];
  rawBodies: Buffer[];
  parsedBodies: Array<Record<string, unknown> | null>;
  runtimeEvents: unknown[];
  offeredToolNames: string[];
  runtimeOnlyBlocksPresent: Record<keyof typeof RUNTIME_ONLY_PROMPT_BLOCKS, boolean>;
}> {
  const modelId = "qwen3.8-flash-next";
  const tools = offeredToolsForSyntheticCapture();
  const snapshots = { value: 0 };
  const stub = await startCaptureStub({
    modelId,
    caseName: "phases",
    replies: [
      {
        kind: "sse",
        finish: "tool_calls",
        events: toolCallDelta("call_capture_first", "browser_snapshot", {}),
      },
      {
        kind: "sse",
        finish: "tool_calls",
        events: toolCallDelta("call_capture_postbrowser", "browser_act", {
          kind: "fill",
          ref: "e1",
        }),
      },
      {
        kind: "sse",
        finish: "stop",
        events: [{ content: "guard-final: stopped at login guard." }],
      },
    ],
  });
  try {
    const runtimeEvents = await drainRuntime(new PiAgentRuntime(), {
      botId: "bot-synthetic-capture",
      threadId: "thread-synthetic-capture",
      runId: `run-synthetic-phases-${service}`,
      prompt: syntheticUserPrompt(),
      instructions: syntheticTurnInstructions(),
      history: [],
      tools,
      contextStrategy: "current",
      model: syntheticModel(stub.baseUrl, modelId),
      executeTool: async (name) => executeSyntheticTool(name, snapshots),
    });
    const haystack = JSON.stringify(stub.parsedBodies[0] ?? {});
    return {
      service,
      caseName: "phases",
      captures: stub.captures,
      rawBodies: stub.rawBodies,
      parsedBodies: stub.parsedBodies,
      runtimeEvents,
      offeredToolNames: tools.map((tool) => tool.name),
      runtimeOnlyBlocksPresent: {
        groupContext: haystack.includes(RUNTIME_ONLY_PROMPT_BLOCKS.groupContext),
        messagingContext: haystack.includes(RUNTIME_ONLY_PROMPT_BLOCKS.messagingContext),
        redactedMemoryContext: haystack.includes(RUNTIME_ONLY_PROMPT_BLOCKS.redactedMemoryContext),
        redactedScratchpadContext: haystack.includes(
          RUNTIME_ONLY_PROMPT_BLOCKS.redactedScratchpadContext,
        ),
      },
    };
  } finally {
    await stub.close();
  }
}

export async function capturePageTrim(service: string): Promise<{
  service: string;
  captures: CapturedHttp[];
  rawBodies: Buffer[];
  parsedBodies: Array<Record<string, unknown> | null>;
  lastRequestText: string;
  keptPageMarkers: string[];
  trimmedNotePresent: boolean;
  clipped12k: boolean;
}> {
  const modelId = "qwen3.8-flash-next";
  const tools = offeredToolsForSyntheticCapture();
  const snapshots = { value: 0 };
  const replies: StubReply[] = [1, 2, 3, 4].map((index) => ({
    kind: "sse" as const,
    finish: "tool_calls",
    events: toolCallDelta(`call_capture_page_${index}`, "browser_snapshot", {}),
  }));
  replies.push({
    kind: "sse",
    finish: "stop",
    events: [{ content: "page-trim: last-3 kept." }],
  });
  const stub = await startCaptureStub({ modelId, caseName: "page-trim", replies });
  try {
    await drainRuntime(new PiAgentRuntime(), {
      botId: "bot-synthetic-capture",
      threadId: "thread-synthetic-capture",
      runId: `run-synthetic-pagetrim-${service}`,
      prompt: syntheticUserPrompt(),
      instructions: syntheticTurnInstructions(),
      history: [],
      tools,
      contextStrategy: "current",
      model: syntheticModel(stub.baseUrl, modelId),
      executeTool: async (name) => executeSyntheticTool(name, snapshots),
    });
    const last = stub.parsedBodies.at(-1);
    const lastRequestText = JSON.stringify(last ?? {});
    const keptPageMarkers = ["BEGIN_PAGE_2_", "BEGIN_PAGE_3_", "BEGIN_PAGE_4_"].filter((marker) =>
      lastRequestText.includes(marker),
    );
    const firstKept = lastRequestText.includes("BEGIN_PAGE_1_");
    return {
      service,
      captures: stub.captures,
      rawBodies: stub.rawBodies,
      parsedBodies: stub.parsedBodies,
      lastRequestText,
      keptPageMarkers,
      trimmedNotePresent: lastRequestText.includes(STALE_PAGE_STATE_NOTE) && !firstKept,
      clipped12k: lastRequestText.includes(`${"x".repeat(32)}…`),
    };
  } finally {
    await stub.close();
  }
}

export async function captureCompactionPass(service: string): Promise<{
  service: string;
  model: ReturnType<typeof syntheticModel>;
  params: SamplingRecord;
  input: { prompt: string; instructions: string };
  stubOutput: string;
  capture: CapturedHttp | undefined;
  rawBody: Buffer | undefined;
}> {
  const modelId = "qwen3.8-flash-next";
  const transcript = "user: synthetic capture transcript\n\nassistant: noted the synthetic fact";
  const prompt = compactionSummarizerPrompt(transcript, null);
  const instructions = compactionSummarizerInstructions(captureClock());
  const stub = await startCaptureStub({
    modelId,
    caseName: "compaction",
    replies: [
      {
        kind: "sse",
        finish: "stop",
        events: [{ content: "synthetic compacted summary: one fact noted." }],
      },
    ],
  });
  const model = syntheticModel(stub.baseUrl, modelId);
  try {
    await drainRuntime(new PiAgentRuntime(), {
      botId: "bot-synthetic-capture",
      threadId: "thread-synthetic-capture",
      runId: `compact:thread-synthetic-capture:-1`,
      usageOperationKind: "compaction",
      prompt,
      instructions,
      history: [],
      tools: [],
      allowSilentEmpty: true,
      model,
    });
    return {
      service,
      model,
      params: stub.captures[0]?.sampling ?? samplingFromBody(null),
      input: { prompt, instructions },
      stubOutput: "synthetic compacted summary: one fact noted.",
      capture: stub.captures[0],
      rawBody: stub.rawBodies[0],
    };
  } finally {
    await stub.close();
  }
}

const IDENTICAL_ERROR_BODY = JSON.stringify({
  error: { message: "synthetic-identical-error", type: "fixture_error" },
});

export async function captureParserGuardCases(service: string): Promise<{
  service: string;
  validcall: { captures: CapturedHttp[]; parsedNames: string[] };
  malformed: { captures: CapturedHttp[]; guardDroppedNameless: boolean };
  twoCalls: { captures: CapturedHttp[]; parsedNames: string[] };
  fourIdenticalErrorsThenSuccess: { captures: CapturedHttp[]; recovered: boolean };
}> {
  const echo: ConnectorTool = {
    name: "browser_snapshot",
    description: "Synthetic snapshot",
    inputSchema: { type: "object", properties: {} },
  };
  const valid = await runParserCase(
    service,
    "validcall",
    [echo],
    [
      {
        kind: "sse",
        finish: "tool_calls",
        events: toolCallDelta("call_valid", "browser_snapshot", {}),
      },
      { kind: "sse", finish: "stop", events: [{ content: "validcall-ok" }] },
    ],
  );
  const malformed = await runParserCase(
    service,
    "malformed",
    [echo],
    [
      {
        kind: "sse",
        finish: "tool_calls",
        events: [
          {
            tool_calls: [
              {
                index: 0,
                id: "call_malformed",
                type: "function",
                function: { name: "", arguments: "{}" },
              },
            ],
          },
        ],
      },
      { kind: "sse", finish: "stop", events: [{ content: "malformed-continued" }] },
    ],
  );
  const two = await runParserCase(
    service,
    "two-calls",
    [echo],
    [
      {
        kind: "sse",
        finish: "tool_calls",
        events: [
          ...toolCallDelta("call_two_a", "browser_snapshot", { page: 1 }, 0),
          ...toolCallDelta("call_two_b", "browser_snapshot", { page: 2 }, 1),
        ],
      },
      { kind: "sse", finish: "stop", events: [{ content: "two-calls-ok" }] },
    ],
  );
  const previousRetries = process.env.MODEL_STREAM_MAX_RETRIES;
  process.env.MODEL_STREAM_MAX_RETRIES = "5";
  let errorsThenSuccess: Awaited<ReturnType<typeof runParserCase>>;
  try {
    errorsThenSuccess = await runParserCase(
      service,
      "four-errors-then-success",
      [echo],
      [
        ...Array.from({ length: 4 }, () => ({
          kind: "http-error" as const,
          status: 500,
          body: IDENTICAL_ERROR_BODY,
        })),
        {
          kind: "sse" as const,
          finish: "stop",
          events: [{ content: "recovered-after-identical-errors" }],
        },
      ],
    );
  } finally {
    if (previousRetries === undefined) delete process.env.MODEL_STREAM_MAX_RETRIES;
    else process.env.MODEL_STREAM_MAX_RETRIES = previousRetries;
  }

  const namelessTranscript = withoutNamelessToolCalls([
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_malformed", name: "", arguments: {} }],
    } as Message,
  ]);

  return {
    service,
    validcall: {
      captures: valid.captures,
      parsedNames: toolNamesFromAssistant(valid.parsedBodies),
    },
    malformed: {
      captures: malformed.captures,
      guardDroppedNameless: namelessTranscript.every(
        (message) =>
          message.role !== "assistant" ||
          !(message.content ?? []).some(
            (part) =>
              part &&
              typeof part === "object" &&
              "type" in part &&
              part.type === "toolCall" &&
              "name" in part &&
              !String(part.name ?? "").trim(),
          ),
      ),
    },
    twoCalls: {
      captures: two.captures,
      parsedNames: toolNamesFromAssistant(two.parsedBodies),
    },
    fourIdenticalErrorsThenSuccess: {
      captures: errorsThenSuccess.captures,
      recovered:
        errorsThenSuccess.captures.some((row) => row.seq === 4) &&
        JSON.stringify(errorsThenSuccess.parsedBodies.at(-1) ?? {}).length > 0,
    },
  };
}

function toolNamesFromAssistant(bodies: Array<Record<string, unknown> | null>): string[] {
  const names: string[] = [];
  for (const body of bodies) {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    for (const message of messages) {
      if (!message || typeof message !== "object") continue;
      const calls = (message as { tool_calls?: Array<{ function?: { name?: string } }> })
        .tool_calls;
      if (!Array.isArray(calls)) continue;
      for (const call of calls) {
        if (call.function?.name) names.push(call.function.name);
      }
    }
  }
  return names;
}

async function runParserCase(
  service: string,
  caseName: string,
  tools: ConnectorTool[],
  replies: StubReply[],
) {
  const modelId = "qwen3.8-flash-next";
  const snapshots = { value: 0 };
  const stub = await startCaptureStub({ modelId, caseName, replies });
  try {
    try {
      await drainRuntime(new PiAgentRuntime(), {
        botId: "bot-synthetic-capture",
        threadId: "thread-synthetic-capture",
        runId: `run-synthetic-${caseName}-${service}`,
        prompt: "Synthetic parser-guard case.",
        instructions: "Synthetic parser-guard.",
        history: [],
        tools,
        contextStrategy: "current",
        allowSilentEmpty: true,
        model: syntheticModel(stub.baseUrl, modelId),
        executeTool: async (name) => executeSyntheticTool(name, snapshots),
      });
    } catch {
      // Parser/retry failures are recorded via stub captures.
    }
    return {
      captures: stub.captures,
      parsedBodies: stub.parsedBodies,
      rawBodies: stub.rawBodies,
    };
  } finally {
    await stub.close();
  }
}

export function pinPiAiVersion(): string | null {
  try {
    const adaptersPkg = require("../package.json") as { dependencies?: Record<string, string> };
    const declared = adaptersPkg.dependencies?.["@earendil-works/pi-ai"];
    if (typeof declared === "string" && declared.length > 0) return declared;
  } catch {
    // fall through to the installed package
  }
  try {
    const pkg = require("@earendil-works/pi-ai/package.json") as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

export function pinToolCallGuardHash(): { path: string; sha256: string } {
  const path = fileURLToPath(new URL("./pi-tool-call-guard.ts", import.meta.url));
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  return { path, sha256 };
}

export function gitSha(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: join(fileURLToPath(new URL(".", import.meta.url)), "../../.."),
      encoding: "utf8",
    }).trim();
  } catch {
    return process.env.RAKAZO_GIT_SHA?.trim() || null;
  }
}

export function secretStoreCapabilityReport(): {
  interfaceMethods: string[];
  env: { SECRET_STORE: "set" | "unset"; ENCRYPTION_KEY: "present" | "absent" };
  productionPath: string;
  didMutate: false;
} {
  return {
    interfaceMethods: ["describe", "put", "load", "delete", "redact"],
    env: {
      SECRET_STORE: process.env.SECRET_STORE?.trim() ? "set" : "unset",
      ENCRYPTION_KEY: process.env.ENCRYPTION_KEY?.trim() ? "present" : "absent",
    },
    productionPath:
      "SecretStore.put returns an opaque ref; protectPersistedEffectResult stores protectedVaultRef on existing externalEffect.result. Missing SecretStore is PROTECTED_RESULT_VAULT fail-closed. This check does not put, load, delete, or print secrets.",
    didMutate: false,
  };
}

export function collectProvenance(service: string): Record<string, unknown> {
  return {
    kind: ISOLATED_CAPTURE_KIND,
    service,
    gitSha: gitSha(),
    piAiParserVersion: pinPiAiVersion(),
    piToolCallGuard: pinToolCallGuardHash(),
    imageDigests: {
      api: process.env.RAKAZO_API_IMAGE_DIGEST ?? null,
      worker: process.env.RAKAZO_WORKER_IMAGE_DIGEST ?? null,
      commands: [
        "docker inspect --format '{{index .RepoDigests 0}}' \"$RAKAZO_API_IMAGE\"",
        "docker inspect --format '{{index .RepoDigests 0}}' \"$RAKAZO_WORKER_IMAGE\"",
      ],
    },
    captureClock: captureClock().toISOString(),
    thinkingEnvObserved: {
      RAKAZO_THINKING_BUDGET: process.env.RAKAZO_THINKING_BUDGET ?? null,
      RAKAZO_THINKING_BUDGET_MODELS: process.env.RAKAZO_THINKING_BUDGET_MODELS ?? null,
      RAKAZO_FAST_COMPUTER_STEPS: process.env.RAKAZO_FAST_COMPUTER_STEPS ?? null,
      RAKAZO_OPENAI_COMPAT_CHAT_TEMPLATE_KWARGS:
        process.env.RAKAZO_OPENAI_COMPAT_CHAT_TEMPLATE_KWARGS ?? null,
    },
    limits: captureCallLimits(process.env),
    builtinToolCount: builtinAgentTools.length,
    gx10Calls: 0,
    network: "127.0.0.1-stub-only",
    volatileFields: VOLATILE_FIELDS,
    historicalExactRequests: "unavailable-unverified-not-a-baseline-blocker",
  };
}

function writeBinAndJson(
  dir: string,
  name: string,
  capture: CapturedHttp,
  raw: Buffer,
  parsed: Record<string, unknown> | null,
) {
  writeFileSync(join(dir, `${name}.bin`), raw);
  writeFileSync(
    join(dir, `${name}.json`),
    `${JSON.stringify({ ...capture, parsedBody: parsed }, null, 2)}\n`,
  );
}

export async function runIsolatedCapture(options: {
  outDir: string;
  service: string;
}): Promise<{ outDir: string; hashManifest: Record<string, string> }> {
  const outDir = options.outDir;
  mkdirSync(outDir, { recursive: true });
  const phases = await capturePhaseTurn(options.service);
  const pageTrim = await capturePageTrim(options.service);
  const compaction = await captureCompactionPass(options.service);
  const parserGuard = await captureParserGuardCases(options.service);

  const phaseDir = join(outDir, "phases");
  mkdirSync(phaseDir, { recursive: true });
  for (const [index, capture] of phases.captures.entries()) {
    writeBinAndJson(
      phaseDir,
      `${capture.phase}-${index}`,
      capture,
      phases.rawBodies[index]!,
      phases.parsedBodies[index] ?? null,
    );
  }

  const trimDir = join(outDir, "page-trim");
  mkdirSync(trimDir, { recursive: true });
  for (const [index, capture] of pageTrim.captures.entries()) {
    writeBinAndJson(
      trimDir,
      `step-${index}`,
      capture,
      pageTrim.rawBodies[index]!,
      pageTrim.parsedBodies[index] ?? null,
    );
  }
  writeFileSync(
    join(trimDir, "summary.json"),
    `${JSON.stringify(
      {
        keptPageMarkers: pageTrim.keptPageMarkers,
        trimmedNotePresent: pageTrim.trimmedNotePresent,
        clipped12k: pageTrim.clipped12k,
        toolResultTextLimit: TOOL_RESULT_TEXT_LIMIT,
      },
      null,
      2,
    )}\n`,
  );

  const compactDir = join(outDir, "compaction");
  mkdirSync(compactDir, { recursive: true });
  if (compaction.capture && compaction.rawBody) {
    writeBinAndJson(compactDir, "pass", compaction.capture, compaction.rawBody, null);
  }
  writeFileSync(
    join(compactDir, "record.json"),
    `${JSON.stringify(
      {
        model: compaction.model,
        params: compaction.params,
        input: compaction.input,
        stubOutput: compaction.stubOutput,
      },
      null,
      2,
    )}\n`,
  );

  writeFileSync(join(outDir, "parser-guard.json"), `${JSON.stringify(parserGuard, null, 2)}\n`);
  writeFileSync(
    join(outDir, "phases-summary.json"),
    `${JSON.stringify(
      {
        offeredToolNames: phases.offeredToolNames,
        runtimeOnlyBlocksPresent: phases.runtimeOnlyBlocksPresent,
        samplingByPhase: Object.fromEntries(
          phases.captures.map((capture) => [capture.phase, capture.sampling]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(outDir, "provenance.json"),
    `${JSON.stringify(collectProvenance(options.service), null, 2)}\n`,
  );
  writeFileSync(
    join(outDir, "secret-store-capability.json"),
    `${JSON.stringify(secretStoreCapabilityReport(), null, 2)}\n`,
  );
  writeFileSync(
    join(outDir, "stub-config.json"),
    `${JSON.stringify(
      {
        listen: "127.0.0.1",
        path: "/v1/chat/completions",
        gx10: false,
        browserWrites: false,
        dbWrites: false,
        realChat: false,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(outDir, "volatile-fields.json"),
    `${JSON.stringify({ fields: VOLATILE_FIELDS }, null, 2)}\n`,
  );
  writeFileSync(
    join(outDir, "historical-unverified.md"),
    [
      "# Historical exact requests (not a baseline blocker)",
      "",
      "Production raw request bytes from prior live turns are unavailable in this checkout.",
      "Deployed-code synthetic capture is the accepted baseline.",
      "This file is an unverified explanation, not a capture artifact to byte-diff.",
      "",
    ].join("\n"),
  );

  const hashManifest: Record<string, string> = {};
  hashTree(outDir, outDir, hashManifest);
  writeFileSync(join(outDir, "HASHMANIFEST.tsv"), renderManifest(hashManifest));
  return { outDir, hashManifest };
}

function hashTree(root: string, dir: string, into: Record<string, string>) {
  for (const entry of readdirSync(dir)) {
    if (entry === "HASHMANIFEST.tsv") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) hashTree(root, full, into);
    else
      into[full.slice(root.length + 1)] = createHash("sha256")
        .update(readFileSync(full))
        .digest("hex");
  }
}

function renderManifest(manifest: Record<string, string>): string {
  return `${Object.entries(manifest)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, hash]) => `${hash}  ${file}`)
    .join("\n")}\n`;
}

export async function runIsolatedCaptureCli(argv: string[]): Promise<void> {
  const outFlag = argv.indexOf("--out");
  const serviceFlag = argv.indexOf("--service");
  const outDir = outFlag >= 0 ? argv[outFlag + 1] : undefined;
  const service = serviceFlag >= 0 ? argv[serviceFlag + 1] : process.env.ISOLATED_CAPTURE_SERVICE;
  if (!outDir || !service) {
    throw new Error("usage: isolated-capture --service worker|api|this-tree --out DIR");
  }
  const result = await runIsolatedCapture({ outDir, service });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result, gx10Calls: 0 }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runIsolatedCaptureCli(process.argv.slice(2));
}
