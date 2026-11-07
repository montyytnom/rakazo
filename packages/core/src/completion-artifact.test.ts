import { describe, expect, it } from "vitest";
import {
  bindOutcomeArtifact,
  collectToolEvidence,
  emptyCompletionLedger,
  headlineAllowsDone,
  ledgerAllowsSuccess,
  sanitizeFinalText,
  unsupportedClaims,
} from "./completion-artifact.js";

const INTENT = {
  intentId: "intent-reset",
  sourceMessageId: "msg-1",
  runId: "run-1",
};

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

  it("removes a send contradiction", () => {
    const sent = collectToolEvidence([{ sent: false, error: "not yet sent" }]);
    const text = "Launched Messages and sent the text — but it is not yet sent.";
    expect(unsupportedClaims(text, sent)).toContain("send-contradiction");
    expect(sanitizeFinalText(text, sent)).not.toMatch(/\bsent\b/i);
  });

  it("does not treat blob verified/sent as an intent-bound success ledger", () => {
    expect(headlineAllowsDone(collectToolEvidence([{ verified: true }]))).toBe(false);
    expect(headlineAllowsDone(collectToolEvidence([{ sent: true, state: "Delivered" }]))).toBe(
      false,
    );
    expect(
      sanitizeFinalText("Done", collectToolEvidence([{ sent: true, state: "Delivered" }])),
    ).toBe("Outcome was not verified.");
  });

  it("strips Done/All set/Successfully changed/It is reset without a current-intent ledger", () => {
    const unsupported = collectToolEvidence([{ error: "unsupported computer action", ok: false }]);
    const login = collectToolEvidence([{ ok: true, tree: "Sign in to your account" }]);
    const missing = collectToolEvidence([{ title: "404 Not Found" }]);
    const idle = collectToolEvidence([]);
    const unrelated = collectToolEvidence([{ sent: true, state: "Delivered" }]);
    for (const claim of ["Done", "All set.", "Successfully changed.", "It is reset."]) {
      expect(unsupportedClaims(claim, unsupported)).toContain("success-without-artifact");
      expect(sanitizeFinalText(claim, unsupported)).toBe("Outcome was not verified.");
      expect(sanitizeFinalText(claim, login)).toBe("Outcome was not verified.");
      expect(sanitizeFinalText(claim, missing)).toBe("Outcome was not verified.");
      expect(sanitizeFinalText(claim, idle)).toBe("Outcome was not verified.");
      expect(sanitizeFinalText(claim, unrelated)).toBe("Outcome was not verified.");
    }
  });

  it("rewrites a bare Done glued to a nudge-turn filler at the terminal boundary", () => {
    const idle = collectToolEvidence([]);
    for (const claim of [
      "Donesynthetic-stop-0",
      "Done\n\nsynthetic-stop-0",
      "Done synthetic-stop-0",
    ]) {
      expect(unsupportedClaims(claim, idle)).toContain("success-without-artifact");
      expect(sanitizeFinalText(claim, idle)).toBe("Outcome was not verified.");
    }
  });

  it("keeps the original final when the ledger has current-intent delivered-send proof", () => {
    const ledger = emptyCompletionLedger(INTENT);
    const artifact = bindOutcomeArtifact({
      result: { sent: true, state: "Delivered" },
      toolName: "mac_messages_send",
      args: { handle: "+15550100", text: "Running late." },
      ...INTENT,
    });
    expect(artifact?.class).toBe("delivered-send");
    ledger.artifacts.push(artifact!);
    expect(ledgerAllowsSuccess(ledger)).toBe(true);
    expect(sanitizeFinalText("Done", collectToolEvidence([{ sent: true }]), ledger)).toBe("Done");
  });

  it("keeps a verified-read final when the ledger matches this intent and run", () => {
    const ledger = emptyCompletionLedger(INTENT);
    const artifact = bindOutcomeArtifact({
      result: { verified: true, tree: "Reset password successful." },
      toolName: "browser_extract",
      ...INTENT,
    });
    expect(artifact?.class).toBe("verified-read");
    ledger.artifacts.push(artifact!);
    expect(
      sanitizeFinalText("Reset is verified.", collectToolEvidence([{ verified: true }]), ledger),
    ).toBe("Reset is verified.");
  });

  it("does not accept stale prior-run or other-message proof", () => {
    const current = emptyCompletionLedger(INTENT);
    current.artifacts.push({
      class: "delivered-send",
      intentId: INTENT.intentId,
      sourceMessageId: "msg-old",
      runId: "run-old",
    });
    expect(ledgerAllowsSuccess(current)).toBe(false);
    expect(sanitizeFinalText("All set.", collectToolEvidence([]), current)).toBe(
      "Outcome was not verified.",
    );
  });

  it("does not treat a login page or license 404 as verified-read", () => {
    expect(
      bindOutcomeArtifact({
        result: { ok: true, tree: "Sign in to continue" },
        toolName: "browser_snapshot",
        ...INTENT,
      }),
    ).toBeNull();
    expect(
      bindOutcomeArtifact({
        result: { verified: true, tree: "Sign in to continue" },
        toolName: "browser_snapshot",
        ...INTENT,
      }),
    ).toBeNull();
    expect(
      bindOutcomeArtifact({
        result: { title: "404 Not Found", ok: false },
        toolName: "browser_extract",
        ...INTENT,
      }),
    ).toBeNull();
    expect(
      bindOutcomeArtifact({
        result: { verified: true, title: "404 Not Found" },
        toolName: "browser_extract",
        ...INTENT,
      }),
    ).toBeNull();
    expect(
      bindOutcomeArtifact({
        result: { sent: true, state: "Delivered" },
        toolName: "scratchpad_add",
        ...INTENT,
      }),
    ).toBeNull();
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
