import {
  extractGeneratedPassword,
  issueProtectedResult,
  type ProtectedResultHandle,
  protectedResultNote,
  redactProtectedTree,
} from "@rakazo/core";

export type ProtectedResultStore = Map<
  string,
  { handle: ProtectedResultHandle; plaintext: string }
>;

export function createProtectedResultStore(): ProtectedResultStore {
  return new Map();
}

export type ProtectedVault = {
  save(opId: string, plaintext: string): Promise<void>;
  load(opId: string): Promise<string | undefined>;
};

export function createMemoryVault(): ProtectedVault {
  const rows = new Map<string, string>();
  return {
    save: async (opId, plaintext) => {
      rows.set(opId, plaintext);
    },
    load: async (opId) => rows.get(opId),
  };
}

export function persistProtectedResult(
  store: ProtectedResultStore,
  plaintext: string,
  at?: Date,
): ProtectedResultHandle {
  const handle = issueProtectedResult(plaintext, at, "verified");
  store.set(handle.handle, { handle, plaintext });
  return handle;
}

export async function persistProtectedResultDurable(
  store: ProtectedResultStore,
  plaintext: string,
  vault: ProtectedVault,
  at?: Date,
): Promise<ProtectedResultHandle> {
  const handle = persistProtectedResult(store, plaintext, at);
  await vault.save(handle.handle, plaintext);
  return handle;
}

export async function recoverProtectedPlaintext(
  store: ProtectedResultStore,
  opId: string,
  vault?: ProtectedVault,
): Promise<string | undefined> {
  const row = store.get(opId);
  if (row) return row.plaintext;
  return vault?.load(opId);
}

export function redactReplayResult(result: unknown, extras: readonly string[] = []): unknown {
  return redactProtectedTree(result, extras);
}

export function redactToolResultForModel(
  result: unknown,
  store: ProtectedResultStore,
): { result: unknown; handle?: ProtectedResultHandle } {
  const text = typeof result === "string" ? result : stringify(result);
  const password = extractGeneratedPassword(text);
  if (!password) return { result: redactProtectedTree(result) };
  const handle = persistProtectedResult(store, password);
  const redacted = redactProtectedTree(result, [password]);
  if (typeof redacted === "string") {
    return { result: `${redacted}\n${protectedResultNote(handle)}`, handle };
  }
  if (redacted && typeof redacted === "object") {
    return {
      result: { ...redacted, protectedResult: handle, note: protectedResultNote(handle) },
      handle,
    };
  }
  return { result: protectedResultNote(handle), handle };
}

export function handoffProtectedResult(
  store: ProtectedResultStore,
  opId: string,
): { delivered: boolean; channel: string; op_id: string } | { error: string } {
  const row = store.get(opId);
  if (!row?.plaintext) {
    return { error: "unknown op_id; hash cannot recover the secret" };
  }
  row.handle = { ...row.handle, status: "delivered" };
  return { delivered: true, channel: "secure card to the user", op_id: opId };
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}
