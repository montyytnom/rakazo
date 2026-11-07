import { describe, expect, it } from "vitest";
import {
  extractGeneratedPassword,
  harvestSecretsFromRequestContext,
  harvestSecretsFromText,
  harvestSecretsFromTool,
  harvestSecretsFromUnknown,
  issueProtectedResult,
  looksLikeLabeledSecret,
  looksLikeSecretValue,
  protectedResultNote,
  redactLabeledSecretSpans,
  redactProtectedTree,
  redactThrown,
  secretsFromPriorAssistantText,
  stripEmbeddedTurnContext,
  stripSecretEchoes,
  stripSecretRequestContext,
  stripSecretTranscriptMessages,
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

  it("harvests labelled plaintext from delimited, JSON, and markdown forms", () => {
    const simple = "hunter99";
    expect(harvestSecretsFromText(`password ${simple}`)).toEqual([]);
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

  it("does not treat structured identifiers as unlabeled secrets", () => {
    for (const id of ["item-1", "group-1", "thread-group-1", "call-1", "run-1", "bot-alpha"]) {
      expect(looksLikeSecretValue(id), id).toBe(false);
      expect(harvestSecretsFromUnknown({ id, groupId: id, threadId: id })).toEqual([]);
      expect(redactProtectedTree({ item: id, groupId: id, threadId: id })).toEqual({
        item: id,
        groupId: id,
        threadId: id,
      });
    }
    expect(looksLikeSecretValue(FIXTURE_NEW)).toBe(true);
    expect(redactProtectedTree({ item: FIXTURE_NEW })).toEqual({ item: FIXTURE_NEW });
    expect(redactProtectedTree({ password: "item-1" })).toEqual({ password: "[withheld]" });
    expect(harvestSecretsFromUnknown({ password: "item-1" })).toContain("item-1");
    expect(harvestSecretsFromUnknown({ id: "item-1" })).toEqual([]);
    for (const sku of ["REF-A1b2", "SkuA12B"]) {
      expect(looksLikeSecretValue(sku), sku).toBe(false);
      expect(redactProtectedTree({ item: sku })).toEqual({ item: sku });
    }
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

  it("does not harvest dictionary words after password/secret/pin/otp", () => {
    expect(harvestSecretsFromText("save the password through the saved-login")).toEqual([]);
    expect(harvestSecretsFromText("fields values and placeholders for secret values")).toEqual([]);
    expect(harvestSecretsFromText("Last password change:")).toEqual([]);
    expect(harvestSecretsFromText("password again?")).toEqual([]);
    expect(harvestSecretsFromText("You never send secret values in the clear.")).toEqual([]);
  });

  it("does not reharvest withheld markers after trailing-bracket trim", () => {
    expect(looksLikeLabeledSecret("[withheld]")).toBe(false);
    expect(looksLikeLabeledSecret("[withheld")).toBe(false);
    expect(looksLikeLabeledSecret("[redacted")).toBe(false);
    expect(harvestSecretsFromText("password [withheld]")).toEqual([]);
    expect(harvestSecretsFromText("secret [withheld]]")).toEqual([]);
    const once = redactProtectedTree({ tree: `New password: ${FIXTURE_NEW}` });
    const twice = redactProtectedTree(once);
    expect(twice).toEqual(once);
    expect(JSON.stringify(twice)).not.toMatch(/withheld\]\]/);
  });

  it("does not harvest system, tool definitions, or turn_context", () => {
    const request = noSecretProductionShapedRequest();
    expect(harvestSecretsFromRequestContext(request)).toEqual([]);
    expect(harvestSecretsFromUnknown(request.systemPrompt)).toEqual([]);
    expect(harvestSecretsFromUnknown(request.tools)).toEqual([]);
    const labeledInDefs = {
      systemPrompt: `password is ${FIXTURE_NEW}`,
      tools: [{ name: "request_secret", description: `secret is ${FIXTURE_OLD}` }],
      turn_context: `otp is ${FIXTURE_NEW}`,
      messages: [{ role: "user", content: "hello" }],
    };
    expect(harvestSecretsFromRequestContext(labeledInDefs)).toEqual([]);
    expect(stripSecretRequestContext(labeledInDefs)).toBe(labeledInDefs);
  });

  it("no-secret production-shaped request is byte-identical after strip (same reference)", () => {
    const request = noSecretProductionShapedRequest();
    const stripped = stripSecretRequestContext(request);
    expect(stripped).toBe(request);
    expect(JSON.stringify(stripped)).toBe(JSON.stringify(request));
    const again = stripSecretRequestContext(stripped);
    expect(again).toBe(request);
    expect(JSON.stringify(again)).not.toMatch(/\[withheld/);
  });

  it("strips a structured secret from messages without rewriting system or tool defs", () => {
    const request = noSecretProductionShapedRequest();
    const withSecret = {
      ...request,
      messages: [
        ...request.messages,
        { role: "tool", content: `New password: ${FIXTURE_NEW}` },
      ],
    };
    const stripped = stripSecretRequestContext(withSecret);
    expect(stripped.systemPrompt).toBe(request.systemPrompt);
    expect(stripped.tools).toBe(request.tools);
    expect(JSON.stringify(stripped.messages)).not.toContain(FIXTURE_NEW);
    expect(JSON.stringify(stripped.messages)).toContain("[withheld]");
    const twice = stripSecretRequestContext(stripped);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(stripped));
    expect(JSON.stringify(twice)).not.toMatch(/withheld\]\]/);
  });

  it("no-harvest and no-rewrite: known secrets never rewrite definition trees", () => {
    const request = {
      systemPrompt: `Keep example ${FIXTURE_NEW} and hunter in the prompt.`,
      tools: [{ name: "request_secret", description: `example ${FIXTURE_NEW} hunter` }],
      turn_context: `hunter ${FIXTURE_NEW}`,
      messages: [
        { role: "system", content: `password is ${FIXTURE_NEW}` },
        { role: "tool", content: { password: "hunter", note: "signed in as hunter" } },
        { role: "user", content: `New password: ${FIXTURE_NEW}` },
      ],
    };
    expect(harvestSecretsFromRequestContext(request)).toEqual(["hunter"]);
    const stripped = stripSecretRequestContext(request);
    expect(stripped.systemPrompt).toBe(request.systemPrompt);
    expect(stripped.tools).toBe(request.tools);
    expect(stripped.turn_context).toBe(request.turn_context);
    expect(stripped.messages[0]).toBe(request.messages[0]);
    expect(JSON.stringify(stripped.messages.slice(1))).not.toContain("hunter");
  });

  it("does not mine embedded <turn_context> or FACTS labelled text in the user envelope", () => {
    const secret = FIXTURE_NEW;
    const request = {
      systemPrompt: `Order ${secret} policy. Use ${secret} slots.`,
      tools: [{ name: "request_secret", description: `slots ${secret}` }],
      messages: [
        {
          role: "user",
          content: `Do the reset.\n<turn_context>\nFACTS.md: Wi-Fi password is ${secret}\n</turn_context>`,
        },
      ],
    };
    expect(stripEmbeddedTurnContext(request.messages[0]!.content)).not.toContain(secret);
    expect(harvestSecretsFromRequestContext(request)).toEqual([]);
    const stripped = stripSecretRequestContext(request);
    expect(stripped.systemPrompt).toBe(request.systemPrompt);
    expect(stripped.tools).toBe(request.tools);
    expect(stripped.systemPrompt).toContain(secret);
    expect(stripped.messages[0]!.content).toContain(secret);
  });

  it("untrusted page labelled password is not a known secret and does not rewrite defs", () => {
    const sku = "REF-A1b2C3";
    const request = {
      systemPrompt: `Order ${sku} policy. Use ${sku} slots.`,
      tools: [{ name: "search", description: `Use ${sku} slots.` }],
      messages: [{ role: "tool", content: { tree: `New password: ${sku}`, header: sku } }],
    };
    expect(harvestSecretsFromRequestContext(request)).toEqual([]);
    const stripped = stripSecretRequestContext(request);
    expect(stripped.systemPrompt).toBe(request.systemPrompt);
    expect(stripped.tools).toBe(request.tools);
    expect(JSON.stringify(stripped.messages)).not.toContain(`New password: ${sku}`);
    expect(JSON.stringify(stripped.systemPrompt)).toContain(sku);
  });

  it("any-shape structured secrets echo-strip unlabelled delivered text", () => {
    for (const value of ["482913", "sunflower", "item-1"]) {
      const tree = redactProtectedTree({
        password: value,
        note: `Jordan's code is ${value}`,
      });
      expect(JSON.stringify(tree)).not.toContain(value);
      expect(harvestSecretsFromUnknown({ password: value, newPassword: value })).toContain(value);
    }
  });

  it("withholds unique-secret fragments, splits, and temp-pw labels", () => {
    const secret = FIXTURE_NEW;
    const prefix = secret.slice(0, secret.length - 2);
    expect(stripSecretEchoes(`It starts ${prefix} then -A`, [secret]).text).not.toContain(prefix);
    expect(stripSecretEchoes(secret.split("").join(" "), [secret]).text).not.toMatch(/FxNew/);
    expect(redactLabeledSecretSpans(`Earlier temp pw: ${FIXTURE_OLD}`)).not.toContain(FIXTURE_OLD);
  });

  it("structured fields and known values withhold regardless of shape", () => {
    for (const value of ["hunter", "aaaaaa", "123456", "item-1"]) {
      expect(redactProtectedTree({ password: value })).toEqual({ password: "[withheld]" });
      expect(redactProtectedTree({ otp: value })).toEqual({ otp: "[withheld]" });
      expect(redactProtectedTree({ pin: value })).toEqual({ pin: "[withheld]" });
      expect(harvestSecretsFromUnknown({ password: value })).toContain(value);
    }
    const known = stripSecretEchoes("signed in as hunter on the page", ["hunter"]);
    expect(known.text).toContain("[withheld]");
    expect(known.text).not.toContain("hunter");
    const echoed = redactProtectedTree({
      password: "hunter",
      note: "signed in as hunter",
    });
    expect(JSON.stringify(echoed)).not.toContain("hunter");
    expect(stripSecretEchoes("hunting hunter2", ["hunter"]).text).toBe("hunting hunter2");
  });

  it("untrusted page/result/args without secret metadata keep SKU, pin English, and mixed refs", () => {
    const page = {
      tree: "Enter pin 123456. SKU REF-A1b2. Confirmation SkuA12B.",
      header: "pin English help",
    };
    expect(redactProtectedTree(page)).toEqual(page);
    expect(harvestSecretsFromText("pin: 123456")).toEqual([]);
    expect(harvestSecretsFromText("otp is 999999")).toEqual([]);
    const args = { title: "REF-A1b2", quantity: 12, note: "pin reminder" };
    expect(harvestSecretsFromUnknown(args)).toEqual([]);
    expect(redactProtectedTree(args)).toEqual(args);
    const result = { ok: true, json: { sku: "REF-A1b2", pinLabel: "pin" } };
    expect(JSON.stringify(redactProtectedTree(result))).toContain("REF-A1b2");
    expect(JSON.stringify(redactProtectedTree(result))).toContain("pin");
  });

  it("labeled history redacts dictionary generated passwords in-place without global-replacing common words", () => {
    const page = redactProtectedTree({
      tree: "New password: hunter. Later through values stay.",
    });
    expect(JSON.stringify(page)).toContain("[withheld]");
    expect(JSON.stringify(page)).not.toContain("New password: hunter");
    expect(JSON.stringify(page)).toContain("through values stay");
    expect(harvestSecretsFromText("New password: hunter")).toEqual([]);
    const echoed = stripSecretEchoes("through the saved-login", harvestSecretsFromText("password is through"));
    expect(echoed.echoed).toBe(false);
    expect(echoed.text).toBe("through the saved-login");
  });

  it("transcript strip is identity when no secrets and skips system-role harvest", () => {
    const messages = [
      { role: "system", content: "Save the password through the saved-login." },
      { role: "user", content: "Reset password successful." },
    ];
    expect(stripSecretTranscriptMessages(messages)).toBe(messages);
  });

  it("browser_act fill_secret secret is a login name; add_mcp_server.secret is a token", () => {
    const args = {
      actions: [{ kind: "fill_secret", secret: "shop-login", field: "password" }],
    };
    expect(harvestSecretsFromTool("browser_act", args, { ok: true, tree: "(filled from shop-login)" })).not.toContain(
      "shop-login",
    );
    expect(redactProtectedTree(args)).toEqual(args);
    expect(
      harvestSecretsFromTool("list_secrets", {}, { secrets: [{ name: "shop-login" }] }),
    ).not.toContain("shop-login");
    expect(harvestSecretsFromTool("add_mcp_server", { secret: "mcpTok#9f" }, { ok: true })).toContain(
      "mcpTok#9f",
    );
  });

  it("serialized tool-result page text does not poison other refs", () => {
    const sku = "REF-A1b2C3";
    const serialized = [{ type: "text", text: JSON.stringify({ tree: `new password: ${sku}` }) }];
    expect(harvestSecretsFromUnknown(serialized)).not.toContain(sku);
    const tree = redactProtectedTree({
      serialized,
      other: `Your order ref is ${sku}.`,
    });
    expect(JSON.stringify(tree)).toContain(`Your order ref is ${sku}.`);
  });

  it("numeric structured pins do not erase dates", () => {
    expect(redactProtectedTree({ pin: "2026", note: "See you Nov 7, 2026." })).toEqual({
      pin: "[withheld]",
      note: "See you Nov 7, 2026.",
    });
    expect(stripSecretEchoes("See you Nov 7, 2026.", ["2026"]).text).toBe("See you Nov 7, 2026.");
    expect(stripSecretEchoes("Order 482913 ships Tuesday", ["482913"]).text).toBe(
      "Order 482913 ships Tuesday",
    );
    expect(stripSecretEchoes("Jordan's code is 482913", ["482913"]).text).toContain("[withheld]");
  });

  it("dictionary structured secrets stay span-bounded and do not erase ordinary words", () => {
    expect(redactProtectedTree({ password: "sunflower", note: "The sunflowers need water." })).toEqual({
      password: "[withheld]",
      note: "The sunflowers need water.",
    });
    expect(stripSecretEchoes("The sunflowers need water.", ["sunflower"]).text).toBe(
      "The sunflowers need water.",
    );
    expect(stripSecretEchoes("Use sunflower to log in", ["sunflower"]).text).toContain("[withheld]");
  });
});

function noSecretProductionShapedRequest() {
  return {
    systemPrompt:
      "Save the password through the saved-login when asked. Composio tools follow. You never send secret values in the clear.",
    tools: [
      {
        name: "request_secret",
        description: "Ask for secret values. Schema fields, values and placeholders stay visible.",
        inputSchema: {
          properties: {
            generate: { description: "Generate a secret value" },
            fields: {},
            values: {},
            placeholders: {},
          },
        },
      },
      { name: "request_takeover", description: "Take over when secret values are needed." },
      {
        name: "search_history",
        inputSchema: {
          properties: {
            after: { description: "messages after" },
            before: { description: "messages before" },
          },
        },
      },
      { name: "secret_request", description: "Authenticated request; secret values stay at origin." },
      { name: "update_bot", description: "Update the bot. Secret values are not returned." },
    ],
    turn_context: "Current date and time for this turn.",
    messages: [
      { role: "system", content: "Save the password through the saved-login." },
      { role: "user", content: "Reset password successful. The password field is required." },
    ],
  };
}
