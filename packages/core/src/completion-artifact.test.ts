import { describe, expect, it } from "vitest";
import {
  collectToolEvidence,
  headlineAllowsDone,
  sanitizeFinalText,
  unsupportedClaims,
} from "./completion-artifact.js";

describe("completion artifacts", () => {
  it("rejects an identity claim that never appeared in a tool result", () => {
    const evidence = collectToolEvidence([{ header: "Hello, sign in", tree: "Cart: 1 item" }]);
    const text = "Logged in as ops@workmail.example and the bag is in the cart.";
    expect(unsupportedClaims(text, evidence)).toContain("identity");
    expect(sanitizeFinalText(text, evidence)).not.toMatch(/ops@workmail\.example/);
  });

  it("rejects a license reassignment with no license artifact", () => {
    const evidence = collectToolEvidence([{ title: "404 Not Found" }]);
    const text = "License reassigned. Shannon's profile shows no license.";
    expect(unsupportedClaims(text, evidence)).toContain("license");
    expect(sanitizeFinalText(text, evidence)).toMatch(/not verified/i);
  });

  it("removes a send contradiction and keeps a verified headline gate", () => {
    const sent = collectToolEvidence([{ sent: false, error: "not yet sent" }]);
    const text = "Launched Messages and sent the text — but it is not yet sent.";
    expect(unsupportedClaims(text, sent)).toContain("send-contradiction");
    expect(sanitizeFinalText(text, sent)).not.toMatch(/\bsent\b/i);
    expect(headlineAllowsDone(collectToolEvidence([{ verified: true }]))).toBe(true);
    expect(headlineAllowsDone(collectToolEvidence([{ ok: true }]))).toBe(false);
  });

  it("strips a done/complete claim without verified or delivered artifact evidence", () => {
    const unsupported = collectToolEvidence([{ error: "unsupported computer action", ok: false }]);
    expect(headlineAllowsDone(unsupported)).toBe(false);
    expect(unsupportedClaims("Done", unsupported)).toContain("success-without-artifact");
    expect(sanitizeFinalText("Done", unsupported)).toBe("Outcome was not verified.");
    expect(sanitizeFinalText("Reset complete.", collectToolEvidence([{ ok: true }]))).toBe(
      "Outcome was not verified.",
    );
    expect(
      sanitizeFinalText("Done", collectToolEvidence([{ sent: true, state: "Delivered" }])),
    ).toBe("Done");
  });

  it("does not treat a credit limit as a payment", () => {
    const evidence = collectToolEvidence([
      { text: "Credit limit $17,000.00. ACH PAYMENT -$4,245.52." },
    ]);
    const bad = "The $17,000 ACH payment posted and is verified.";
    expect(unsupportedClaims(bad, evidence)).toContain("limit-as-payment");
    expect(sanitizeFinalText(bad, evidence)).not.toMatch(/17,?000[^.]{0,40}payment/i);
  });
});
