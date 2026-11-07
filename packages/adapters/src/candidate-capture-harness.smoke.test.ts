import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repo = path.resolve(import.meta.dirname, "../../..");
const overlay = process.env.OVERLAY_EXPORT ?? "/tmp/overlay-export/overlay-export";
const composeAfter = path.join(
  repo,
  ".compose/worker/after/packages/adapters/src/history-compaction.ts",
);
const smokeScript = path.join(
  repo,
  "infra/overlays/reliability-20261107/candidate-capture/smoke-harness.sh",
);

describe("candidate-capture-harness composed-tree smoke", { timeout: 180_000 }, () => {
  it("is not covered by overlay-orchestration named tests", () => {
    expect(smokeScript).not.toContain("overlay-orchestration");
    expect(existsSync(path.join(repo, "packages/adapters/src/candidate-capture-harness.ts"))).toBe(
      true,
    );
  });

  it("runs the actual harness on both composed AFTER trees under ctxmem facts on and off", () => {
    if (!existsSync(overlay) && !existsSync(composeAfter)) {
      throw new Error(
        "composed AFTER trees and overlay archive are missing; this smoke copies the harness into composed after so relative imports hit composed history-compaction/executor. Overlay-orchestration tests do not exercise candidate-capture-harness.ts.",
      );
    }
    const out = mkdtempSync(path.join(tmpdir(), "candidate-harness-smoke-"));
    try {
      const result = spawnSync("bash", [smokeScript, out], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, COMPOSE_OUT: path.join(repo, ".compose") },
        timeout: 170_000,
      });
      if (result.status !== 0) {
        throw new Error(
          `harness smoke failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
        );
      }
      for (const service of ["worker", "api"] as const) {
        for (const branch of ["ctxmem-facts-on", "ctxmem-facts-off"] as const) {
          const summary = JSON.parse(
            readFileSync(path.join(out, service, branch, "phases-summary.json"), "utf8"),
          ) as {
            failed: boolean;
            ctxmem: string;
            ctxmemFacts: string;
            scenarios: Record<string, { ok?: boolean; error?: { message?: string } }>;
          };
          expect(summary.failed, `${service} ${branch}`).toBe(false);
          expect(summary.ctxmem).toBe("1");
          expect(summary.ctxmemFacts).toBe(branch === "ctxmem-facts-on" ? "1" : "0");
          expect(Object.keys(summary.scenarios).sort()).toEqual(
            [
              "compaction-current-secret",
              "compaction-stale-secret",
              "false-success-done",
              "generated-secret",
              "protected-handoff-repaired-path",
              "stale-secret",
            ].sort(),
          );
          for (const [name, row] of Object.entries(summary.scenarios)) {
            expect(row.ok, `${service} ${branch} ${name} ${row.error?.message ?? ""}`).toBe(true);
          }
          expect(existsSync(path.join(out, service, branch, "scenario-compaction-current-secret.json"))).toBe(
            true,
          );
        }
      }
      expect(result.stdout).toContain("LIMIT: not Docker image");
      expect(result.stdout).toContain("candidate-harness-smoke OK");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
