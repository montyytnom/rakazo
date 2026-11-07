import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import { compactHistory } from "./history-compaction.js";
import { createRunExecutor } from "./executor.js";
import { PiAgentRuntime } from "./pi-runtime.js";
import { EncryptedSecretStore } from "./secrets.js";

export const CURRENT_SECRET_SENTINEL = "Cur#Rpr7xQ2mN9kL";
export const STALE_SECRET_SENTINEL = "Old#Stl4pW8vB3yH";
export const CANDIDATE_CAPTURE_KIND = "composed-executor-piruntime-stub-sse";
export const CAPTURE_MODEL_ID = "qwen3.8-flash-next";

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

type StubReply =
  | { kind: "sse"; finish: string; events: unknown[] }
  | { kind: "http-error"; status: number; body: string };

function dump(value: unknown): string {
  return JSON.stringify(value);
}

function ssePayload(modelId: string, events: unknown[], finish: string | null): string {
  const chunks: string[] = [];
  const emit = (delta: unknown, finishReason: string | null = null) => {
    chunks.push(
      `data: ${JSON.stringify({
        id: "synthetic-candidate-capture",
        object: "chat.completion.chunk",
        created: 0,
        model: modelId,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`,
    );
  };
  emit({ role: "assistant" });
  for (const event of events) emit(event);
  emit({}, finish);
  chunks.push("data: [DONE]\n\n");
  return chunks.join("");
}

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

async function startLoopbackStub(options: {
  modelId: string;
  replies: StubReply[];
  caseName: string;
}) {
  const rawBodies: Buffer[] = [];
  const parsedBodies: Array<Record<string, unknown> | null> = [];
  let seq = 0;
  const server: Server = createServer((request: IncomingMessage, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      rawBodies.push(raw);
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      parsedBodies.push(parsed);
      const reply = options.replies[seq];
      seq += 1;
      if (!reply) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "stub exhausted", type: "stub" } }));
        return;
      }
      if (reply.kind === "http-error") {
        response.writeHead(reply.status, { "content-type": "application/json" });
        response.end(reply.body);
        return;
      }
      const stubSse = ssePayload(options.modelId, reply.events, reply.finish);
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.end(stubSse);
    })().catch(() => response.destroy());
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    rawBodies,
    parsedBodies,
    caseName: options.caseName,
    async close() {
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
        server.closeAllConnections();
      });
    },
  };
}

function captureRunModel(baseUrl: string) {
  return {
    provider: OPENAI_COMPATIBLE_PROVIDER_ID,
    id: CAPTURE_MODEL_ID,
    baseUrl,
    apiKey: "local",
    reasoning: false,
    acceptsImages: false,
    maxTokens: 8192,
    contextWindow: 32768,
  };
}

function extractProtectedHandle(serialized: string): string | undefined {
  const quoted = serialized.match(/"handle":"(op-[a-f0-9]{8})"/i);
  if (quoted?.[1]) return quoted[1];
  return serialized.match(/\bop-[a-f0-9]{8}\b/i)?.[0];
}

function asyncFn<T>(impl: (...args: never[]) => Promise<T> | T) {
  return impl as never;
}

function harness(options: {
  runId: string;
  prompt: string;
  sourceMessageId: string;
  secretStore?: unknown;
  history?: Array<{
    id: string;
    role: "user" | "bot";
    seq: number;
    blocks: Array<{ kind: string; text: string }>;
  }>;
  runtime: {
    describe: () => { capabilities: { scripted: boolean } };
    run: (request: AgentRunRequest) => AsyncGenerator<unknown>;
  };
}) {
  const effects: Effect[] = [];
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
  const externalEffect = {
    findFirst: async () => null,
    findMany: async () => effects,
    findUnique: async ({ where }: { where: { id?: string; idempotencyKey?: string } }) =>
      effects.find((effect) =>
        where.id ? effect.id === where.id : effect.idempotencyKey === where.idempotencyKey,
      ) ?? null,
    create: async ({ data }: { data: Omit<Effect, "id"> }) => {
      const effect = { ...data, id: `effect-${effects.length + 1}` };
      effects.push(effect);
      return { ...effect };
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<Effect> }) => {
      Object.assign(effects.find((effect) => effect.id === where.id)!, data);
    },
    updateMany: async ({
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
      update: async () => undefined,
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
          blocks: [{ kind: "text", text: options.prompt }],
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
      ],
      findUnique: async () => ({
        id: options.sourceMessageId,
        blocks: [{ kind: "text", text: options.prompt }],
      }),
      findFirst: async () => null,
      create: async ({ data }: { data: unknown }) => ({ id: "message-1", ...(data as object) }),
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
        defaultModelProvider: OPENAI_COMPATIBLE_PROVIDER_ID,
        defaultModelId: CAPTURE_MODEL_ID,
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
        createdAt: new Date("2026-11-06T00:00:00.000Z"),
        updatedAt: new Date("2026-11-06T00:00:00.000Z"),
      }),
    },
    actionApprovalRule: { findMany: async () => [] },
    actionAutoReviewPreference: { findUnique: async () => ({ enabled: false }) },
    secret: { findFirst: async () => null },
    computer: {
      findUniqueOrThrow: async () => ({
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
      }),
      findUnique: async () => ({
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
      }),
      findFirst: async () => ({
        id: "computer-1",
        botId: "bot-1",
        homeKey: "bot-1",
        scope: "dedicated",
        kind: "desktop",
        state: "running",
        providerRef: "computer-1",
        screenGeneration: 1,
        updatedAt: new Date(),
      }),
      updateMany: async () => ({ count: 1 }),
      update: async () => undefined,
    },
    computerExecutionLease: {
      findFirst: async () => null,
      findMany: async () => [],
      create: async () => undefined,
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
  const executor = createRunExecutor({
    prisma: prisma as never,
    runtime: options.runtime,
    connector: {
      discoverTools: async () => [],
      resolveCall: async () => undefined,
      execute: async function* () {
        yield { sent: true, state: "Delivered" };
      },
    },
    sandbox: {
      describe: () => ({ capabilities: { graphical: false } }),
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
    artifacts: { put: asyncFn(async () => undefined), get: asyncFn(async () => undefined) },
    home: { commit: async () => "rev" },
    events: {
      append: async () => undefined,
      notify: async () => undefined,
      claimSteering: async () => [],
      pauseRunForInput: async () => true,
      finalizeRun: async (input: { blocks?: unknown; outcome?: string }) => {
        finalized.push(input);
        return { continuationRunId: null };
      },
    },
    jobs: { enqueue: async () => undefined },
    secrets: [],
    secretStore: options.secretStore,
  } as never);

  return {
    effects,
    results,
    finalized,
    run,
    async runTurn(runId: string) {
      run.id = runId;
      run.status = "queued";
      results.length = 0;
      await executor.continueRun(run.id, "worker-1");
    },
  };
}

async function runPiRuntimeScenario(options: {
  runId: string;
  prompt: string;
  includeStaleHistory: boolean;
  finalText: string;
  toolTitle: string;
  invokeHandoff: boolean;
}) {
  process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = "1";
  const pi = new PiAgentRuntime();
  const stub = await startLoopbackStub({
    modelId: CAPTURE_MODEL_ID,
    caseName: options.runId,
    replies: [
      {
        kind: "sse",
        finish: "tool_calls",
        events: sseToolCall("call-secret-1", "scratchpad_add", { title: options.toolTitle }),
      },
      {
        kind: "sse",
        finish: "stop",
        events: [{ content: options.finalText }],
      },
      ...Array.from({ length: 6 }, (_, index) => ({
        kind: "sse" as const,
        finish: "stop" as const,
        events: [{ content: `synthetic-stop-${index}` }],
      })),
    ],
  });
  let handoffResult: unknown = null;
  try {
    const f = harness({
      runId: options.runId,
      prompt: options.prompt,
      sourceMessageId: "source-1",
      secretStore: new EncryptedSecretStore("test-only-candidate-capture-key"),
      history: options.includeStaleHistory
        ? [
            {
              id: "msg-prior",
              role: "bot",
              seq: 1,
              blocks: [{ kind: "text", text: `Old password: ${STALE_SECRET_SENTINEL}` }],
            },
          ]
        : [],
      runtime: {
        describe: () => ({ capabilities: { scripted: false } }),
        run: async function* (request: AgentRunRequest) {
          request.model = captureRunModel(stub.baseUrl);
          const inner = request.executeTool;
          request.executeTool = inner
            ? async (name, args, executionId) => {
                const result = await inner(name, args, executionId);
                if (options.invokeHandoff && name === "scratchpad_add") {
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
          for await (const event of pi.run(request, {
            operationId: options.runId,
            traceId: options.runId,
            spaceId: "space-1",
            userId: "user-1",
            signal: AbortSignal.timeout(90_000),
          })) {
            yield event;
          }
        },
      },
    });
    await f.runTurn(options.runId);
    const http = stub.rawBodies.map((body) => body.toString("utf8")).join("\n");
    const persist = dump(f.effects.map((effect) => effect.result));
    const final = dump(f.finalized);
    const handoff = dump(handoffResult);
    return {
      http,
      persist,
      final,
      handoff,
      httpHasCurrent: http.includes(CURRENT_SECRET_SENTINEL),
      httpHasStale: http.includes(STALE_SECRET_SENTINEL),
      persistHasCurrent: persist.includes(CURRENT_SECRET_SENTINEL),
      persistHasStale: persist.includes(STALE_SECRET_SENTINEL),
      finalHasCurrent: final.includes(CURRENT_SECRET_SENTINEL),
      finalHasStale: final.includes(STALE_SECRET_SENTINEL),
      handoffHasCurrent: handoff.includes(CURRENT_SECRET_SENTINEL),
      handoffHasStale: handoff.includes(STALE_SECRET_SENTINEL),
      handoffEmpty: handoff === "null" || handoff === "",
    };
  } finally {
    await stub.close();
  }
}

async function runCompactionScenario(summaryText: string) {
  const messages = Array.from({ length: 50 }, (_, i) => ({
    seq: i,
    role: i % 2 === 0 ? "user" : "bot",
    blocks: [
      {
        kind: "text" as const,
        text:
          i === 1
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
      findUniqueOrThrow: async () => thread,
      updateMany: async (args: { data: { historyCompactionSummary: string } }) => {
        thread.historyCompactionSummary = args.data.historyCompactionSummary;
        return { count: 1 };
      },
    },
    event: { findFirst: async () => null },
    message: { findMany: async () => messages },
    deploymentSettings: { findUnique: async () => null },
    usageRecord: { createMany: async () => ({ count: 0 }), create: async () => undefined },
  };
  await compactHistory(
    {
      prisma,
      runtime: {
        describe: () => ({ capabilities: { streaming: true, compaction: true } }),
        run: async function* () {
          yield { type: "done", text: summaryText };
        },
      },
      jobs: { enqueue: async () => undefined },
      memoryProviders: { resolve: async () => null },
      deploymentModelKey: "openrouter-key",
      deploymentModelConfigured: true,
    } as never,
    "thread-1",
  );
  const summary = thread.historyCompactionSummary ?? "";
  return {
    summary,
    hasCurrent: summary.includes(CURRENT_SECRET_SENTINEL),
    hasStale: summary.includes(STALE_SECRET_SENTINEL),
    hasAllSet: /\bAll set\b/.test(summary),
  };
}

export async function runCandidateCapture(options: { service: string; outDir: string }) {
  const previous = process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
  process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = "1";
  mkdirSync(options.outDir, { recursive: true });
  try {
    const generated = await runPiRuntimeScenario({
      runId: `${options.service}-generated-secret`,
      prompt: "Save the generated password",
      includeStaleHistory: false,
      toolTitle: `New password: ${CURRENT_SECRET_SENTINEL}`,
      finalText: `Done. New password: ${CURRENT_SECRET_SENTINEL}`,
      invokeHandoff: false,
    });
    const stale = await runPiRuntimeScenario({
      runId: `${options.service}-stale-secret`,
      prompt: "Save the generated password",
      includeStaleHistory: true,
      toolTitle: `New password: ${CURRENT_SECRET_SENTINEL}`,
      finalText: `Done. New password: ${CURRENT_SECRET_SENTINEL}. Old password: ${STALE_SECRET_SENTINEL}`,
      invokeHandoff: false,
    });
    const handoff = await runPiRuntimeScenario({
      runId: `${options.service}-protected-handoff`,
      prompt: "Save the generated password",
      includeStaleHistory: true,
      toolTitle: `New password: ${CURRENT_SECRET_SENTINEL}`,
      finalText: `Done. New password: ${CURRENT_SECRET_SENTINEL}. Old password: ${STALE_SECRET_SENTINEL}`,
      invokeHandoff: true,
    });
    const falseSuccess = await runPiRuntimeScenario({
      runId: `${options.service}-false-success-done`,
      prompt: "Finish the reset",
      includeStaleHistory: false,
      toolTitle: "status note",
      finalText: "Done",
      invokeHandoff: false,
    });
    const compactionCurrent = await runCompactionScenario(
      `All set. New password: ${CURRENT_SECRET_SENTINEL}`,
    );
    const compactionStale = await runCompactionScenario(
      `All set. Old password: ${STALE_SECRET_SENTINEL}`,
    );
    const phases = {
      kind: CANDIDATE_CAPTURE_KIND,
      notBaselineAssembler: true,
      service: options.service,
      packSha256: process.env.CANDIDATE_PACK_SHA256 ?? "",
      gitHead: process.env.CANDIDATE_GIT_HEAD ?? "",
      imageId:
        process.env[`RAKAZO_${options.service.toUpperCase()}_IMAGE_ID` as keyof NodeJS.ProcessEnv] ??
        "",
      scenarios: {
        "generated-secret": {
          ...generated,
          expected: "HTTP/persist/final withhold current sentinel",
        },
        "stale-secret": {
          ...stale,
          expected: "HTTP/persist/final withhold current and stale sentinels",
        },
        "protected-handoff-repaired-path": {
          ...handoff,
          kind: "repaired-path",
          notFailBeforeCausalProof: true,
          note:
            "Preimage has no protected handle; empty fail-before handoff is an invariant, not leak proof. This AFTER call is the repaired path.",
        },
        "false-success-done": {
          ...falseSuccess,
          expected: "Done without a current-intent ledger becomes Outcome was not verified.",
          finalHasDoneWord: /\bDone\b/.test(falseSuccess.final),
          finalHasNotVerified: /not verified/i.test(falseSuccess.final),
        },
        "compaction-current-secret": compactionCurrent,
        "compaction-stale-secret": compactionStale,
      },
      gateMet: false,
    };
    writeFileSync(join(options.outDir, "phases-summary.json"), `${JSON.stringify(phases, null, 2)}\n`);
    writeFileSync(
      join(options.outDir, "hashes.json"),
      `${JSON.stringify(
        {
          packSha256: process.env.CANDIDATE_PACK_SHA256 ?? "",
          gitHead: process.env.CANDIDATE_GIT_HEAD ?? "",
          service: options.service,
          phasesSha256: createHash("sha256")
            .update(JSON.stringify(phases))
            .digest("hex"),
        },
        null,
        2,
      )}\n`,
    );
    return phases;
  } finally {
    if (previous === undefined) delete process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
    else process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = previous;
  }
}

async function main(argv: string[]) {
  const outFlag = argv.indexOf("--out");
  const serviceFlag = argv.indexOf("--service");
  const outDir = outFlag >= 0 ? argv[outFlag + 1] : process.env.ISOLATED_CAPTURE_OUT;
  const service = serviceFlag >= 0 ? argv[serviceFlag + 1] : process.env.ISOLATED_CAPTURE_SERVICE;
  if (!outDir || !service) {
    throw new Error("usage: candidate-capture-harness --service worker|api --out DIR");
  }
  const result = await runCandidateCapture({ service, outDir });
  process.stdout.write(`${JSON.stringify({ ok: true, kind: result.kind, service }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
