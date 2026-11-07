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

export function persistProtectedResult(
  store: ProtectedResultStore,
  plaintext: string,
  at?: Date,
): ProtectedResultHandle {
  const handle = issueProtectedResult(plaintext, at, "verified");
  store.set(handle.handle, { handle, plaintext });
  return handle;
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
  if (!row) return { error: "unknown op_id" };
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
