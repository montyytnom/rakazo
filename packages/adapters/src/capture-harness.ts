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

export function captureCallLimits(env: NodeJS.ProcessEnv = process.env): {
  label: typeof CAPTURE_LABEL;
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

export async function captureOverlayToolsJson(overlayRoot: string | undefined): Promise<{
  label: typeof CAPTURE_LABEL;
  variant: "worker" | "api";
  tools: CapturedToolWire[];
} | null> {
  if (!overlayRoot) return null;
  const worker = `${overlayRoot.replace(/\/$/, "")}/opt/docker/rakazo/patches/savedlogins-20261104/src/worker/builtin-tools.ts`;
  const api = `${overlayRoot.replace(/\/$/, "")}/opt/docker/rakazo/patches/browserextract/builtin-tools.ts`;
  const { pathToFileURL } = await import("node:url");
  const { existsSync } = await import("node:fs");
  const target = existsSync(worker) ? worker : existsSync(api) ? api : "";
  if (!target) return null;
  const mod = (await import(pathToFileURL(target).href)) as { builtinAgentTools?: ConnectorTool[] };
  if (!Array.isArray(mod.builtinAgentTools)) return null;
  return {
    label: CAPTURE_LABEL,
    variant: existsSync(worker) ? "worker" : "api",
    tools: serializeToolsWire(mod.builtinAgentTools),
  };
}
