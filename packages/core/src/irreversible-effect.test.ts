import { describe, expect, it } from "vitest";
import {
  classifyBrowserMutation,
  classifyIrreversibleTool,
  irreversibleIntentId,
  isContinueNudge,
  isThreadIrreversibleEffectKey,
  resolveTurnIntentId,
  sameThreadIrreversibleOwner,
  threadIrreversibleEffectKey,
} from "./irreversible-effect.js";

describe("irreversible intent", () => {
  it("keeps Continue on the prior intent and treats a new reset request as distinct", () => {
    const first = irreversibleIntentId("Reset the fixture user password");
    expect(isContinueNudge("Continue")).toBe(true);
    expect(irreversibleIntentId("Continue", first)).toBe(first);
    expect(irreversibleIntentId("It did not work. Reset it again.", first)).not.toBe(first);
    expect(resolveTurnIntentId("Continue", ["Reset the fixture user password", "Continue"])).toBe(
      first,
    );
    expect(
      resolveTurnIntentId("It did not work. Reset it again.", ["Reset the fixture user password"]),
    ).not.toBe(first);
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
  it("is stable per thread intent and distinct across intents", () => {
    const a = threadIrreversibleEffectKey({
      threadId: "thread-1",
      intentId: "intent-a",
      class: "password-reset",
      subject: "https://admin.example.test/u-1",
    });
    const b = threadIrreversibleEffectKey({
      threadId: "thread-1",
      intentId: "intent-a",
      class: "password-reset",
      subject: "https://admin.example.test/u-1",
    });
    const c = threadIrreversibleEffectKey({
      threadId: "thread-1",
      intentId: "intent-b",
      class: "password-reset",
      subject: "https://admin.example.test/u-1",
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(isThreadIrreversibleEffectKey(a)).toBe(true);
    expect(
      sameThreadIrreversibleOwner({
        existingSpaceId: "space-1",
        existingRequest: { threadId: "thread-1" },
        spaceId: "space-1",
        threadId: "thread-1",
      }),
    ).toBe(true);
    expect(
      sameThreadIrreversibleOwner({
        existingSpaceId: "space-1",
        existingRequest: { threadId: "thread-1" },
        spaceId: "space-1",
        threadId: "thread-2",
      }),
    ).toBe(false);
  });
});
