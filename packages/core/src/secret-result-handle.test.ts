import { describe, expect, it } from "vitest";
import {
  extractGeneratedPassword,
  harvestSecretsFromText,
  harvestSecretsFromUnknown,
  issueProtectedResult,
  looksLikeSecretValue,
  protectedResultNote,
  redactProtectedTree,
  redactThrown,
  secretsFromPriorAssistantText,
  stripSecretEchoes,
  stripSecretsFromUnknown,
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
    expect(
      extractGeneratedPassword(JSON.stringify({ tree: `New password: ${FIXTURE_NEW}` })),
    ).toBe(FIXTURE_NEW);
    expect(looksLikeSecretValue(FIXTURE_NEW)).toBe(true);
    expect(looksLikeSecretValue("op-deadbeef")).toBe(false);
    expect(looksLikeSecretValue(`sha256:${"a".repeat(64)}`)).toBe(false);
    const prior = secretsFromPriorAssistantText([
      `Reset complete. Temporary password: ${FIXTURE_OLD}`,
    ]);
    expect(prior).toEqual([FIXTURE_OLD]);
    const stripped = stripSecretEchoes(`The password is ${FIXTURE_OLD}`, prior);
    expect(stripped.echoed).toBe(true);
    expect(stripped.text).not.toContain(FIXTURE_OLD);
    const both = secretsFromPriorAssistantText([
      `Old password: ${FIXTURE_OLD}. New password: ${FIXTURE_NEW}`,
    ]);
    expect(both).toEqual([FIXTURE_OLD, FIXTURE_NEW]);
  });

  it("harvests labelled plaintext from simple, JSON, and markdown forms", () => {
    const simple = "hunter99";
    expect(harvestSecretsFromText(`password ${simple}`)).toContain(simple);
    expect(harvestSecretsFromText(`password is ${simple}`)).toContain(simple);
    expect(harvestSecretsFromUnknown({ password: simple })).toContain(simple);
    expect(harvestSecretsFromText(`{"newPassword":"${FIXTURE_NEW}"}`)).toContain(FIXTURE_NEW);
    expect(harvestSecretsFromText(`**New password:** \`${FIXTURE_NEW}\``)).toContain(FIXTURE_NEW);
    expect(
      harvestSecretsFromText("```json\n" + JSON.stringify({ password: FIXTURE_OLD }) + "\n```"),
    ).toContain(FIXTURE_OLD);
  });

  it("does not harvest protected refs or benign password language", () => {
    expect(harvestSecretsFromText("Reset password successful.")).toEqual([]);
    expect(harvestSecretsFromText("The password field is required.")).toEqual([]);
    expect(harvestSecretsFromText("Protected result op-deadbeef at 2026-11-07, sha256:aabb")).toEqual(
      [],
    );
    expect(harvestSecretsFromText("complete the form")).toEqual([]);
    expect(looksLikeSecretValue("op-deadbeef")).toBe(false);
  });

  it("strips secrets from thrown errors so logs cannot echo plaintext", () => {
    const error = redactThrown(new Error(`vault failed for ${FIXTURE_NEW}`), [FIXTURE_NEW]);
    expect(error.message).not.toContain(FIXTURE_NEW);
    expect(error.message).toContain("[withheld]");
  });

  it("strips harvested secrets from replayed tool-call arguments and tool results", () => {
    const transcript = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "scratchpad_add",
            arguments: { title: `New password: ${FIXTURE_NEW}` },
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "scratchpad_add",
        content: [{ type: "text", text: `Protected result. title: New password: ${FIXTURE_NEW}` }],
      },
    ];
    const secrets = harvestSecretsFromUnknown(transcript);
    expect(secrets).toContain(FIXTURE_NEW);
    const stripped = JSON.stringify(stripSecretsFromUnknown(transcript, secrets));
    expect(stripped).not.toContain(FIXTURE_NEW);
    expect(stripped).toContain("[withheld]");
  });
});
