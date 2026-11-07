import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bindOutcomeArtifact,
  collectToolEvidence,
  emptyCompletionLedger,
  headlineAllowsDone,
  ledgerAllowsGenericSuccess,
  ledgerAllowsSuccess,
  sanitizeFinalText,
  unsupportedClaims,
} from "./completion-artifact.js";
import { classifyBrowserMutation } from "./irreversible-effect.js";

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

  it("rejects a completed-action claim with no current-intent ledger", () => {
    const evidence = collectToolEvidence([{ title: "404 Not Found" }]);
    const text = "License reassigned. Shannon's profile shows no license.";
    expect(unsupportedClaims(text, evidence)).toContain("success-without-artifact");
    expect(sanitizeFinalText(text, evidence)).toBe("Shannon's profile shows no license.");
    expect(sanitizeFinalText(text, evidence)).not.toMatch(/reassigned/i);
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

  it("rewrites a realistic unverified completion claim, including glued and whitespace variants", () => {
    const idle = collectToolEvidence([]);
    for (const claim of [
      "All set.",
      "DoneAll set.",
      "Done\n\nAll set.",
      "Done All set.",
      "Done. All set.",
    ]) {
      expect(unsupportedClaims(claim, idle)).toContain("success-without-artifact");
      expect(sanitizeFinalText(claim, idle)).toBe("Outcome was not verified.");
    }
  });

  it("keeps unrelated legitimate text and does not strip non-English completions", () => {
    const idle = collectToolEvidence([]);
    expect(sanitizeFinalText("The bag is in the cart.", idle)).toBe("The bag is in the cart.");
    expect(sanitizeFinalText("I found three matching rows.", idle)).toBe(
      "I found three matching rows.",
    );
    expect(sanitizeFinalText("Listo.", idle)).toBe("Listo.");
    expect(sanitizeFinalText("Done. The bag is in the cart.", idle)).toBe(
      "The bag is in the cart.",
    );
    expect(sanitizeFinalText("DoneThe bag is in the cart.", idle)).toBe(
      "The bag is in the cart.",
    );
  });

  it("does not match harness filler tokens or capture sentinels in production source", () => {
    const src = readFileSync(new URL("./completion-artifact.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/synthetic-stop/);
    expect(src).not.toMatch(/Cur#Rpr/);
    expect(src).not.toMatch(/Old#Stl/);
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
      action: "send",
      subject: "+15550100",
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

  it("does not let a verified-read license Done/All set or unrelated completed actions", () => {
    const ledger = emptyCompletionLedger(INTENT);
    const artifact = bindOutcomeArtifact({
      result: { verified: true, tree: "Reset password successful.", url: "https://admin.example/reset" },
      toolName: "browser_extract",
      ...INTENT,
    });
    expect(artifact?.class).toBe("verified-read");
    ledger.artifacts.push(artifact!);
    expect(ledgerAllowsSuccess(ledger)).toBe(true);
    expect(ledgerAllowsGenericSuccess(ledger)).toBe(false);
    const evidence = collectToolEvidence([{ verified: true }]);
    expect(sanitizeFinalText("All set.", evidence, ledger)).toBe("Outcome was not verified.");
    expect(sanitizeFinalText("Done", evidence, ledger)).toBe("Outcome was not verified.");
    expect(sanitizeFinalText("License reassigned.", evidence, ledger)).toBe(
      "Outcome was not verified.",
    );
  });

  it("never returns an empty final", () => {
    const idle = collectToolEvidence([]);
    expect(sanitizeFinalText("", idle)).toBe("Outcome was not verified.");
    expect(sanitizeFinalText("   ", idle)).toBe("Outcome was not verified.");
    expect(sanitizeFinalText("The payment posted and is verified.", idle)).toBe(
      "Outcome was not verified.",
    );
  });

  it("adversarial families: local negation, identity prepositions, send claims, finished, English-only", () => {
    const idle = collectToolEvidence([]);
    expect(sanitizeFinalText("reassigned the license, nothing failed", idle)).toBe(
      "Outcome was not verified.",
    );
    expect(sanitizeFinalText("Signed in as Sam", idle)).toMatch(/not on the page/i);
    expect(sanitizeFinalText("signed in with shop-login", idle)).toMatch(/not on the page/i);
    expect(sanitizeFinalText("signed in using the shop-login account", idle)).toMatch(
      /not on the page/i,
    );
    expect(unsupportedClaims("Text sent", idle)).toContain("send-without-artifact");
    expect(sanitizeFinalText("Text sent", idle)).toBe("Delivery was not verified.");
    expect(sanitizeFinalText("the message went out", idle)).toBe("Delivery was not verified.");
    expect(sanitizeFinalText("Finished — the rows are listed", idle)).toBe("the rows are listed");
    expect(sanitizeFinalText("Listo.", idle)).toBe("Listo.");
    expect(sanitizeFinalText("You will not need to reset after this.", idle)).toBe(
      "You will not need to reset after this.",
    );
  });

  it("send claims require a delivered-send ledger, not blob sent or verified-read", () => {
    const blobSent = collectToolEvidence([{ sent: true, state: "Delivered" }]);
    expect(sanitizeFinalText("Text sent", blobSent)).toBe("Delivery was not verified.");
    const ledger = emptyCompletionLedger(INTENT);
    const artifact = bindOutcomeArtifact({
      result: { sent: true, state: "Delivered" },
      toolName: "mac_messages_send",
      args: { handle: "+15550100", text: "Running late." },
      ...INTENT,
    });
    ledger.artifacts.push(artifact!);
    expect(sanitizeFinalText("Text sent", blobSent, ledger)).toBe("Delivery was not verified.");
    expect(sanitizeFinalText("sent to +15550100", blobSent, ledger)).toBe("sent to +15550100");
  });

  it("verified-read of resource A does not license verified B", () => {
    const ledger = emptyCompletionLedger(INTENT);
    const artifact = bindOutcomeArtifact({
      result: { verified: true, tree: "Reset password successful.", url: "https://admin.example/reset" },
      toolName: "browser_extract",
      ...INTENT,
    });
    ledger.artifacts.push(artifact!);
    const evidence = collectToolEvidence([{ verified: true }]);
    expect(sanitizeFinalText("Reset is verified.", evidence, ledger)).toBe("Reset is verified.");
    expect(sanitizeFinalText("License is verified.", evidence, ledger)).toBe(
      "Outcome was not verified.",
    );
    expect(sanitizeFinalText("Billing is verified.", evidence, ledger)).toBe(
      "Outcome was not verified.",
    );
  });

  it("send and reset claims require matching action proof on this intent", () => {
    const sendLedger = emptyCompletionLedger(INTENT);
    sendLedger.artifacts.push({
      class: "delivered-send",
      action: "send",
      subject: "+15550100",
      ...INTENT,
    });
    const evidence = collectToolEvidence([{ sent: true }]);
    expect(sanitizeFinalText("Text sent", evidence, sendLedger)).toBe(
      "Delivery was not verified.",
    );
    expect(sanitizeFinalText("sent to +15550100", evidence, sendLedger)).toBe("sent to +15550100");
    expect(sanitizeFinalText("sent to Pat Lee", evidence, sendLedger)).toBe(
      "Delivery was not verified.",
    );
    expect(sanitizeFinalText("It is reset.", evidence, sendLedger)).toBe(
      "Outcome was not verified.",
    );
    expect(sanitizeFinalText("sent to +19998887777", evidence, sendLedger)).toBe(
      "Delivery was not verified.",
    );
    const resetLedger = emptyCompletionLedger(INTENT);
    resetLedger.artifacts.push({
      class: "task-proof",
      action: "reset",
      subject: "https://admin.example/reset",
      ...INTENT,
    });
    resetLedger.artifacts.push({
      class: "verified-read",
      action: "read",
      subject: "https://admin.example/reset",
      ...INTENT,
    });
    expect(sanitizeFinalText("It is reset.", collectToolEvidence([]), resetLedger)).toBe(
      "It is reset.",
    );
    expect(sanitizeFinalText("sent to +15550100", collectToolEvidence([]), resetLedger)).toBe(
      "Delivery was not verified.",
    );
  });

  it("a Reset click or filter ok:true does not mint reset task-proof", () => {
    const dialog = classifyBrowserMutation(
      ["button 'RESET PASSWORD'"],
      "https://admin.example/users/u-1",
    );
    expect(dialog?.class).toBe("password-reset");
    expect(
      bindOutcomeArtifact({
        result: { ok: true, tree: "Dialog OPEN RESET PASSWORD" },
        toolName: "browser_act",
        classification: dialog,
        ...INTENT,
      }),
    ).toBeNull();
    const filter = classifyBrowserMutation(["Reset"], "https://shop.example/search");
    expect(filter?.class).toBe("password-reset");
    expect(
      bindOutcomeArtifact({
        result: { ok: true },
        toolName: "browser_act",
        classification: filter,
        ...INTENT,
      }),
    ).toBeNull();
  });

  it("reset proof is a verified-read of post-reset page copy; it does not license order/license claims", () => {
    const subject = "https://admin.example/users/u-1";
    const ledger = emptyCompletionLedger(INTENT);
    const click = classifyBrowserMutation(["button 'RESET PASSWORD'"], subject);
    expect(
      bindOutcomeArtifact({
        result: { ok: true },
        toolName: "browser_act",
        classification: click,
        ...INTENT,
      }),
    ).toBeNull();
    expect(
      bindOutcomeArtifact({
        result: {
          outcomeProof: true,
          intentId: INTENT.intentId,
          sourceMessageId: INTENT.sourceMessageId,
          runId: INTENT.runId,
          subject,
        },
        toolName: "browser_snapshot",
        classification: { class: "password-reset", subject },
        ...INTENT,
      }),
    ).toBeNull();
    const read = bindOutcomeArtifact({
      result: { verified: true, url: subject, tree: "Password was changed." },
      toolName: "browser_snapshot",
      ...INTENT,
    });
    expect(read?.class).toBe("verified-read");
    expect(read?.action).toBe("reset");
    ledger.artifacts.push(read!);
    expect(sanitizeFinalText("It is reset.", collectToolEvidence([]), ledger)).toBe("It is reset.");
    expect(sanitizeFinalText("All set, your order is placed.", collectToolEvidence([]), ledger)).toBe(
      "Outcome was not verified.",
    );
    expect(sanitizeFinalText("License reassigned to j.rivera.", collectToolEvidence([]), ledger)).toBe(
      "Outcome was not verified.",
    );
  });

  it("reset proof is same-subject; send and empty ledgers do not license reset claims", () => {
    const idle = collectToolEvidence([]);
    const cross = emptyCompletionLedger(INTENT);
    cross.artifacts.push({
      class: "task-proof",
      action: "reset",
      subject: "https://admin.example.test/ac/users/u-1001",
      ...INTENT,
    });
    cross.artifacts.push({
      class: "verified-read",
      action: "read",
      subject: "https://shop.example/cart",
      ...INTENT,
    });
    expect(sanitizeFinalText("It is reset.", idle, cross)).toBe("Outcome was not verified.");
    const sendOnly = emptyCompletionLedger(INTENT);
    sendOnly.artifacts.push({
      class: "delivered-send",
      action: "send",
      subject: "+15550199",
      ...INTENT,
    });
    expect(sanitizeFinalText("Done — the password is reset.", idle, sendOnly)).toBe(
      "Outcome was not verified.",
    );
    expect(sanitizeFinalText("Done. Jordan's password is reset.", idle, sendOnly)).toBe(
      "Outcome was not verified.",
    );
    expect(sanitizeFinalText("Your password has been reset.", idle)).toBe(
      "Outcome was not verified.",
    );
    const resetA = emptyCompletionLedger(INTENT);
    resetA.artifacts.push({
      class: "task-proof",
      action: "reset",
      subject: "https://admin.example.test/ac/users/u-1001",
      ...INTENT,
    });
    resetA.artifacts.push({
      class: "verified-read",
      action: "read",
      subject: "https://admin.example.test/ac/users/u-1001",
      ...INTENT,
    });
    expect(sanitizeFinalText("All set, the subscription is cancelled.", idle, resetA)).toBe(
      "Outcome was not verified.",
    );
    const produced = bindOutcomeArtifact({
      result: {
        verified: true,
        url: "https://admin.example/users/u-1",
        tree: "Password was changed.",
      },
      toolName: "browser_snapshot",
      ...INTENT,
    });
    expect(produced?.class).toBe("verified-read");
    expect(produced?.action).toBe("reset");
    const live = emptyCompletionLedger(INTENT);
    live.artifacts.push(produced!);
    expect(sanitizeFinalText("It is reset.", idle, live)).toBe("It is reset.");
  });

  it("uses proof-token identity, not substring or discourse-no or glued ok", () => {
    const idle = collectToolEvidence([]);
    expect(sanitizeFinalText("No worries, all set", idle)).toBe("Outcome was not verified.");
    expect(sanitizeFinalText("No issues, completed", idle)).toBe("Outcome was not verified.");
    expect(sanitizeFinalText("OKRs are on track.", idle)).toBe("OKRs are on track.");
    expect(sanitizeFinalText("Completely listed the rows.", idle)).toBe(
      "Completely listed the rows.",
    );
    expect(sanitizeFinalText("Your password has been reset.", idle)).toBe(
      "Outcome was not verified.",
    );
    expect(sanitizeFinalText("The record has been transferred.", idle)).toBe(
      "Outcome was not verified.",
    );
    expect(sanitizeFinalText("using the shop-login account", idle)).toMatch(/not on the page/i);
    const sample = collectToolEvidence([{ tree: "Sample user signed out" }]);
    expect(sanitizeFinalText("Signed in as Sam", sample)).toMatch(/not on the page/i);
    const shop = collectToolEvidence([{ tree: "saved shop-login for the store" }]);
    expect(sanitizeFinalText("using the shop-login account", shop)).toBe(
      "using the shop-login account",
    );
    const cartLedger = emptyCompletionLedger(INTENT);
    cartLedger.artifacts.push({
      class: "verified-read",
      action: "read",
      subject: "https://shop.example/cart",
      ...INTENT,
    });
    expect(
      sanitizeFinalText(
        "I confirmed the cart has 1 item and verified the shipping address.",
        collectToolEvidence([{ verified: true }]),
        cartLedger,
      ),
    ).toBe("I confirmed the cart has 1 item and verified the shipping address.");
  });

  it("does not match grader amount or license-phrase literals in production source", () => {
    const src = readFileSync(new URL("./completion-artifact.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/17,?000/);
    expect(src).not.toMatch(/LICENSE_CLAIM/);
    expect(src).not.toMatch(/LIMIT_AS_PAYMENT/);
    expect(src).not.toMatch(/moved the license/);
  });
});
