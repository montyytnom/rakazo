import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FLEET_TOOL_NAMES } from "@rakazo/contracts";
import { formatSkillsCatalogInstruction } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { longWorkProgressGuidance, persistentComputerInstruction } from "./executor.js";
import {
  CAPTURE_CLOCK_DEFAULT,
  CAPTURE_DEFAULT_DISABLED_TOOLS,
  CAPTURE_LOGIN_CLAIM,
  CAPTURE_MODEL_ID,
  CREATE_SPACE_CLAUSE,
  FLEET_CLAUSE,
  HISTORICAL_CANDIDATE_WORDING,
  OLDER_RESULT_SHORTENING,
  OLDER_TOOL_RESULT_SHORTEN_BYTES,
  RENDER_PLOT_CLAUSE,
  SKIPPED_LOOP_GUARD,
  classifyCapturePhase,
  captureCompactionPass,
  captureContextStrategy,
  captureDisabledBuiltinTools,
  captureFleetManagement,
  captureGuardPathB,
  captureGuardPathC,
  capturePageTrim,
  captureParserGuardCases,
  capturePhaseTurn,
  collectProvenance,
  deriveProductionModelMetadata,
  ERROR_GUARD_PREFIX,
  GUARD_HALT_MARK,
  IDENTICAL_TOOL_ERROR,
  identicalToolErrorCount,
  ISOLATED_CAPTURE_KIND,
  LOOP_GUARD_PREFIX,
  LOOP_GUARD_WARN_MARK,
  loopGuardSignals,
  offeredToolsFromDeployedBuilder,
  olderToolResultFallbackLength,
  pinPiAiVersion,
  pinToolCallGuardHash,
  REVIEWER_EXPECTED_WORKER_BUILTINS,
  runIsolatedCapture,
  SAMPLING_KEYS,
  STALE_PAGE_STATE_NOTE,
  SYNTHETIC_SKILL_CATALOG,
  secretStoreCapabilityReport,
  VOLATILE_FIELDS,
} from "./isolated-capture.js";

process.env.RAKAZO_ASSIST_DEFAULT_DISABLED_TOOLS ??= CAPTURE_DEFAULT_DISABLED_TOOLS;
process.env.RAKAZO_DEFAULT_TIMEZONE ??= "America/New_York";
process.env.RAKAZO_GUARD_FINAL_SUMMARY ??= "1";
delete process.env.ISOLATED_CAPTURE_CONTEXT_STRATEGY;

describe("isolated capture harness", () => {
  it("classifies LOOP GUARD warn/halt and does not treat halt-with-tools as tool-free", () => {
    const warnBody = {
      tools: [{ function: { name: "browser_act" } }],
      messages: [
        {
          role: "tool",
          content: `${LOOP_GUARD_PREFIX}: click had no effect 3 times. ${LOOP_GUARD_WARN_MARK}`,
        },
      ],
    };
    const haltBody = {
      tools: [{ function: { name: "browser_act" } }, { function: { name: "browser_snapshot" } }],
      messages: [
        {
          role: "tool",
          content: `${LOOP_GUARD_PREFIX}: click had no effect 4 times. ${GUARD_HALT_MARK}`,
        },
      ],
    };
    const toolFree = { tools: [], messages: [{ role: "user", content: "summary" }] };
    expect(classifyCapturePhase("phases", 5, warnBody)).toBe("guard-warning");
    expect(classifyCapturePhase("phases", 6, haltBody)).toBe("guard-halt");
    expect(classifyCapturePhase("phases", 7, toolFree)).toBe("guard-final");
    expect(classifyCapturePhase("phases", 6, haltBody) === "guard-final").toBe(false);
    const errorOnly = {
      tools: [{ function: { name: "browser_act" } }],
      messages: [{ role: "tool", content: `${ERROR_GUARD_PREFIX}: ignored` }],
    };
    expect(classifyCapturePhase("phases", 5, errorOnly)).toBe("turn-5");
    const login = IDENTICAL_TOOL_ERROR.error;
    const bodies = [
      { tools: [{ function: { name: "browser_act" } }], messages: [{ role: "tool", content: login }] },
      {
        tools: [{ function: { name: "browser_act" } }],
        messages: [{ role: "tool", content: login }],
      },
      {
        tools: [{ function: { name: "browser_act" } }],
        messages: [{ role: "tool", content: login }],
      },
      {
        tools: [{ function: { name: "browser_act" } }],
        messages: [{ role: "tool", content: login }],
      },
      { tools: [], messages: [{ role: "user", content: "runtidy" }] },
    ];
    expect(identicalToolErrorCount(bodies)).toBe(4);
    expect(loopGuardSignals([warnBody]).warning).toBe(true);
    expect(loopGuardSignals([haltBody]).halt).toBe(true);
    expect(loopGuardSignals([errorOnly]).errorGuard).toBe(true);
    expect(loopGuardSignals([warnBody, haltBody]).errorGuard).toBe(false);
  });

  it("uses the code-default retrieval strategy and merged env disabled tools", async () => {
    expect(captureContextStrategy().value).toBe("retrieval");
    expect(captureContextStrategy().source).toMatch(/DEFAULT_CONTEXT_STRATEGY/);
    expect(captureDisabledBuiltinTools()).toEqual(CAPTURE_DEFAULT_DISABLED_TOOLS.split(","));
    const inventory = await offeredToolsFromDeployedBuilder();
    expect(inventory.assemblerInputs.contextStrategy).toBe("retrieval");
    expect(inventory.assemblerInputs.historyRetrievalEnabled).toBe(true);
    expect(inventory.assemblerInputs.disabledBuiltinTools).toEqual(
      CAPTURE_DEFAULT_DISABLED_TOOLS.split(","),
    );
    expect(captureFleetManagement().property).toBe("bot.fleetManagement");
    expect(inventory.assemblerInputs.fleetManagement).toBe(captureFleetManagement().value);
    expect(inventory.assemblerInputs.fleetManagement).toBe(true);
    for (const name of FLEET_TOOL_NAMES) {
      expect(inventory.offeredBuiltinNames).toContain(name);
    }
    expect(inventory.withheldBuiltinNames.some((name) =>
      (FLEET_TOOL_NAMES as readonly string[]).includes(name),
    )).toBe(false);
    const disabled = new Set(CAPTURE_DEFAULT_DISABLED_TOOLS.split(","));
    for (const name of disabled) {
      expect(inventory.offeredBuiltinNames).not.toContain(name);
      expect(
        inventory.withheldRationale.some(
          (row) => row.name === name && row.reason.includes("assistDisabledTools"),
        ),
      ).toBe(true);
    }
    const meta = deriveProductionModelMetadata();
    expect(meta.id).toBe(CAPTURE_MODEL_ID);
    expect(meta.maxTokens).toBeGreaterThan(4096);
    expect(meta.maxTokens).toBe(32_768);
    expect(meta.rejectedStub4096.historicalMaxOutputTokens).toBe(9256);
  });

  it("captures valid identical tool errors, reasoning replay, and guard path when overlay is present", async () => {
    const result = await capturePhaseTurn("this-tree");
    expect(result.validBrowserActCalls).toBeGreaterThanOrEqual(4);
    expect(result.identicalToolErrors).toBeGreaterThanOrEqual(4);
    const firstText = JSON.stringify(result.parsedBodies[0]);
    const byName = Object.fromEntries(result.blocks.map((block) => [block.name, block]));
    expect(byName.baseComputerInstruction?.present).toBe(true);
    expect(byName.baseComputerInstruction?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(byName.longWorkProgressGuidance?.present).toBe(true);
    expect(byName.formatSkillsCatalogInstruction?.present).toBe(true);
    const computer = persistentComputerInstruction({
      heldForTakeover: false,
      graphicalToolsAllowed: true,
      graphical: true,
      disabled: new Set(captureDisabledBuiltinTools()),
    });
    const longWork = longWorkProgressGuidance();
    const skills = formatSkillsCatalogInstruction(SYNTHETIC_SKILL_CATALOG);
    expect(result.assembledInHttp.baseComputerInstruction).toBe(true);
    expect(result.assembledInHttp.longWorkProgressGuidance).toBe(true);
    expect(result.assembledInHttp.formatSkillsCatalogInstruction).toBe(true);
    expect(firstText).toContain(computer.slice(0, 40));
    expect(firstText).toContain(longWork.slice(0, 40));
    expect(skills && firstText.includes(skills.slice(0, 40))).toBe(true);
    expect(firstText).toContain("America/New_York");
    expect(result.captures[0]!.phase).toBe("first");
    expect(result.captures.some((row) => row.phase === "postbrowser")).toBe(true);
    expect(result.captures[0]!.stubSseByteLength).toBeGreaterThan(0);
    const hay = result.parsedBodies.map((body) => JSON.stringify(body ?? {})).join("\n");
    // HEAD runtime has no loop-guard. Overlay 4-act+stop warns/halts but still advertises tools;
    // tool-free final is overlay-guard-final.entry.test.ts via the post-halt execute path.
    if (hay.includes(LOOP_GUARD_PREFIX)) {
      expect(result.guardWarning).toBe(true);
      expect(result.guardHalt).toBe(true);
      expect(result.captures.some((row) => row.phase === "guard-warning")).toBe(true);
      expect(result.captures.some((row) => row.phase === "guard-halt")).toBe(true);
    }
    expect(hay.includes(ERROR_GUARD_PREFIX)).toBe(false);
    const inventory = await offeredToolsFromDeployedBuilder();
    expect(result.offeredToolNames).toEqual(inventory.tools.map((tool) => tool.name));
    expect([...result.captures[0]!.toolNames].sort()).toEqual(
      [...inventory.tools.map((tool) => tool.name)].sort(),
    );
    expect(inventory.reviewerExpectedWorkerBuiltins).toBe(REVIEWER_EXPECTED_WORKER_BUILTINS);
    expect(result.namedBlocks.every((block) => block.name.length > 0)).toBe(true);
    for (const capture of result.captures) {
      expect(capture.rawSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(capture.rawByteLength).toBeGreaterThan(100);
      expect(capture.nonAuthHeaders).not.toHaveProperty("authorization");
      expect(capture.url).toBe("/v1/chat/completions");
      for (const key of SAMPLING_KEYS) {
        expect(key in capture.sampling.included || capture.sampling.omitted.includes(key)).toBe(
          true,
        );
      }
    }
    expect(firstText).toContain(CAPTURE_CLOCK_DEFAULT.slice(0, 10));
    expect(firstText).not.toContain(CREATE_SPACE_CLAUSE);
    expect(firstText).not.toContain(RENDER_PLOT_CLAUSE);
    expect(firstText).toContain(FLEET_CLAUSE);
    expect(result.promptClauses.createSpace).toBe(false);
    expect(result.promptClauses.renderPlot).toBe(false);
    expect(result.promptClauses.fleet).toBe(true);
    expect(result.path).toBe("A");
    expect(result.skippedPresent).toBe(false);
    expect(result.runtidyPrompt).toBe(false);
    if (hay.includes(LOOP_GUARD_PREFIX)) {
      expect(result.haltAdvertisesTools).toBe(true);
      expect(result.guardFinalToolFree).toBe(false);
    }
    expect(JSON.stringify(result)).not.toMatch(/sk-|BEGIN PRIVATE|password=/i);
  }, 90_000);

  it("prunes four distinct max_controls snapshots in one turn on the actual path", async () => {
    const result = await capturePageTrim("this-tree");
    expect(result.captures.length).toBeGreaterThanOrEqual(5);
    expect(result.distinctLargeSnapshotArgs).toEqual([101, 102, 103, 104]);
    expect(result.distinctSnapshotArgs).toEqual(expect.arrayContaining([101, 102, 103, 104, 1, 999]));
    expect(result.page1Trimmed).toBe(true);
    expect(result.trimmedNotePresent).toBe(true);
    expect(result.request5Text).toContain(STALE_PAGE_STATE_NOTE);
    expect(result.request5Text).not.toContain("BEGIN_PAGE_1_");
    expect(result.keptPageMarkers).toEqual(["BEGIN_PAGE_2_", "BEGIN_PAGE_3_", "BEGIN_PAGE_4_"]);
    const fallback = olderToolResultFallbackLength();
    for (const length of [result.page2Length, result.page3Length]) {
      expect(length).toBeTruthy();
      expect(
        length === fallback ||
          (length !== null && length <= OLDER_TOOL_RESULT_SHORTEN_BYTES + 200),
      ).toBe(true);
    }
    expect(result.page4Full).toBe(true);
    expect(result.shortControlUntouched).toBe(true);
    expect(result.errorControlUntouched).toBe(true);
    expect(result.olderResultShortening).toEqual(OLDER_RESULT_SHORTENING);
    expect(result.olderResultShortening.independentOfContextWindow).toBe(true);
    expect(result.olderResultShortening.function).toBe("createRuntimeContextPolicy");
    expect(result.olderResultShortening.sizeHardcoded).toBe(1024);
  }, 90_000);

  it("invokes deployed compactHistory with pinned clock, mixed rows, and prior summary", async () => {
    const result = await captureCompactionPass("this-tree");
    expect(result.deployedBoundary).toBe("compactHistory");
    expect(result.invoked).toBe(true);
    expect(result.gate).toBe("invoked");
    expect(result.captures.length).toBeGreaterThan(0);
    expect(result.writeback.summary).toMatch(/synthetic compacted summary/);
    expect(result.writeback.historyCompactedUpToSeq).not.toBeNull();
    expect(result.clockPinned).toBe(true);
    expect(result.priorSummaryInRequest).toBe(true);
    expect(result.loginClaimInRequest).toBe(true);
    expect(result.mixedToolRows).toBe(true);
    expect(result.stubOutput).toBeTruthy();
    expect(JSON.stringify(result.parsedBodies[0] ?? {})).toContain(CAPTURE_LOGIN_CLAIM);
    expect(result.matched).toBe(false);
  }, 90_000);

  it("records guard path B (5th act skipped/runtidy) and C (ERROR GUARD isError) when overlay is present", async () => {
    const pathB = await captureGuardPathB("this-tree");
    const pathC = await captureGuardPathC("this-tree");
    const hayB = pathB.parsedBodies.map((body) => JSON.stringify(body ?? {})).join("\n");
    const hayC = pathC.parsedBodies.map((body) => JSON.stringify(body ?? {})).join("\n");
    if (hayB.includes(LOOP_GUARD_PREFIX)) {
      expect(pathB.guardWarning).toBe(true);
      expect(pathB.guardHalt).toBe(true);
      expect(pathB.skippedPresent).toBe(true);
      expect(hayB).toContain(SKIPPED_LOOP_GUARD);
      expect(pathB.guardFinalToolFree).toBe(true);
      expect(pathB.runtidyPrompt).toBe(true);
      expect(pathB.errorGuardPresent).toBe(false);
    }
    if (hayC.includes(ERROR_GUARD_PREFIX)) {
      expect(pathC.errorGuardPresent).toBe(true);
      expect(pathC.guardWarning).toBe(true);
      expect(pathC.guardHalt).toBe(true);
      expect(pathC.skippedPresent).toBe(true);
      expect(pathC.guardFinalToolFree).toBe(true);
      expect(pathC.runtidyPrompt).toBe(true);
      expect(hayC).not.toContain(LOOP_GUARD_PREFIX);
    }
  }, 120_000);

  it("feeds full prompt/tools through the parser and identical tool errors, not HTTP 500s", async () => {
    const result = await captureParserGuardCases("this-tree");
    expect(result.validcall.usedFullPromptTools).toBe(true);
    expect(result.validcall.captures.length).toBeGreaterThanOrEqual(1);
    expect(result.malformed.guardDroppedNameless).toBe(true);
    expect(result.twoCalls.usedFullPromptTools).toBe(true);
    expect(result.fourIdenticalToolErrors.usedHttp500).toBe(false);
    expect(result.fourIdenticalToolErrors.validBrowserActCalls).toBeGreaterThanOrEqual(4);
    expect(result.fourIdenticalToolErrors.identicalToolErrors).toBeGreaterThanOrEqual(4);
  }, 90_000);

  it("pins provenance from deploy inspect and does not fabricate git", () => {
    const provenance = collectProvenance("worker");
    expect(provenance.kind).toBe(ISOLATED_CAPTURE_KIND);
    expect(provenance.servingChief).toBe("worker");
    expect(provenance.baseline).toBe("worker");
    expect((provenance.gitSha as { value: null; baseSha: string }).value).toBeNull();
    expect((provenance.gitSha as { baseSha: string }).baseSha).toBe("926710a");
    expect(String(pinPiAiVersion() ?? "")).toMatch(/^\d+\.\d+\.\d+/);
    expect(String(provenance.piAiParserVersion ?? "")).toMatch(/^\d+\.\d+\.\d+/);
    expect(pinToolCallGuardHash().sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(VOLATILE_FIELDS.length).toBeGreaterThan(0);
    const capability = secretStoreCapabilityReport();
    expect(capability.didMutate).toBe(false);
    expect(capability.interfaceMethods).toContain("put");
    const model = provenance.modelResolution as { maxTokens: number; id: string };
    expect(model.id).toBe(CAPTURE_MODEL_ID);
    expect(model.maxTokens).toBeGreaterThan(4096);
  });

  it("writes a parent-replayable hash manifest of paths actually taken", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "isolated-capture-"));
    const result = await runIsolatedCapture({ outDir, service: "this-tree" });
    const manifest = readFileSync(join(outDir, "HASHMANIFEST.tsv"), "utf8");
    expect(manifest).toContain("phases/first-0.bin");
    expect(manifest).toContain("provenance.json");
    expect(manifest).toContain("paths-taken.json");
    expect(manifest).not.toContain("HASHMANIFEST.tsv");
    expect(manifest).not.toContain("SHA256SUMS");
    expect(result.hashManifest["phases/first-0.bin"]).toMatch(/^[a-f0-9]{64}$/);
    const summary = JSON.parse(readFileSync(join(outDir, "phases-summary.json"), "utf8")) as {
      gateMet: boolean;
      compactionGate?: { gate: string; matched: boolean; invoked?: boolean };
      blocks: Array<{ name: string; sha256: string | null }>;
    };
    expect(summary.compactionGate?.invoked).toBe(true);
    expect(summary.compactionGate?.matched).toBe(false);
    expect(summary.gateMet).toBe(false);
    const paths = JSON.parse(readFileSync(join(outDir, "paths-taken.json"), "utf8")) as {
      validBrowserActCalls: number;
      identicalToolErrors: number;
      pruningDistinctSnapshotArgs: number;
      pruningStaleNote: boolean;
      pruningPage1Trimmed: boolean;
      compactionInvoked: boolean;
      compactionClockPinned: boolean;
      promptClauses: { createSpace: boolean; renderPlot: boolean; fleet: boolean };
      pathA: { skippedPresent: boolean; haltAdvertisesTools: boolean };
      guardWarning: boolean;
      guardHalt: boolean;
      guardFinalToolFree: boolean;
    };
    expect(paths.validBrowserActCalls).toBeGreaterThanOrEqual(4);
    expect(paths.identicalToolErrors).toBeGreaterThanOrEqual(4);
    expect(paths.pruningDistinctSnapshotArgs).toBe(4);
    expect(paths.pruningStaleNote).toBe(true);
    expect(paths.pruningPage1Trimmed).toBe(true);
    expect(paths.compactionInvoked).toBe(true);
    expect(paths.compactionClockPinned).toBe(true);
    expect(paths.promptClauses.createSpace).toBe(false);
    expect(paths.promptClauses.renderPlot).toBe(false);
    expect(paths.promptClauses.fleet).toBe(true);
    expect(paths.pathA.skippedPresent).toBe(false);
    expect(manifest).toContain("historical-unverified.md");
    expect(readFileSync(join(outDir, "historical-unverified.md"), "utf8")).toContain(
      HISTORICAL_CANDIDATE_WORDING,
    );
    expect(manifest).toContain("compaction/invoked.json");
    expect(manifest).toContain("guard-b/summary.json");
    expect(manifest).toContain("guard-c/summary.json");
    expect(summary.blocks.map((block) => block.name)).toEqual([
      "baseComputerInstruction",
      "renderBotCapabilityDirectory",
      "formatSkillsCatalogInstruction",
      "longWorkProgressGuidance",
    ]);
    const named = JSON.parse(readFileSync(join(outDir, "named-blocks.json"), "utf8")) as {
      everyBlock: Array<{ name: string; sha256: string | null; present: boolean }>;
    };
    expect(named.everyBlock.length).toBeGreaterThan(4);
    const inventoryFile = JSON.parse(
      readFileSync(join(outDir, "tools-inventory.json"), "utf8"),
    ) as {
      handwrittenSchemas: boolean;
      reviewerExpectedWorkerBuiltins: number;
      withheldRationale: Array<{ name: string }>;
    };
    expect(inventoryFile.handwrittenSchemas).toBe(false);
    expect(inventoryFile.reviewerExpectedWorkerBuiltins).toBe(REVIEWER_EXPECTED_WORKER_BUILTINS);
    expect(inventoryFile.withheldRationale.length).toBeGreaterThan(0);
    expect(manifest).toContain("named-blocks.json");
    expect(manifest).toContain("tools-inventory.json");
  }, 300_000);

  it("keeps overlay source mounts and forwards typed assist switches", () => {
    const overlay = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../infra/overlays/reliability-20261107/isolated-capture",
    );
    const result = spawnSync(
      "python3",
      ["-m", "unittest", "host_launch_test", "dependency_closure_test", "config_coverage_test"],
      {
        cwd: overlay,
        encoding: "utf8",
        env: {
          ...process.env,
          ISOLATED_CAPTURE_COMPOSED_SOURCE:
            process.env.ISOLATED_CAPTURE_COMPOSED_SOURCE ??
            "/tmp/compose-check/worker/after/packages/adapters/src:/tmp/compose-check/api/after/packages/adapters/src",
        },
      },
    );
    const output = `${result.stdout}${result.stderr}`;
    if (result.status !== 0) {
      throw new Error(output);
    }
    expect(result.status).toBe(0);
  });
});
