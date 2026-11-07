import { describe, expect, it } from "vitest";
import {
  extractGeneratedPassword,
  issueProtectedResult,
  looksLikeSecretValue,
  protectedResultNote,
  redactProtectedTree,
  secretsFromPriorAssistantText,
  stripSecretEchoes,
} from "./secret-result-handle.js";

const FIXTURE_OLD = "FxOld#4419Temp";
const FIXTURE_NEW = "FxNew#2207GenA";

describe("protected result handles", () => {
  it("issues a handle without embedding plaintext", () => {
    const handle = issueProtectedResult(FIXTURE_NEW, new Date("2026-11-06T17:26:41.000Z"));
    expect(handle.handle).toMatch(/^op-[a-f0-9]{8}$/);
    expect(handle.hash.startsWith("sha256:")).toBe(true);
    expect(JSON.stringify(handle)).not.toContain(FIXTURE_NEW);
    expect(protectedResultNote(handle)).not.toContain(FIXTURE_NEW);
  });

  it("redacts generated passwords from tool trees and prior assistant echoes", () => {
    const tree = redactProtectedTree(
      { ok: true, tree: `Dialog: Reset password successful. New password: ${FIXTURE_NEW}` },
      [FIXTURE_NEW],
    );
    expect(JSON.stringify(tree)).not.toContain(FIXTURE_NEW);
    expect(extractGeneratedPassword(`New password: ${FIXTURE_NEW}`)).toBe(FIXTURE_NEW);
    expect(looksLikeSecretValue(FIXTURE_NEW)).toBe(true);
    const prior = secretsFromPriorAssistantText([
      `Reset complete. Temporary password: ${FIXTURE_OLD}`,
    ]);
    expect(prior).toEqual([FIXTURE_OLD]);
    const stripped = stripSecretEchoes(`The password is ${FIXTURE_OLD}`, prior);
    expect(stripped.echoed).toBe(true);
    expect(stripped.text).not.toContain(FIXTURE_OLD);
  });
});
