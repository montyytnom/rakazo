import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CAPTURE_CLOCK_DEFAULT,
  captureCompactionPass,
  capturePageTrim,
  captureParserGuardCases,
  capturePhaseTurn,
  collectProvenance,
  ISOLATED_CAPTURE_KIND,
  offeredToolsForSyntheticCapture,
  pinPiAiVersion,
  pinToolCallGuardHash,
  RUNTIME_ONLY_PROMPT_BLOCKS,
  runIsolatedCapture,
  SAMPLING_KEYS,
  STALE_PAGE_STATE_NOTE,
  secretStoreCapabilityReport,
  VOLATILE_FIELDS,
} from "./isolated-capture.js";

describe("isolated capture harness", () => {
  it("captures first/postbrowser/guard-final at actual outbound HTTP to a local stub", async () => {
    const result = await capturePhaseTurn("this-tree");
    expect(result.captures).toHaveLength(3);
    expect(result.captures.map((row) => row.phase)).toEqual([
      "first",
      "postbrowser",
      "guard-final",
    ]);
    expect(result.runtimeOnlyBlocksPresent).toEqual({
      groupContext: true,
      messagingContext: true,
      redactedMemoryContext: true,
      redactedScratchpadContext: true,
    });
    const offered = offeredToolsForSyntheticCapture().map((tool) => tool.name);
    expect(result.offeredToolNames).toEqual(offered);
    expect([...result.captures[0]!.toolNames].sort()).toEqual([...offered].sort());
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
    const first = JSON.stringify(result.parsedBodies[0]);
    for (const block of Object.values(RUNTIME_ONLY_PROMPT_BLOCKS)) {
      expect(first).toContain(block);
    }
    expect(first).toContain(CAPTURE_CLOCK_DEFAULT.slice(0, 10));
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
    expect(
      capability.env.ENCRYPTION_KEY === "present" || capability.env.ENCRYPTION_KEY === "absent",
    ).toBe(true);
  });

  it("writes a parent-replayable hash manifest", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "isolated-capture-"));
    const result = await runIsolatedCapture({ outDir, service: "this-tree" });
    const manifest = readFileSync(join(outDir, "HASHMANIFEST.tsv"), "utf8");
    expect(manifest).toContain("phases/first-0.bin");
    expect(manifest).toContain("provenance.json");
    expect(result.hashManifest["phases/first-0.bin"]).toMatch(/^[a-f0-9]{64}$/);
  }, 120_000);
});
