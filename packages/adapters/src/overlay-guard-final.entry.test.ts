import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  captureLoopGuardOrchestration,
  ERROR_GUARD_PREFIX,
  IDENTICAL_TOOL_ERROR,
  LOOP_GUARD_PREFIX,
  SKIPPED_LOOP_GUARD,
  STALE_REF_ERROR,
} from "./isolated-capture.js";
import { PiAgentRuntime as HeadPiAgentRuntime } from "./pi-runtime.js";

const repo = path.resolve(import.meta.dirname, "../../..");
const overlay = process.env.OVERLAY_EXPORT ?? "/tmp/overlay-export/overlay-export";
const composeOut = existsSync("/tmp/compose-check/worker/after/packages/adapters/src/pi-runtime.ts")
  ? "/tmp/compose-check"
  : path.join(repo, ".compose");
const afterPi = path.join(composeOut, "worker/after/packages/adapters/src/pi-runtime.ts");
const afterExecutor = path.join(composeOut, "worker/after/packages/adapters/src/executor.ts");
const afterLoopGuard = path.join(composeOut, "worker/after/packages/adapters/src/loop-guard.ts");
const headPi = path.join(repo, "packages/adapters/src/pi-runtime.ts");
const headExecutor = path.join(repo, "packages/adapters/src/executor.ts");
const orchestrationHarness = path.join(
  repo,
  "packages/adapters/src/overlay-orchestration.entry.test.ts",
);

function missingOverlay(): string[] {
  const required = [
    "MOUNT-MAP.tsv",
    "FILE-HASHES.tsv",
    "COMPOSE-CHAINS.txt",
    "opt/docker/rakazo/patches/amazon-signin-verify-20261106/worker/src/worker/executor.ts",
  ];
  if (!existsSync(overlay)) return [overlay];
  return required.filter((rel) => !existsSync(path.join(overlay, rel))).map((rel) => path.join(overlay, rel));
}

function composeWorker() {
  const script = path.join(repo, "scripts/compose-overlay-trees.py");
  for (const patch of [false, true]) {
    const result = spawnSync(
      "python3",
      [
        script,
        "--overlay",
        overlay,
        "--out",
        composeOut,
        "--service",
        "worker",
        ...(patch ? ["--patch"] : []),
      ],
      { cwd: repo, encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(
        `compose failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
      );
    }
  }
}

type LoopGuardCtor = new () => {
  observe: (
    tool: string,
    args: Record<string, unknown>,
    result: unknown,
    failure: unknown,
  ) => { kind: string; message?: string };
};

const loginGuardResult = {
  content: [{ type: "text", text: IDENTICAL_TOOL_ERROR.error }],
  details: { error: IDENTICAL_TOOL_ERROR.error },
};
const actArgs = { actions: [{ kind: "click", ref: "e1" }] };

describe("overlay guard-final orchestration boundary", () => {
  const missing = missingOverlay();

  beforeAll(() => {
    if (missing.length) return;
    if (!existsSync(afterPi) || !existsSync(afterLoopGuard)) composeWorker();
  });

  it("has the supplied overlay archive required to compose production-effective trees", () => {
    if (missing.length) {
      throw new Error(
        `overlay compose blocked; missing files/dependencies:\n${missing.join("\n")}`,
      );
    }
    expect(missing).toEqual([]);
  });

  it("production continueRun delegates guard-final to overlay PiAgentRuntime, not executor", () => {
    if (missing.length) return;
    const executorSrc = readFileSync(afterExecutor, "utf8");
    const overlayPiSrc = readFileSync(afterPi, "utf8");
    const headPiSrc = readFileSync(headPi, "utf8");
    const headExecutorSrc = readFileSync(headExecutor, "utf8");
    const harnessSrc = readFileSync(orchestrationHarness, "utf8");

    expect(executorSrc).toContain("const runtimeEvents = deps.runtime.run(");
    expect(headExecutorSrc).toContain("deps.runtime.run(");
    expect(executorSrc).not.toMatch(/agent\.state\.tools\s*=\s*\[\s*\]/);
    expect(executorSrc).not.toContain("runtidyGuardSummaryEnabled");
    expect(executorSrc).not.toContain("loopGuard.observe");
    expect(executorSrc).toContain("advanceToolCallLoopGuard");

    expect(overlayPiSrc).toContain("let verdict = loopGuard.observe(");
    expect(overlayPiSrc).toContain('if (verdict.kind === "ok")');
    expect(overlayPiSrc).toContain("assistErrorGuardObserve");
    expect(overlayPiSrc).toContain("if (loopGuard.halted && !host.toolCallBudget.exceeded)");
    expect(overlayPiSrc).toContain("host.toolCallBudget.exceeded = true");
    expect(overlayPiSrc).toContain("agent.state.tools = []");
    expect(overlayPiSrc).toContain("runtidyGuardSummaryEnabled()");
    expect(overlayPiSrc).toContain("await agent.prompt(runtidyGuardSummaryPrompt(reason))");
    expect(readFileSync(afterLoopGuard, "utf8")).toContain(`${LOOP_GUARD_PREFIX}:`);
    expect(overlayPiSrc).not.toContain(`${LOOP_GUARD_PREFIX}:`);

    expect(headPiSrc).not.toContain("loopGuard.observe");
    expect(headPiSrc).not.toContain("runtidyGuardSummaryEnabled");
    expect(headPiSrc).not.toContain("assistErrorGuardObserve");

    // overlay-orchestration.entry.test.ts mocks runtime.run, so it never enters this path.
    expect(harnessSrc).toContain("run: runtimeRun");
    expect(harnessSrc).toContain("yield { type: \"done\" as const, text: \"Done\" }");
  });

  it("fail-before: HEAD has no LoopGuard module", () => {
    expect(existsSync(path.join(repo, "packages/adapters/src/loop-guard.ts"))).toBe(false);
  });

  it("pass-after: overlay LoopGuard warns at 3 identical LOGIN_GUARD acts and halts at 4", async () => {
    if (missing.length) return;
    expect(existsSync(afterLoopGuard)).toBe(true);
    const mod = await import(`${pathToFileURL(afterLoopGuard).href}?t=${Date.now()}`);
    const LoopGuard = mod.LoopGuard as LoopGuardCtor;
    const guard = new LoopGuard();
    expect(guard.observe("browser_act", actArgs, loginGuardResult, undefined).kind).toBe("ok");
    expect(guard.observe("browser_act", actArgs, loginGuardResult, undefined).kind).toBe("ok");
    const warn = guard.observe("browser_act", actArgs, loginGuardResult, undefined);
    expect(warn.kind).toBe("warn");
    expect(warn.message).toContain(LOOP_GUARD_PREFIX);
    expect(warn.message).not.toContain("ERROR GUARD");
    const halt = guard.observe("browser_act", actArgs, loginGuardResult, undefined);
    expect(halt.kind).toBe("halt");
    expect(halt.message).toContain(LOOP_GUARD_PREFIX);
    expect(halt.message).toContain("Tools are now stopped");
    expect(halt.message).not.toContain("ERROR GUARD");
  });

  it("fail-before: HEAD PiAgentRuntime 4 identical acts plus ignored extra call never halt or clear tools", async () => {
    process.env.RAKAZO_GUARD_FINAL_SUMMARY = "1";
    const result = await captureLoopGuardOrchestration({
      runtime: new HeadPiAgentRuntime(),
      runId: "run-guard-head-bypass",
      extraIgnoredHaltCall: true,
    });
    expect(result.identicalToolErrors).toBeGreaterThanOrEqual(4);
    expect(result.validBrowserActCalls).toBeGreaterThanOrEqual(4);
    expect(result.guardWarning).toBe(false);
    expect(result.guardHalt).toBe(false);
    expect(result.guardFinalToolFree).toBe(false);
    expect(result.errorGuardPresent).toBe(false);
  }, 90_000);

  it("overlay 4-act+stop (Run10 shape): LOOP GUARD halt still advertises tools; no runtidy", async () => {
    if (missing.length) return;
    process.env.RAKAZO_GUARD_FINAL_SUMMARY = "1";
    const { PiAgentRuntime } = await import(`${pathToFileURL(afterPi).href}?t=${Date.now()}`);
    const result = await captureLoopGuardOrchestration({
      runtime: new PiAgentRuntime(),
      runId: "run-guard-overlay-halt-tools",
      extraIgnoredHaltCall: false,
    });
    expect(result.identicalToolErrors).toBeGreaterThanOrEqual(4);
    expect(result.validBrowserActCalls).toBeGreaterThanOrEqual(4);
    expect(result.guardWarning).toBe(true);
    expect(result.guardHalt).toBe(true);
    expect(result.errorGuardPresent).toBe(false);
    expect(result.haltAdvertisesTools).toBe(true);
    expect(result.guardFinalToolFree).toBe(false);
  }, 90_000);

  it("pass-after: overlay post-halt extra execute sets exceeded and runtidy emits tools=[]", async () => {
    if (missing.length) return;
    process.env.RAKAZO_GUARD_FINAL_SUMMARY = "1";
    const { PiAgentRuntime } = await import(`${pathToFileURL(afterPi).href}?t=${Date.now()}`);
    const result = await captureLoopGuardOrchestration({
      runtime: new PiAgentRuntime(),
      runId: "run-guard-overlay-runtidy",
      extraIgnoredHaltCall: true,
    });
    expect(result.identicalToolErrors).toBeGreaterThanOrEqual(4);
    expect(result.guardWarning).toBe(true);
    expect(result.guardHalt).toBe(true);
    expect(result.errorGuardPresent).toBe(false);
    expect(result.guardFinalToolFree).toBe(true);
    expect(result.skippedPresent).toBe(true);
    expect(result.runtidyPrompt).toBe(true);
    const hay = result.parsedBodies.map((body) => JSON.stringify(body ?? {})).join("\n");
    expect(hay).toContain(SKIPPED_LOOP_GUARD);
    const toolFree = result.captures.find((row) => row.phase === "guard-final");
    expect(toolFree?.toolNames ?? ["x"]).toEqual([]);
  }, 90_000);

  it("pass-after: overlay ERROR GUARD isError extract + 5th skipped/runtidy", async () => {
    if (missing.length) return;
    process.env.RAKAZO_GUARD_FINAL_SUMMARY = "1";
    const { PiAgentRuntime } = await import(`${pathToFileURL(afterPi).href}?t=${Date.now()}`);
    const result = await captureLoopGuardOrchestration({
      runtime: new PiAgentRuntime(),
      runId: "run-guard-overlay-error-runtidy",
      extraIgnoredHaltCall: true,
      toolName: "browser_extract",
    });
    expect(result.errorGuardPresent).toBe(true);
    expect(result.guardWarning).toBe(true);
    expect(result.guardHalt).toBe(true);
    expect(result.skippedPresent).toBe(true);
    expect(result.guardFinalToolFree).toBe(true);
    expect(result.runtidyPrompt).toBe(true);
    expect(result.identicalToolErrors).toBe(0);
    const hay = result.parsedBodies.map((body) => JSON.stringify(body ?? {})).join("\n");
    expect(hay).toContain(ERROR_GUARD_PREFIX);
    expect(hay).toContain(STALE_REF_ERROR);
    expect(hay).toContain(SKIPPED_LOOP_GUARD);
    expect(hay).not.toContain(`${LOOP_GUARD_PREFIX}:`);
    const toolFree = result.captures.find((row) => row.phase === "guard-final");
    expect(toolFree?.toolNames ?? ["x"]).toEqual([]);
  }, 90_000);
});
