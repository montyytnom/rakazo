import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

const repo = path.resolve(import.meta.dirname, "../../..");
const overlay =
  process.env.OVERLAY_EXPORT ?? "/tmp/overlay-export/overlay-export";
const composeOut = path.join(repo, ".compose");
const beforeExecutor = path.join(
  composeOut,
  "worker/before/packages/adapters/src/executor.ts",
);
const afterExecutor = path.join(
  composeOut,
  "worker/after/packages/adapters/src/executor.ts",
);
const beforeFetch = path.join(
  composeOut,
  "worker/before/packages/adapters/src/pi-openai-compatible-provider.ts",
);
const afterFetch = path.join(
  composeOut,
  "worker/after/packages/adapters/src/pi-openai-compatible-provider.ts",
);

function missingOverlay(): string[] {
  const required = [
    "MOUNT-MAP.tsv",
    "FILE-HASHES.tsv",
    "COMPOSE-CHAINS.txt",
    "opt/docker/rakazo/patches/amazon-signin-verify-20261106/worker/src/worker/executor.ts",
    "opt/docker/rakazo/patches/browserextract/executor.ts",
    "opt/docker/rakazo/patches/savedlogins-20261104/src/worker/browser-tools.ts",
    "opt/docker/rakazo/patches/thinkbudget/pi-openai-compatible-provider.ts",
  ];
  if (!existsSync(overlay)) return [overlay];
  return required.filter((rel) => !existsSync(path.join(overlay, rel))).map((rel) => path.join(overlay, rel));
}

function compose(patch: boolean) {
  const script = path.join(repo, "scripts/compose-overlay-trees.py");
  const result = spawnSync(
    "python3",
    [
      script,
      "--overlay",
      overlay,
      "--out",
      composeOut,
      "--service",
      "worker",
      "--test-shim",
      ...(patch ? ["--patch"] : []),
    ],
    { cwd: repo, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `compose failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }
}

type CreateRunExecutor = (deps: never) => {
  continueRun: (runId: string, workerId: string) => Promise<void>;
};

async function loadExecutor(file: string): Promise<CreateRunExecutor> {
  const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
  return mod.createRunExecutor as CreateRunExecutor;
}

type Effect = {
  id: string;
  spaceId: string;
  runId?: string;
  kind: string;
  idempotencyKey: string;
  status: string;
  request: unknown;
  result?: unknown;
};

function harness(
  createRunExecutor: CreateRunExecutor,
  options: {
    runId: string;
    prompt: string;
    sourceMessageId: string;
    graphical: boolean;
    sandboxAct?: (args: unknown) => Promise<unknown>;
    connectorExecute?: () => AsyncGenerator<unknown>;
  },
) {
  const effects: Effect[] = [];
  const results: unknown[] = [];
  const run = {
    id: options.runId,
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: "user",
    sourceMessageId: options.sourceMessageId,
    leaseFence: 0,
  };
  let calls: Array<{ name: string; args: Record<string, unknown>; executionId: string }> = [];
  const externalEffect = {
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => effects),
    findUnique: vi.fn(
      async ({ where }: { where: { id?: string; idempotencyKey?: string } }) =>
        effects.find((effect) =>
          where.id ? effect.id === where.id : effect.idempotencyKey === where.idempotencyKey,
        ) ?? null,
    ),
    create: vi.fn(async ({ data }: { data: Omit<Effect, "id"> }) => {
      const effect = { ...data, id: `effect-${effects.length + 1}` };
      effects.push(effect);
      return { ...effect };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Effect> }) => {
      Object.assign(effects.find((effect) => effect.id === where.id)!, data);
    }),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string; status?: string | { not: string } };
        data: Partial<Effect>;
      }) => {
        const effect = effects.find(
          (row) =>
            row.id === where.id &&
            (!where.status ||
              (typeof where.status === "string"
                ? row.status === where.status
                : row.status !== where.status.not)),
        );
        if (!effect) return { count: 0 };
        Object.assign(effect, data);
        return { count: 1 };
      },
    ),
  };
  const prisma = {
    user: { findUnique: vi.fn(async () => null) },
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        computerId: "computer-1",
        computerSwitching: false,
        computer: { id: "computer-1", scope: "dedicated", kind: "desktop" },
      })),
      findMany: vi.fn(async () => []),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: null,
        historyCompactionSummary: null,
        historyCompactedUpToSeq: null,
      })),
      update: vi.fn(async () => ({ nextMessageSeq: 2, nextEventSeq: 2 })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    message: {
      findMany: vi.fn(async () => [
        {
          id: "msg-1",
          threadId: "thread-1",
          role: "user",
          seq: 0,
          botId: null,
          runId: null,
          createdAt: new Date("2026-11-06T00:00:00.000Z"),
          replyToMessageId: null,
          replyQuote: null,
          replyTo: null,
          blocks: [{ kind: "text", text: "Text Pat: running late" }],
        },
      ]),
      findUnique: vi.fn(async () => ({
        id: options.sourceMessageId,
        blocks: [{ kind: "text", text: options.prompt }],
      })),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: unknown }) => ({ id: "message-1", ...(data as object) })),
    },
    event: { create: vi.fn(async () => ({ seq: 1 })) },
    artifact: { findFirst: vi.fn(async () => null) },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: options.prompt })),
    },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    spaceBackupModel: { findMany: vi.fn(async () => []) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "scripted",
        defaultModelId: "scripted",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSecret: { findMany: vi.fn(async () => []) },
    botSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "scratch-1",
        ...data,
        createdAt: new Date("2026-11-06T00:00:00.000Z"),
        updatedAt: new Date("2026-11-06T00:00:00.000Z"),
      })),
    },
    actionApprovalRule: { findMany: vi.fn(async () => []) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => ({ enabled: false })) },
    secret: { findFirst: vi.fn(async () => null) },
    computer: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: "computer-1",
        scope: "dedicated",
        kind: "desktop",
        maintenanceId: null,
      })),
    },
    computerExecutionLease: {
      updateManyAndReturn: vi.fn(async () => [{ fence: 7 }]),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    externalEffect,
    $queryRaw: vi.fn(async () => [{ id: "computer-1", scope: "dedicated" }]),
    $transaction: async (work: (tx: typeof prisma) => Promise<unknown>) => work(prisma),
  };
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    for (const call of calls) {
      const result = await request.executeTool!(call.name, call.args, call.executionId);
      results.push(result);
    }
    yield { type: "done" as const, text: "Done" };
  });
  const executor = createRunExecutor({
    prisma: prisma as never,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    connector: {
      discoverTools: async () => [],
      resolveCall: async () => undefined,
      execute: options.connectorExecute ?? (async function* () {}),
    },
    sandbox: {
      describe: () => ({ capabilities: { graphical: options.graphical } }),
      act:
        options.sandboxAct ??
        (async () => {
          throw new Error("sandbox unused");
        }),
      writeFile: async () => undefined,
      async *exportWorkspace() {},
    },
    memory: {
      describe: () => ({ capabilities: {} }),
      read: async () => ({ documents: [] }),
      search: async () => [],
      commit: async () => ({ revision: "rev-1" }),
      remove: async () => ({ removed: false }),
      async *exportMarkdown() {},
    },
    memoryProviders: { resolve: async () => null },
    artifacts: { put: vi.fn(), get: vi.fn() },
    home: { commit: vi.fn(async () => "rev") },
    events: {
      append: vi.fn(async () => undefined),
      notify: vi.fn(async () => undefined),
      pauseRunForInput: vi.fn(async () => true),
      finalizeRun: vi.fn(async () => ({ continuationRunId: null })),
    },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as never);

  return {
    effects,
    results,
    run,
    setCalls(next: typeof calls) {
      calls = next;
    },
    setPrompt(prompt: string) {
      options.prompt = prompt;
    },
    async runTurn(runId: string) {
      run.id = runId;
      run.status = "queued";
      results.length = 0;
      await executor.continueRun(run.id, "worker-1");
    },
  };
}

describe("overlay compose + orchestration entry path", () => {
  const missing = missingOverlay();

  it("has the supplied overlay archive required to compose production-effective trees", () => {
    if (missing.length) {
      throw new Error(
        `overlay compose blocked; missing files/dependencies:\n${missing.join("\n")}\n` +
          "This is not parent-owned. Compose cannot run without those archive paths.",
      );
    }
    expect(missing).toEqual([]);
  });

  beforeAll(() => {
    if (missing.length) return;
    compose(false);
    compose(true);
  });

  it("fail-before: unpatched overlay send is run-scoped, not irr:v1", async () => {
    if (missing.length) return;
    const createRunExecutor = await loadExecutor(beforeExecutor);
    const f = harness(createRunExecutor, {
      runId: "run-send-before",
      prompt: "Text Pat: running late",
      sourceMessageId: "msg-1",
      graphical: false,
    });
    f.setCalls([
      {
        name: "installed_execute_tool",
        args: {
          name: "mac_messages_send",
          arguments: { handle: "+15550100", text: "Running 10 minutes late." },
        },
        executionId: "call-send-1",
      },
    ]);
    await f.runTurn("run-send-before");
    expect(f.effects.length).toBeGreaterThan(0);
    expect(f.effects[0]?.idempotencyKey).not.toMatch(/^irr:v1:/);
  });

  it("pass-after: patched overlay send uses irr:v1 and Continue reuses it", async () => {
    if (missing.length) return;
    const createRunExecutor = await loadExecutor(afterExecutor);
    const first = harness(createRunExecutor, {
      runId: "run-send-after-1",
      prompt: "Text Pat: running late",
      sourceMessageId: "msg-1",
      graphical: false,
    });
    const args = {
      name: "mac_messages_send",
      arguments: { handle: "+15550100", text: "Running 10 minutes late." },
    };
    first.setCalls([
      {
        name: "installed_execute_tool",
        args: structuredClone(args),
        executionId: "call-a",
      },
    ]);
    await first.runTurn("run-send-after-1");
    expect(first.effects[0]?.idempotencyKey).toMatch(/^irr:v1:[a-f0-9]{64}$/);
    const key = first.effects[0]!.idempotencyKey;
    first.effects[0]!.status = "completed";
    first.effects[0]!.result = { sent: true };
    first.setPrompt("Continue");
    first.setCalls([
      {
        name: "installed_execute_tool",
        args: structuredClone(args),
        executionId: "call-b",
      },
    ]);
    await first.runTurn("run-send-after-2");
    const keys = first.effects.map((effect) => ({
      key: effect.idempotencyKey,
      runId: effect.runId,
      status: effect.status,
    }));
    expect(keys, JSON.stringify(keys)).toHaveLength(1);
    expect(first.effects[0]?.idempotencyKey).toBe(key);
    expect(first.results[0]).toEqual(expect.objectContaining({ sent: true }));
  });

  it("fail-before: unpatched persist keeps a generated password in the tool result", async () => {
    if (missing.length) return;
    const createRunExecutor = await loadExecutor(beforeExecutor);
    const f = harness(createRunExecutor, {
      runId: "run-secret-before",
      prompt: "Save the generated password",
      sourceMessageId: "msg-1",
      graphical: false,
    });
    f.setCalls([
      {
        name: "scratchpad_add",
        args: { title: "New password: FxNew#2207GenA" },
        executionId: "call-mem-1",
      },
    ]);
    await f.runTurn("run-secret-before");
    expect(f.results, JSON.stringify({ results: f.results, effects: f.effects })).not.toEqual([]);
    expect(JSON.stringify(f.results)).toContain("FxNew#2207GenA");
  });

  it("pass-after: patched persist redacts the generated password on the same scratchpad path", async () => {
    if (missing.length) return;
    const createRunExecutor = await loadExecutor(afterExecutor);
    const f = harness(createRunExecutor, {
      runId: "run-secret-after",
      prompt: "Save the generated password",
      sourceMessageId: "msg-1",
      graphical: false,
    });
    f.setCalls([
      {
        name: "scratchpad_add",
        args: { title: "New password: FxNew#2207GenA" },
        executionId: "call-mem-2",
      },
    ]);
    await f.runTurn("run-secret-after");
    expect(f.results, JSON.stringify(f.results)).not.toEqual([]);
    expect(JSON.stringify(f.effects.map((effect) => effect.result))).not.toContain("FxNew#2207GenA");
    expect(JSON.stringify(f.results)).not.toContain("FxNew#2207GenA");
  });

  it("fail-before: unpatched launch_app throws unsupported instead of recovering", async () => {
    if (missing.length) return;
    const createRunExecutor = await loadExecutor(beforeExecutor);
    const f = harness(createRunExecutor, {
      runId: "run-launch-before",
      prompt: "Open Messages",
      sourceMessageId: "msg-1",
      graphical: true,
      sandboxAct: async () => {
        throw new Error("500 unsupported computer action");
      },
    });
    f.setCalls([{ name: "launch_app", args: { application: "Messages" }, executionId: "call-launch-1" }]);
    await f.runTurn("run-launch-before");
    const text = JSON.stringify(f.results);
    expect(text).not.toContain("Search installed desktop tools");
  });

  it("pass-after: patched launch_app returns the desktop catalog hint and does not retry", async () => {
    if (missing.length) return;
    const createRunExecutor = await loadExecutor(afterExecutor);
    const f = harness(createRunExecutor, {
      runId: "run-launch-after",
      prompt: "Open Messages",
      sourceMessageId: "msg-1",
      graphical: true,
      sandboxAct: async () => {
        throw new Error("500 unsupported computer action");
      },
    });
    f.setCalls([{ name: "launch_app", args: { application: "Messages" }, executionId: "call-launch-2" }]);
    await f.runTurn("run-launch-after");
    expect(JSON.stringify(f.results)).toContain("Search installed desktop tools");
  });

  it("fail-before: unpatched Flash-Next fetch forwards an HTTP 200 SSE error frame", async () => {
    if (missing.length) return;
    const previous = process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
    process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = "1";
    try {
      const { createOpenAiCompatibleFetch } = await import(
        `${pathToFileURL(beforeFetch).href}?t=${Date.now()}`
      );
      const fetchImpl = createOpenAiCompatibleFetch(async () =>
        new Response("event: error\ndata: {\"error\":{\"message\":\"upstream failed\"}}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
      const response = await fetchImpl("https://models.example.test/v1/chat/completions");
      const body = await response.text();
      expect(body).toContain("upstream failed");
    } finally {
      if (previous === undefined) delete process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
      else process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = previous;
    }
  });

  it("pass-after: patched Flash-Next fetch fails closed on that SSE error frame", async () => {
    if (missing.length) return;
    const previous = process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
    process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = "1";
    try {
      const { createOpenAiCompatibleFetch } = await import(
        `${pathToFileURL(afterFetch).href}?t=${Date.now()}`
      );
      const fetchImpl = createOpenAiCompatibleFetch(async () =>
        new Response("event: error\ndata: {\"error\":{\"message\":\"upstream failed\"}}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
      const response = await fetchImpl("https://models.example.test/v1/chat/completions");
      await expect(response.text()).rejects.toThrow(/upstream failed/);
    } finally {
      if (previous === undefined) delete process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
      else process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = previous;
    }
  });
});
