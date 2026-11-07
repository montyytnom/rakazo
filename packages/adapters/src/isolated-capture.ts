import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import type { AdapterContext, ConnectorTool } from "@rakazo/adapter-kit";
import { formatSkillsCatalogInstruction, type SkillCatalogEntry } from "@rakazo/core";
import { builtinAgentTools } from "./builtin-tools.js";
import { ConnectorRegistry } from "./composio-connector.js";
import { formatCurrentTimeInstruction } from "./current-time.js";
import { DestinationEmulator } from "./destination-emulator.js";
import * as executorApi from "./executor.js";
import {
  longWorkProgressGuidance,
  offeredFleetTools,
  persistentComputerInstruction,
  selectBuiltinToolsForRun,
  userTurnInstructions,
} from "./executor.js";
import { PiAgentRuntime } from "./pi-runtime.js";
import {
  MODEL_STREAM_IDLE_TIMEOUT_MS,
  MODEL_STREAM_TIMEOUT_MS,
  TOOL_RESULT_TEXT_LIMIT,
} from "./pi-runtime-limits.js";
import { withoutNamelessToolCalls } from "./pi-tool-call-guard.js";
import { TASK_CATALOG_GUIDANCE } from "./task-catalog.js";

const require = createRequire(import.meta.url);

export const ISOLATED_CAPTURE_KIND = "deployed-code-synthetic-http";
export const STALE_PAGE_STATE_NOTE =
  "[Earlier page state trimmed to save context. Facts you still need from that page should already be in your notes or tracker; otherwise take a fresh snapshot.]";
export const OVERSIZED_PAGE_CHARS = 40_000;
export const CAPTURE_CLOCK_DEFAULT = "2026-11-07T00:00:00.000Z";

function captureCallLimits(env: NodeJS.ProcessEnv = process.env): {
  envSource: "isolated-capture";
  productionFaithful: false;
  thinking: {
    budget: string | null;
    models: string | null;
    fastComputerSteps: string | null;
    unchanged: true;
  };
  maxTokensDefault: number;
  parallelToolCalls: null;
  streamTimeoutMs: number;
  streamIdleTimeoutMs: number;
  maxToolCallsPerTurn: string | null;
} {
  return {
    envSource: "isolated-capture",
    productionFaithful: false,
    thinking: {
      budget: env.RAKAZO_THINKING_BUDGET ?? null,
      models: env.RAKAZO_THINKING_BUDGET_MODELS ?? null,
      fastComputerSteps: env.RAKAZO_FAST_COMPUTER_STEPS ?? null,
      unchanged: true,
    },
    maxTokensDefault: 32768,
    parallelToolCalls: null,
    streamTimeoutMs: Number(env.RAKAZO_MODEL_STREAM_TIMEOUT_MS) || MODEL_STREAM_TIMEOUT_MS,
    streamIdleTimeoutMs:
      Number(env.RAKAZO_MODEL_STREAM_IDLE_TIMEOUT_MS) || MODEL_STREAM_IDLE_TIMEOUT_MS,
    maxToolCallsPerTurn: env.MAX_TOOL_CALLS_PER_TURN ?? null,
  };
}

/** Volatile fields the byte-diff replay may exclude. The rest of the body must match. */
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

export const REVIEWER_EXPECTED_WORKER_BUILTINS = 74;

/** Synthetic fixtures for real assemblers. Not live directory, skills, or secrets. */
export const SYNTHETIC_SKILL_CATALOG: SkillCatalogEntry[] = [
  {
    name: "synthetic-capture-skill",
    description: "Synthetic capture fixture skill. No live account.",
    source: "user",
    readOnly: false,
  },
];

export const SYNTHETIC_BOTDIR_SELF_ID = "bot-synthetic-capture";
export const SYNTHETIC_BOTDIR_PEERS = [
  {
    id: SYNTHETIC_BOTDIR_SELF_ID,
    name: "synthetic-self",
    title: "",
    description: "Synthetic capture bot. No live account.",
    mcpServers: [] as { server: { slug: string; name: string; enabled: boolean } }[],
    botSecrets: [] as { name: string; origin: string }[],
  },
  {
    id: "bot-synthetic-peer",
    name: "synthetic-peer",
    title: "",
    description: "Synthetic peer bot for the directory renderer. No live account.",
    mcpServers: [] as { server: { slug: string; name: string; enabled: boolean } }[],
    botSecrets: [] as { name: string; origin: string }[],
  },
];

export type NamedBlock = {
  name: string;
  required: boolean;
  present: boolean;
  sha256: string | null;
  charLength: number;
  source: string;
};

function hashText(
  text: string | undefined | null,
): Pick<NamedBlock, "present" | "sha256" | "charLength"> {
  if (text == null || text.length === 0) {
    return { present: false, sha256: null, charLength: 0 };
  }
  return {
    present: true,
    sha256: createHash("sha256").update(text).digest("hex"),
    charLength: text.length,
  };
}

function envFlag(name: string): boolean | undefined {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (raw === "0" || raw.toLowerCase() === "false") return false;
  return true;
}

export const SAMPLING_KEYS = [
  "temperature",
  "top_p",
  "top_k",
  "thinking_budget",
  "enable_thinking",
  "medium_effort",
  "max_tokens",
  "max_completion_tokens",
] as const;

const CHAT_TEMPLATE_KWARGS_KNOWN_FIELDS = ["enable_thinking", "medium_effort"] as const;

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

export function deriveAssemblerInputs() {
  return {
    trigger: "user" as const,
    groupId: null as string | null,
    graphical: true,
    graphicalToolsAllowed: true,
    pageBrowserAllowed: true,
    heldForTakeover: false,
    historyRetrievalEnabled: true,
    ticketBoardEnabled: envFlag("RAKAZO_TICKET_BOARD") ?? false,
    phoneCallsEnabled: envFlag("RAKAZO_PHONE_CALLS") ?? false,
    semanticMemoryEnabled: envFlag("RAKAZO_SEMANTIC_MEMORY") ?? false,
    cloudAgentEnabled: envFlag("RAKAZO_CLOUD_AGENT") ?? false,
    mediaImagesEnabled: false,
    mediaVideoEnabled: false,
    messagingChannelRun: false,
    voiceCall: false,
    fleetManagement: false,
    followUpFromUser: true,
    disabledBuiltinTools: [] as string[],
    connectorRegistry: "empty" as const,
  };
}

function syntheticAdapterContext(): AdapterContext {
  return {
    operationId: "run-synthetic-capture",
    traceId: "run-synthetic-capture",
    spaceId: "space-synthetic-capture",
    userId: "user-synthetic-capture",
    botId: SYNTHETIC_BOTDIR_SELF_ID,
    runId: "run-synthetic-capture",
    signal: AbortSignal.timeout(5_000),
  };
}

/** Empty connector registry through ConnectorRegistry.discoverTools. Network-off. */
export async function discoverEmptyConnectorTools(): Promise<{
  tools: ConnectorTool[];
  source: string;
  missingConnectors: string[];
}> {
  const destination = new DestinationEmulator();
  destination.discoverTools = async () => [];
  const registry = new ConnectorRegistry(destination, []);
  const tools = await registry.discoverTools(syntheticAdapterContext());
  return {
    tools,
    source: "ConnectorRegistry.discoverTools",
    missingConnectors: [
      "composio (not constructed, network-off)",
      "pipedream (not constructed, network-off)",
      "mcp (not constructed, network-off)",
      "installed capabilityInstall rows (empty registry, network-off)",
    ],
  };
}

export async function offeredToolsFromDeployedBuilder(): Promise<{
  tools: ConnectorTool[];
  builtinCatalogNames: string[];
  builtinCatalogCount: number;
  offeredBuiltinNames: string[];
  offeredBuiltinCount: number;
  withheldBuiltinNames: string[];
  connectorTools: ConnectorTool[];
  reviewerExpectedWorkerBuiltins: number;
  reviewerCountMatch: boolean;
  missingConnectors: string[];
  missingDynamicResolution: string[];
  assemblerInputs: ReturnType<typeof deriveAssemblerInputs>;
}> {
  const assemblerInputs = deriveAssemblerInputs();
  const builtins = selectBuiltinToolsForRun({
    ticketBoardEnabled: assemblerInputs.ticketBoardEnabled,
    phoneCallsEnabled: assemblerInputs.phoneCallsEnabled,
    historyRetrievalEnabled: assemblerInputs.historyRetrievalEnabled,
    graphicalToolsAllowed: assemblerInputs.graphicalToolsAllowed,
    pageBrowserAllowed: assemblerInputs.pageBrowserAllowed,
    groupId: assemblerInputs.groupId,
    trigger: assemblerInputs.trigger,
    semanticMemoryEnabled: assemblerInputs.semanticMemoryEnabled,
    cloudAgentEnabled: assemblerInputs.cloudAgentEnabled,
    mediaImagesEnabled: assemblerInputs.mediaImagesEnabled,
    mediaVideoEnabled: assemblerInputs.mediaVideoEnabled,
    messagingChannelRun: assemblerInputs.messagingChannelRun,
    voiceCall: assemblerInputs.voiceCall,
    fleetManagement: assemblerInputs.fleetManagement,
    followUpFromUser: assemblerInputs.followUpFromUser,
    disabledBuiltinTools: assemblerInputs.disabledBuiltinTools,
  });
  const connector = await discoverEmptyConnectorTools();
  const builtinNames = new Set(builtinAgentTools.map((tool) => tool.name));
  const exposedConnectorTools = connector.tools.filter((tool) => !builtinNames.has(tool.name));
  const tools = [...builtins, ...exposedConnectorTools];
  const offeredBuiltinNames = builtins.map((tool) => tool.name);
  const offeredSet = new Set(offeredBuiltinNames);
  return {
    tools,
    builtinCatalogNames: builtinAgentTools.map((tool) => tool.name),
    builtinCatalogCount: builtinAgentTools.length,
    offeredBuiltinNames,
    offeredBuiltinCount: builtins.length,
    withheldBuiltinNames: builtinAgentTools
      .map((tool) => tool.name)
      .filter((name) => !offeredSet.has(name)),
    connectorTools: exposedConnectorTools,
    reviewerExpectedWorkerBuiltins: REVIEWER_EXPECTED_WORKER_BUILTINS,
    reviewerCountMatch: builtins.length === REVIEWER_EXPECTED_WORKER_BUILTINS,
    missingConnectors: connector.missingConnectors,
    missingDynamicResolution: [
      `${connector.source} empty registry (network-off)`,
      "agentConnectionTools (no live messaging identity)",
      "generate_image/generate_video (no live media provider)",
      "hostInstruction (no live sandbox.environment)",
      "dockerComputerToolInstruction (no live computerKind; omitted rather than guessed)",
    ],
    assemblerInputs,
  };
}

/** @deprecated use offeredToolsFromDeployedBuilder */
export async function offeredToolsForSyntheticCapture(): Promise<ConnectorTool[]> {
  return (await offeredToolsFromDeployedBuilder()).tools;
}

async function renderBotDirectoryBlock(): Promise<{
  text: string | undefined;
  source: string;
}> {
  try {
    const mod = (await import(new URL("./botdir.js", import.meta.url).href)) as {
      renderBotCapabilityDirectory?: (
        peers: typeof SYNTHETIC_BOTDIR_PEERS,
        selfId: string,
      ) => string | undefined;
    };
    if (typeof mod.renderBotCapabilityDirectory !== "function") {
      return { text: undefined, source: "botdir-present-without-renderer" };
    }
    return {
      text: mod.renderBotCapabilityDirectory(SYNTHETIC_BOTDIR_PEERS, SYNTHETIC_BOTDIR_SELF_ID),
      source: "renderBotCapabilityDirectory",
    };
  } catch {
    return { text: undefined, source: "botdir-module-absent" };
  }
}

function namedBlock(
  name: string,
  required: boolean,
  source: string,
  text: string | undefined | null,
): NamedBlock {
  return { name, required, source, ...hashText(text) };
}

export async function assembleCapturePrompt(): Promise<{
  instructions: string;
  prompt: string;
  tools: ConnectorTool[];
  blocks: NamedBlock[];
  namedBlocks: NamedBlock[];
  additionalEmitted: NamedBlock[];
  toolInventory: Awaited<ReturnType<typeof offeredToolsFromDeployedBuilder>>;
  computerInstruction: string;
  botDirectory: string | undefined;
  skillsLine: string | undefined;
  longWork: string;
}> {
  const toolInventory = await offeredToolsFromDeployedBuilder();
  const computerInstruction = persistentComputerInstruction({
    heldForTakeover: false,
    graphicalToolsAllowed: true,
    graphical: true,
  });
  const longWork = longWorkProgressGuidance();
  const skillsLine = formatSkillsCatalogInstruction(SYNTHETIC_SKILL_CATALOG);
  const botdir = await renderBotDirectoryBlock();
  const taskCatalogInstruction = toolInventory.tools.some((tool) => tool.name === "task_catalog")
    ? TASK_CATALOG_GUIDANCE
    : undefined;
  const parts = {
    botInstructions: "Synthetic capture bot. No live chat.",
    groupContext: undefined as string | undefined,
    messagingContext: undefined as string | undefined,
    redactedMemoryContext: undefined as string | undefined,
    redactedScratchpadContext: undefined as string | undefined,
    redactedTicketContext: undefined as string | undefined,
    hasHistoricalContext: false,
    historyRetrievalEnabled: toolInventory.assemblerInputs.historyRetrievalEnabled,
    computerInstruction,
    pageBrowserAllowed: true,
    taskCatalogInstruction,
    workspaceInstruction:
      "This entire computer workspace is your private home. Relative file paths and shell working directories start at its root.",
    agentEnvironmentInstruction: undefined as string | undefined,
    botDirectory: botdir.text,
    pluginLine: "No plugins are connected yet.",
    agentSkillsLine: skillsLine,
    taughtSkillsLine: undefined as string | undefined,
    replyGuidance: longWork,
    offeredFleetTools: offeredFleetTools(toolInventory.tools),
  };
  const userPrompt = syntheticUserPrompt();
  const splitFn = (
    executorApi as {
      assistSplitInstructions?: (
        prompt: string,
        parts: Parameters<typeof userTurnInstructions>[0],
      ) => { instructions: string; prompt: string };
    }
  ).assistSplitInstructions;
  let instructions: string;
  let prompt: string;
  if (typeof splitFn === "function") {
    const split = splitFn(userPrompt, parts);
    instructions = split.instructions;
    prompt = split.prompt;
  } else {
    instructions = userTurnInstructions(parts)
      .filter((part): part is string => Boolean(part))
      .join("\n\n");
    prompt = userPrompt;
  }
  const required: NamedBlock[] = [
    namedBlock(
      "baseComputerInstruction",
      true,
      "persistentComputerInstruction",
      computerInstruction,
    ),
    namedBlock("renderBotCapabilityDirectory", true, botdir.source, botdir.text),
    namedBlock(
      "formatSkillsCatalogInstruction",
      true,
      "formatSkillsCatalogInstruction",
      skillsLine,
    ),
    namedBlock("longWorkProgressGuidance", true, "longWorkProgressGuidance()", longWork),
  ];
  const additionalEmitted: NamedBlock[] = [
    namedBlock("groupContext", false, "userTurnInstructions-volatile", parts.groupContext),
    namedBlock("messagingContext", false, "userTurnInstructions-volatile", parts.messagingContext),
    namedBlock(
      "redactedMemoryContext",
      false,
      "userTurnInstructions-volatile",
      parts.redactedMemoryContext,
    ),
    namedBlock(
      "redactedScratchpadContext",
      false,
      "userTurnInstructions-volatile",
      parts.redactedScratchpadContext,
    ),
    namedBlock(
      "redactedTicketContext",
      false,
      "userTurnInstructions-volatile",
      parts.redactedTicketContext,
    ),
  ];
  const namedBlocks: NamedBlock[] = [
    ...required,
    ...additionalEmitted,
    namedBlock("botInstructions", false, "assembleCapturePrompt", parts.botInstructions),
    namedBlock("workspaceInstruction", false, "assembleCapturePrompt", parts.workspaceInstruction),
    namedBlock("pluginLine", false, "assembleCapturePrompt", parts.pluginLine),
    namedBlock(
      "taskCatalogInstruction",
      false,
      "TASK_CATALOG_GUIDANCE",
      parts.taskCatalogInstruction,
    ),
    namedBlock(
      "agentEnvironmentInstruction",
      false,
      "assembleCapturePrompt",
      parts.agentEnvironmentInstruction,
    ),
    namedBlock("taughtSkillsLine", false, "assembleCapturePrompt", parts.taughtSkillsLine),
    namedBlock(
      "assembledInstructions",
      false,
      "assistSplitInstructions|userTurnInstructions",
      instructions,
    ),
    namedBlock("assembledPrompt", false, "assistSplitInstructions|syntheticUserPrompt", prompt),
  ];
  return {
    instructions,
    prompt,
    tools: toolInventory.tools,
    blocks: required,
    namedBlocks,
    additionalEmitted,
    toolInventory,
    computerInstruction,
    botDirectory: botdir.text,
    skillsLine,
    longWork,
  };
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
    if (key === "enable_thinking" || key === "medium_effort") {
      if (kwargs && key in kwargs) included[key] = kwargs[key];
      else omitted.push(key);
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

function requestBodyText(body: Record<string, unknown> | null): string {
  if (!body) return "";
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const parts: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") parts.push(content);
    else if (content != null) parts.push(JSON.stringify(content));
  }
  return parts.join("\n");
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
  blocks: NamedBlock[];
  namedBlocks: NamedBlock[];
  additionalEmitted: NamedBlock[];
  toolInventory: Awaited<ReturnType<typeof offeredToolsFromDeployedBuilder>>;
  assembledInHttp: Record<string, boolean>;
}> {
  const modelId = "qwen3.8-flash-next";
  const assembled = await assembleCapturePrompt();
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
      prompt: assembled.prompt,
      instructions: assembled.instructions,
      history: [],
      tools: assembled.tools,
      contextStrategy: "current",
      model: syntheticModel(stub.baseUrl, modelId),
      executeTool: async (name) => executeSyntheticTool(name, snapshots),
    });
    const haystack = requestBodyText(stub.parsedBodies[0] ?? null);
    const snippet = {
      baseComputerInstruction: assembled.computerInstruction,
      longWorkProgressGuidance: assembled.longWork,
      formatSkillsCatalogInstruction: assembled.skillsLine ?? "",
      renderBotCapabilityDirectory: assembled.botDirectory ?? "",
    };
    const assembledInHttp: Record<string, boolean> = {};
    for (const block of assembled.blocks) {
      const text = snippet[block.name as keyof typeof snippet] ?? "";
      assembledInHttp[block.name] = block.present && text.length > 0 && haystack.includes(text);
    }
    return {
      service,
      caseName: "phases",
      captures: stub.captures,
      rawBodies: stub.rawBodies,
      parsedBodies: stub.parsedBodies,
      runtimeEvents,
      offeredToolNames: assembled.tools.map((tool) => tool.name),
      blocks: assembled.blocks,
      namedBlocks: assembled.namedBlocks,
      additionalEmitted: assembled.additionalEmitted,
      toolInventory: assembled.toolInventory,
      assembledInHttp,
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
  const assembled = await assembleCapturePrompt();
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
      prompt: assembled.prompt,
      instructions: assembled.instructions,
      history: [],
      tools: assembled.tools,
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

export type CompactionCaptureResult = {
  service: string;
  gate: "unmet";
  matched: false;
  deployedBoundary: "compactHistory";
  reason: string;
};

export async function captureCompactionPass(service: string): Promise<CompactionCaptureResult> {
  return {
    service,
    gate: "unmet",
    matched: false,
    deployedBoundary: "compactHistory",
    reason:
      "Deployed compaction is compactHistory(deps, threadId) in history-compaction.ts (overlay uses ctxmemSummaryInstructions plus prisma thread rows, recordUsage, and the job publisher). isolated-capture does not import that module and does not wrap that boundary with mocked job/DB adapters only. An inlined summarizer prompt is not a matched serializer baseline. The three /v1/chat/completions phases remain the byte-diff target. Compaction is unresolved.",
  };
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
      chatTemplateKwargsTyped: typedChatTemplateKwargs(
        process.env.RAKAZO_OPENAI_COMPAT_CHAT_TEMPLATE_KWARGS,
      ),
    },
    limits: captureCallLimits(process.env),
    builtinToolCount: builtinAgentTools.length,
    gx10Calls: 0,
    network: "127.0.0.1-stub-only",
    volatileFields: VOLATILE_FIELDS,
    historicalExactRequests: "unavailable-unverified-not-a-baseline-blocker",
  };
}

function typedChatTemplateKwargs(raw: string | undefined): {
  present: boolean;
  enable_thinking: boolean | null;
  medium_effort: boolean | null;
  unexplainedKeys: string[];
} {
  const empty = {
    present: false,
    enable_thinking: null as boolean | null,
    medium_effort: null as boolean | null,
    unexplainedKeys: [] as string[],
  };
  if (!raw?.trim()) return empty;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...empty, present: true, unexplainedKeys: ["<non-object>"] };
    }
    const record = parsed as Record<string, unknown>;
    const known = new Set<string>(CHAT_TEMPLATE_KWARGS_KNOWN_FIELDS);
    const unexplainedKeys = Object.keys(record).filter((key) => !known.has(key));
    return {
      present: true,
      enable_thinking: typeof record.enable_thinking === "boolean" ? record.enable_thinking : null,
      medium_effort: typeof record.medium_effort === "boolean" ? record.medium_effort : null,
      unexplainedKeys,
    };
  } catch {
    return { ...empty, present: true, unexplainedKeys: ["<invalid-json>"] };
  }
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
  writeFileSync(join(compactDir, "unmet.json"), `${JSON.stringify(compaction, null, 2)}\n`);

  writeFileSync(join(outDir, "parser-guard.json"), `${JSON.stringify(parserGuard, null, 2)}\n`);
  writeFileSync(
    join(outDir, "named-blocks.json"),
    `${JSON.stringify(
      {
        required: phases.blocks,
        additionalIfEmitted: phases.additionalEmitted,
        everyBlock: phases.namedBlocks,
        assembledInHttp: phases.assembledInHttp,
        note: "group/messaging/memory/scratchpad/ticket are additional if emitted, not replacements for the four required blocks",
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(outDir, "tools-inventory.json"),
    `${JSON.stringify(
      {
        offeredToolNames: phases.offeredToolNames,
        builtinCatalogNames: phases.toolInventory.builtinCatalogNames,
        builtinCatalogCount: phases.toolInventory.builtinCatalogCount,
        offeredBuiltinCount: phases.toolInventory.offeredBuiltinCount,
        withheldBuiltinNames: phases.toolInventory.withheldBuiltinNames,
        reviewerExpectedWorkerBuiltins: phases.toolInventory.reviewerExpectedWorkerBuiltins,
        reviewerCountMatch: phases.toolInventory.reviewerCountMatch,
        missingConnectors: phases.toolInventory.missingConnectors,
        missingDynamicResolution: phases.toolInventory.missingDynamicResolution,
        connectorToolNames: phases.toolInventory.connectorTools.map((tool) => tool.name),
        schemasFrom: "selectBuiltinToolsForRun + ConnectorRegistry.discoverTools (empty registry)",
        handwrittenSchemas: false,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(outDir, "phases-summary.json"),
    `${JSON.stringify(
      {
        offeredToolNames: phases.offeredToolNames,
        blocks: phases.blocks,
        namedBlocks: phases.namedBlocks,
        additionalEmitted: phases.additionalEmitted,
        assembledInHttp: phases.assembledInHttp,
        toolInventory: {
          builtinCatalogNames: phases.toolInventory.builtinCatalogNames,
          builtinCatalogCount: phases.toolInventory.builtinCatalogCount,
          offeredBuiltinNames: phases.toolInventory.offeredBuiltinNames,
          offeredBuiltinCount: phases.toolInventory.offeredBuiltinCount,
          withheldBuiltinNames: phases.toolInventory.withheldBuiltinNames,
          reviewerExpectedWorkerBuiltins: phases.toolInventory.reviewerExpectedWorkerBuiltins,
          reviewerCountMatch: phases.toolInventory.reviewerCountMatch,
          missingConnectors: phases.toolInventory.missingConnectors,
          missingDynamicResolution: phases.toolInventory.missingDynamicResolution,
          assemblerInputs: phases.toolInventory.assemblerInputs,
          offeredToolNames: phases.offeredToolNames,
          connectorToolNames: phases.toolInventory.connectorTools.map((tool) => tool.name),
        },
        samplingByPhase: Object.fromEntries(
          phases.captures.map((capture) => [capture.phase, capture.sampling]),
        ),
        compactionGate: {
          gate: compaction.gate,
          matched: compaction.matched,
          deployedBoundary: compaction.deployedBoundary,
          reason: compaction.reason,
        },
        gateMet: false,
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
