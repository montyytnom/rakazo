import {
  classifyIrreversibleTool,
  irreversibleEffectRequest,
  resolveTurnIntent,
  threadIrreversibleEffectKey,
} from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { resolveDuplicateEffectGate } from "./approval-effect.js";
import { recordEffect } from "./executor.js";
import { redactReplayResult } from "./protected-result.js";

type Effect = {
  id: string;
  runId: string;
  spaceId: string;
  idempotencyKey: string;
  kind: string;
  request: unknown;
  status: string;
  result?: unknown;
};

function fixture(initial: Effect[] = []) {
  const stored = new Map(initial.map((effect) => [effect.idempotencyKey, effect]));
  const create = async ({ data }: { data: Omit<Effect, "id"> }) => {
    if (stored.has(data.idempotencyKey)) throw new Error("Duplicate key");
    const effect = { ...data, id: `effect-${stored.size}` };
    stored.set(data.idempotencyKey, effect);
    return effect;
  };
  const deps = {
    prisma: {
      externalEffect: {
        findUnique: async ({ where }: { where: { idempotencyKey: string } }) =>
          stored.get(where.idempotencyKey) ?? null,
        findMany: async () => [...stored.values()],
        create,
      },
    },
    events: { append: async () => undefined },
  } as unknown as Parameters<typeof recordEffect>[0];
  return { deps, stored };
}

describe("cross-run irreversible ledger", () => {
  it("reuses a completed send after timeout instead of sending again", async () => {
    const intentId = resolveTurnIntent({ id: "msg-1", text: "Text Pat: running late" }).intentId;
    const classification = classifyIrreversibleTool("installed_execute_tool", {
      name: "mac_messages_send",
      arguments: { handle: "+15550100", text: "Running 10 minutes late." },
    });
    expect(classification?.class).toBe("send");
    const key = threadIrreversibleEffectKey({
      threadId: "thread-1",
      intentId,
      class: classification!.class,
      subject: classification!.subject,
    });
    const request = irreversibleEffectRequest(classification!, "thread-1", intentId, {
      handle: "+15550100",
    });
    const f = fixture();
    const first = await recordEffect(
      f.deps,
      { id: "run-1", spaceId: "space-1", threadId: "thread-1", botId: "bot-1" },
      "send",
      key,
      request,
    );
    first.effect.status = "completed";
    first.effect.result = { sent: true, state: "Delivered" };
    const second = await recordEffect(
      f.deps,
      { id: "run-2", spaceId: "space-1", threadId: "thread-1", botId: "bot-1" },
      "send",
      key,
      request,
    );
    expect(second.duplicate).toBe(true);
    expect(second.effect.result).toEqual({ sent: true, state: "Delivered" });
    expect(f.stored.size).toBe(1);
  });

  it("does not reuse a password reset across a new user intent", async () => {
    const firstIntent = resolveTurnIntent({
      id: "msg-1",
      text: "Reset the fixture user password",
    }).intentId;
    const secondIntent = resolveTurnIntent({
      id: "msg-2",
      text: "It did not work. Reset it again.",
    }).intentId;
    expect(firstIntent).not.toBe(secondIntent);
    const classification = {
      class: "password-reset" as const,
      subject: "https://admin.example.test/u-1",
    };
    const firstKey = threadIrreversibleEffectKey({
      threadId: "thread-1",
      intentId: firstIntent,
      class: classification.class,
      subject: classification.subject,
    });
    const secondKey = threadIrreversibleEffectKey({
      threadId: "thread-1",
      intentId: secondIntent,
      class: classification.class,
      subject: classification.subject,
    });
    expect(firstKey).not.toBe(secondKey);
  });

  it("fails closed on crash-while-executing and redacts plaintext on completed replay", async () => {
    const intentId = resolveTurnIntent({ id: "msg-1", text: "Text Pat: running late" }).intentId;
    const classification = classifyIrreversibleTool("installed_execute_tool", {
      name: "mac_messages_send",
      arguments: { handle: "+15550100" },
    });
    const key = threadIrreversibleEffectKey({
      threadId: "thread-1",
      intentId,
      class: classification!.class,
    });
    const request = irreversibleEffectRequest(classification!, "thread-1", intentId, {
      handle: "+15550100",
    });
    const f = fixture();
    const first = await recordEffect(
      f.deps,
      { id: "run-1", spaceId: "space-1", threadId: "thread-1", botId: "bot-1" },
      "send",
      key,
      request,
    );
    first.effect.status = "executing";
    const second = await recordEffect(
      f.deps,
      { id: "run-2", spaceId: "space-1", threadId: "thread-1", botId: "bot-1" },
      "send",
      key,
      request,
    );
    expect(second.duplicate).toBe(true);
    expect(resolveDuplicateEffectGate(second.effect, "send").action).toBe("uncertain");
    first.effect.status = "completed";
    first.effect.result = { sent: true, password: "FxNew#2207GenA" };
    const replay = resolveDuplicateEffectGate(first.effect, "send");
    expect(replay.action).toBe("return");
    if (replay.action === "return") {
      expect(JSON.stringify(redactReplayResult(replay.result))).not.toContain("FxNew#2207GenA");
    }
  });
});
