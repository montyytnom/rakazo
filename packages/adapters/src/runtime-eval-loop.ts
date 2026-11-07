import type { AgentRunRequest, BrowserProvider, ConnectorProvider, SecretStore } from "@rakazo/adapter-kit";
import type { EvalChannelRecord } from "@rakazo/core";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FakeBrowserProvider } from "./fake-browser.js";
import { captureRunModel } from "./isolated-capture.js";

const repo = path.resolve(import.meta.dirname, "../../..");
const DEFAULT_OVERLAY =
  process.env.OVERLAY_EXPORT ?? "/tmp/overlay-export/overlay-export";
const DEFAULT_AFTER = path.join(repo, ".compose/worker/after");

const OVERLAY_REQUIRED = [
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
] as const;

export function overlayArchiveMissing(overlayDir = DEFAULT_OVERLAY): string[] {
  if (!existsSync(overlayDir)) return [overlayDir];
  return OVERLAY_REQUIRED.filter((rel) => !existsSync(path.join(overlayDir, rel))).map((rel) =>
    path.join(overlayDir, rel),
  );
}

/** Hard-fail. Missing overlay is not a skip and not a pass. */
export function requireOverlayArchive(overlayDir = DEFAULT_OVERLAY): void {
  const missing = overlayArchiveMissing(overlayDir);
  if (missing.length === 0) return;
  throw new Error(
    `overlay compose blocked; missing files/dependencies:\n${missing.join("\n")}\n` +
      "This is not parent-owned. Compose cannot run without those archive paths.",
  );
}

function noopAsync() {
  return async () => undefined;
}

function emptySecretStore(): SecretStore {
  return {
    describe: () => ({
      id: "eval-offline",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { rotate: false },
    }),
    put: async () => ({ id: "rec-eval", ref: "opaque:v1:eval", ciphertext: "opaque" }),
    load: async () => {
      throw new Error("eval store load is not model-visible");
    },
    delete: async () => undefined,
    redact: (value: string) => value,
    onChange: () => () => undefined,
    start: async () => undefined,
    close: async () => undefined,
  };
}

export type ComposedEvalLoopOptions = {
  overlayDir?: string;
  afterRoot?: string;
  /** Recording OpenAI-compatible base URL (stub offline; live needs approval). */
  modelBaseUrl: string;
  prompt: string;
  sourceMessageId?: string;
  runId?: string;
  browser?: BrowserProvider;
  connector?: ConnectorProvider;
  secretStore?: SecretStore;
  secrets?: string[];
};

export type ComposedEvalLoopResult = {
  record: EvalChannelRecord | null;
  records: EvalChannelRecord[];
  finalized: unknown[];
  publishedMessages: unknown[];
  progressEvents: unknown[];
  modelBaseUrl: string;
};

type CreateRunExecutor = (deps: never) => {
  continueRun: (runId: string, workerId: string) => Promise<void>;
};

/**
 * Drive composed AFTER `continueRun` with a recording model baseURL and
 * pluggable browser/connector backends. Offline stub is allowed; live eval
 * is not this function's job.
 */
export async function runComposedEvalLoop(
  options: ComposedEvalLoopOptions,
): Promise<ComposedEvalLoopResult> {
  requireOverlayArchive(options.overlayDir ?? DEFAULT_OVERLAY);
  const afterRoot = options.afterRoot ?? DEFAULT_AFTER;
  const executorFile = path.join(afterRoot, "packages/adapters/src/executor.ts");
  const piFile = path.join(afterRoot, "packages/adapters/src/pi-runtime.ts");
  if (!existsSync(executorFile) || !existsSync(piFile)) {
    throw new Error(
      `composed AFTER trees missing:\n${executorFile}\n${piFile}\nCompose before calling runComposedEvalLoop.`,
    );
  }
  const previous = process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
  process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = "1";
  const records: EvalChannelRecord[] = [];
  const finalized: unknown[] = [];
  const publishedMessages: unknown[] = [];
  const progressEvents: unknown[] = [];
  const runId = options.runId ?? "eval-loop-1";
  const sourceMessageId = options.sourceMessageId ?? "msg-1";
  const run = {
    id: runId,
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: "user",
    sourceMessageId,
    leaseFence: 0,
    startedAt: new Date("2026-11-07T00:00:00.000Z"),
  };
  const effects: Array<{
    id: string;
    spaceId: string;
    runId?: string;
    kind: string;
    idempotencyKey: string;
    status: string;
    request: unknown;
    result?: unknown;
  }> = [];
  const externalEffect = {
    findFirst: async () => null,
    findMany: async () => effects,
    findUnique: async ({ where }: { where: { id?: string; idempotencyKey?: string } }) =>
      effects.find((effect) =>
        where.id ? effect.id === where.id : effect.idempotencyKey === where.idempotencyKey,
      ) ?? null,
    create: async ({ data }: { data: (typeof effects)[number] }) => {
      if (effects.some((effect) => effect.idempotencyKey === data.idempotencyKey)) {
        const error = new Error("Unique constraint failed");
        Object.assign(error, { code: "P2002" });
        throw error;
      }
      const effect = { ...data, id: `effect-${effects.length + 1}` };
      effects.push(effect);
      return { ...effect };
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      Object.assign(effects.find((effect) => effect.id === where.id)!, data);
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: string; status?: string | { not: string } };
      data: Record<string, unknown>;
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
  };
  const computerRow = {
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
    updatedAt: new Date("2026-11-07T00:00:00.000Z"),
  };
  const prisma = {
    user: { findUnique: async () => null },
    run: {
      findUnique: async () => run,
      findUniqueOrThrow: async () => run,
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      },
    },
    bot: {
      findUniqueOrThrow: async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        computerId: "computer-1",
        computerSwitching: false,
        computer: { id: "computer-1", scope: "dedicated", kind: "desktop" },
      }),
      findMany: async () => [],
    },
    attempt: {
      create: async () => ({ id: "attempt-1" }),
      update: noopAsync(),
      updateMany: async () => ({ count: 1 }),
    },
    thread: {
      findUniqueOrThrow: async () => ({
        id: run.threadId,
        groupId: null,
        historyCompactionSummary: null,
        historyCompactedUpToSeq: null,
      }),
      update: async () => ({ nextMessageSeq: 2, nextEventSeq: 2 }),
      updateMany: async () => ({ count: 1 }),
    },
    message: {
      findMany: async () => [
        {
          id: sourceMessageId,
          threadId: "thread-1",
          role: "user",
          seq: 0,
          botId: null,
          runId: null,
          createdAt: new Date("2026-11-07T00:00:00.000Z"),
          replyToMessageId: null,
          replyQuote: null,
          replyTo: null,
          blocks: [{ kind: "text", text: options.prompt }],
        },
      ],
      findUnique: async () => ({
        id: sourceMessageId,
        blocks: [{ kind: "text", text: options.prompt }],
      }),
      findFirst: async () => null,
      create: async ({ data }: { data: unknown }) => {
        publishedMessages.push(data);
        return { id: "message-1", ...(data as object) };
      },
    },
    event: { create: async () => ({ seq: 1 }) },
    artifact: { findFirst: async () => null },
    task: { findUniqueOrThrow: async () => ({ id: run.taskId, prompt: options.prompt }) },
    connection: { findMany: async () => [] },
    spaceModelPreference: { findFirst: async () => null },
    userModelCredential: { findFirst: async () => null },
    spaceBackupModel: { findMany: async () => [] },
    deploymentSettings: {
      findUnique: async () => ({
        defaultModelProvider: "scripted",
        defaultModelId: "scripted",
      }),
    },
    taughtSkill: { findMany: async () => [] },
    agentSecret: { findMany: async () => [] },
    botSecret: { findMany: async () => [] },
    agentSkill: { findMany: async () => [] },
    scratchpadItem: {
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => ({
        id: "scratch-1",
        ...data,
        createdAt: new Date("2026-11-07T00:00:00.000Z"),
        updatedAt: new Date("2026-11-07T00:00:00.000Z"),
      }),
    },
    actionApprovalRule: { findMany: async () => [] },
    actionAutoReviewPreference: { findUnique: async () => ({ enabled: false }) },
    secret: { findFirst: async () => null },
    computer: {
      findUniqueOrThrow: async () => computerRow,
      findUnique: async () => computerRow,
      findFirst: async () => computerRow,
      updateMany: async () => ({ count: 1 }),
      update: noopAsync(),
    },
    computerExecutionLease: {
      findFirst: async () => null,
      findMany: async () => [],
      create: noopAsync(),
      updateManyAndReturn: async () => [{ fence: 7 }],
      updateMany: async () => ({ count: 1 }),
      deleteMany: async () => ({ count: 0 }),
    },
    usageRecord: {
      createMany: async () => ({ count: 1 }),
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "usage-1", ...data }),
    },
    externalEffect,
    $queryRaw: async () => [{ id: "computer-1", scope: "dedicated" }],
    $executeRaw: async () => 1,
    $transaction: async (work: (tx: never) => Promise<unknown>) => work(prisma as never),
  };
  const connector: ConnectorProvider =
    options.connector ??
    ({
      discoverTools: async () => [],
      resolveCall: async () => undefined,
      execute: async function* () {
        yield { sent: true, state: "Delivered" };
      },
    } as ConnectorProvider);
  try {
    const executorMod = await import(`${pathToFileURL(executorFile).href}?t=${Date.now()}`);
    const { PiAgentRuntime } = await import(`${pathToFileURL(piFile).href}?t=${Date.now()}`);
    const createRunExecutor = executorMod.createRunExecutor as CreateRunExecutor;
    const pi = new PiAgentRuntime();
    const model = captureRunModel(options.modelBaseUrl);
    const executor = createRunExecutor({
      prisma,
      runtime: {
        describe: () => ({ capabilities: { scripted: false } }),
        run: async function* (request: AgentRunRequest) {
          request.model = model;
          for await (const event of pi.run(request, {
            operationId: runId,
            traceId: runId,
            spaceId: "space-1",
            userId: "user-1",
            signal: AbortSignal.timeout(90_000),
          })) {
            yield event;
          }
        },
      },
      connector,
      browser: options.browser ?? new FakeBrowserProvider({ pages: {} }),
      sandbox: {
        describe: () => ({ capabilities: { graphical: true } }),
        isRunning: async () => true,
        prepare: async () => undefined,
        act: async () => {
          throw new Error("sandbox unused");
        },
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
      artifacts: { put: async () => undefined, get: async () => undefined },
      home: { commit: async () => "rev" },
      events: {
        append: async (event: { type?: string }) => {
          if (event?.type === "thread.progress") progressEvents.push(event);
        },
        notify: async () => undefined,
        claimSteering: async () => [],
        pauseRunForInput: async () => true,
        pauseRunForTakeover: async () => true,
        finalizeRun: async (input: { blocks?: unknown; outcome?: string }) => {
          finalized.push(input);
          return { continuationRunId: null };
        },
      },
      jobs: { enqueue: async () => undefined },
      secrets: options.secrets ?? [],
      secretStore: options.secretStore ?? emptySecretStore(),
      evalSink: (record: EvalChannelRecord) => {
        records.push(record);
      },
    } as never);
    await executor.continueRun(run.id, "worker-1");
    return {
      record: records.at(-1) ?? null,
      records,
      finalized,
      publishedMessages,
      progressEvents,
      modelBaseUrl: options.modelBaseUrl,
    };
  } finally {
    if (previous === undefined) delete process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
    else process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = previous;
  }
}
