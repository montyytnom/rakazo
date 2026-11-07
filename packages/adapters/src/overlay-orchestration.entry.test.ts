import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { captureRunModel, startCaptureStub } from "./isolated-capture.js";

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
const afterPiRuntime = path.join(
  composeOut,
  "worker/after/packages/adapters/src/pi-runtime.ts",
);
const beforePiRuntime = path.join(
  composeOut,
  "worker/before/packages/adapters/src/pi-runtime.ts",
);
const beforeFetch = path.join(
  composeOut,
  "worker/before/packages/adapters/src/pi-openai-compatible-provider.ts",
);
const afterFetch = path.join(
  composeOut,
  "worker/after/packages/adapters/src/pi-openai-compatible-provider.ts",
);
const beforeBrowser = path.join(
  composeOut,
  "worker/before/packages/adapters/src/computer-browser.ts",
);
const afterBrowser = path.join(
  composeOut,
  "worker/after/packages/adapters/src/computer-browser.ts",
);
const beforeApiBrowser = path.join(
  composeOut,
  "api/before/packages/adapters/src/computer-browser.ts",
);
const afterApiBrowser = path.join(
  composeOut,
  "api/after/packages/adapters/src/computer-browser.ts",
);
const afterBotSecrets = path.join(
  composeOut,
  "worker/after/packages/adapters/src/bot-secrets.ts",
);
const afterApiBotSecrets = path.join(
  composeOut,
  "api/after/packages/adapters/src/bot-secrets.ts",
);
const beforeApiExecutor = path.join(
  composeOut,
  "api/before/packages/adapters/src/executor.ts",
);
const afterApiExecutor = path.join(
  composeOut,
  "api/after/packages/adapters/src/executor.ts",
);
const beforeCompaction = path.join(
  composeOut,
  "worker/before/packages/adapters/src/history-compaction.ts",
);
const afterCompaction = path.join(
  composeOut,
  "worker/after/packages/adapters/src/history-compaction.ts",
);

const CURRENT_SECRET_SENTINEL = "Cur#Rpr7xQ2mN9kL";
const STALE_SECRET_SENTINEL = "Old#Stl4pW8vB3yH";

function opaqueSecretStore() {
  return {
    describe: () => ({
      id: "opaque-test",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { rotate: false },
    }),
    put: vi.fn(async (plaintext: string) => {
      expect(plaintext).toContain(CURRENT_SECRET_SENTINEL);
      return { id: "rec-1", ref: "opaque:v1:test", ciphertext: "opaque-ciphertext" };
    }),
    load: vi.fn(async () => {
      throw new Error("opaque store load is not model-visible");
    }),
    delete: vi.fn(async () => undefined),
    redact: (value: string) => value,
    onChange: () => () => undefined,
    start: async () => undefined,
    close: async () => undefined,
  };
}

function dump(value: unknown): string {
  return JSON.stringify(value);
}

function missingOverlay(): string[] {
  const required = [
    "MOUNT-MAP.tsv",
    "FILE-HASHES.tsv",
    "COMPOSE-CHAINS.txt",
    "opt/docker/rakazo/patches/amazon-signin-verify-20261106/worker/src/worker/executor.ts",
    "opt/docker/rakazo/patches/browserextract/executor.ts",
    "opt/docker/rakazo/patches/savedlogins-20261104/src/worker/browser-tools.ts",
    "opt/docker/rakazo/patches/thinkbudget/pi-openai-compatible-provider.ts",
    "opt/docker/rakazo/patches/savedlogins-20261104/src/worker/bot-secrets.ts",
    "opt/docker/rakazo/patches/savedlogins-20261104/src/worker/login-guard.ts",
    "opt/docker/rakazo/patches/savedlogins-20261104/src/worker/computer-browser.ts",
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
    effects?: Effect[];
    secretStore?: unknown;
    finalText?: string;
    runtime?: {
      describe: () => { capabilities: { scripted: boolean } };
      run: (request: AgentRunRequest) => AsyncGenerator<unknown>;
    };
    history?: Array<{
      id: string;
      role: "user" | "bot";
      seq: number;
      blocks: Array<{ kind: string; text: string }>;
    }>;
  },
) {
  const effects: Effect[] = options.effects ?? [];
  let executeCount = 0;
  const results: unknown[] = [];
  const finalized: Array<{ blocks?: unknown; outcome?: string }> = [];
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
      if (effects.some((effect) => effect.idempotencyKey === data.idempotencyKey)) {
        const error = new Error("Unique constraint failed");
        Object.assign(error, { code: "P2002" });
        throw error;
      }
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
        ...(options.history ?? []).map((row) => ({
          id: row.id,
          threadId: "thread-1",
          role: row.role,
          seq: row.seq,
          botId: row.role === "bot" ? "bot-1" : null,
          runId: row.role === "bot" ? "run-prior" : null,
          createdAt: new Date("2026-11-06T00:00:00.000Z"),
          replyToMessageId: null,
          replyQuote: null,
          replyTo: null,
          blocks: row.blocks,
        })),
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
        botId: "bot-1",
        homeKey: "bot-1",
        spaceId: "space-1",
        scope: "dedicated",
        kind: "desktop",
        state: "running",
        providerRef: "computer-1",
        screenGeneration: 1,
        maintenanceId: null,
        controlLeaseId: null,
        updatedAt: new Date(),
      })),
      findUnique: vi.fn(async () => ({
        id: "computer-1",
        botId: "bot-1",
        homeKey: "bot-1",
        spaceId: "space-1",
        scope: "dedicated",
        kind: "desktop",
        state: "running",
        providerRef: "computer-1",
        screenGeneration: 1,
        maintenanceId: null,
        controlLeaseId: null,
        updatedAt: new Date(),
      })),
      findFirst: vi.fn(async () => ({
        id: "computer-1",
        botId: "bot-1",
        homeKey: "bot-1",
        scope: "dedicated",
        kind: "desktop",
        state: "running",
        providerRef: "computer-1",
        screenGeneration: 1,
        updatedAt: new Date(),
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(),
    },
    computerExecutionLease: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(),
      updateManyAndReturn: vi.fn(async () => [{ fence: 7 }]),
      updateMany: vi.fn(async () => ({ count: 1 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    usageRecord: {
      createMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "usage-1",
        ...data,
      })),
    },
    externalEffect,
    $queryRaw: vi.fn(async () => [{ id: "computer-1", scope: "dedicated" }]),
    $executeRaw: vi.fn(async () => 1),
    $transaction: async (work: (tx: never) => Promise<unknown>) => work(prisma as never),
  };
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    for (const call of calls) {
      const result = await request.executeTool!(call.name, call.args, call.executionId);
      results.push(result);
    }
    const finalText = options.finalText ?? "Done";
    if (finalText) yield { type: "text" as const, text: finalText };
    yield { type: "done" as const, text: finalText };
  });
  const executor = createRunExecutor({
    prisma: prisma as never,
    runtime: options.runtime ?? {
      describe: () => ({ capabilities: { scripted: false } }),
      run: runtimeRun,
    },
    connector: {
      discoverTools: async () => [],
      resolveCall: async () => undefined,
      execute:
        options.connectorExecute ??
        (async function* () {
          executeCount += 1;
          yield { sent: true, state: "Delivered" };
        }),
    },
      sandbox: {
      describe: () => ({ capabilities: { graphical: options.graphical } }),
      isRunning: async () => true,
      prepare: async () => undefined,
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
      claimSteering: vi.fn(async () => []),
      pauseRunForInput: vi.fn(async () => true),
      finalizeRun: vi.fn(async (input: { blocks?: unknown; outcome?: string }) => {
        finalized.push(input);
        return { continuationRunId: null };
      }),
    },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
    secretStore: options.secretStore,
  } as never);

  return {
    effects,
    results,
    finalized,
    run,
    executeCount: () => executeCount,
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

describe("overlay compose + orchestration entry path", { timeout: 180_000 }, () => {
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
    const apiScript = path.join(repo, "scripts/compose-overlay-trees.py");
    const apiBefore = spawnSync(
      "python3",
      [apiScript, "--overlay", overlay, "--out", composeOut, "--service", "api"],
      { cwd: repo, encoding: "utf8" },
    );
    if (apiBefore.status !== 0) {
      throw new Error(
        `api compose before failed (${apiBefore.status}):\n${apiBefore.stdout}\n${apiBefore.stderr}`,
      );
    }
    const api = spawnSync(
      "python3",
      [apiScript, "--overlay", overlay, "--out", composeOut, "--service", "api", "--patch"],
      { cwd: repo, encoding: "utf8" },
    );
    if (api.status !== 0) {
      throw new Error(`api compose failed (${api.status}):\n${api.stdout}\n${api.stderr}`);
    }
  }, 180_000);

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

  it("per-service bot-secrets: worker overlay b22b7f69, api remains 926710a", async () => {
    if (missing.length) return;
    const { createHash } = await import("node:crypto");
    const { readFileSync } = await import("node:fs");
    const worker = createHash("sha256").update(readFileSync(afterBotSecrets)).digest("hex");
    const api = createHash("sha256").update(readFileSync(afterApiBotSecrets)).digest("hex");
    expect(worker).toBe("b22b7f69ce3a0a45c54258dc9b66134352068f3abd89fb7800b3631b88e89d53");
    expect(api).toBe("e9ef81aaa20645c3ad27cd310600afae728295abc853ed602a00bf18317f6384");
    expect(readFileSync(afterBotSecrets, "utf8")).toContain("export async function plainLoginFillProblem");
    expect(readFileSync(afterBotSecrets, "utf8")).not.toContain("Archive gap");
  });

  it("pass-after: lost response / restart reuses irr:v1 and does not send again", async () => {
    if (missing.length) return;
    const createRunExecutor = await loadExecutor(afterExecutor);
    const effects: Effect[] = [];
    const first = harness(createRunExecutor, {
      runId: "run-restart-1",
      prompt: "Text Pat: running late",
      sourceMessageId: "msg-1",
      graphical: false,
      effects,
    });
    const args = {
      name: "mac_messages_send",
      arguments: { handle: "+15550100", text: "Running 10 minutes late." },
    };
    first.setCalls([{ name: "installed_execute_tool", args, executionId: "call-r1" }]);
    await first.runTurn("run-restart-1");
    expect(first.effects[0]?.idempotencyKey).toMatch(/^irr:v1:/);
    first.effects[0]!.status = "completed";
    first.effects[0]!.result = { sent: true, state: "Delivered" };
    const sent = first.executeCount();
    const second = harness(createRunExecutor, {
      runId: "run-restart-2",
      prompt: "Continue",
      sourceMessageId: "msg-1",
      graphical: false,
      effects,
    });
    second.setCalls([{ name: "installed_execute_tool", args, executionId: "call-r2" }]);
    await second.runTurn("run-restart-2");
    expect(effects).toHaveLength(1);
    expect(second.executeCount()).toBe(0);
    expect(sent).toBeGreaterThanOrEqual(0);
    expect(second.results[0]).toEqual(expect.objectContaining({ sent: true }));
  });

  it("pass-after: a new authorized request with the same text is a new irr:v1 and is not suppressed", async () => {
    if (missing.length) return;
    const createRunExecutor = await loadExecutor(afterExecutor);
    const effects: Effect[] = [];
    const first = harness(createRunExecutor, {
      runId: "run-new-1",
      prompt: "Text Pat: running late",
      sourceMessageId: "msg-1",
      graphical: false,
      effects,
    });
    const args = {
      name: "mac_messages_send",
      arguments: { handle: "+15550100", text: "Running 10 minutes late." },
    };
    first.setCalls([{ name: "installed_execute_tool", args, executionId: "call-n1" }]);
    await first.runTurn("run-new-1");
    first.effects[0]!.status = "completed";
    const second = harness(createRunExecutor, {
      runId: "run-new-2",
      prompt: "Text Pat: running late",
      sourceMessageId: "msg-2",
      graphical: false,
      effects,
    });
    second.setCalls([{ name: "installed_execute_tool", args, executionId: "call-n2" }]);
    await second.runTurn("run-new-2");
    const keys = [...new Set(effects.map((effect) => effect.idempotencyKey))];
    expect(keys).toHaveLength(2);
    expect(keys.every((key) => /^irr:v1:/.test(key))).toBe(true);
  });

  it("pass-after: concurrent continueRun hits unique constraint and does not create a second send", async () => {
    if (missing.length) return;
    const createRunExecutor = await loadExecutor(afterExecutor);
    const effects: Effect[] = [];
    const args = {
      name: "mac_messages_send",
      arguments: { handle: "+15550100", text: "Running 10 minutes late." },
    };
    const left = harness(createRunExecutor, {
      runId: "run-race-1",
      prompt: "Text Pat: running late",
      sourceMessageId: "msg-1",
      graphical: false,
      effects,
    });
    const right = harness(createRunExecutor, {
      runId: "run-race-2",
      prompt: "Continue",
      sourceMessageId: "msg-1",
      graphical: false,
      effects,
    });
    left.setCalls([{ name: "installed_execute_tool", args, executionId: "call-race-1" }]);
    right.setCalls([{ name: "installed_execute_tool", args, executionId: "call-race-2" }]);
    await Promise.all([left.runTurn("run-race-1"), right.runTurn("run-race-2")]);
    expect(effects.filter((effect) => /^irr:v1:/.test(effect.idempotencyKey))).toHaveLength(1);
  });

  it("fail-before: unpatched persist has no opaque handle and keeps plaintext", async () => {
    if (missing.length) return;
    const createRunExecutor = await loadExecutor(beforeExecutor);
    const f = harness(createRunExecutor, {
      runId: "run-vault-before",
      prompt: "Save the generated password",
      sourceMessageId: "msg-1",
      graphical: false,
    });
    f.setCalls([
      {
        name: "scratchpad_add",
        args: { title: "New password: FxNew#2207GenA" },
        executionId: "call-vault-b",
      },
    ]);
    await f.runTurn("run-vault-before");
    expect(JSON.stringify(f.effects.map((effect) => effect.result))).toContain("FxNew#2207GenA");
    expect(JSON.stringify(f.results)).not.toContain("Protected result");
  });

  it("pass-after: fail-closed vault stores handle without plaintext and without inventing a vaultRef", async () => {
    if (missing.length) return;
    const createRunExecutor = await loadExecutor(afterExecutor);
    const f = harness(createRunExecutor, {
      runId: "run-vault-closed",
      prompt: "Save the generated password",
      sourceMessageId: "msg-1",
      graphical: false,
    });
    f.setCalls([
      {
        name: "scratchpad_add",
        args: { title: "New password: FxNew#2207GenA" },
        executionId: "call-vault-c",
      },
    ]);
    await f.runTurn("run-vault-closed");
    expect(JSON.stringify(f.results)).not.toContain("FxNew#2207GenA");
    expect(JSON.stringify(f.effects.map((effect) => effect.result))).not.toContain("FxNew#2207GenA");
    expect(JSON.stringify(f.effects.map((effect) => effect.result))).not.toContain("protectedVaultRef");
    expect(JSON.stringify(f.results)).toContain("Protected result");
  });

  it("pass-after: encrypted SecretStore vault stores an opaque ref and handoff never returns plaintext", async () => {
    if (missing.length) return;
    const { EncryptedSecretStore } = await import("./secrets.js");
    const createRunExecutor = await loadExecutor(afterExecutor);
    const secretStore = new EncryptedSecretStore("test-only-protected-result-key");
    const f = harness(createRunExecutor, {
      runId: "run-vault-enc",
      prompt: "Save the generated password",
      sourceMessageId: "msg-1",
      graphical: false,
      secretStore,
    });
    f.setCalls([
      {
        name: "scratchpad_add",
        args: { title: "New password: FxNew#2207GenA" },
        executionId: "call-vault-e",
      },
    ]);
    await f.runTurn("run-vault-enc");
    expect(JSON.stringify(f.results)).not.toContain("FxNew#2207GenA");
    expect(JSON.stringify(f.results)).not.toContain("protectedVaultRef");
    const storedResult = f.effects[0]?.result;
    expect(JSON.stringify(storedResult)).not.toContain("FxNew#2207GenA");
    expect(JSON.stringify(storedResult)).toContain("protectedVaultRef");
    const handle = (storedResult as { protectedResult?: { handle?: string } } | undefined)
      ?.protectedResult?.handle;
    expect(handle).toMatch(/^op-/);
    const { createProtectedResultStore, handoffProtectedResultDurable, resolveProtectedResultVault } =
      await import("./protected-result.js");
    const delivered = await handoffProtectedResultDurable(
      createProtectedResultStore(),
      handle!,
      resolveProtectedResultVault(secretStore as never, {
        operationId: "op",
        traceId: "tr",
        spaceId: "space-1",
        userId: "user-1",
        signal: new AbortController().signal,
      }),
      storedResult,
    );
    expect(delivered).toEqual({
      delivered: true,
      channel: "secure card to the user",
      op_id: handle,
    });
    expect(JSON.stringify(delivered)).not.toContain("FxNew#2207GenA");
  });

  it("fail-before: unpatched api overlay falls back to computer_act on LOGIN_GUARD", async () => {
    if (missing.length) return;
    const { ComputerBrowserProvider } = await import(
      `${pathToFileURL(beforeApiBrowser).href}?t=${Date.now()}`
    );
    const provider = new ComputerBrowserProvider({
      liveDriver: async () => ({
        ok: false,
        error: "LOGIN_GUARD refused fill",
        fallback: "computer_act",
      }),
    });
    const computer = { id: "c1", botId: "home", kind: "docker", providerRef: "c1" };
    const context = {
      operationId: "1",
      traceId: "1",
      spaceId: "w",
      userId: "u",
      signal: new AbortController().signal,
    };
    const act = await provider.act(
      computer,
      { actions: [{ kind: "click", ref: "e1" }] },
      context,
    );
    expect(act.fallback).toBe("computer_act");
  });

  it("pass-after: patched worker focused never returns a value; LOGIN_GUARD does not fall back to computer_act", async () => {
    if (missing.length) return;
    const { ComputerBrowserProvider } = await import(
      `${pathToFileURL(afterBrowser).href}?t=${Date.now()}`
    );
    const provider = new ComputerBrowserProvider({
      liveDriver: async (_c: unknown, request: { command?: string }) => {
        if (request.command === "focused") {
          return {
            ok: true,
            url: "https://login.example.test/",
            title: "Login",
            hasFocus: true,
            kind: "password",
            origin: "https://login.example.test",
            value: "FxNew#2207GenA",
          };
        }
        return {
          ok: false,
          error: "LOGIN_GUARD refused fill",
          fallback: "computer_act",
        };
      },
    });
    const computer = { id: "c1", botId: "home", kind: "docker", providerRef: "c1" };
    const context = {
      operationId: "1",
      traceId: "1",
      spaceId: "w",
      userId: "u",
      signal: new AbortController().signal,
    };
    const focused = await provider.focused(computer, { guard: {} }, context);
    expect(JSON.stringify(focused)).not.toContain("FxNew#2207GenA");
    expect(focused).toEqual(
      expect.not.objectContaining({ value: expect.anything() }),
    );
    expect(focused).toMatchObject({ ok: true, kind: "password" });
    const act = await provider.act(
      computer,
      { actions: [{ kind: "click", ref: "e1" }] },
      context,
    );
    expect(act.fallback).toBeUndefined();
    expect(act.error).toMatch(/LOGIN_GUARD refused/);
  });

  it("pass-after: api overlay LOGIN_GUARD refusal is also final; login-guard focused stays worker-only", async () => {
    if (missing.length) return;
    const { ComputerBrowserProvider } = await import(
      `${pathToFileURL(afterApiBrowser).href}?t=${Date.now()}`
    );
    const provider = new ComputerBrowserProvider({
      liveDriver: async () => ({
        ok: false,
        error: "LOGIN_GUARD refused fill",
        fallback: "computer_act",
      }),
    });
    const computer = { id: "c1", botId: "home", kind: "docker", providerRef: "c1" };
    const context = {
      operationId: "1",
      traceId: "1",
      spaceId: "w",
      userId: "u",
      signal: new AbortController().signal,
    };
    const act = await provider.act(
      computer,
      { actions: [{ kind: "click", ref: "e1" }] },
      context,
    );
    expect(act.fallback).toBeUndefined();
    expect(act.error).toMatch(/LOGIN_GUARD refused/);
    expect(typeof provider.focused).toBe("undefined");
  });

  it("fail-before: overlay executor persists current generated password in the final reply", async () => {
    if (missing.length) return;
    const createRunExecutor = await loadExecutor(beforeExecutor);
    const f = harness(createRunExecutor, {
      runId: "run-echo-current-before",
      prompt: "Save the generated password",
      sourceMessageId: "msg-1",
      graphical: false,
      finalText: `Reset complete. New password: ${CURRENT_SECRET_SENTINEL}`,
    });
    f.setCalls([
      {
        name: "scratchpad_add",
        args: { title: `New password: ${CURRENT_SECRET_SENTINEL}` },
        executionId: "call-echo-current-b",
      },
    ]);
    await f.runTurn("run-echo-current-before");
    expect(dump(f.results)).toContain(CURRENT_SECRET_SENTINEL);
    expect(dump(f.finalized)).toContain(CURRENT_SECRET_SENTINEL);
  });

  it("fail-before: overlay executor persists a stale prior password in the final reply", async () => {
    if (missing.length) return;
    const createRunExecutor = await loadExecutor(beforeExecutor);
    const f = harness(createRunExecutor, {
      runId: "run-echo-stale-before",
      prompt: "Continue the reset",
      sourceMessageId: "msg-1",
      graphical: false,
      finalText: `Done. Old password: ${STALE_SECRET_SENTINEL}`,
      history: [
        {
          id: "msg-prior",
          role: "bot",
          seq: 1,
          blocks: [{ kind: "text", text: `Temporary password: ${STALE_SECRET_SENTINEL}` }],
        },
      ],
    });
    await f.runTurn("run-echo-stale-before");
    expect(dump(f.finalized)).toContain(STALE_SECRET_SENTINEL);
  });

  it("fail-before: overlay executor persists Done without an artifact-backed evidence ledger", async () => {
    if (missing.length) return;
    const createRunExecutor = await loadExecutor(beforeExecutor);
    const f = harness(createRunExecutor, {
      runId: "run-false-done-before",
      prompt: "Finish the reset",
      sourceMessageId: "msg-1",
      graphical: false,
      finalText: "Done",
    });
    await f.runTurn("run-false-done-before");
    expect(dump(f.finalized)).toMatch(/\bDone\b/);
    expect(dump(f.finalized)).not.toMatch(/not verified/i);
  });

  it("pass-after: overlay executor never persists current or stale secrets and does not claim Done without evidence", async () => {
    if (missing.length) return;
    const createRunExecutor = await loadExecutor(afterExecutor);
    const secretStore = opaqueSecretStore();
    const f = harness(createRunExecutor, {
      runId: "run-echo-after",
      prompt: "Save the generated password",
      sourceMessageId: "msg-1",
      graphical: false,
      secretStore,
      finalText: `Done. New password: ${CURRENT_SECRET_SENTINEL}. Old password: ${STALE_SECRET_SENTINEL}`,
      history: [
        {
          id: "msg-prior",
          role: "bot",
          seq: 1,
          blocks: [{ kind: "text", text: `Old password: ${STALE_SECRET_SENTINEL}` }],
        },
      ],
    });
    f.setCalls([
      {
        name: "scratchpad_add",
        args: { title: `New password: ${CURRENT_SECRET_SENTINEL}` },
        executionId: "call-echo-after",
      },
    ]);
    await f.runTurn("run-echo-after");
    const visible = dump({
      results: f.results,
      effects: f.effects.map((effect) => effect.result),
      finalized: f.finalized,
    });
    expect(f.finalized.length, visible).toBeGreaterThan(0);
    expect(visible).not.toContain(CURRENT_SECRET_SENTINEL);
    expect(visible).not.toContain(STALE_SECRET_SENTINEL);
    expect(dump(f.results)).toContain("Protected result");
    expect(dump(f.effects.map((effect) => effect.result))).toContain("protectedVaultRef");
    expect(dump(f.finalized)).not.toMatch(/\bDone\b/);
  });

  it("pass-after: overlay executor refuses Done without an artifact-backed evidence ledger", async () => {
    if (missing.length) return;
    const createRunExecutor = await loadExecutor(afterExecutor);
    const f = harness(createRunExecutor, {
      runId: "run-false-done-after",
      prompt: "Finish the reset",
      sourceMessageId: "msg-1",
      graphical: false,
      finalText: "Done",
    });
    await f.runTurn("run-false-done-after");
    expect(dump(f.finalized)).not.toMatch(/\bDone\b/);
    expect(dump(f.finalized)).toMatch(/not verified/i);
  });

  it("fail-before: api overlay executor also persists current generated password in the final reply", async () => {
    if (missing.length) return;
    const createRunExecutor = await loadExecutor(beforeApiExecutor);
    const f = harness(createRunExecutor, {
      runId: "run-api-echo-before",
      prompt: "Save the generated password",
      sourceMessageId: "msg-1",
      graphical: false,
      finalText: `Reset complete. New password: ${CURRENT_SECRET_SENTINEL}`,
    });
    f.setCalls([
      {
        name: "scratchpad_add",
        args: { title: `New password: ${CURRENT_SECRET_SENTINEL}` },
        executionId: "call-api-echo-b",
      },
    ]);
    await f.runTurn("run-api-echo-before");
    expect(dump(f.finalized)).toContain(CURRENT_SECRET_SENTINEL);
  });

  it("pass-after: api overlay executor withholds current and stale secrets and refuses unsupported Done", async () => {
    if (missing.length) return;
    const createRunExecutor = await loadExecutor(afterApiExecutor);
    const secretStore = opaqueSecretStore();
    const f = harness(createRunExecutor, {
      runId: "run-api-echo-after",
      prompt: "Save the generated password",
      sourceMessageId: "msg-1",
      graphical: false,
      secretStore,
      finalText: `Done. New password: ${CURRENT_SECRET_SENTINEL}. Old password: ${STALE_SECRET_SENTINEL}`,
      history: [
        {
          id: "msg-prior",
          role: "bot",
          seq: 1,
          blocks: [{ kind: "text", text: `Old password: ${STALE_SECRET_SENTINEL}` }],
        },
      ],
    });
    f.setCalls([
      {
        name: "scratchpad_add",
        args: { title: `New password: ${CURRENT_SECRET_SENTINEL}` },
        executionId: "call-api-echo-a",
      },
    ]);
    await f.runTurn("run-api-echo-after");
    const visible = dump({
      results: f.results,
      effects: f.effects.map((effect) => effect.result),
      finalized: f.finalized,
    });
    expect(f.finalized.length, visible).toBeGreaterThan(0);
    expect(visible).not.toContain(CURRENT_SECRET_SENTINEL);
    expect(visible).not.toContain(STALE_SECRET_SENTINEL);
    expect(dump(f.finalized)).not.toMatch(/\bDone\b/);
  });

  it("pass-after: api overlay executor refuses Done without an artifact-backed evidence ledger", async () => {
    if (missing.length) return;
    const createRunExecutor = await loadExecutor(afterApiExecutor);
    const f = harness(createRunExecutor, {
      runId: "run-api-false-done-after",
      prompt: "Finish the reset",
      sourceMessageId: "msg-1",
      graphical: false,
      finalText: "Done",
    });
    await f.runTurn("run-api-false-done-after");
    expect(dump(f.finalized)).not.toMatch(/\bDone\b/);
    expect(dump(f.finalized)).toMatch(/not verified/i);
  });

  it("fail-before: PiRuntime stub HTTP after a generated secret still carries plaintext", async () => {
    if (missing.length) return;
    const visible = await captureSecretBoundary(beforeExecutor, "run-pi-secret-before");
    expect(visible.captureCount, visible.debug).toBeGreaterThan(1);
    expect(visible.http).toContain(STALE_SECRET_SENTINEL);
    expect(visible.http).toContain(CURRENT_SECRET_SENTINEL);
  });

  it("pass-after: PiRuntime stub HTTP, persist, and final withhold current and stale sentinels", async () => {
    if (missing.length) return;
    const visible = await captureSecretBoundary(afterExecutor, "run-pi-secret-after");
    expect(visible.captureCount, visible.debug).toBeGreaterThan(1);
    expect(visible.http, visible.debug).not.toContain(CURRENT_SECRET_SENTINEL);
    expect(visible.http).not.toContain(STALE_SECRET_SENTINEL);
    expect(visible.persist.length, visible.persist).toBeGreaterThan(2);
    expect(visible.persist).not.toContain(CURRENT_SECRET_SENTINEL);
    expect(visible.persist).not.toContain(STALE_SECRET_SENTINEL);
    expect(visible.final).not.toContain(CURRENT_SECRET_SENTINEL);
    expect(visible.final).not.toContain(STALE_SECRET_SENTINEL);
    expect(visible.http).toMatch(/Protected result|\[withheld\]|\[redacted\]/);
  });

  it("preimage invariant: PiRuntime fail-before has no protected handle so handoff is empty (not a leak proof)", async () => {
    if (missing.length) return;
    const visible = await captureSecretBoundary(beforeExecutor, "run-pi-handoff-before");
    expect(visible.handoffKind).toBe("preimage-invariant-no-handle");
    expect(visible.failBeforeCausalProof, visible.handoff).toBe(false);
    expect(visible.handoffHasHandle, visible.handoff).toBe(false);
    expect(visible.handoff).not.toContain(CURRENT_SECRET_SENTINEL);
    expect(visible.handoff).not.toContain(STALE_SECRET_SENTINEL);
  });

  it("repaired path: PiRuntime pass-after protected_result_handoff withholds current and stale sentinels", async () => {
    if (missing.length) return;
    const visible = await captureSecretBoundary(afterExecutor, "run-pi-handoff-after");
    expect(visible.handoffKind).toBe("repaired-path");
    expect(visible.handoff.length, visible.handoff).toBeGreaterThan(2);
    expect(visible.handoffHasHandle, visible.handoff).toBe(true);
    expect(visible.handoff).not.toContain(CURRENT_SECRET_SENTINEL);
    expect(visible.handoff).not.toContain(STALE_SECRET_SENTINEL);
    expect(visible.handoff).toMatch(/delivered|op-|secure card|unknown op_id/i);
  });

  it("fail-before: composed history-compaction keeps All set without a current-intent ledger", async () => {
    if (missing.length) return;
    const summary = await composedCompactSummary(
      beforeCompaction,
      "All set. Successfully changed. It is reset.",
    );
    expect(summary).toMatch(/\bAll set\b/);
  });

  it("pass-after: composed history-compaction rewrites All set without a current-intent ledger", async () => {
    if (missing.length) return;
    const summary = await composedCompactSummary(
      afterCompaction,
      "All set. Successfully changed. It is reset.",
    );
    expect(summary).toMatch(/not verified/i);
    expect(summary).not.toMatch(/\bAll set\b/);
    expect(summary).not.toMatch(/Successfully changed/);
    expect(summary).not.toMatch(/\bIt is reset\b/);
  });

  it("fail-before: composed history-compaction keeps current and stale generated-password sentinels", async () => {
    if (missing.length) return;
    const summary = await composedCompactSummary(
      beforeCompaction,
      `All set. New password: ${CURRENT_SECRET_SENTINEL}. Old password: ${STALE_SECRET_SENTINEL}`,
    );
    expect(summary).toContain(CURRENT_SECRET_SENTINEL);
    expect(summary).toContain(STALE_SECRET_SENTINEL);
  });

  it("pass-after: composed history-compaction strips current and stale generated-password sentinels", async () => {
    if (missing.length) return;
    const summary = await composedCompactSummary(
      afterCompaction,
      `All set. New password: ${CURRENT_SECRET_SENTINEL}. Old password: ${STALE_SECRET_SENTINEL}`,
    );
    expect(summary).not.toContain(CURRENT_SECRET_SENTINEL);
    expect(summary).not.toContain(STALE_SECRET_SENTINEL);
    expect(summary).toMatch(/withheld|not verified/i);
  });

  it("claim detection is English regex; allowing success is ledger-only, not a semantic parser", async () => {
    if (missing.length) return;
    const { sanitizeFinalText, collectToolEvidence, emptyCompletionLedger } = await import(
      `${pathToFileURL(path.join(composeOut, "worker/after/packages/core/src/completion-artifact.ts")).href}?t=${Date.now()}`
    );
    const evidence = collectToolEvidence([]);
    expect(sanitizeFinalText("Done", evidence)).toBe("Outcome was not verified.");
    expect(sanitizeFinalText("Listo.", evidence)).toBe("Listo.");
    const ledger = emptyCompletionLedger({
      intentId: "intent-1",
      sourceMessageId: "msg-1",
      runId: "run-1",
    });
    expect(sanitizeFinalText("Done", evidence, ledger)).toBe("Outcome was not verified.");
  });

  it("compose-before leaves 926710a-absent helpers absent and does not patch core index", () => {
    if (missing.length) return;
    const added = [
      "packages/core/src/completion-artifact.ts",
      "packages/core/src/irreversible-effect.ts",
      "packages/core/src/secret-result-handle.ts",
      "packages/core/src/compaction-provenance.ts",
      "packages/core/src/handoff-delivery.ts",
      "packages/adapters/src/protected-result.ts",
      "packages/adapters/src/stale-element-recovery.ts",
      "packages/adapters/src/desktop-tool-contract.ts",
      "packages/adapters/src/model-stream-error.ts",
    ];
    for (const rel of added) {
      expect(existsSync(path.join(composeOut, "worker/before", rel)), rel).toBe(false);
      expect(existsSync(path.join(composeOut, "api/before", rel)), rel).toBe(false);
      expect(existsSync(path.join(composeOut, "worker/after", rel)), rel).toBe(true);
      expect(existsSync(path.join(composeOut, "api/after", rel)), rel).toBe(true);
    }
    const beforeIndex = readFileSync(
      path.join(composeOut, "worker/before/packages/core/src/index.ts"),
      "utf8",
    );
    const afterIndex = readFileSync(
      path.join(composeOut, "worker/after/packages/core/src/index.ts"),
      "utf8",
    );
    expect(beforeIndex).not.toContain('export * from "./completion-artifact.js";');
    expect(afterIndex).toContain('export * from "./completion-artifact.js";');
    expect(afterIndex).toContain('export * from "./irreversible-effect.js";');
    expect(afterIndex).toContain('export * from "./secret-result-handle.js";');
    const afterArtifact = readFileSync(
      path.join(composeOut, "worker/after/packages/core/src/completion-artifact.ts"),
      "utf8",
    );
    expect(afterArtifact).toContain('from "./irreversible-effect.js"');
    expect(
      existsSync(
        path.join(composeOut, "worker/after/packages/core/src/irreversible-effect.ts"),
      ),
    ).toBe(true);
  });

  it("loads after completion-artifact through irreversible-effect without workspace @rakazo/core", async () => {
    if (missing.length) return;
    const tmp = mkdtempSync(path.join(tmpdir(), "isolated-core-"));
    try {
      for (const name of [
        "completion-artifact.ts",
        "irreversible-effect.ts",
        "approval-effect-key.ts",
        "secret-result-handle.ts",
      ]) {
        writeFileSync(
          path.join(tmp, name),
          readFileSync(path.join(composeOut, "worker/after/packages/core/src", name)),
        );
      }
      const mod = await import(
        `${pathToFileURL(path.join(tmp, "completion-artifact.ts")).href}?t=${Date.now()}`
      );
      expect(typeof mod.bindOutcomeArtifact).toBe("function");
      expect(
        mod.bindOutcomeArtifact({
          result: { verified: true, tree: "Reset password successful." },
          toolName: "browser_extract",
          intentId: "intent-1",
          sourceMessageId: "msg-1",
          runId: "run-1",
        })?.class,
      ).toBe("verified-read");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("records live source loading: tsx start and @rakazo/core default ./src/index.ts", () => {
    const corePkg = JSON.parse(
      readFileSync(path.join(repo, "packages/core/package.json"), "utf8"),
    ) as { exports: { ".": { default: string } } };
    const workerPkg = JSON.parse(
      readFileSync(path.join(repo, "apps/worker/package.json"), "utf8"),
    ) as { scripts: { start: string } };
    const apiPkg = JSON.parse(
      readFileSync(path.join(repo, "apps/api/package.json"), "utf8"),
    ) as { scripts: { start: string } };
    expect(corePkg.exports["."].default).toBe("./src/index.ts");
    expect(corePkg.exports["."].default).not.toMatch(/dist/);
    expect(workerPkg.scripts.start).toBe("tsx src/index.ts");
    expect(apiPkg.scripts.start).toBe("tsx src/index.ts");
  });
});

function sseToolCall(id: string, name: string, args: Record<string, unknown>) {
  return [
    {
      tool_calls: [
        { index: 0, id, type: "function", function: { name, arguments: "" } },
      ],
    },
    { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] },
  ];
}

async function captureSecretBoundary(executorFile: string, runId: string) {
  const previous = process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
  process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = "1";
  const piFile = executorFile.includes("/after/") ? afterPiRuntime : beforePiRuntime;
  const { PiAgentRuntime } = await import(`${pathToFileURL(piFile).href}?t=${Date.now()}`);
  const pi = new PiAgentRuntime();
  const stub = await startCaptureStub({
    modelId: captureRunModel("http://127.0.0.1/v1").id,
    caseName: "candidate-secret-boundary",
    replies: [
      {
        kind: "sse",
        finish: "tool_calls",
        events: sseToolCall("call-secret-1", "scratchpad_add", {
          title: `New password: ${CURRENT_SECRET_SENTINEL}`,
        }),
      },
      {
        kind: "sse",
        finish: "stop",
        events: [
          {
            content: `Done. New password: ${CURRENT_SECRET_SENTINEL}. Old password: ${STALE_SECRET_SENTINEL}`,
          },
        ],
      },
      ...Array.from({ length: 6 }, (_, index) => ({
        kind: "sse" as const,
        finish: "stop" as const,
        events: [{ content: `synthetic-stop-${index}` }],
      })),
    ],
  });
  try {
    const piEvents: Array<{ type?: string }> = [];
    const executeCalls: Array<{ name: string; args: unknown }> = [];
    let hasExecute = false;
    let piError: string | undefined;
    let handoffResult: unknown;
    const createRunExecutor = await loadExecutor(executorFile);
    const { EncryptedSecretStore } = await import("./secrets.js");
    const f = harness(createRunExecutor, {
      runId,
      prompt: "Save the generated password",
      sourceMessageId: "msg-1",
      graphical: false,
      secretStore: new EncryptedSecretStore("test-only-piruntime-handoff-key"),
      history: [
        {
          id: "msg-prior",
          role: "bot",
          seq: 1,
          blocks: [{ kind: "text", text: `Old password: ${STALE_SECRET_SENTINEL}` }],
        },
      ],
      runtime: {
        describe: () => ({ capabilities: { scripted: false } }),
        run: async function* (request: AgentRunRequest) {
          request.model = captureRunModel(stub.baseUrl);
          hasExecute = Boolean(request.executeTool);
          const inner = request.executeTool;
          request.executeTool = inner
            ? async (name, args, executionId) => {
                executeCalls.push({ name, args });
                const result = await inner(name, args, executionId);
                if (name === "scratchpad_add") {
                  const handle = extractProtectedHandle(dump(result));
                  if (handle) {
                    handoffResult = await inner(
                      "protected_result_handoff",
                      { op_id: handle },
                      "call-handoff",
                    );
                  }
                }
                return result;
              }
            : undefined;
          try {
            for await (const event of pi.run(request, {
              operationId: runId,
              traceId: runId,
              spaceId: "space-1",
              userId: "user-1",
              signal: AbortSignal.timeout(90_000),
            })) {
              piEvents.push({ type: (event as { type?: string }).type });
              yield event;
            }
          } catch (error) {
            piError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
            throw error;
          }
        },
      },
    });
    await f.runTurn(runId);
    const http = stub.rawBodies.map((body) => body.toString("utf8")).join("\n");
    const persist = dump(f.effects.map((effect) => effect.result));
    const final = dump(f.finalized);
    const handoff = dump(handoffResult ?? null);
    const preimage = executorFile.includes("/before/");
    const handoffHasHandle = Boolean(extractProtectedHandle(handoff));
    const handoffKind = preimage ? "preimage-invariant-no-handle" : "repaired-path";
    const debug = dump({ events: piEvents, error: piError, executeCalls, hasExecute, handoff, handoffKind });
    const logPath = process.env.CANDIDATE_PIRUNTIME_LOG;
    if (logPath) {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(
        logPath,
        `${JSON.stringify({
          runId,
          executorFile,
          captureCount: stub.captures.length,
          executeCalls,
          events: piEvents,
          error: piError,
          hasExecute,
          httpSha256: stub.rawBodies.map((body) =>
            createHash("sha256").update(body).digest("hex"),
          ),
          currentSentinelInHttp: http.includes(CURRENT_SECRET_SENTINEL),
          staleSentinelInHttp: http.includes(STALE_SECRET_SENTINEL),
          currentSentinelInPersist: persist.includes(CURRENT_SECRET_SENTINEL),
          staleSentinelInPersist: persist.includes(STALE_SECRET_SENTINEL),
          currentSentinelInFinal: final.includes(CURRENT_SECRET_SENTINEL),
          currentSentinelInHandoff: handoff.includes(CURRENT_SECRET_SENTINEL),
          staleSentinelInHandoff: handoff.includes(STALE_SECRET_SENTINEL),
          handoffKind,
          handoffHasHandle,
          failBeforeCausalProof: false,
          measured: ["http", "persist", "final", "handoff"],
          notMeasuredInHttp: ["handoff", "compaction"],
          handoffNote: preimage
            ? "Empty fail-before handoff is an invariant (no protected handle). It is not leak proof."
            : "AFTER protected_result_handoff is the repaired path.",
          httpPreview: stub.parsedBodies.map((body) => ({
            roles: Array.isArray(body?.messages)
              ? (body.messages as Array<{ role?: string }>).map((message) => message.role)
              : [],
            toolResultPreview:
              JSON.stringify(body).includes("Protected result") ||
              JSON.stringify(body).includes("[withheld]"),
          })),
          persist,
          final,
          handoff,
          debug,
        })}\n`,
      );
    }
    return {
      http,
      captureCount: stub.captures.length,
      persist,
      final,
      handoff,
      handoffKind,
      handoffHasHandle,
      failBeforeCausalProof: false as const,
      results: dump(f.results),
      debug,
    };
  } finally {
    await stub.close();
    if (previous === undefined) delete process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
    else process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = previous;
  }
}

function extractProtectedHandle(serialized: string): string | undefined {
  const quoted = serialized.match(/"handle":"(op-[a-f0-9]{8})"/i);
  if (quoted?.[1]) return quoted[1];
  return serialized.match(/\bop-[a-f0-9]{8}\b/i)?.[0];
}

async function composedCompactSummary(file: string, summaryText: string): Promise<string> {
  const { compactHistory } = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
  const messages = Array.from({ length: 50 }, (_, i) => ({
    seq: i,
    role: i % 2 === 0 ? "user" : "bot",
    blocks: [
      {
        kind: "text",
        text:
          i === 1 && /password/i.test(summaryText)
            ? `New password: ${CURRENT_SECRET_SENTINEL}. Old password: ${STALE_SECRET_SENTINEL}`
            : `message ${i}`,
      },
    ],
  }));
  const thread = {
    id: "thread-1",
    botId: "bot-1",
    spaceId: "workspace-1",
    userId: "user-1",
    nextMessageSeq: 50,
    historyCompactedUpToSeq: null as number | null,
    historyCompactionSummary: null as string | null,
    historyCompactionGeneration: 0,
  };
  const prisma = {
    thread: {
      findUniqueOrThrow: vi.fn(async () => thread),
      updateMany: vi.fn(async (args: { data: { historyCompactionSummary: string } }) => {
        thread.historyCompactionSummary = args.data.historyCompactionSummary;
        return { count: 1 };
      }),
    },
    event: { findFirst: vi.fn(async () => null) },
    message: {
      findMany: vi.fn(async () => messages),
    },
    deploymentSettings: { findUnique: vi.fn(async () => null) },
    usageRecord: { createMany: vi.fn(async () => ({ count: 0 })), create: vi.fn() },
  };
  const runtime = {
    describe: () => ({ capabilities: { streaming: true, compaction: true } }),
    run: vi.fn(async function* () {
      yield { type: "done", text: summaryText };
    }),
  };
  await compactHistory(
    {
      prisma,
      runtime,
      jobs: { enqueue: vi.fn(async () => undefined) },
      memoryProviders: { resolve: vi.fn(async () => null) },
      deploymentModelKey: "openrouter-key",
      deploymentModelConfigured: true,
    },
    "thread-1",
  );
  return thread.historyCompactionSummary ?? "";
}
