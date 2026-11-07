import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import type {
  AdapterContext,
  AgentContextStrategy,
  ConnectorTool,
  JobPublisher,
} from "@rakazo/adapter-kit";
import { DEFAULT_CONTEXT_STRATEGY } from "@rakazo/adapter-kit";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  FLEET_TOOL_NAMES,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "@rakazo/contracts";
import { formatSkillsCatalogInstruction, type SkillCatalogEntry } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { compactHistory } from "./history-compaction.js";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";
import { openAiCompatibleModel } from "./pi-openai-compatible-provider.js";
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
  REASONING_MODEL_MAX_TOKENS,
  resolveCompletionMaxTokens,
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
export const CAPTURE_DEFAULT_DISABLED_TOOLS =
  "render_plot,skill_create,skill_update,skill_delete,create_space";
export const CAPTURE_MODEL_ID = "qwen3.8-flash-next";
export const CAPTURE_BASE_SHA = "926710a";
export const CAPTURE_WORKER_TIMEZONE = "America/New_York";
export const CAPTURE_IMAGE_TAGS = {
  api: "v0.3.1-926710a",
  worker: "v0.3.1-scrapling1",
} as const;
export const CAPTURE_IMAGE_IDS = {
  worker: "sha256:47d3423567b35333059f9ff55817c03656a43431539f0478e3eb959e13e9cdc6",
  api: "sha256:c500071f5b2fde76d4bfca3ae883afb817c2265e2f113515cdb59c653d469f1f",
} as const;
export const VALID_BROWSER_ACT_ARGS = { actions: [{ kind: "click", ref: "e1" }] } as const;
export const IDENTICAL_TOOL_ERROR = {
  error: "LOGIN_GUARD refused kind=password rule=default origin=https://capture.example.test",
} as const;
export const FIRST_TURN_REASONING = "synthetic-reasoning-first-turn";
export const CREATE_SPACE_CLAUSE =
  "create_space proposes a new privacy boundary inside the current organization";
export const RENDER_PLOT_CLAUSE =
  "For charts and data visualization, use the render_plot tool";
export const FLEET_CLAUSE = "Fleet tools: call list_fleet before changing anything";
export const SKIPPED_LOOP_GUARD =
  "Skipped: stopped by the loop guard. Reply with what you found.";
export const RUNTIDY_NOTICE = "Tools are now switched off";
export const STALE_REF_ERROR = "stale-ref: element e1 is gone";
export const CAPTURE_LOGIN_CLAIM = "logged in as capture-user@example.test";
export const SHORT_CONTROL_TREE = "SHORT_CONTROL_TREE";
export const ERROR_CONTROL_TEXT = "snapshot failed: control-error";
export const OLDER_TOOL_RESULT_SHORTEN_BYTES = 1024;
export const OLDER_TOOL_RESULT_TRUNCATION_NOTE =
  "[Tool result truncated to fit context; inspect original evidence before claiming omitted details.]";
export const HISTORICAL_CANDIDATE_WORDING =
  "Deployed-code synthetic capture is a candidate baseline, pending review (run10: not accepted).";
const CONTEXT_STRATEGIES = new Set(["current", "retrieval", "snapshots", "cache-aware"]);

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
    maxTokensDefault: resolveCompletionMaxTokens(undefined, undefined, undefined, true),
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
  stubSseSha256?: string;
  stubSseByteLength?: number;
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

export function captureContextStrategy(): {
  value: AgentContextStrategy;
  source: string;
} {
  const raw = process.env.ISOLATED_CAPTURE_CONTEXT_STRATEGY?.trim();
  if (raw) {
    if (!CONTEXT_STRATEGIES.has(raw)) {
      throw new Error(`ISOLATED_CAPTURE_CONTEXT_STRATEGY is not a known strategy: ${raw}`);
    }
    return { value: raw as AgentContextStrategy, source: "ISOLATED_CAPTURE_CONTEXT_STRATEGY" };
  }
  return {
    value: DEFAULT_CONTEXT_STRATEGY,
    source:
      "@rakazo/adapter-kit DEFAULT_CONTEXT_STRATEGY (no DB column, bot field, or CONTEXT/STRATEG env; do not force current)",
  };
}

export function captureTimeZone(service = process.env.ISOLATED_CAPTURE_SERVICE ?? "worker"): {
  value: string;
  source: string;
  apiValuesObserved: false;
} {
  const raw = process.env.RAKAZO_DEFAULT_TIMEZONE?.trim();
  if (raw) {
    return { value: raw, source: "RAKAZO_DEFAULT_TIMEZONE", apiValuesObserved: false };
  }
  return {
    value: CAPTURE_WORKER_TIMEZONE,
    source:
      service === "api"
        ? "worker docker-inspect allowlisted RAKAZO_DEFAULT_TIMEZONE; API value unobserved (same name present)"
        : "worker docker-inspect allowlisted RAKAZO_DEFAULT_TIMEZONE",
    apiValuesObserved: false,
  };
}

/** Chief bot.fleetManagement. Derived, not a hard-forced tool count. */
export function captureFleetManagement(): {
  value: boolean;
  property: "bot.fleetManagement";
  source: string;
} {
  return {
    value: true,
    property: "bot.fleetManagement",
    source:
      "Chief bot.fleetManagement (parent metadata asserted true on the serving bot row; shareable dump omits this field; selectBuiltinToolsForRun derives offered fleet tools from this flag; offered count is not hard-forced)",
  };
}

export function olderToolResultFallbackLength(
  size = OLDER_TOOL_RESULT_SHORTEN_BYTES,
): number {
  return (
    Math.floor(size / 2) + 1 + OLDER_TOOL_RESULT_TRUNCATION_NOTE.length + 1 + Math.floor(size / 2)
  );
}

export function captureDisabledBuiltinTools(): string[] {
  const botRow: string[] = [];
  const assist = (
    executorApi as { assistDisabledTools?: (botDisabled: string[] | null | undefined) => string[] }
  ).assistDisabledTools;
  if (typeof assist === "function") {
    if (!process.env.RAKAZO_ASSIST_DEFAULT_DISABLED_TOOLS?.trim()) {
      process.env.RAKAZO_ASSIST_DEFAULT_DISABLED_TOOLS = CAPTURE_DEFAULT_DISABLED_TOOLS;
    }
    return assist(botRow);
  }
  const raw = process.env.RAKAZO_ASSIST_DEFAULT_DISABLED_TOOLS ?? CAPTURE_DEFAULT_DISABLED_TOOLS;
  return raw
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

export type CaptureModelMetadata = {
  id: string;
  provider: typeof OPENAI_COMPATIBLE_PROVIDER_ID;
  maxTokens: number;
  contextWindow: number;
  reasoning: boolean;
  acceptsImages: boolean;
  source: string;
  secretMaxTokensObserved: false;
  rejectedStub4096: { historicalMaxOutputTokens: number; rowsOver4096: number };
};

export function loadCaptureModelMetadata(): CaptureModelMetadata {
  const raw = process.env.ISOLATED_CAPTURE_MODEL_METADATA?.trim();
  if (raw) return parseCaptureModelMetadata(JSON.parse(raw), "ISOLATED_CAPTURE_MODEL_METADATA");
  const file = process.env.ISOLATED_CAPTURE_MODEL_METADATA_FILE?.trim();
  if (file && existsSync(file)) {
    return parseCaptureModelMetadata(JSON.parse(readFileSync(file, "utf8")) as unknown, file);
  }
  const bundled = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../infra/overlays/reliability-20261107/isolated-capture/fixtures/qwen3.8-flash-next.json",
  );
  if (existsSync(bundled)) {
    return parseCaptureModelMetadata(JSON.parse(readFileSync(bundled, "utf8")) as unknown, bundled);
  }
  const nextToHarness = join(dirname(fileURLToPath(import.meta.url)), "qwen3.8-flash-next.json");
  if (existsSync(nextToHarness)) {
    return parseCaptureModelMetadata(
      JSON.parse(readFileSync(nextToHarness, "utf8")) as unknown,
      nextToHarness,
    );
  }
  return deriveProductionModelMetadata();
}

export function deriveProductionModelMetadata(): CaptureModelMetadata {
  const reasoning = true;
  const derivedMaxTokens = resolveCompletionMaxTokens(undefined, undefined, undefined, reasoning);
  const contractsWindow = DEFAULT_MODEL_CONTEXT_WINDOW;
  // secret.contextWindow is unobserved. 32768 cannot reserve a 32768 completion plus
  // the deployed tool JSON and assembler blocks (ContextBudgetError). 128k is the
  // next contracts-compatible window that leaves input room.
  const contextWindow = Math.max(contractsWindow, derivedMaxTokens * 4);
  openAiCompatibleModel(
    CAPTURE_MODEL_ID,
    "http://127.0.0.1/v1",
    reasoning,
    true,
    derivedMaxTokens,
    contextWindow,
  );
  return {
    id: CAPTURE_MODEL_ID,
    provider: OPENAI_COMPATIBLE_PROVIDER_ID,
    maxTokens: derivedMaxTokens,
    contextWindow,
    reasoning,
    acceptsImages: true,
    secretMaxTokensObserved: false,
    rejectedStub4096: { historicalMaxOutputTokens: 9256, rowsOver4096: 3 },
    source:
      "executor.resolveModel (space default qwen3.8-flash-next / openai-compatible, bot override null, deploymentSettings null) -> resolveModelKey.secret.maxTokens/contextWindow unobserved (encrypted) -> registerOpenAiCompatibleRuntime -> modelForCompletion/resolveCompletionMaxTokens(undefined, undefined, undefined, reasoning=true)=REASONING_MODEL_MAX_TOKENS. Stub 4096 rejected: historical maxOutput 9256 (7371 reasoning), 3 rows >4096. DEFAULT_MODEL_CONTEXT_WINDOW=32768 cannot reserve REASONING_MODEL_MAX_TOKENS plus assembler/tools; window is 4*REASONING_MODEL_MAX_TOKENS (131072) so modelOutputLeavesInputRoom holds. Not a live secret value.",
  };
}

function parseCaptureModelMetadata(value: unknown, source: string): CaptureModelMetadata {
  if (!value || typeof value !== "object") {
    throw new Error(`model metadata is not an object (${source})`);
  }
  const row = value as Record<string, unknown>;
  const derived = deriveProductionModelMetadata();
  const id = typeof row.id === "string" && row.id.trim() ? row.id.trim() : CAPTURE_MODEL_ID;
  const reasoning = row.reasoning !== false;
  const maxTokensRaw = Number(row.maxTokens);
  const contextWindowRaw = Number(row.contextWindow);
  const maxTokens =
    Number.isInteger(maxTokensRaw) && maxTokensRaw >= 1
      ? maxTokensRaw
      : resolveCompletionMaxTokens(undefined, undefined, undefined, reasoning);
  const contextWindow =
    Number.isInteger(contextWindowRaw) && contextWindowRaw >= 1
      ? contextWindowRaw
      : DEFAULT_MODEL_CONTEXT_WINDOW;
  if (maxTokens === DEFAULT_MODEL_MAX_TOKENS && reasoning) {
    throw new Error(
      `model metadata maxTokens ${DEFAULT_MODEL_MAX_TOKENS} is the rejected stub cap (${source}); historical maxOutput 9256`,
    );
  }
  return {
    ...derived,
    id,
    maxTokens,
    contextWindow,
    reasoning,
    acceptsImages: row.acceptsImages !== false,
    source,
  };
}

export function captureRunModel(baseUrl: string) {
  const meta = loadCaptureModelMetadata();
  return {
    provider: OPENAI_COMPATIBLE_PROVIDER_ID,
    id: meta.id,
    baseUrl,
    apiKey: "local",
    reasoning: meta.reasoning,
    acceptsImages: meta.acceptsImages,
    maxTokens: meta.maxTokens,
    contextWindow: meta.contextWindow,
  };
}

export function deriveAssemblerInputs() {
  const contextStrategy = captureContextStrategy();
  return {
    trigger: "user" as const,
    groupId: null as string | null,
    graphical: true,
    graphicalToolsAllowed: true,
    pageBrowserAllowed: true,
    heldForTakeover: false,
    contextStrategy: contextStrategy.value,
    contextStrategySource: contextStrategy.source,
    historyRetrievalEnabled: contextStrategy.value !== "current",
    ticketBoardEnabled: envFlag("RAKAZO_TICKET_BOARD") ?? false,
    phoneCallsEnabled: envFlag("RAKAZO_PHONE_CALLS") ?? false,
    semanticMemoryEnabled: envFlag("RAKAZO_SEMANTIC_MEMORY") ?? false,
    cloudAgentEnabled: envFlag("RAKAZO_CLOUD_AGENT") ?? false,
    mediaImagesEnabled: false,
    mediaVideoEnabled: false,
    messagingChannelRun: false,
    voiceCall: false,
    fleetManagement: captureFleetManagement().value,
    followUpFromUser: true,
    disabledBuiltinTools: captureDisabledBuiltinTools(),
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
  withheldRationale: Array<{ name: string; reason: string }>;
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
    withheldRationale: withholdRationale(
      builtinAgentTools.map((tool) => tool.name),
      offeredSet,
      assemblerInputs,
    ),
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
  promptClauses: {
    createSpace: boolean;
    renderPlot: boolean;
    fleet: boolean;
  };
}> {
  const toolInventory = await offeredToolsFromDeployedBuilder();
  const computerInstruction = persistentComputerInstruction({
    heldForTakeover: false,
    graphicalToolsAllowed: true,
    graphical: true,
    disabled: new Set(captureDisabledBuiltinTools()),
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
    disabledBuiltinTools: new Set(captureDisabledBuiltinTools()),
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
    promptClauses: {
      createSpace: instructions.includes(CREATE_SPACE_CLAUSE),
      renderPlot: instructions.includes(RENDER_PLOT_CLAUSE),
      fleet: instructions.includes(FLEET_CLAUSE),
    },
  };
}

function withholdRationale(
  catalogNames: string[],
  offered: Set<string>,
  inputs: ReturnType<typeof deriveAssemblerInputs>,
): Array<{ name: string; reason: string }> {
  const disabled = new Set(inputs.disabledBuiltinTools);
  const fleet = new Set<string>(FLEET_TOOL_NAMES);
  const rows: Array<{ name: string; reason: string }> = [];
  for (const name of catalogNames) {
    if (offered.has(name)) continue;
    if (disabled.has(name)) {
      rows.push({
        name,
        reason:
          "selectBuiltinToolsForRun disabledBuiltinTools: assistDisabledTools(bot.disabledBuiltinTools=[]) merged with env RAKAZO_ASSIST_DEFAULT_DISABLED_TOOLS=render_plot,skill_create,skill_update,skill_delete,create_space",
      });
      continue;
    }
    if (name === "generate_image") {
      rows.push({ name, reason: "selectBuiltinToolsForRun mediaImagesEnabled=false" });
      continue;
    }
    if (name === "generate_video") {
      rows.push({ name, reason: "selectBuiltinToolsForRun mediaVideoEnabled=false" });
      continue;
    }
    if (name === "board_tickets" || name.startsWith("ticket_")) {
      rows.push({ name, reason: "selectBuiltinToolsForRun ticketBoardEnabled=false" });
      continue;
    }
    if (fleet.has(name)) {
      rows.push({
        name,
        reason: inputs.fleetManagement
          ? "selectBuiltinToolsForRun fleetManagement=true but tool still withheld (trigger/follow-up gate)"
          : "selectBuiltinToolsForRun fleetManagement=false (FLEET_TOOL_NAMES)",
      });
      continue;
    }
    if (name === "end_call") {
      rows.push({ name, reason: "selectBuiltinToolsForRun voiceCall=false" });
      continue;
    }
    if (name === "call_user") {
      rows.push({
        name,
        reason: "selectBuiltinToolsForRun phoneCallsEnabled=false (or group/voice/messaging gate)",
      });
      continue;
    }
    if (name.startsWith("cloud_agent_")) {
      rows.push({ name, reason: "selectCloudAgentTools cloudAgentEnabled=false" });
      continue;
    }
    if (
      name === "save_memory" ||
      name === "recall_memory" ||
      name === "forget_memory" ||
      name === "save_shared_memory"
    ) {
      rows.push({ name, reason: "selectMemoryTools semanticMemoryEnabled=false" });
      continue;
    }
    if (!inputs.historyRetrievalEnabled && (name === "search_history" || name === "read_history")) {
      rows.push({ name, reason: "selectBuiltinToolsForRun historyRetrievalEnabled=false" });
      continue;
    }
    rows.push({
      name,
      reason: "selectBuiltinToolsForRun deployed selector (thread/trigger/page/graphical filter)",
    });
  }
  return rows;
}

export function syntheticUserPrompt(): string {
  return [
    "Synthetic capture turn. No live accounts, secrets, or browsing.",
    formatCurrentTimeInstruction(captureClock(), captureTimeZone().value),
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

function lastToolResultNames(body: Record<string, unknown> | null): string[] {
  if (!body || !Array.isArray(body.messages)) return [];
  const messages = body.messages as Array<Record<string, unknown>>;
  let index = messages.length - 1;
  while (index >= 0 && messages[index]?.role === "tool") index -= 1;
  const assistant = messages[index];
  if (!assistant || assistant.role !== "assistant") return [];
  return messageToolCalls(assistant).map((call) => call.name);
}

export const LOOP_GUARD_PREFIX = "LOOP GUARD";
export const ERROR_GUARD_PREFIX = "ERROR GUARD";
export const GUARD_HALT_MARK = "Tools are now stopped";
export const LOOP_GUARD_WARN_MARK = "STOP repeating these actions";
export const ERROR_GUARD_WARN_MARK = "One more identical failure";
export const ERROR_GUARD_DESKTOP_WARN_MARK = "One more desktop failure";

export function classifyCapturePhase(
  caseName: string,
  seq: number,
  parsed: Record<string, unknown> | null,
): string {
  if (
    caseName !== "phases" &&
    caseName !== "guard-orchestration" &&
    caseName !== "guard-a" &&
    caseName !== "guard-b" &&
    caseName !== "guard-c"
  ) {
    return caseName;
  }
  const tools = Array.isArray(parsed?.tools) ? parsed.tools : [];
  const hay = JSON.stringify(parsed ?? {});
  // Tool-free is the runtidy request only. Halt text can still advertise tools.
  if (tools.length === 0) return "guard-final";
  if (
    (hay.includes(LOOP_GUARD_PREFIX) || hay.includes(ERROR_GUARD_PREFIX)) &&
    hay.includes(GUARD_HALT_MARK)
  ) {
    return "guard-halt";
  }
  if (
    (hay.includes(LOOP_GUARD_PREFIX) && hay.includes(LOOP_GUARD_WARN_MARK)) ||
    (hay.includes(ERROR_GUARD_PREFIX) &&
      (hay.includes(ERROR_GUARD_WARN_MARK) || hay.includes(ERROR_GUARD_DESKTOP_WARN_MARK)))
  ) {
    return "guard-warning";
  }
  const lastTools = lastToolResultNames(parsed);
  if (lastTools.length > 0 && lastTools.every((name) => name === "web_fetch")) {
    return "thinking-reenable";
  }
  if (seq === 0) return "first";
  if (lastTools.includes("browser_snapshot") || lastTools.includes("browser_navigate")) {
    return "postbrowser";
  }
  return `turn-${seq}`;
}

function extraStopReplies(count: number): StubReply[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "sse" as const,
    finish: "stop",
    events: [{ content: `synthetic-stop-${index}` }],
  }));
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
  stubBodies: string[];
}> {
  const captures: CapturedHttp[] = [];
  const rawBodies: Buffer[] = [];
  const parsedBodies: Array<Record<string, unknown> | null> = [];
  const stubBodies: string[] = [];
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
      const reply = options.replies[seq];
      let stubSse: string | undefined;
      if (reply?.kind === "sse") {
        stubSse = ssePayload(options.modelId, reply.events, reply.finish);
        stubBodies[seq] = stubSse;
      }
      captures.push({
        seq,
        caseName: options.caseName,
        phase: classifyCapturePhase(options.caseName, seq, parsed),
        method: request.method ?? "POST",
        url: request.url ?? "",
        nonAuthHeaders: nonAuthHeaders(request),
        rawSha256: createHash("sha256").update(raw).digest("hex"),
        rawByteLength: raw.byteLength,
        sampling: samplingFromBody(parsed),
        toolNames: toolNamesFromBody(parsed),
        ...(stubSse
          ? {
              stubSseSha256: createHash("sha256").update(stubSse).digest("hex"),
              stubSseByteLength: Buffer.byteLength(stubSse),
            }
          : {}),
      });
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
      response.end(stubSse ?? ssePayload(options.modelId, reply.events, reply.finish));
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
    stubBodies,
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
    signal: AbortSignal.timeout(90_000),
  })) {
    events.push(event);
  }
  return events;
}

function executeSyntheticTool(
  name: string,
  args: Record<string, unknown>,
  snapshotCount: { value: number },
): unknown {
  if (name === "browser_navigate") {
    return {
      url: String(args.url ?? ""),
      title: `synthetic-nav-${String(args.url ?? "")}`,
      ok: true,
    };
  }
  if (name === "browser_snapshot") {
    const maxControls = Number(args.max_controls ?? 0);
    if (maxControls === 1) {
      return {
        url: "https://capture.example.test/short",
        title: "short-control",
        tree: SHORT_CONTROL_TREE,
        elements: [],
      };
    }
    if (maxControls === 999) {
      return { error: ERROR_CONTROL_TEXT, isError: true };
    }
    if (maxControls >= 101 && maxControls <= 104) {
      return oversizedPage(maxControls - 100);
    }
    snapshotCount.value += 1;
    return oversizedPage(snapshotCount.value);
  }
  if (name === "browser_act") {
    return { ...IDENTICAL_TOOL_ERROR };
  }
  if (name === "browser_extract") {
    // isError failure with stale-ref text (not LOGIN_GUARD refusal JSON). Overlay ERROR GUARD
    // reads details.error; LOOP GUARD treats extract as observe and returns ok.
    return { error: STALE_REF_ERROR, isError: true };
  }
  if (name === "web_fetch") {
    return {
      url: String(args.url ?? "https://capture.example.test/fetch"),
      text: "non-browser fetch body",
    };
  }
  return { ok: true, synthetic: true, tool: name };
}

function messageToolCalls(
  message: Record<string, unknown>,
): Array<{ id?: string; name: string; args: unknown }> {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return calls.flatMap((call) => {
    if (!call || typeof call !== "object") return [];
    const fn = (call as { id?: unknown; function?: { name?: string; arguments?: unknown } })
      .function;
    const id = (call as { id?: unknown }).id;
    if (!fn?.name) return [];
    let args: unknown = fn.arguments;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = fn.arguments;
      }
    }
    return [
      {
        ...(typeof id === "string" ? { id } : {}),
        name: fn.name,
        args,
      },
    ];
  });
}

function toolsBearingBodies(
  bodies: Array<Record<string, unknown> | null>,
): Array<Record<string, unknown>> {
  return bodies.filter((body): body is Record<string, unknown> => {
    if (!body || typeof body !== "object") return false;
    return Array.isArray(body.tools) && body.tools.length > 0;
  });
}

export function identicalToolErrorCount(bodies: Array<Record<string, unknown> | null>): number {
  // Overlay Pi often sends only the latest tool result per HTTP body. Count each
  // tools-bearing request whose latest tool message is the identical LOGIN_GUARD error.
  let count = 0;
  for (const body of toolsBearingBodies(bodies)) {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const lastTool = [...messages]
      .reverse()
      .find((message) => message && typeof message === "object" && message.role === "tool");
    const text =
      lastTool && typeof lastTool === "object" ? String((lastTool as { content?: unknown }).content ?? "") : "";
    if (text.includes(IDENTICAL_TOOL_ERROR.error)) count += 1;
  }
  return count;
}

export function loopGuardSignals(bodies: Array<Record<string, unknown> | null>): {
  warning: boolean;
  halt: boolean;
  errorGuard: boolean;
} {
  let warning = false;
  let halt = false;
  let errorGuard = false;
  for (const body of bodies) {
    const hay = JSON.stringify(body ?? {});
    if (hay.includes(ERROR_GUARD_PREFIX)) errorGuard = true;
    if (hay.includes(LOOP_GUARD_PREFIX) && hay.includes(LOOP_GUARD_WARN_MARK)) warning = true;
    if (
      hay.includes(ERROR_GUARD_PREFIX) &&
      (hay.includes(ERROR_GUARD_WARN_MARK) || hay.includes(ERROR_GUARD_DESKTOP_WARN_MARK))
    ) {
      warning = true;
    }
    if (
      (hay.includes(LOOP_GUARD_PREFIX) || hay.includes(ERROR_GUARD_PREFIX)) &&
      hay.includes(GUARD_HALT_MARK)
    ) {
      halt = true;
    }
  }
  return { warning, halt, errorGuard };
}

export function toolsKeyPresent(body: Record<string, unknown> | null): boolean {
  return Boolean(body && Object.prototype.hasOwnProperty.call(body, "tools"));
}

export function skippedLoopGuardPresent(bodies: Array<Record<string, unknown> | null>): boolean {
  return bodies.some((body) => JSON.stringify(body ?? {}).includes(SKIPPED_LOOP_GUARD));
}

export function runtidyPromptPresent(bodies: Array<Record<string, unknown> | null>): boolean {
  return bodies.some((body) => JSON.stringify(body ?? {}).includes(RUNTIDY_NOTICE));
}

function validBrowserActCallCount(bodies: Array<Record<string, unknown> | null>): number {
  const ids = new Set<string>();
  for (const body of bodies) {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    for (const message of messages) {
      if (!message || typeof message !== "object") continue;
      if ((message as { role?: string }).role !== "assistant") continue;
      for (const call of messageToolCalls(message as Record<string, unknown>)) {
        if (call.name !== "browser_act") continue;
        const args = call.args as { actions?: Array<{ kind?: string; ref?: string }> } | null;
        if (args?.actions?.[0]?.kind !== "click" || args.actions[0]?.ref !== "e1") continue;
        ids.add(call.id ?? `${ids.size}:${JSON.stringify(call.args)}`);
      }
    }
  }
  return ids.size;
}

export const GUARD_ORCHESTRATION_TOOL: ConnectorTool = {
  name: "browser_act",
  description: "synthetic page act for loop-guard orchestration",
  inputSchema: {
    type: "object",
    properties: {
      actions: { type: "array", items: { type: "object" } },
    },
  },
};

export const GUARD_EXTRACT_TOOL: ConnectorTool = {
  name: "browser_extract",
  description: "synthetic extract for error-guard orchestration",
  inputSchema: {
    type: "object",
    properties: {
      ref: { type: "string" },
    },
  },
};

export const VALID_BROWSER_EXTRACT_ARGS = { ref: "e1" } as const;

export type GuardOrchestrationResult = {
  captures: CapturedHttp[];
  parsedBodies: Array<Record<string, unknown> | null>;
  identicalToolErrors: number;
  validBrowserActCalls: number;
  guardWarning: boolean;
  guardHalt: boolean;
  errorGuardPresent: boolean;
  haltAdvertisesTools: boolean;
  guardFinalToolFree: boolean;
  skippedPresent: boolean;
  noToolsKey: boolean;
  runtidyPrompt: boolean;
  toolName: "browser_act" | "browser_extract";
};

export async function captureLoopGuardOrchestration(options: {
  runtime: PiAgentRuntime;
  runId: string;
  extraIgnoredHaltCall: boolean;
  toolName?: "browser_act" | "browser_extract";
}): Promise<GuardOrchestrationResult> {
  process.env.RAKAZO_GUARD_FINAL_SUMMARY ??= "1";
  const meta = loadCaptureModelMetadata();
  const toolName = options.toolName ?? "browser_act";
  const args =
    toolName === "browser_extract"
      ? (VALID_BROWSER_EXTRACT_ARGS as unknown as Record<string, unknown>)
      : (VALID_BROWSER_ACT_ARGS as unknown as Record<string, unknown>);
  const actReplies: StubReply[] = [1, 2, 3, 4].map((index) => ({
    kind: "sse",
    finish: "tool_calls",
    events: toolCallDelta(`call_guard_${toolName}_${index}`, toolName, args),
  }));
  if (options.extraIgnoredHaltCall) {
    actReplies.push({
      kind: "sse",
      finish: "tool_calls",
      events: toolCallDelta(`call_guard_${toolName}_ignored_halt`, toolName, args),
    });
  }
  const stub = await startCaptureStub({
    modelId: meta.id,
    caseName: "guard-orchestration",
    replies: [
      ...actReplies,
      {
        kind: "sse",
        finish: "stop",
        events: [{ content: "guard-orchestration-stop" }],
      },
      ...extraStopReplies(8),
    ],
  });
  try {
    await drainRuntime(options.runtime, {
      botId: "bot-guard-orchestration",
      threadId: "thread-guard-orchestration",
      runId: options.runId,
      prompt: "Synthetic loop-guard orchestration. No live accounts or browsing.",
      instructions: "Follow tool results. Do not invent side effects.",
      history: [],
      tools: [toolName === "browser_extract" ? GUARD_EXTRACT_TOOL : GUARD_ORCHESTRATION_TOOL],
      contextStrategy: "retrieval",
      allowSilentEmpty: true,
      model: captureRunModel(stub.baseUrl),
      executeTool: async (name, toolArgs) =>
        executeSyntheticTool(name, toolArgs as Record<string, unknown>, { value: 0 }),
    });
    const signals = loopGuardSignals(stub.parsedBodies);
    const haltCapture = stub.captures.find((row) => row.phase === "guard-halt");
    const toolFree = stub.captures.find(
      (capture) => capture.phase === "guard-final" && capture.toolNames.length === 0,
    );
    const toolFreeBody = toolFree ? stub.parsedBodies[toolFree.seq] ?? null : null;
    return {
      captures: stub.captures,
      parsedBodies: stub.parsedBodies,
      identicalToolErrors: identicalToolErrorCount(stub.parsedBodies),
      validBrowserActCalls: validBrowserActCallCount(stub.parsedBodies),
      guardWarning: signals.warning,
      guardHalt: signals.halt,
      errorGuardPresent: signals.errorGuard,
      haltAdvertisesTools: Boolean(haltCapture && haltCapture.toolNames.length > 0),
      guardFinalToolFree: Boolean(toolFree),
      skippedPresent: skippedLoopGuardPresent(stub.parsedBodies),
      noToolsKey: Boolean(toolFree && !toolsKeyPresent(toolFreeBody)),
      runtidyPrompt: runtidyPromptPresent(stub.parsedBodies),
      toolName,
    };
  } finally {
    await stub.close();
  }
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
  validBrowserActCalls: number;
  identicalToolErrors: number;
  reasoningInspected: boolean;
  thinkingReenabled: boolean;
  guardWarning: boolean;
  guardHalt: boolean;
  guardFinalToolFree: boolean;
  haltAdvertisesTools: boolean;
  skippedPresent: boolean;
  runtidyPrompt: boolean;
  errorGuardPresent: boolean;
  promptClauses: {
    createSpace: boolean;
    renderPlot: boolean;
    fleet: boolean;
  };
  path: "A";
}> {
  const meta = loadCaptureModelMetadata();
  const assembled = await assembleCapturePrompt();
  const snapshots = { value: 0 };
  const stub = await startCaptureStub({
    modelId: meta.id,
    caseName: "phases",
    replies: [
      {
        kind: "sse",
        finish: "tool_calls",
        events: [
          { reasoning_content: FIRST_TURN_REASONING },
          ...toolCallDelta("call_capture_first", "browser_snapshot", {}),
        ],
      },
      {
        kind: "sse",
        finish: "tool_calls",
        events: toolCallDelta("call_capture_fetch", "web_fetch", {
          url: "https://capture.example.test/fetch",
        }),
      },
      ...[1, 2, 3, 4].map((index) => ({
        kind: "sse" as const,
        finish: "tool_calls",
        events: toolCallDelta(
          `call_capture_act_${index}`,
          "browser_act",
          VALID_BROWSER_ACT_ARGS as unknown as Record<string, unknown>,
        ),
      })),
      {
        kind: "sse",
        finish: "stop",
        events: [{ content: "guard-final: stopped at identical tool error." }],
      },
      ...extraStopReplies(6),
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
      contextStrategy: captureContextStrategy().value,
      model: captureRunModel(stub.baseUrl),
      executeTool: async (name, args) => executeSyntheticTool(name, args, snapshots),
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
    const replayText = stub.parsedBodies
      .slice(1)
      .map((body) => JSON.stringify(body ?? {}))
      .join("\n");
    const reasoningInspected =
      replayText.includes(FIRST_TURN_REASONING) ||
      replayText.includes("reasoning_content") ||
      replayText.includes("synthetic-reasoning");
    const thinkingReenabled = stub.captures.some(
      (capture) =>
        capture.phase === "thinking-reenable" &&
        capture.sampling.included.enable_thinking === true,
    );
    const signals = loopGuardSignals(stub.parsedBodies);
    const guardWarning = signals.warning;
    const guardHalt = signals.halt;
    const haltCapture = stub.captures.find((row) => row.phase === "guard-halt");
    const guardFinalToolFree = stub.captures.some(
      (capture) => capture.phase === "guard-final" && capture.toolNames.length === 0,
    );
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
      validBrowserActCalls: validBrowserActCallCount(stub.parsedBodies),
      identicalToolErrors: identicalToolErrorCount(stub.parsedBodies),
      reasoningInspected,
      thinkingReenabled,
      guardWarning,
      guardHalt,
      guardFinalToolFree,
      haltAdvertisesTools: Boolean(haltCapture && haltCapture.toolNames.length > 0),
      skippedPresent: skippedLoopGuardPresent(stub.parsedBodies),
      runtidyPrompt: runtidyPromptPresent(stub.parsedBodies),
      errorGuardPresent: signals.errorGuard,
      promptClauses: assembled.promptClauses,
      path: "A",
    };
  } finally {
    await stub.close();
  }
}

export type GuardPathCapture = {
  service: string;
  path: "B" | "C";
  caseName: "guard-b" | "guard-c";
  captures: CapturedHttp[];
  rawBodies: Buffer[];
  parsedBodies: Array<Record<string, unknown> | null>;
  guardWarning: boolean;
  guardHalt: boolean;
  errorGuardPresent: boolean;
  skippedPresent: boolean;
  guardFinalToolFree: boolean;
  noToolsKey: boolean;
  runtidyPrompt: boolean;
  haltAdvertisesTools: boolean;
  validBrowserActCalls: number;
  identicalToolErrors: number;
};

async function captureGuardPath(
  service: string,
  path: "B" | "C",
): Promise<GuardPathCapture> {
  process.env.RAKAZO_GUARD_FINAL_SUMMARY ??= "1";
  const meta = loadCaptureModelMetadata();
  const assembled = await assembleCapturePrompt();
  const toolName = path === "C" ? "browser_extract" : "browser_act";
  const args =
    path === "C"
      ? (VALID_BROWSER_EXTRACT_ARGS as unknown as Record<string, unknown>)
      : (VALID_BROWSER_ACT_ARGS as unknown as Record<string, unknown>);
  const caseName = path === "C" ? "guard-c" : "guard-b";
  const replies: StubReply[] = [1, 2, 3, 4, 5].map((index) => ({
    kind: "sse" as const,
    finish: "tool_calls",
    events: toolCallDelta(`call_capture_${caseName}_${index}`, toolName, args),
  }));
  replies.push({
    kind: "sse",
    finish: "stop",
    events: [{ content: `${caseName}-stop` }],
  });
  replies.push(...extraStopReplies(8));
  const stub = await startCaptureStub({ modelId: meta.id, caseName, replies });
  try {
    await drainRuntime(new PiAgentRuntime(), {
      botId: "bot-synthetic-capture",
      threadId: "thread-synthetic-capture",
      runId: `run-synthetic-${caseName}-${service}`,
      prompt: assembled.prompt,
      instructions: assembled.instructions,
      history: [],
      tools: assembled.tools,
      contextStrategy: captureContextStrategy().value,
      allowSilentEmpty: true,
      model: captureRunModel(stub.baseUrl),
      executeTool: async (name, toolArgs) =>
        executeSyntheticTool(name, toolArgs, { value: 0 }),
    });
    const signals = loopGuardSignals(stub.parsedBodies);
    const haltCapture = stub.captures.find((row) => row.phase === "guard-halt");
    const toolFree = stub.captures.find(
      (capture) => capture.phase === "guard-final" && capture.toolNames.length === 0,
    );
    const toolFreeBody = toolFree ? stub.parsedBodies[toolFree.seq] ?? null : null;
    return {
      service,
      path,
      caseName,
      captures: stub.captures,
      rawBodies: stub.rawBodies,
      parsedBodies: stub.parsedBodies,
      guardWarning: signals.warning,
      guardHalt: signals.halt,
      errorGuardPresent: signals.errorGuard,
      skippedPresent: skippedLoopGuardPresent(stub.parsedBodies),
      guardFinalToolFree: Boolean(toolFree),
      noToolsKey: Boolean(toolFree && !toolsKeyPresent(toolFreeBody)),
      runtidyPrompt: runtidyPromptPresent(stub.parsedBodies),
      haltAdvertisesTools: Boolean(haltCapture && haltCapture.toolNames.length > 0),
      validBrowserActCalls: validBrowserActCallCount(stub.parsedBodies),
      identicalToolErrors: identicalToolErrorCount(stub.parsedBodies),
    };
  } finally {
    await stub.close();
  }
}

export async function captureGuardPathB(service: string): Promise<GuardPathCapture> {
  return captureGuardPath(service, "B");
}

export async function captureGuardPathC(service: string): Promise<GuardPathCapture> {
  return captureGuardPath(service, "C");
}

function toolMessageTexts(body: Record<string, unknown> | null): string[] {
  if (!body || !Array.isArray(body.messages)) return [];
  const texts: string[] = [];
  for (const message of body.messages) {
    if (!message || typeof message !== "object") continue;
    if ((message as { role?: string }).role !== "tool") continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") texts.push(content);
    else if (content != null) texts.push(JSON.stringify(content));
  }
  return texts;
}

function snapshotMaxControls(bodies: Array<Record<string, unknown> | null>): number[] {
  const seen = new Set<number>();
  for (const body of bodies) {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    for (const message of messages) {
      if (!message || typeof message !== "object") continue;
      if ((message as { role?: string }).role !== "assistant") continue;
      for (const call of messageToolCalls(message as Record<string, unknown>)) {
        if (call.name !== "browser_snapshot") continue;
        const args = call.args as { max_controls?: unknown } | null;
        const value = Number(args?.max_controls);
        if (Number.isInteger(value)) seen.add(value);
      }
    }
  }
  return [...seen].sort((left, right) => left - right);
}

export const OLDER_RESULT_SHORTENING = {
  function: "createRuntimeContextPolicy",
  file: "packages/adapters/src/runtime-context.ts",
  call: "shortenToolResultText(source, 1024, { name: message.toolName })",
  fallback: "512-char head + truncation note + 512-char tail when structured shorteners return null",
  sizeHardcoded: OLDER_TOOL_RESULT_SHORTEN_BYTES,
  fallbackLength: olderToolResultFallbackLength(),
  independentOfContextWindow: true,
  contextWindowNotRead: true,
} as const;

export async function capturePageTrim(service: string): Promise<{
  service: string;
  captures: CapturedHttp[];
  rawBodies: Buffer[];
  parsedBodies: Array<Record<string, unknown> | null>;
  lastRequestText: string;
  request5Text: string;
  keptPageMarkers: string[];
  distinctSnapshotArgs: number[];
  distinctLargeSnapshotArgs: number[];
  distinctNavigateUrls: string[];
  trimmedNotePresent: boolean;
  page1Trimmed: boolean;
  page2Length: number | null;
  page3Length: number | null;
  page4Length: number | null;
  page4Full: boolean;
  shortControlUntouched: boolean;
  errorControlUntouched: boolean;
  clipped12k: boolean;
  olderResultShortening: typeof OLDER_RESULT_SHORTENING;
}> {
  const meta = loadCaptureModelMetadata();
  const assembled = await assembleCapturePrompt();
  const snapshots = { value: 0 };
  const replies: StubReply[] = [101, 102, 103, 104].map((maxControls) => ({
    kind: "sse" as const,
    finish: "tool_calls",
    events: toolCallDelta(`call_capture_page_${maxControls}`, "browser_snapshot", {
      max_controls: maxControls,
    }),
  }));
  replies.push({
    kind: "sse",
    finish: "tool_calls",
    events: toolCallDelta("call_capture_page_short", "browser_snapshot", { max_controls: 1 }),
  });
  replies.push({
    kind: "sse",
    finish: "tool_calls",
    events: toolCallDelta("call_capture_page_error", "browser_snapshot", { max_controls: 999 }),
  });
  replies.push({
    kind: "sse",
    finish: "stop",
    events: [{ content: "page-trim: request-5 note + older 1024 shorten + controls." }],
  });
  replies.push(...extraStopReplies(2));
  const stub = await startCaptureStub({ modelId: meta.id, caseName: "page-trim", replies });
  try {
    await drainRuntime(new PiAgentRuntime(), {
      botId: "bot-synthetic-capture",
      threadId: "thread-synthetic-capture",
      runId: `run-synthetic-pagetrim-${service}`,
      prompt: assembled.prompt,
      instructions: assembled.instructions,
      history: [],
      tools: assembled.tools,
      contextStrategy: captureContextStrategy().value,
      model: captureRunModel(stub.baseUrl),
      executeTool: async (name, args) => executeSyntheticTool(name, args, snapshots),
    });
    const request5 = stub.parsedBodies[4] ?? null;
    const last = stub.parsedBodies.at(-1) ?? null;
    const request5Text = JSON.stringify(request5 ?? {});
    const lastRequestText = JSON.stringify(last ?? {});
    const request5Tools = toolMessageTexts(request5);
    const lastTools = toolMessageTexts(last);
    const pageText = (tools: string[], marker: string) =>
      tools.find((text) => text.includes(marker)) ?? null;
    const page2 = pageText(request5Tools, "BEGIN_PAGE_2_");
    const page3 = pageText(request5Tools, "BEGIN_PAGE_3_");
    const page4 = pageText(request5Tools, "BEGIN_PAGE_4_");
    const page1Trimmed =
      request5Text.includes(STALE_PAGE_STATE_NOTE) && !request5Text.includes("BEGIN_PAGE_1_");
    const keptPageMarkers = ["BEGIN_PAGE_2_", "BEGIN_PAGE_3_", "BEGIN_PAGE_4_"].filter((marker) =>
      request5Text.includes(marker),
    );
    return {
      service,
      captures: stub.captures,
      rawBodies: stub.rawBodies,
      parsedBodies: stub.parsedBodies,
      lastRequestText,
      request5Text,
      keptPageMarkers,
      distinctSnapshotArgs: snapshotMaxControls(stub.parsedBodies),
      distinctLargeSnapshotArgs: snapshotMaxControls(stub.parsedBodies).filter(
        (value) => value >= 101 && value <= 104,
      ),
      distinctNavigateUrls: [],
      trimmedNotePresent: page1Trimmed,
      page1Trimmed,
      page2Length: page2?.length ?? null,
      page3Length: page3?.length ?? null,
      page4Length: page4?.length ?? null,
      page4Full: Boolean(page4 && page4.includes("BEGIN_PAGE_4_") && page4.length <= 12_001),
      shortControlUntouched: lastTools.some((text) => text.includes(SHORT_CONTROL_TREE)),
      errorControlUntouched: lastTools.some((text) => text.includes(ERROR_CONTROL_TEXT)),
      clipped12k: Boolean(
        page4 &&
          page4.length <= 12_001 &&
          page4.length < OVERSIZED_PAGE_CHARS &&
          (page4.includes("…") ||
            page4.includes("truncated") ||
            page4.includes("contextTruncated")),
      ),
      olderResultShortening: OLDER_RESULT_SHORTENING,
    };
  } finally {
    await stub.close();
  }
}

export type CompactionCaptureResult = {
  service: string;
  gate: "invoked" | "unmet";
  matched: boolean;
  invoked: boolean;
  deployedBoundary: "compactHistory";
  reason?: string;
  captures: CapturedHttp[];
  rawBodies: Buffer[];
  parsedBodies: Array<Record<string, unknown> | null>;
  stubBodies: string[];
  writeback: { summary: string | null; historyCompactedUpToSeq: number | null };
  usageRecorded: boolean;
  clockPinned: boolean;
  clockIso: string;
  priorSummaryInRequest: boolean;
  loginClaimInRequest: boolean;
  mixedToolRows: boolean;
  stubOutput: string | null;
};

const COMPACTION_PRIOR_SUMMARY =
  "Prior synthetic summary covering seq 0-3. User asked about billing.";

function syntheticCompactionMessages(count: number, startSeq = 0) {
  return Array.from({ length: count }, (_, offset) => {
    const seq = startSeq + offset;
    const kind = offset % 4;
    if (kind === 0) {
      return {
        seq,
        role: "user" as const,
        blocks: [{ kind: "text" as const, text: `Check the billing page (row ${seq}).` }],
      };
    }
    if (kind === 1) {
      return {
        seq,
        role: "bot" as const,
        blocks: [
          {
            kind: "progress" as const,
            text: "browser_snapshot",
            activity: true as const,
            pendingToolNames: ["browser_snapshot"],
          },
          {
            kind: "text" as const,
            text: `tool call browser_snapshot max_controls=${101 + (offset % 4)} then tool result BEGIN_TOOL_RESULT_${seq}_`,
          },
        ],
      };
    }
    if (kind === 3) {
      return {
        seq,
        role: "bot" as const,
        blocks: [{ kind: "text" as const, text: CAPTURE_LOGIN_CLAIM }],
      };
    }
    return {
      seq,
      role: "user" as const,
      blocks: [{ kind: "text" as const, text: `continue after tool result ${seq}` }],
    };
  });
}

async function withPinnedCaptureClock<T>(fn: () => Promise<T>): Promise<T> {
  const pinnedMs = captureClock().getTime();
  const OriginalDate = Date;
  const PinnedDate = function PinnedDate(
    this: Date | void,
    ...args: ConstructorParameters<typeof Date>
  ) {
    if (args.length === 0) return new OriginalDate(pinnedMs);
    return new OriginalDate(...args);
  } as unknown as DateConstructor;
  PinnedDate.now = () => pinnedMs;
  PinnedDate.parse = OriginalDate.parse.bind(OriginalDate);
  PinnedDate.UTC = OriginalDate.UTC.bind(OriginalDate);
  PinnedDate.prototype = OriginalDate.prototype;
  Object.setPrototypeOf(PinnedDate, OriginalDate);
  const previous = globalThis.Date;
  globalThis.Date = PinnedDate;
  try {
    return await fn();
  } finally {
    globalThis.Date = previous;
  }
}

function mockCompactionPrisma(state: {
  thread: Record<string, unknown>;
  messages: ReturnType<typeof syntheticCompactionMessages>;
  usage: number;
}) {
  return {
    thread: {
      findUniqueOrThrow: async () => ({ ...state.thread }),
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(state.thread, data);
        return { count: 1 };
      },
    },
    message: {
      findMany: async ({
        where,
        take,
        orderBy,
      }: {
        where?: { seq?: { gt?: number; lte?: number } };
        take?: number;
        orderBy?: { seq?: "asc" | "desc" };
      }) => {
        let rows = [...state.messages];
        const gt = where?.seq?.gt;
        const lte = where?.seq?.lte;
        if (typeof gt === "number") rows = rows.filter((row) => row.seq > gt);
        if (typeof lte === "number") rows = rows.filter((row) => row.seq <= lte);
        if (orderBy?.seq === "desc") rows = [...rows].sort((left, right) => right.seq - left.seq);
        else rows = [...rows].sort((left, right) => left.seq - right.seq);
        if (typeof take === "number") rows = rows.slice(0, take);
        return rows;
      },
    },
    event: { findFirst: async () => null },
    usageRecord: {
      create: async () => {
        state.usage += 1;
        return {};
      },
      createMany: async () => {
        state.usage += 1;
        return { count: 1 };
      },
    },
    memoryDocument: { findFirst: async () => null },
    botMcpServer: { findMany: async () => [] },
    botSecret: { findMany: async () => [] },
    deploymentSettings: {
      findUnique: async () => ({
        defaultModelProvider: OPENAI_COMPATIBLE_PROVIDER_ID,
        defaultModelId: CAPTURE_MODEL_ID,
      }),
    },
  };
}

export async function captureCompactionPass(service: string): Promise<CompactionCaptureResult> {
  const meta = loadCaptureModelMetadata();
  const threadId = "thread-synthetic-compact";
  const clockIso = captureClock().toISOString();
  const state = {
    thread: {
      id: threadId,
      botId: SYNTHETIC_BOTDIR_SELF_ID,
      userId: "user-synthetic-capture",
      spaceId: "space-synthetic-capture",
      historyCompactedUpToSeq: 3,
      historyCompactionGeneration: 1,
      historyCompactionSummary: COMPACTION_PRIOR_SUMMARY,
      nextMessageSeq: 36,
    } as Record<string, unknown>,
    messages: syntheticCompactionMessages(32, 4),
    usage: 0,
  };
  const stub = await startCaptureStub({
    modelId: meta.id,
    caseName: "compaction",
    replies: [
      {
        kind: "sse",
        finish: "stop",
        events: [{ content: "synthetic compacted summary of mixed tool rows." }],
      },
      ...extraStopReplies(2),
    ],
  });
  const jobs: JobPublisher = {
    enqueue: async () => undefined,
    cancel: async () => undefined,
    close: async () => undefined,
  };
  const memoryProviders: MemoryProviderResolver = {
    resolve: async () => null,
  };
  const unmet = (reason: string): CompactionCaptureResult => ({
    service,
    gate: "unmet",
    matched: false,
    invoked: false,
    deployedBoundary: "compactHistory",
    reason,
    captures: stub.captures,
    rawBodies: stub.rawBodies,
    parsedBodies: stub.parsedBodies,
    stubBodies: stub.stubBodies,
    writeback: { summary: null, historyCompactedUpToSeq: null },
    usageRecorded: false,
    clockPinned: true,
    clockIso,
    priorSummaryInRequest: false,
    loginClaimInRequest: false,
    mixedToolRows: true,
    stubOutput: stub.stubBodies[0] ?? null,
  });
  try {
    await withPinnedCaptureClock(() =>
      compactHistory(
        {
          prisma: mockCompactionPrisma(state) as unknown as PrismaClient,
          runtime: new PiAgentRuntime(),
          jobs,
          memoryProviders,
          resolveModel: async () => captureRunModel(stub.baseUrl),
        },
        threadId,
      ),
    );
    const summary =
      typeof state.thread.historyCompactionSummary === "string"
        ? state.thread.historyCompactionSummary
        : null;
    const invoked = stub.captures.length > 0 && Boolean(summary);
    const requestText = stub.parsedBodies.map((body) => JSON.stringify(body ?? {})).join("\n");
    return {
      service,
      gate: invoked ? "invoked" : "unmet",
      matched: false,
      invoked,
      deployedBoundary: "compactHistory",
      reason: invoked
        ? undefined
        : "compactHistory returned without a summarizer HTTP call or writeback",
      captures: stub.captures,
      rawBodies: stub.rawBodies,
      parsedBodies: stub.parsedBodies,
      stubBodies: stub.stubBodies,
      writeback: {
        summary,
        historyCompactedUpToSeq:
          typeof state.thread.historyCompactedUpToSeq === "number"
            ? state.thread.historyCompactedUpToSeq
            : null,
      },
      usageRecorded: state.usage > 0,
      clockPinned: requestText.includes(clockIso.replace(/\.\d{3}Z$/, "Z")) || requestText.includes(clockIso.slice(0, 10)),
      clockIso,
      priorSummaryInRequest: requestText.includes("previous_compacted_summary"),
      loginClaimInRequest: requestText.includes(CAPTURE_LOGIN_CLAIM),
      mixedToolRows: requestText.includes("browser_snapshot") && requestText.includes("BEGIN_TOOL_RESULT_"),
      stubOutput: stub.stubBodies[0] ?? null,
    };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return unmet(`compactHistory dependency-closure or runtime blocker: ${message}`);
  } finally {
    await stub.close();
  }
}

export async function captureParserGuardCases(service: string): Promise<{
  service: string;
  validcall: { captures: CapturedHttp[]; parsedNames: string[]; usedFullPromptTools: boolean };
  malformed: { captures: CapturedHttp[]; guardDroppedNameless: boolean; usedFullPromptTools: boolean };
  twoCalls: { captures: CapturedHttp[]; parsedNames: string[]; usedFullPromptTools: boolean };
  fourIdenticalToolErrors: {
    captures: CapturedHttp[];
    identicalToolErrors: number;
    validBrowserActCalls: number;
    usedHttp500: boolean;
  };
}> {
  const assembled = await assembleCapturePrompt();
  const tools = assembled.tools;
  const valid = await runParserCase(service, "validcall", assembled, [
    {
      kind: "sse",
      finish: "tool_calls",
      events: toolCallDelta("call_valid", "browser_snapshot", {}),
    },
    { kind: "sse", finish: "stop", events: [{ content: "validcall-ok" }] },
  ]);
  const malformed = await runParserCase(service, "malformed", assembled, [
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
  ]);
  const two = await runParserCase(service, "two-calls", assembled, [
    {
      kind: "sse",
      finish: "tool_calls",
      events: [
        ...toolCallDelta("call_two_a", "browser_snapshot", { page: 1 }, 0),
        ...toolCallDelta("call_two_b", "web_fetch", { url: "https://capture.example.test/b" }, 1),
      ],
    },
    { kind: "sse", finish: "stop", events: [{ content: "two-calls-ok" }] },
  ]);
  const fourErrors = await runParserCase(service, "four-identical-tool-errors", assembled, [
    ...[1, 2, 3, 4].map((index) => ({
      kind: "sse" as const,
      finish: "tool_calls",
      events: toolCallDelta(
        `call_err_${index}`,
        "browser_act",
        VALID_BROWSER_ACT_ARGS as unknown as Record<string, unknown>,
      ),
    })),
    {
      kind: "sse",
      finish: "stop",
      events: [{ content: "four-identical-tool-errors-done" }],
    },
    ...extraStopReplies(4),
  ]);

  const namelessTranscript = withoutNamelessToolCalls([
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_malformed", name: "", arguments: {} }],
    } as Message,
  ]);
  const usedFull = (captures: CapturedHttp[]) =>
    captures.some((capture) => capture.toolNames.length === tools.length);

  return {
    service,
    validcall: {
      captures: valid.captures,
      parsedNames: toolNamesFromAssistant(valid.parsedBodies),
      usedFullPromptTools: usedFull(valid.captures),
    },
    malformed: {
      captures: malformed.captures,
      usedFullPromptTools: usedFull(malformed.captures),
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
      usedFullPromptTools: usedFull(two.captures),
    },
    fourIdenticalToolErrors: {
      captures: fourErrors.captures,
      identicalToolErrors: identicalToolErrorCount(fourErrors.parsedBodies),
      validBrowserActCalls: validBrowserActCallCount(fourErrors.parsedBodies),
      usedHttp500: fourErrors.captures.some((capture) => capture.phase === "four-identical-tool-errors")
        ? false
        : false,
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
  assembled: Awaited<ReturnType<typeof assembleCapturePrompt>>,
  replies: StubReply[],
) {
  const snapshots = { value: 0 };
  const stub = await startCaptureStub({
    modelId: loadCaptureModelMetadata().id,
    caseName,
    replies,
  });
  try {
    try {
      await drainRuntime(new PiAgentRuntime(), {
        botId: "bot-synthetic-capture",
        threadId: "thread-synthetic-capture",
        runId: `run-synthetic-${caseName}-${service}`,
        prompt: assembled.prompt,
        instructions: assembled.instructions,
        history: [],
        tools: assembled.tools,
        contextStrategy: captureContextStrategy().value,
        allowSilentEmpty: true,
        model: captureRunModel(stub.baseUrl),
        executeTool: async (name, args) => executeSyntheticTool(name, args, snapshots),
      });
    } catch {
      // Parser/guard failures are recorded via stub captures.
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

export function gitSha(): { value: null; reason: string; baseSha: string } {
  return {
    value: null,
    reason: "no .git in capture image; do not fabricate a live checkout SHA",
    baseSha: CAPTURE_BASE_SHA,
  };
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
  const model = loadCaptureModelMetadata();
  const strategy = captureContextStrategy();
  const timezone = captureTimeZone(service);
  const workerBaseline = service === "worker";
  return {
    kind: ISOLATED_CAPTURE_KIND,
    service,
    servingChief: "worker",
    baseline: workerBaseline ? "worker" : "api-comparison",
    gitSha: gitSha(),
    baseSha: CAPTURE_BASE_SHA,
    piAiParserVersion: pinPiAiVersion(),
    piToolCallGuard: pinToolCallGuardHash(),
    imageIds: {
      worker: process.env.RAKAZO_WORKER_IMAGE_ID ?? CAPTURE_IMAGE_IDS.worker,
      api: process.env.RAKAZO_API_IMAGE_ID ?? CAPTURE_IMAGE_IDS.api,
      source: process.env.RAKAZO_WORKER_IMAGE_ID
        ? "RAKAZO_*_IMAGE_ID from docker inspect"
        : "parent-reported local image ids from deploy; not a live-image-tested claim",
    },
    imageTags: {
      worker: process.env.RAKAZO_WORKER_IMAGE_TAG ?? CAPTURE_IMAGE_TAGS.worker,
      api: process.env.RAKAZO_API_IMAGE_TAG ?? CAPTURE_IMAGE_TAGS.api,
    },
    captureClock: captureClock().toISOString(),
    timezone,
    contextStrategy: strategy,
    disabledBuiltinTools: {
      botRow: [],
      envDefault: CAPTURE_DEFAULT_DISABLED_TOOLS.split(","),
      effective: captureDisabledBuiltinTools(),
      caller: "overlay assistDisabledTools(bot.disabledBuiltinTools) or HEAD env split",
      promptBuilder: "assistSplitInstructions/userTurnInstructions parts.disabledBuiltinTools",
    },
    fleetManagement: captureFleetManagement(),
    olderToolResultShortening: OLDER_RESULT_SHORTENING,
    modelResolution: {
      ...model,
      spaceDefault: {
        modelId: CAPTURE_MODEL_ID,
        credentialProvider: OPENAI_COMPATIBLE_PROVIDER_ID,
        isDefault: true,
        supportsImages: true,
      },
      botOverride: { modelProvider: null, modelId: null, thinkingLevel: null },
      deploymentSettings: { defaultModelProvider: null, defaultModelId: null },
      runsLast7d: {
        count: 81,
        modelProvider: OPENAI_COMPATIBLE_PROVIDER_ID,
        modelId: CAPTURE_MODEL_ID,
      },
      secretMaxTokens: {
        observed: false,
        value: null,
        reason: "encrypted credential field; not exported",
      },
      derivedMaxTokens: model.maxTokens,
      derivedVia: `resolveCompletionMaxTokens(undefined, undefined, undefined, reasoning=${String(model.reasoning)})`,
      reasoningModelMaxTokens: REASONING_MODEL_MAX_TOKENS,
      rejectedStub4096: model.rejectedStub4096,
      contractsDefaultMaxTokens: DEFAULT_MODEL_MAX_TOKENS,
    },
    workerTypedEnvObserved: {
      RAKAZO_DEFAULT_TIMEZONE: CAPTURE_WORKER_TIMEZONE,
      RAKAZO_ASSIST_SCHEDULE_GUARD: "1",
      RAKAZO_DEDUPE_FINAL_POSTS: "1",
      RAKAZO_SUBAGENT_STEERING: "1",
      RAKAZO_ASSIST_DEFAULT_DISABLED_TOOLS: CAPTURE_DEFAULT_DISABLED_TOOLS,
      apiValuesObserved: false,
    },
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
    historicalExactRequests: HISTORICAL_CANDIDATE_WORDING,
    unobserved: [
      "encrypted openai-compatible secret.maxTokens/contextWindow/reasoning",
      "API docker-inspect values for timezone/schedule/dedupe/steering (names present)",
    ],
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
  stubSse?: string,
) {
  writeFileSync(join(dir, `${name}.bin`), raw);
  writeFileSync(
    join(dir, `${name}.json`),
    `${JSON.stringify({ ...capture, parsedBody: parsed }, null, 2)}\n`,
  );
  if (stubSse) writeFileSync(join(dir, `${name}.sse`), stubSse);
}

export async function runIsolatedCapture(options: {
  outDir: string;
  service: string;
}): Promise<{ outDir: string; hashManifest: Record<string, string> }> {
  const outDir = options.outDir;
  mkdirSync(outDir, { recursive: true });
  const phases = await capturePhaseTurn(options.service);
  const guardB = await captureGuardPathB(options.service);
  const guardC = await captureGuardPathC(options.service);
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

  for (const [label, guard] of [
    ["guard-b", guardB],
    ["guard-c", guardC],
  ] as const) {
    const dir = join(outDir, label);
    mkdirSync(dir, { recursive: true });
    for (const [index, capture] of guard.captures.entries()) {
      writeBinAndJson(
        dir,
        `${capture.phase}-${index}`,
        capture,
        guard.rawBodies[index]!,
        guard.parsedBodies[index] ?? null,
      );
    }
    writeFileSync(
      join(dir, "summary.json"),
      `${JSON.stringify(
        {
          path: guard.path,
          guardWarning: guard.guardWarning,
          guardHalt: guard.guardHalt,
          errorGuardPresent: guard.errorGuardPresent,
          skippedPresent: guard.skippedPresent,
          guardFinalToolFree: guard.guardFinalToolFree,
          noToolsKey: guard.noToolsKey,
          runtidyPrompt: guard.runtidyPrompt,
          haltAdvertisesTools: guard.haltAdvertisesTools,
        },
        null,
        2,
      )}\n`,
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
        distinctSnapshotArgs: pageTrim.distinctSnapshotArgs,
        distinctLargeSnapshotArgs: pageTrim.distinctLargeSnapshotArgs,
        distinctNavigateUrls: pageTrim.distinctNavigateUrls,
        trimmedNotePresent: pageTrim.trimmedNotePresent,
        page1Trimmed: pageTrim.page1Trimmed,
        page2Length: pageTrim.page2Length,
        page3Length: pageTrim.page3Length,
        page4Length: pageTrim.page4Length,
        page4Full: pageTrim.page4Full,
        shortControlUntouched: pageTrim.shortControlUntouched,
        errorControlUntouched: pageTrim.errorControlUntouched,
        clipped12k: pageTrim.clipped12k,
        olderResultShortening: pageTrim.olderResultShortening,
        toolResultTextLimit: TOOL_RESULT_TEXT_LIMIT,
        oversizedPageChars: OVERSIZED_PAGE_CHARS,
        requestCount: pageTrim.captures.length,
      },
      null,
      2,
    )}\n`,
  );

  const compactDir = join(outDir, "compaction");
  mkdirSync(compactDir, { recursive: true });
  for (const [index, capture] of compaction.captures.entries()) {
    writeBinAndJson(
      compactDir,
      `request-${index}`,
      capture,
      compaction.rawBodies[index] ?? Buffer.alloc(0),
      compaction.parsedBodies[index] ?? null,
      compaction.stubBodies[index],
    );
  }
  writeFileSync(
    join(compactDir, compaction.invoked ? "invoked.json" : "unmet.json"),
    `${JSON.stringify(
      {
        service: compaction.service,
        gate: compaction.gate,
        matched: compaction.matched,
        invoked: compaction.invoked,
        deployedBoundary: compaction.deployedBoundary,
        reason: compaction.reason,
        writeback: compaction.writeback,
        usageRecorded: compaction.usageRecorded,
        clockPinned: compaction.clockPinned,
        clockIso: compaction.clockIso,
        priorSummaryInRequest: compaction.priorSummaryInRequest,
        loginClaimInRequest: compaction.loginClaimInRequest,
        mixedToolRows: compaction.mixedToolRows,
        stubOutputPresent: Boolean(compaction.stubOutput),
      },
      null,
      2,
    )}\n`,
  );

  writeFileSync(
    join(outDir, "paths-taken.json"),
    `${JSON.stringify(
      {
        guardWarning: phases.guardWarning,
        guardHalt: phases.guardHalt,
        guardFinalToolFree: phases.guardFinalToolFree,
        pathA: {
          haltAdvertisesTools: phases.haltAdvertisesTools,
          skippedPresent: phases.skippedPresent,
          runtidyPrompt: phases.runtidyPrompt,
          errorGuardPresent: phases.errorGuardPresent,
          guardFinalToolFree: phases.guardFinalToolFree,
        },
        pathB: {
          guardWarning: guardB.guardWarning,
          guardHalt: guardB.guardHalt,
          skippedPresent: guardB.skippedPresent,
          guardFinalToolFree: guardB.guardFinalToolFree,
          noToolsKey: guardB.noToolsKey,
          runtidyPrompt: guardB.runtidyPrompt,
          errorGuardPresent: guardB.errorGuardPresent,
        },
        pathC: {
          guardWarning: guardC.guardWarning,
          guardHalt: guardC.guardHalt,
          skippedPresent: guardC.skippedPresent,
          guardFinalToolFree: guardC.guardFinalToolFree,
          noToolsKey: guardC.noToolsKey,
          runtidyPrompt: guardC.runtidyPrompt,
          errorGuardPresent: guardC.errorGuardPresent,
        },
        validBrowserActCalls: phases.validBrowserActCalls,
        identicalToolErrors: phases.identicalToolErrors,
        reasoningInspected: phases.reasoningInspected,
        thinkingReenabled: phases.thinkingReenabled,
        promptClauses: phases.promptClauses,
        pruningDistinctSnapshotArgs: pageTrim.distinctLargeSnapshotArgs.length,
        pruningDistinctNavigate: pageTrim.distinctNavigateUrls.length,
        pruningKeptPageMarkers: pageTrim.keptPageMarkers,
        pruningStaleNote: pageTrim.trimmedNotePresent,
        pruningPage1Trimmed: pageTrim.page1Trimmed,
        pruningControlsUntouched:
          pageTrim.shortControlUntouched && pageTrim.errorControlUntouched,
        compactionInvoked: compaction.invoked,
        compactionClockPinned: compaction.clockPinned,
        compactionPriorSummary: compaction.priorSummaryInRequest,
        compactionLoginClaim: compaction.loginClaimInRequest,
        servingChief: "worker",
        gateMet: false,
      },
      null,
      2,
    )}\n`,
  );

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
        withheldRationale: phases.toolInventory.withheldRationale,
        reviewerExpectedWorkerBuiltins: phases.toolInventory.reviewerExpectedWorkerBuiltins,
        reviewerCountMatch: phases.toolInventory.reviewerCountMatch,
        missingConnectors: phases.toolInventory.missingConnectors,
        missingDynamicResolution: phases.toolInventory.missingDynamicResolution,
        connectorToolNames: phases.toolInventory.connectorTools.map((tool) => tool.name),
        fleetManagement: captureFleetManagement(),
        offeredFleetTools: offeredFleetTools(phases.toolInventory.tools),
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
          invoked: compaction.invoked,
          deployedBoundary: compaction.deployedBoundary,
          reason: compaction.reason,
        },
        promptClauses: phases.promptClauses,
        pathsTaken: {
          guardWarning: phases.guardWarning,
          guardHalt: phases.guardHalt,
          guardFinalToolFree: phases.guardFinalToolFree,
          pathA: {
            haltAdvertisesTools: phases.haltAdvertisesTools,
            skippedPresent: phases.skippedPresent,
            runtidyPrompt: phases.runtidyPrompt,
          },
          pathB: {
            skippedPresent: guardB.skippedPresent,
            guardFinalToolFree: guardB.guardFinalToolFree,
            noToolsKey: guardB.noToolsKey,
            runtidyPrompt: guardB.runtidyPrompt,
          },
          pathC: {
            errorGuardPresent: guardC.errorGuardPresent,
            skippedPresent: guardC.skippedPresent,
            guardFinalToolFree: guardC.guardFinalToolFree,
            noToolsKey: guardC.noToolsKey,
            runtidyPrompt: guardC.runtidyPrompt,
          },
          validBrowserActCalls: phases.validBrowserActCalls,
          identicalToolErrors: phases.identicalToolErrors,
          reasoningInspected: phases.reasoningInspected,
          thinkingReenabled: phases.thinkingReenabled,
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
    `${HISTORICAL_CANDIDATE_WORDING}\n`,
  );
  const hashManifest: Record<string, string> = {};
  hashTree(outDir, outDir, hashManifest);
  writeFileSync(join(outDir, "HASHMANIFEST.tsv"), renderManifest(hashManifest));
  return { outDir, hashManifest };
}

function hashTree(root: string, dir: string, into: Record<string, string>) {
  for (const entry of readdirSync(dir)) {
    if (entry === "HASHMANIFEST.tsv" || entry === "SHA256SUMS") continue;
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
