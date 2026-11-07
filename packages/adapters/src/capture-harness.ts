import type { ConnectorTool } from "@rakazo/adapter-kit";
import { builtinAgentTools } from "./builtin-tools.js";
import { parametersFor } from "./pi-runtime.js";
import { MODEL_STREAM_IDLE_TIMEOUT_MS, MODEL_STREAM_TIMEOUT_MS } from "./pi-runtime-limits.js";

export const CAPTURE_LABEL = "code-derived-not-captured";

export type CapturedToolWire = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
};

export function serializeToolsWire(tools: readonly ConnectorTool[]): CapturedToolWire[] {
  return [...tools]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: JSON.parse(JSON.stringify(parametersFor(tool))),
      },
    }));
}

export function captureBuiltinToolsJson(): {
  label: typeof CAPTURE_LABEL;
  variant: "base";
  tools: CapturedToolWire[];
} {
  return {
    label: CAPTURE_LABEL,
    variant: "base",
    tools: serializeToolsWire(builtinAgentTools),
  };
}

export const SANITIZED_PRODUCTION_SHAPED_ENV: Record<string, string> = {
  RAKAZO_MODEL_STREAM_TIMEOUT_MS: "600000",
  MAX_TOOL_CALLS_PER_TURN: "150",
  RAKAZO_THINKING_BUDGET: "64",
  RAKAZO_THINKING_BUDGET_MODELS: "qwen3.8-flash-next",
};

export type CaptureEnvSource = "agent-vm-defaults" | "sanitized-production-shaped";

export function captureCallLimits(
  env: NodeJS.ProcessEnv = process.env,
  envSource: CaptureEnvSource = "agent-vm-defaults",
): {
  label: typeof CAPTURE_LABEL;
  envSource: CaptureEnvSource;
  productionFaithful: false;
  liveGate: "locked";
  thinking: {
    budget: string | null;
    models: string | null;
    fastComputerSteps: string | null;
    chatTemplateKwargs: string | null;
    unchanged: true;
  };
  maxTokensDefault: number;
  parallelToolCalls: null;
  streamTimeoutMs: number;
  streamIdleTimeoutMs: number;
  maxToolCallsPerTurn: string | null;
} {
  return {
    label: CAPTURE_LABEL,
    envSource,
    productionFaithful: false,
    liveGate: "locked",
    thinking: {
      budget: env.RAKAZO_THINKING_BUDGET ?? null,
      models: env.RAKAZO_THINKING_BUDGET_MODELS ?? null,
      fastComputerSteps: env.RAKAZO_FAST_COMPUTER_STEPS ?? null,
      chatTemplateKwargs: env.RAKAZO_OPENAI_COMPAT_CHAT_TEMPLATE_KWARGS ?? null,
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

export const PRODUCTION_CAPTURE = "production-live-not-present";
export const RECONSTRUCTION = "reconstruction-overlay-offline";

export function toolNamesFromBuiltinSource(source: string): string[] {
  const names = [...source.matchAll(/^\s*name:\s*"([a-z0-9_]+)"/gm)].map((match) => match[1]!);
  return [...new Set(names)];
}

export async function captureOverlayToolNames(overlayRoot: string | undefined): Promise<{
  kind: typeof RECONSTRUCTION;
  productionCapture: false;
  worker: string[] | null;
  api: string[] | null;
} | null> {
  if (!overlayRoot) return null;
  const { readFile } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const root = overlayRoot.replace(/\/$/, "");
  const workerPath = `${root}/opt/docker/rakazo/patches/savedlogins-20261104/src/worker/builtin-tools.ts`;
  const apiPath = `${root}/opt/docker/rakazo/patches/browserextract/builtin-tools.ts`;
  const readNames = async (path: string) =>
    existsSync(path) ? toolNamesFromBuiltinSource(await readFile(path, "utf8")) : null;
  return {
    kind: RECONSTRUCTION,
    productionCapture: false,
    worker: await readNames(workerPath),
    api: await readNames(apiPath),
  };
}

export async function captureOverlayToolsJson(overlayRoot: string | undefined): Promise<{
  label: typeof CAPTURE_LABEL;
  kind: typeof RECONSTRUCTION;
  productionCapture: false;
  variant: "worker" | "api";
  tools: CapturedToolWire[];
} | null> {
  const names = await captureOverlayToolNames(overlayRoot);
  const variant = names?.worker?.length ? "worker" : names?.api?.length ? "api" : "";
  if (!names || !variant) return null;
  const listed = variant === "worker" ? names.worker : names.api;
  if (!listed) return null;
  const byName = new Map(
    serializeToolsWire(builtinAgentTools).map((tool) => [tool.function.name, tool]),
  );
  return {
    label: CAPTURE_LABEL,
    kind: RECONSTRUCTION,
    productionCapture: false,
    variant,
    tools: listed.map(
      (name) =>
        byName.get(name) ?? {
          type: "function" as const,
          function: { name, description: "overlay-only-name-reconstruction", parameters: {} },
        },
    ),
  };
}

export function reconstructOfflinePhases(input: {
  apiToolNames: string[];
  workerToolNames: string[];
  limits: ReturnType<typeof captureCallLimits>;
  baseTools: CapturedToolWire[];
}): {
  kind: typeof RECONSTRUCTION;
  productionCapture: false;
  productionFaithful: false;
  productionLiveCapture: typeof PRODUCTION_CAPTURE;
  liveGate: "locked";
  thinkingUnchanged: true;
  phases: {
    first: { tools: CapturedToolWire[]; params: ReturnType<typeof captureCallLimits> };
    postbrowser: { tools: CapturedToolWire[]; params: ReturnType<typeof captureCallLimits> };
    "guard-final": { tools: CapturedToolWire[]; params: ReturnType<typeof captureCallLimits> };
  };
  apiWorkerNameDelta: string[];
} {
  const params = {
    ...input.limits,
    productionFaithful: false as const,
    liveGate: "locked" as const,
    thinking: { ...input.limits.thinking, unchanged: true as const },
  };
  return {
    kind: RECONSTRUCTION,
    productionCapture: false,
    productionFaithful: false,
    productionLiveCapture: PRODUCTION_CAPTURE,
    liveGate: "locked",
    thinkingUnchanged: true,
    phases: {
      first: { tools: input.baseTools, params },
      postbrowser: { tools: input.baseTools, params },
      "guard-final": { tools: input.baseTools, params },
    },
    apiWorkerNameDelta: [...new Set([...input.apiToolNames, ...input.workerToolNames])].filter(
      (name) => !input.apiToolNames.includes(name) || !input.workerToolNames.includes(name),
    ),
  };
}
