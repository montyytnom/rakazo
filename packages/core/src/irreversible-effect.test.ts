import { describe, expect, it } from "vitest";
import {
  classifyBrowserMutation,
  classifyIrreversibleTool,
  irreversibleIntentId,
  isContinueNudge,
  isThreadIrreversibleEffectKey,
  resolveTurnIntent,
  sameThreadIrreversibleOwner,
  threadIrreversibleEffectKey,
} from "./irreversible-effect.js";

describe("irreversible intent", () => {
  it("keeps Continue on the authorizing message and treats a later same-text request as new", () => {
    const first = resolveTurnIntent({ id: "msg-1", text: "Reset the fixture user password" });
    expect(isContinueNudge("Continue")).toBe(true);
    expect(
      resolveTurnIntent({ id: "msg-2", text: "Continue" }, [
        { id: "msg-1", text: "Reset the fixture user password" },
      ]).intentId,
    ).toBe(first.intentId);
    expect(
      resolveTurnIntent({ id: "msg-3", text: "Reset the fixture user password" }).intentId,
    ).not.toBe(first.intentId);
    expect(first.authorized).toBe(true);
    expect(
      resolveTurnIntent({ id: "msg-4", text: "Continue" }, [{ text: "summary of 50 messages." }])
        .authorized,
    ).toBe(false);
  });

  it("does not authorize irreversible work from a compacted summary", () => {
    const nudge = resolveTurnIntent({ text: "Continue" }, [
      { text: "Reset the fixture user password" },
    ]);
    expect(nudge.authorized).toBe(false);
    expect(nudge.sourceMessageId).toBeNull();
  });
});

describe("classifyIrreversibleTool", () => {
  it("classifies send and generate, not reads", () => {
    expect(
      classifyIrreversibleTool("mcp__grommunio-email__send_mail", { to: "pat@example.test" }),
    ).toEqual({ class: "send", subject: "pat@example.test" });
    expect(
      classifyIrreversibleTool("installed_execute_tool", {
        name: "mac_messages_send",
        arguments: { handle: "+15550100" },
      }),
    ).toEqual({ class: "send", subject: "+15550100" });
    expect(
      classifyIrreversibleTool("request_secret", {
        generate: true,
        origin: "https://admin.example.test",
      }),
    ).toEqual({ class: "secret-generate", subject: "https://admin.example.test" });
    expect(classifyIrreversibleTool("browser_snapshot", {})).toBeNull();
  });

  it("classifies browser reset and place-order by control labels", () => {
    expect(
      classifyBrowserMutation(
        ["button 'RESET PASSWORD'"],
        "https://admin.example.test/ac/users/u-1",
      ),
    ).toEqual({
      class: "password-reset",
      subject: "https://admin.example.test/ac/users/u-1",
    });
    expect(
      classifyBrowserMutation(["button 'Place your order'"], "https://shop.example/checkout"),
    ).toEqual({
      class: "purchase",
      subject: "https://shop.example/checkout",
    });
  });
});

describe("threadIrreversibleEffectKey", () => {
  it("binds class to the authorizing message, not the recipient text", () => {
    const a = threadIrreversibleEffectKey({
      threadId: "thread-1",
      intentId: "intent-a",
      class: "send",
      subject: "+15550100",
    });
    const b = threadIrreversibleEffectKey({
      threadId: "thread-1",
      intentId: "intent-a",
      class: "send",
      subject: "+15550999",
    });
    const c = threadIrreversibleEffectKey({
      threadId: "thread-1",
      intentId: "intent-b",
      class: "send",
      subject: "+15550100",
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(isThreadIrreversibleEffectKey(a)).toBe(true);
    expect(irreversibleIntentId("Continue", "intent-a")).toBe("intent-a");
    expect(
      sameThreadIrreversibleOwner({
        existingSpaceId: "space-1",
        existingRequest: { threadId: "thread-1", intentId: "intent-a" },
        spaceId: "space-1",
        threadId: "thread-1",
        intentId: "intent-a",
      }),
    ).toBe(true);
    expect(
      sameThreadIrreversibleOwner({
        existingSpaceId: "space-1",
        existingRequest: { threadId: "thread-1", intentId: "intent-a" },
        spaceId: "space-1",
        threadId: "thread-1",
        intentId: "intent-b",
      }),
    ).toBe(false);
  });
});
