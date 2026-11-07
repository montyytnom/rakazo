import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { PiAgentRuntime } from "./pi-runtime.js";
import {
  ERROR_GUARD_PREFIX,
  GUARD_EXTRACT_TOOL,
  GUARD_ORCHESTRATION_TOOL,
  IDENTICAL_TOOL_ERROR,
  LOOP_GUARD_PREFIX,
  SKIPPED_LOOP_GUARD,
  STALE_REF_ERROR,
  VALID_BROWSER_ACT_ARGS,
  VALID_BROWSER_EXTRACT_ARGS,
  captureRunModel,
  loadCaptureModelMetadata,
  startCaptureStub,
} from "./isolated-capture.js";

const repo = path.resolve(import.meta.dirname, "../../..");
const overlay = process.env.OVERLAY_EXPORT ?? "/tmp/overlay-export/overlay-export";
const composeOut = existsSync("/tmp/compose-check/worker/after/packages/adapters/src/pi-runtime.ts")
  ? "/tmp/compose-check"
  : path.join(repo, ".compose");
const afterRoot = path.join(composeOut, "worker/after/packages/adapters/src");
const afterPi = path.join(afterRoot, "pi-runtime.ts");
const afterLoopGuard = path.join(afterRoot, "loop-guard.ts");
const afterBrowserTools = path.join(afterRoot, "browser-tools.ts");
const afterComputerBrowser = path.join(afterRoot, "computer-browser.ts");
const afterDockerSandbox = path.join(afterRoot, "docker-sandbox.ts");
const afterScreens = path.join(afterRoot, "computer-screens.ts");
const afterStale = path.join(afterRoot, "stale-element-recovery.ts");
const overlayHelper = path.join(
  overlay,
  "opt/docker/rakazo/patches/savedlogins-20261104/computer-image/page-browser",
);
const overlaySupervisor = path.join(
  overlay,
  "opt/docker/rakazo/patches/savedlogins-20261104/src/supervisor/supervisor-index.ts",
);
const piAgentLoop = path.join(
  repo,
  "packages/adapters/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js",
);

/** Production-effective composed overlay hashes (worker after-tree). */
const COMPOSED_SHA256 = {
  piRuntime: "90cf3b42fcb14e26760dc9c22fc281d4ed442ab662d7e3a0436bf9dac5d5e7e0",
  loopGuard: "82624ab7e1e6d41cf82dacff5a9975978f321d19a68d08d3019e0b183231f339",
  browserTools: "2136167d088718a8a3d81455862f15af80ed50d70630eb59ac60e8475f953992",
  computerBrowser: "060a6e63c02db1d2f3dca8ce6a295d28fe93fc388c130cb0734564b0e442f5e6",
  dockerSandbox: "fda3d3fe2429b0eb065cd5b7e099eae4f6bfbe8e3c8d351a492dc282e65013e2",
  helper: "f49e951b5c4df8021265bb7d8389b364fa5adab8324631f3ad7edac4a81e3e1b",
  supervisor: "5ce66338f5c5cdfee2cfb77a1263fcf35d4f36a4cf3d1eeafeae7e166a51303d",
} as const;

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function missingOverlay(): string[] {
  const required = ["MOUNT-MAP.tsv", "FILE-HASHES.tsv", "COMPOSE-CHAINS.txt"];
  if (!existsSync(overlay)) return [overlay];
  return required.filter((rel) => !existsSync(path.join(overlay, rel))).map((rel) => path.join(overlay, rel));
}

function composeWorker() {
  const script = path.join(repo, "scripts/compose-overlay-trees.py");
  for (const patch of [false, true]) {
    const result = spawnSync(
      "python3",
      [script, "--overlay", overlay, "--out", composeOut, "--service", "worker", ...(patch ? ["--patch"] : [])],
      { cwd: repo, encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(`compose failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
    }
  }
}

function extraStopReplies(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    kind: "sse" as const,
    finish: "stop" as const,
    events: [{ content: `synthetic-stop-${index}` }],
  }));
}

function toolCallDelta(id: string, name: string, args: Record<string, unknown>) {
  return [
    {
      tool_calls: [
        {
          index: 0,
          id,
          type: "function",
          function: { name, arguments: "" },
        },
      ],
    },
    {
      tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }],
    },
  ];
}

function toolResultTexts(bodies: Array<Record<string, unknown> | null>): string[] {
  const texts: string[] = [];
  for (const body of bodies) {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    for (const message of messages) {
      if (!message || typeof message !== "object") continue;
      const role = (message as { role?: unknown }).role;
      if (role !== "tool" && role !== "toolResult") continue;
      const content = (message as { content?: unknown }).content;
      texts.push(typeof content === "string" ? content : JSON.stringify(content ?? ""));
    }
  }
  return texts;
}

async function drainRuntime(runtime: PiAgentRuntime, request: Parameters<PiAgentRuntime["run"]>[0]) {
  const events: unknown[] = [];
  for await (const event of runtime.run(request, { signal: AbortSignal.timeout(90_000) })) {
    events.push(event);
  }
  return events;
}

async function runStubbedBrowserCalls(options: {
  runtime: PiAgentRuntime;
  runId: string;
  toolName: "browser_act" | "browser_extract";
  executeTool: (name: string, args: Record<string, unknown>) => unknown | Promise<unknown>;
}): Promise<{
  parsedBodies: Array<Record<string, unknown> | null>;
  hay: string;
  toolTexts: string[];
  toolHay: string;
}> {
  process.env.RAKAZO_GUARD_FINAL_SUMMARY ??= "1";
  const meta = loadCaptureModelMetadata();
  const args =
    options.toolName === "browser_extract"
      ? (VALID_BROWSER_EXTRACT_ARGS as unknown as Record<string, unknown>)
      : (VALID_BROWSER_ACT_ARGS as unknown as Record<string, unknown>);
  const stub = await startCaptureStub({
    modelId: meta.id,
    caseName: "guard-throw-vs-return",
    replies: [
      ...[1, 2, 3, 4].map((index) => ({
        kind: "sse" as const,
        finish: "tool_calls" as const,
        events: toolCallDelta(`call_r8_${options.toolName}_${index}`, options.toolName, args),
      })),
      {
        kind: "sse" as const,
        finish: "tool_calls" as const,
        events: toolCallDelta(`call_r8_${options.toolName}_ignored_halt`, options.toolName, args),
      },
      {
        kind: "sse" as const,
        finish: "stop" as const,
        events: [{ content: "guard-throw-vs-return-stop" }],
      },
      ...extraStopReplies(8),
    ],
  });
  try {
    await drainRuntime(options.runtime, {
      botId: "bot-guard-throw-vs-return",
      threadId: "thread-guard-throw-vs-return",
      runId: options.runId,
      prompt: "Synthetic throw-vs-return guard visibility. No live accounts or browsing.",
      instructions: "Follow tool results. Do not invent side effects.",
      history: [],
      tools: [options.toolName === "browser_extract" ? GUARD_EXTRACT_TOOL : GUARD_ORCHESTRATION_TOOL],
      contextStrategy: "retrieval",
      allowSilentEmpty: true,
      model: captureRunModel(stub.baseUrl),
      executeTool: async (name, toolArgs) =>
        options.executeTool(name, toolArgs as Record<string, unknown>),
    });
    const toolTexts = toolResultTexts(stub.parsedBodies);
    return {
      parsedBodies: stub.parsedBodies,
      hay: stub.parsedBodies.map((body) => JSON.stringify(body ?? {})).join("\n"),
      toolTexts,
      toolHay: toolTexts.join("\n"),
    };
  } finally {
    await stub.close();
  }
}

describe("overlay executeTool return vs throw warning visibility", () => {
  const missing = missingOverlay();

  beforeAll(() => {
    if (missing.length) return;
    if (!existsSync(afterPi) || !existsSync(afterLoopGuard)) composeWorker();
  });

  it("has the supplied overlay archive required to compose production-effective trees", () => {
    if (missing.length) {
      throw new Error(`overlay compose blocked; missing files/dependencies:\n${missing.join("\n")}`);
    }
    expect(missing).toEqual([]);
  });

  it("pins production-effective overlay hashes for the classified call chain", () => {
    if (missing.length) return;
    expect(sha256File(afterPi)).toBe(COMPOSED_SHA256.piRuntime);
    expect(sha256File(afterLoopGuard)).toBe(COMPOSED_SHA256.loopGuard);
    expect(sha256File(afterBrowserTools)).toBe(COMPOSED_SHA256.browserTools);
    expect(sha256File(afterComputerBrowser)).toBe(COMPOSED_SHA256.computerBrowser);
    expect(sha256File(afterDockerSandbox)).toBe(COMPOSED_SHA256.dockerSandbox);
    expect(sha256File(overlayHelper)).toBe(COMPOSED_SHA256.helper);
    expect(sha256File(overlaySupervisor)).toBe(COMPOSED_SHA256.supervisor);
  });

  it("overlay catch observes guards then rethrows without appending verdict.message", () => {
    if (missing.length) return;
    const src = readFileSync(afterPi, "utf8");
    expect(src).toContain("content: [...(guarded.content ?? []), { type: \"text\", text: verdict.message }]");
    expect(src).toContain("failure = error;");
    expect(src).toContain("loopGuard.observe(tool.name, args, undefined, error);");
    expect(src).toContain("assistErrorGuardObserve(host.request.runId, loopGuard, tool.name, undefined, error);");
    expect(src).toContain("throw error;");
    const catchIdx = src.indexOf("loopGuard.observe(tool.name, args, undefined, error);");
    const throwIdx = src.indexOf("throw error;", catchIdx);
    const appendIdx = src.lastIndexOf("verdict.message", throwIdx);
    expect(catchIdx).toBeGreaterThan(0);
    expect(throwIdx).toBeGreaterThan(catchIdx);
    expect(appendIdx).toBeGreaterThan(0);
    expect(appendIdx).toBeLessThan(catchIdx);
  });

  it("FromTool / provider / helper common failures RETURN {error} instead of throwing to execute", () => {
    if (missing.length) return;
    const fromTool = readFileSync(afterBrowserTools, "utf8");
    for (const fn of [
      "browserNavigateFromTool",
      "browserSnapshotFromTool",
      "browserExtractFromTool",
      "browserActFromTool",
    ]) {
      expect(fromTool).toContain(`export async function ${fn}`);
    }
    expect(fromTool).toContain("context.signal.throwIfAborted();");
    expect(fromTool).toContain('fallback: "computer_act" as const');
    expect(fromTool).toContain("return {\n      ok: false,\n      uncertain: true,\n      error:");
    expect(fromTool).toContain(
      "const refusal = /LOGIN_GUARD refused kind=([a-z-]+) rule=(\\S+) origin=(\\S+)/.exec(String(result.error ?? \"\"));",
    );

    const provider = readFileSync(afterComputerBrowser, "utf8");
    expect(provider).toContain("private async runLive(");
    expect(provider).toContain("if (live?.ok !== true && /LOGIN_GUARD refused/.test(String(live?.error ?? \"\")))");
    expect(provider).toContain("return {\n        uncertain: request.command === \"act\",\n        ok: false,");

    const docker = readFileSync(afterDockerSandbox, "utf8");
    expect(docker).toContain("if (!res.ok) throw new Error(`page browser failed: ${res.status}`)");

    const supervisor = readFileSync(overlaySupervisor, "utf8");
    expect(supervisor).toContain('app.post("/computers/:id/browser"');
    expect(supervisor).toContain("return c.json({");
    expect(supervisor).toContain('fallback: "computer_act"');
    expect(supervisor).toContain("Page browser timed out");

    const helper = readFileSync(overlayHelper, "utf8");
    expect(helper).toContain("throw new Error(`LOGIN_GUARD refused kind=${info.kind} rule=${info.rule} origin=${location.origin}`)");
    expect(helper).toContain('raise RuntimeError("Stale element ref. Take a fresh snapshot.")');
    expect(helper).toContain('return f"wait: TIMED OUT after {timeout} ms');
    expect(helper).toContain('refused = "LOGIN_GUARD refused" in str(exc)');
    expect(helper).toContain("return 0  # Structured failures preserve partial action progress.");

    const stale = readFileSync(afterStale, "utf8");
    expect(stale).toContain("if (first.ok || !isStaleElementError(first.error))");
    expect(stale).toContain("Do not retry the old ref.");

    const screens = readFileSync(afterScreens, "utf8");
    expect(screens).toContain("if (isComputerScreenUnavailable(error)) return { error: error.message };");
    expect(screens).toContain("throw error;");
  });

  it("Pi SDK converts thrown execute() into isError content without details.error", () => {
    const src = readFileSync(piAgentLoop, "utf8");
    expect(src).toContain("Never rejects for tool failures");
    expect(src).toContain("createErrorToolResult(error instanceof Error ? error.message : String(error))");
    expect(src).toContain("isError: true");
    expect(src).toContain("details: {},");
  });

  it("returned LOGIN_GUARD details.error appends LOOP GUARD text; thrown Error updates halt but drops it", async () => {
    if (missing.length) return;
    const { PiAgentRuntime } = await import(`${pathToFileURL(afterPi).href}?t=${Date.now()}`);

    const returned = await runStubbedBrowserCalls({
      runtime: new PiAgentRuntime(),
      runId: "run-guard-return-login",
      toolName: "browser_act",
      executeTool: async () => ({ ...IDENTICAL_TOOL_ERROR }),
    });
    expect(returned.toolHay).toContain(IDENTICAL_TOOL_ERROR.error);
    expect(returned.toolHay).toContain(`${LOOP_GUARD_PREFIX}:`);
    expect(returned.toolHay).toContain(SKIPPED_LOOP_GUARD);
    expect(returned.toolHay).not.toContain(`${ERROR_GUARD_PREFIX}:`);

    const thrown = await runStubbedBrowserCalls({
      runtime: new PiAgentRuntime(),
      runId: "run-guard-throw-login",
      toolName: "browser_act",
      executeTool: async () => {
        throw new Error(IDENTICAL_TOOL_ERROR.error);
      },
    });
    expect(thrown.toolHay).toContain(IDENTICAL_TOOL_ERROR.error);
    expect(thrown.toolHay).not.toContain(`${LOOP_GUARD_PREFIX}:`);
    expect(thrown.toolHay).not.toContain(`${ERROR_GUARD_PREFIX}:`);
    expect(thrown.toolHay).toContain(SKIPPED_LOOP_GUARD);
  }, 90_000);

  it("returned extract isError/details.error appends ERROR GUARD text; thrown extract drops it", async () => {
    if (missing.length) return;
    const { PiAgentRuntime } = await import(`${pathToFileURL(afterPi).href}?t=${Date.now()}`);

    const returned = await runStubbedBrowserCalls({
      runtime: new PiAgentRuntime(),
      runId: "run-guard-return-extract",
      toolName: "browser_extract",
      executeTool: async () => ({ error: STALE_REF_ERROR, isError: true }),
    });
    expect(returned.toolHay).toContain(STALE_REF_ERROR);
    expect(returned.toolHay).toContain(`${ERROR_GUARD_PREFIX}:`);
    expect(returned.toolHay).not.toContain(`${LOOP_GUARD_PREFIX}:`);
    expect(returned.toolHay).toContain(SKIPPED_LOOP_GUARD);

    const thrown = await runStubbedBrowserCalls({
      runtime: new PiAgentRuntime(),
      runId: "run-guard-throw-extract",
      toolName: "browser_extract",
      executeTool: async () => {
        throw new Error(STALE_REF_ERROR);
      },
    });
    expect(thrown.toolHay).toContain(STALE_REF_ERROR);
    expect(thrown.toolHay).not.toContain(`${ERROR_GUARD_PREFIX}:`);
    expect(thrown.toolHay).not.toContain(`${LOOP_GUARD_PREFIX}:`);
    expect(thrown.toolHay).toContain(SKIPPED_LOOP_GUARD);
  }, 90_000);
});
