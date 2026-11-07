import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSkillsCatalogInstruction } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { longWorkProgressGuidance, persistentComputerInstruction } from "./executor.js";
import {
  CAPTURE_CLOCK_DEFAULT,
  captureCompactionPass,
  capturePageTrim,
  captureParserGuardCases,
  capturePhaseTurn,
  collectProvenance,
  ISOLATED_CAPTURE_KIND,
  offeredToolsFromDeployedBuilder,
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

describe("isolated capture harness", () => {
  it("captures first/postbrowser/guard-final with named hashed assembler blocks", async () => {
    const result = await capturePhaseTurn("this-tree");
    expect(result.captures).toHaveLength(3);
    expect(result.captures.map((row) => row.phase)).toEqual([
      "first",
      "postbrowser",
      "guard-final",
    ]);
    const byName = Object.fromEntries(result.blocks.map((block) => [block.name, block]));
    expect(byName.baseComputerInstruction?.present).toBe(true);
    expect(byName.baseComputerInstruction?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(byName.longWorkProgressGuidance?.present).toBe(true);
    expect(byName.formatSkillsCatalogInstruction?.present).toBe(true);
    expect(byName.renderBotCapabilityDirectory?.name).toBe("renderBotCapabilityDirectory");
    const computer = persistentComputerInstruction({
      heldForTakeover: false,
      graphicalToolsAllowed: true,
      graphical: true,
    });
    const longWork = longWorkProgressGuidance();
    const skills = formatSkillsCatalogInstruction(SYNTHETIC_SKILL_CATALOG);
    expect(result.assembledInHttp.baseComputerInstruction).toBe(true);
    expect(result.assembledInHttp.longWorkProgressGuidance).toBe(true);
    expect(result.assembledInHttp.formatSkillsCatalogInstruction).toBe(true);
    const firstText = JSON.stringify(result.parsedBodies[0]);
    expect(firstText).toContain(computer.slice(0, 40));
    expect(firstText).toContain(longWork.slice(0, 40));
    expect(skills && firstText.includes(skills.slice(0, 40))).toBe(true);
    for (const extra of result.additionalEmitted) {
      expect(extra.required).toBe(false);
    }
    const inventory = await offeredToolsFromDeployedBuilder();
    expect(result.offeredToolNames).toEqual(inventory.tools.map((tool) => tool.name));
    expect([...result.captures[0]!.toolNames].sort()).toEqual(
      [...inventory.tools.map((tool) => tool.name)].sort(),
    );
    expect(inventory.reviewerExpectedWorkerBuiltins).toBe(REVIEWER_EXPECTED_WORKER_BUILTINS);
    expect(typeof inventory.reviewerCountMatch).toBe("boolean");
    expect(inventory.missingConnectors.length).toBeGreaterThan(0);
    expect(inventory.missingDynamicResolution.length).toBeGreaterThan(0);
    expect(result.namedBlocks.every((block) => block.name.length > 0)).toBe(true);
    expect(result.namedBlocks.some((block) => block.name === "baseComputerInstruction")).toBe(true);
    for (const block of result.namedBlocks) {
      if (block.present) expect(block.sha256).toMatch(/^[a-f0-9]{64}$/);
      else expect(block.sha256).toBeNull();
    }
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
    expect(JSON.stringify(result)).not.toMatch(/sk-|BEGIN PRIVATE|password=/i);
  }, 60_000);

  it("serializes oversized pages with last-3 trim and 12K clip", async () => {
    const result = await capturePageTrim("this-tree");
    expect(result.captures.length).toBe(5);
    expect(result.trimmedNotePresent).toBe(true);
    expect(result.lastRequestText).toContain(STALE_PAGE_STATE_NOTE);
    expect(result.keptPageMarkers).toEqual(["BEGIN_PAGE_2_", "BEGIN_PAGE_3_", "BEGIN_PAGE_4_"]);
    expect(result.lastRequestText).not.toContain("BEGIN_PAGE_1_");
    expect(result.clipped12k).toBe(true);
  }, 60_000);

  it("records one synthetic compaction pass without leaving the stub", async () => {
    const result = await captureCompactionPass("this-tree");
    expect(result.model.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(result.input.prompt).toContain("synthetic capture transcript");
    expect(result.input.instructions).toContain("Produce a complete replacement summary");
    expect(result.stubOutput).toContain("synthetic compacted summary");
    expect(result.capture?.rawSha256).toMatch(/^[a-f0-9]{64}$/);
  }, 30_000);

  it("feeds stub responses through the real parser and tool-call guard", async () => {
    const result = await captureParserGuardCases("this-tree");
    expect(result.validcall.captures.length).toBeGreaterThanOrEqual(1);
    expect(result.malformed.guardDroppedNameless).toBe(true);
    expect(result.twoCalls.captures.length).toBeGreaterThanOrEqual(1);
    expect(result.fourIdenticalErrorsThenSuccess.captures.length).toBe(5);
    expect(result.fourIdenticalErrorsThenSuccess.recovered).toBe(true);
  }, 60_000);

  it("pins provenance and does not create secrets", () => {
    const provenance = collectProvenance("this-tree");
    expect(provenance.kind).toBe(ISOLATED_CAPTURE_KIND);
    expect(String(pinPiAiVersion() ?? "")).toMatch(/^\d+\.\d+\.\d+/);
    expect(String(provenance.piAiParserVersion ?? "")).toMatch(/^\d+\.\d+\.\d+/);
    expect(pinToolCallGuardHash().sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(VOLATILE_FIELDS.length).toBeGreaterThan(0);
    const capability = secretStoreCapabilityReport();
    expect(capability.didMutate).toBe(false);
    expect(capability.interfaceMethods).toContain("put");
  });

  it("writes a parent-replayable hash manifest", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "isolated-capture-"));
    const result = await runIsolatedCapture({ outDir, service: "this-tree" });
    const manifest = readFileSync(join(outDir, "HASHMANIFEST.tsv"), "utf8");
    expect(manifest).toContain("phases/first-0.bin");
    expect(manifest).toContain("provenance.json");
    expect(result.hashManifest["phases/first-0.bin"]).toMatch(/^[a-f0-9]{64}$/);
    const summary = JSON.parse(readFileSync(join(outDir, "phases-summary.json"), "utf8")) as {
      gateMet: boolean;
      blocks: Array<{ name: string; sha256: string | null }>;
    };
    expect(summary.gateMet).toBe(false);
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
    };
    expect(inventoryFile.handwrittenSchemas).toBe(false);
    expect(inventoryFile.reviewerExpectedWorkerBuiltins).toBe(REVIEWER_EXPECTED_WORKER_BUILTINS);
    expect(manifest).toContain("named-blocks.json");
    expect(manifest).toContain("tools-inventory.json");
  }, 120_000);
});
