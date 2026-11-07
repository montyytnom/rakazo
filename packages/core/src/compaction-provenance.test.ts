import { describe, expect, it } from "vitest";
import {
  preferFreshToolFacts,
  promotesUnverifiedIdentity,
  rewriteUnverifiedClaims,
} from "./compaction-provenance.js";

describe("compaction provenance", () => {
  it("does not promote an unverified account email to fact", () => {
    const summary =
      "## Current facts\n- logged in as ops@workmail.example via shop-login (confirmed).";
    expect(promotesUnverifiedIdentity(summary, "Header: Hello, sign in")).toBe(true);
    const rewritten = preferFreshToolFacts(summary, "Header: Hello, sign in");
    expect(rewritten).not.toMatch(/ops@workmail\.example/);
    expect(rewriteUnverifiedClaims("Current facts: signed in as Sam.")).toMatch(/^claimed:/i);
  });

  it("keeps a verified identity from tool evidence and ignores a summary that claims verified", () => {
    const summary = "- signed in as sam@shop.example";
    const verified = 'Hello, Sam sam@shop.example\n"verified": true';
    expect(promotesUnverifiedIdentity(summary, verified)).toBe(false);
    expect(rewriteUnverifiedClaims(summary, verified)).toBe(summary);
    expect(
      rewriteUnverifiedClaims("- signed in as ops@workmail.example", "verified: true"),
    ).toMatch(/claimed:/i);
  });
});
