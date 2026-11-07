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
/** Isolated-capture runs 10–13 used 4 × 32768. Not a live encrypted secret window. */
export const SYNTHETIC_CAPTURE_MAX_TOKENS = 32_768;
export const SYNTHETIC_CAPTURE_CONTEXT_WINDOW = 131_072;
export const SYNTHETIC_CAPTURE_WINDOW_NOTE =
  "DEFAULT_MODEL_CONTEXT_WINDOW=32768 cannot reserve REASONING_MODEL_MAX_TOKENS=32768 plus assembler/tools (ContextBudgetError). Synthetic window is 4*32768=131072 so input room remains. Previously accepted for isolated-capture runs 10-13. Not a live encrypted secret.contextWindow/maxTokens value.";
/** Exact overlay assistBareDone follow-up (composed AFTER pi-runtime). */
export const ASSIST_BARE_DONE_NUDGE =
  "Give the user the actual result now: what you did, what you found or changed, and how you checked it. A bare 'done' is not enough.";
export const SCRIPT_NUDGE_FILLER = "synthetic-stop-0";

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

function stubEventText(events: unknown[]): string {
  return events
    .map((event) => {
      if (!event || typeof event !== "object" || !("content" in event)) return "";
      const content = (event as { content?: unknown }).content;
      return typeof content === "string" ? content : "";
    })
    .join("");
}

async function startLoopbackStub(options: {
  modelId: string;
  replies: StubReply[];
  caseName: string;
}) {
  const rawBodies: Buffer[] = [];
  const parsedBodies: Array<Record<string, unknown> | null> = [];
  const servedFinalTexts: string[] = [];
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
      const blob = parsed ? JSON.stringify(parsed) : "";
      const isBareDoneNudge = blob.includes(ASSIST_BARE_DONE_NUDGE);
      let reply = options.replies[seq];
      seq += 1;
      if (isBareDoneNudge) {
        reply = {
          kind: "sse",
          finish: "stop",
          events: [{ content: SCRIPT_NUDGE_FILLER }],
        };
      } else if (!reply) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: "unscripted filler reply refused", type: "stub" },
          }),
        );
        return;
      }
      if (reply.kind === "http-error") {
        response.writeHead(reply.status, { "content-type": "application/json" });
        response.end(reply.body);
        return;
      }
      if (reply.finish === "stop") servedFinalTexts.push(stubEventText(reply.events));
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
    servedFinalTexts,
    repliesServed: () => seq,
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
    reasoning: true,
    acceptsImages: true,
    maxTokens: SYNTHETIC_CAPTURE_MAX_TOKENS,
    contextWindow: SYNTHETIC_CAPTURE_CONTEXT_WINDOW,
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

/** Synthetic rows for composed compactHistory when RAKAZO_CTXMEM=1 (production-forwarded). */
function ctxmemPrisma() {
  return {
    memoryDocument: {
      findFirst: async () => ({
        content: "synthetic FACTS.md for capture. No generated passwords.",
      }),
    },
    botMcpServer: {
      findMany: async () => [
        { server: { name: "synthetic-mcp", slug: "synthetic-mcp" } },
      ],
      findFirst: async () => ({
        server: { name: "synthetic-mcp", slug: "synthetic-mcp" },
      }),
    },
    botSecret: {
      findMany: async () => [
        { name: "synthetic-cred", origin: "https://capture.example.test" },
      ],
    },
  };
}

function missingPrismaGuard<T extends object>(base: T, label: string): T {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
      if (prop in target) return Reflect.get(target, prop, receiver);
      throw new Error(`${label} synthetic prisma missing ${String(prop)}`);
    },
  }) as T;
}

export type NonVacuousVerdict = {
  ok: boolean;
  nonvacuous: boolean;
  vacuous: boolean;
  failures: string[];
};

const EXECUTOR_SCENARIOS = new Set([
  "generated-secret",
  "stale-secret",
  "protected-handoff-repaired-path",
  "false-success-done",
]);

/** Fail-closed: no-throw / rc=0 is not proof the model boundary ran. */
export function evaluateNonVacuous(name: string, row: Record<string, unknown>): NonVacuousVerdict {
  const failures: string[] = [];
  const fail = (code: string) => failures.push(code);
  if (name.startsWith("compaction-")) {
    const summary = typeof row.summary === "string" ? row.summary : "";
    if (!summary) fail("VACUOUS_EMPTY_COMPACTION_SUMMARY");
    if (row.hasCurrent === true) fail("AFTER_LEAK_CURRENT_IN_COMPACTION");
    if (row.hasStale === true) fail("AFTER_LEAK_STALE_IN_COMPACTION");
    if (row.hasAllSet === true) fail("AFTER_FALSE_ALL_SET_NOT_REMOVED");
    const ok = failures.length === 0;
    return { ok, nonvacuous: ok, vacuous: !ok, failures };
  }
  if (!EXECUTOR_SCENARIOS.has(name)) {
    fail("UNKNOWN_SCENARIO");
    return { ok: false, nonvacuous: false, vacuous: true, failures };
  }
  const httpBytes = Number(row.httpBytes ?? 0);
  const httpRequestCount = Number(row.httpRequestCount ?? 0);
  const runOutcome = typeof row.runOutcome === "string" ? row.runOutcome : "";
  const runError = typeof row.runError === "string" ? row.runError : "";
  const persist = typeof row.persist === "string" ? row.persist : "";
  const final = typeof row.final === "string" ? row.final : "";
  const handoff = typeof row.handoff === "string" ? row.handoff : "";
  const toolNames = Array.isArray(row.executeToolNames)
    ? row.executeToolNames.map((value) => String(value))
    : [];
  if (httpBytes <= 0) fail("VACUOUS_ZERO_HTTP");
  if (httpRequestCount < 2) fail("VACUOUS_MISSING_TOOL_ROUND");
  if (runOutcome !== "completed") fail("VACUOUS_FAILED_RUN");
  if (/context budget/i.test(runError) || /context budget/i.test(final)) fail("VACUOUS_CONTEXT_BUDGET");
  if (!final || final === "[]") fail("VACUOUS_FINAL_NOT_REACHED");
  if (!persist || persist === "[]") fail("VACUOUS_PERSIST_NOT_REACHED");
  if (!toolNames.includes("scratchpad_add")) fail("VACUOUS_MISSING_EXPECTED_TOOL_CALL");
  if (typeof row.http === "string" && row.http.length > 0) fail("PRIVACY_RAW_HTTP_PERSISTED");
  if (row.httpBodiesPersisted === true) fail("PRIVACY_RAW_HTTP_PERSISTED");
  if (row.httpHasCurrent === true) fail("AFTER_LEAK_CURRENT_IN_HTTP");
  if (row.httpHasStale === true) fail("AFTER_LEAK_STALE_IN_HTTP");
  if (row.persistHasCurrent === true) fail("AFTER_LEAK_CURRENT_IN_PERSIST");
  if (row.persistHasStale === true) fail("AFTER_LEAK_STALE_IN_PERSIST");
  if (row.finalHasCurrent === true) fail("AFTER_LEAK_CURRENT_IN_FINAL");
  if (row.finalHasStale === true) fail("AFTER_LEAK_STALE_IN_FINAL");
  if (row.handoffHasCurrent === true) fail("AFTER_LEAK_CURRENT_IN_HANDOFF");
  if (row.handoffHasStale === true) fail("AFTER_LEAK_STALE_IN_HANDOFF");
  if (name !== "false-success-done" && row.executeArgsHasCurrent !== true) {
    fail("VACUOUS_SENTINEL_DID_NOT_REACH_TOOL_ARGS");
  }
  if (row.toolResultAfterHasCurrent === true) fail("AFTER_LEAK_CURRENT_IN_TOOL_RESULT");
  if (row.toolResultAfterHasStale === true) fail("AFTER_LEAK_STALE_IN_TOOL_RESULT");
  if (name === "protected-handoff-repaired-path") {
    if (!toolNames.includes("protected_result_handoff")) fail("VACUOUS_MISSING_EXPECTED_HANDOFF");
    if (handoff === "null" || handoff === "" || handoff === "undefined") fail("VACUOUS_HANDOFF_NULL");
  }
  if (name === "false-success-done") {
    if (row.stubEmittedDone !== true) fail("VACUOUS_STUB_DID_NOT_EMIT_DONE");
    if (row.httpHasBareDoneNudge !== true) fail("VACUOUS_MISSING_BARE_DONE_NUDGE");
    if (httpRequestCount < 3) fail("VACUOUS_MISSING_NUDGE_TURN");
    if (row.stubEmittedNudgeFiller !== true) fail("VACUOUS_NUDGE_FILLER_NOT_SCRIPTED");
    if (row.finalHasNotVerified !== true) fail("AFTER_DONE_NOT_REWRITTEN");
    if (row.finalHasDoneWord === true || row.finalHasUnsupportedDoneShape === true) {
      fail("AFTER_DONE_STILL_IN_FINAL");
    }
  }
  const ok = failures.length === 0;
  return { ok, nonvacuous: ok, vacuous: !ok, failures };
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
    ...ctxmemPrisma(),
    externalEffect,
    $queryRaw: async () => [{ id: "computer-1", scope: "dedicated" }],
    $executeRaw: async () => 1,
    $transaction: async (work: (tx: never) => Promise<unknown>) => work(prisma as never),
  };
  const guarded = missingPrismaGuard(prisma, "executor");
  const executor = createRunExecutor({
    prisma: guarded as never,
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
    ],
  });
  let handoffResult: unknown = null;
  const executeCalls: Array<{ name: string; args: unknown }> = [];
  const toolResults: Array<{ name: string; result: unknown }> = [];
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
                executeCalls.push({ name, args });
                const result = await inner(name, args, executionId);
                toolResults.push({ name, result });
                if (options.invokeHandoff && name === "scratchpad_add") {
                  const handle = extractProtectedHandle(dump(result));
                  if (handle) {
                    const handed = await inner(
                      "protected_result_handoff",
                      { op_id: handle },
                      "call-handoff",
                    );
                    executeCalls.push({
                      name: "protected_result_handoff",
                      args: { op_id: handle },
                    });
                    toolResults.push({ name: "protected_result_handoff", result: handed });
                    handoffResult = handed;
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
    const httpByteCounts = stub.rawBodies.map((body) => body.byteLength);
    const http = stub.rawBodies.map((body) => body.toString("utf8")).join("\n");
    const persist = dump(f.effects.map((effect) => effect.result));
    const final = dump(f.finalized);
    const handoff = dump(handoffResult);
    const executeArgs = dump(executeCalls.map((row) => row.args));
    const toolResultAfter = dump(toolResults.map((row) => row.result));
    const firstFinal = f.finalized[0] as
      | { outcome?: string; error?: string; blocks?: unknown }
      | undefined;
    const stubEmittedFinal = stub.servedFinalTexts[0] ?? "";
    const httpHasBareDoneNudge = http.includes(ASSIST_BARE_DONE_NUDGE);
    return {
      persist,
      final,
      handoff,
      httpBytes: httpByteCounts.reduce((sum, n) => sum + n, 0),
      httpRequestCount: stub.rawBodies.length,
      httpByteCounts,
      httpSha256: createHash("sha256").update(http).digest("hex"),
      httpBodiesPersisted: false,
      stubRepliesServed: stub.repliesServed(),
      stubEmittedFinal,
      stubEmittedDone: stub.servedFinalTexts.some((text) => /\bDone\b/.test(text)),
      stubEmittedNudgeFiller: stub.servedFinalTexts.includes(SCRIPT_NUDGE_FILLER),
      httpHasBareDoneNudge,
      runOutcome: firstFinal?.outcome ?? null,
      runError: firstFinal?.error ?? null,
      persistEffectCount: f.effects.length,
      finalCount: f.finalized.length,
      executeToolNames: executeCalls.map((row) => row.name),
      executeArgsHasCurrent: executeArgs.includes(CURRENT_SECRET_SENTINEL),
      executeArgsHasStale: executeArgs.includes(STALE_SECRET_SENTINEL),
      toolResultAfterHasCurrent: toolResultAfter.includes(CURRENT_SECRET_SENTINEL),
      toolResultAfterHasStale: toolResultAfter.includes(STALE_SECRET_SENTINEL),
      syntheticContextWindow: SYNTHETIC_CAPTURE_CONTEXT_WINDOW,
      syntheticMaxTokens: SYNTHETIC_CAPTURE_MAX_TOKENS,
      httpHasCurrent: http.includes(CURRENT_SECRET_SENTINEL),
      httpHasStale: http.includes(STALE_SECRET_SENTINEL),
      persistHasCurrent: persist.includes(CURRENT_SECRET_SENTINEL),
      persistHasStale: persist.includes(STALE_SECRET_SENTINEL),
      finalHasCurrent: final.includes(CURRENT_SECRET_SENTINEL),
      finalHasStale: final.includes(STALE_SECRET_SENTINEL),
      finalHasUnsupportedDoneShape:
        /\bDone\b/.test(final) ||
        /Donesynthetic-stop/i.test(final) ||
        (final.includes(SCRIPT_NUDGE_FILLER) && !/not verified/i.test(final)),
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
  const prisma = missingPrismaGuard(
    {
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
      ...ctxmemPrisma(),
    },
    "compaction",
  );
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

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function errorRecord(error: unknown) {
  return {
    ok: false as const,
    error:
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { name: "Error", message: String(error) },
  };
}

export async function runCandidateCapture(options: { service: string; outDir: string }) {
  const previous = process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
  process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = "1";
  mkdirSync(options.outDir, { recursive: true });
  const scenarios: Record<string, unknown> = {};
  let failed = false;
  const persist = (name: string, value: unknown) => {
    scenarios[name] = value;
    writeJson(join(options.outDir, `scenario-${name}.json`), value);
    writeJson(join(options.outDir, "phases-partial.json"), {
      kind: CANDIDATE_CAPTURE_KIND,
      service: options.service,
      ctxmem: process.env.RAKAZO_CTXMEM ?? "",
      ctxmemFacts: process.env.RAKAZO_CTXMEM_FACTS ?? "",
      scenarios,
    });
  };
  const runNamed = async (name: string, work: () => Promise<unknown>, extra: Record<string, unknown> = {}) => {
    try {
      const value = (await work()) as Record<string, unknown>;
      const verdict = evaluateNonVacuous(name, { ...extra, ...value });
      persist(name, { ...extra, ...value, ...verdict });
      if (!verdict.ok) failed = true;
    } catch (error) {
      failed = true;
      persist(name, {
        ...extra,
        ...errorRecord(error),
        ...evaluateNonVacuous(name, { ...extra, ...errorRecord(error) }),
      });
    }
  };
  try {
    await runNamed("generated-secret", () =>
      runPiRuntimeScenario({
        runId: `${options.service}-generated-secret`,
        prompt: "Save the generated password",
        includeStaleHistory: false,
        toolTitle: `New password: ${CURRENT_SECRET_SENTINEL}`,
        finalText: `Done. New password: ${CURRENT_SECRET_SENTINEL}`,
        invokeHandoff: false,
      }),
    );
    await runNamed("stale-secret", () =>
      runPiRuntimeScenario({
        runId: `${options.service}-stale-secret`,
        prompt: "Save the generated password",
        includeStaleHistory: true,
        toolTitle: `New password: ${CURRENT_SECRET_SENTINEL}`,
        finalText: `Done. New password: ${CURRENT_SECRET_SENTINEL}. Old password: ${STALE_SECRET_SENTINEL}`,
        invokeHandoff: false,
      }),
    );
    await runNamed(
      "protected-handoff-repaired-path",
      () =>
        runPiRuntimeScenario({
          runId: `${options.service}-protected-handoff`,
          prompt: "Save the generated password",
          includeStaleHistory: true,
          toolTitle: `New password: ${CURRENT_SECRET_SENTINEL}`,
          finalText: `Done. New password: ${CURRENT_SECRET_SENTINEL}. Old password: ${STALE_SECRET_SENTINEL}`,
          invokeHandoff: true,
        }),
      {
        kind: "repaired-path",
        notFailBeforeCausalProof: true,
        note:
          "Preimage has no protected handle; empty fail-before handoff is an invariant, not leak proof. This AFTER call is the repaired path.",
      },
    );
    await runNamed("false-success-done", async () => {
      const falseSuccess = await runPiRuntimeScenario({
        runId: `${options.service}-false-success-done`,
        prompt: "Finish the reset",
        includeStaleHistory: false,
        toolTitle: "status note",
        finalText: "Done",
        invokeHandoff: false,
      });
      return {
        ...falseSuccess,
        finalHasDoneWord: /\bDone\b/.test(falseSuccess.final),
        finalHasNotVerified: /not verified/i.test(falseSuccess.final),
      };
    });
    await runNamed("compaction-current-secret", () =>
      runCompactionScenario(`All set. New password: ${CURRENT_SECRET_SENTINEL}`),
    );
    await runNamed("compaction-stale-secret", () =>
      runCompactionScenario(`All set. Old password: ${STALE_SECRET_SENTINEL}`),
    );
    const phases = {
      kind: CANDIDATE_CAPTURE_KIND,
      notBaselineAssembler: true,
      okMeansNonVacuous: true,
      noThrowIsNotProof: true,
      service: options.service,
      packSha256: process.env.CANDIDATE_PACK_SHA256 ?? "",
      gitHead: process.env.CANDIDATE_GIT_HEAD ?? "",
      ctxmem: process.env.RAKAZO_CTXMEM ?? "",
      ctxmemFacts: process.env.RAKAZO_CTXMEM_FACTS ?? "",
      syntheticContextWindow: SYNTHETIC_CAPTURE_CONTEXT_WINDOW,
      syntheticMaxTokens: SYNTHETIC_CAPTURE_MAX_TOKENS,
      syntheticWindowNote: SYNTHETIC_CAPTURE_WINDOW_NOTE,
      failed,
      imageId:
        process.env[`RAKAZO_${options.service.toUpperCase()}_IMAGE_ID` as keyof NodeJS.ProcessEnv] ??
        "",
      scenarios,
      gateMet: false,
    };
    writeJson(join(options.outDir, "phases-summary.json"), phases);
    writeJson(join(options.outDir, "hashes.json"), {
      packSha256: process.env.CANDIDATE_PACK_SHA256 ?? "",
      gitHead: process.env.CANDIDATE_GIT_HEAD ?? "",
      service: options.service,
      failed,
      phasesSha256: createHash("sha256").update(JSON.stringify(phases)).digest("hex"),
    });
    if (failed) {
      throw new Error(`candidate capture scenarios failed for ${options.service}`);
    }
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
