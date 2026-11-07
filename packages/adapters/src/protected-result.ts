import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import {
  extractGeneratedPassword,
  issueProtectedResult,
  type ProtectedResultHandle,
  protectedResultNote,
  redactProtectedTree,
} from "@rakazo/core";

export const PROTECTED_RESULT_VAULT_BLOCKER =
  "PROTECTED_RESULT_VAULT: disabled until SecretStore encryption is provisioned on the runtime; plaintext persist is refused";

export const VAULT_REF_FIELD = "protectedVaultRef";

export type ProtectedResultStore = Map<
  string,
  { handle: ProtectedResultHandle; plaintext?: string; vaultRef?: string }
>;

export function createProtectedResultStore(): ProtectedResultStore {
  return new Map();
}

export type ProtectedVault = {
  save(opId: string, plaintext: string): Promise<string | undefined>;
  load(opId: string, vaultRef?: string): Promise<string | undefined>;
};

export class ProtectedResultVaultDisabledError extends Error {
  constructor() {
    super(PROTECTED_RESULT_VAULT_BLOCKER);
    this.name = "ProtectedResultVaultDisabledError";
  }
}

export function createFailClosedVault(): ProtectedVault {
  return {
    save: async () => {
      throw new ProtectedResultVaultDisabledError();
    },
    load: async () => undefined,
  };
}

/** Test-only in-process map. Not the overlay persist path. */
export function createMemoryVault(): ProtectedVault {
  const rows = new Map<string, string>();
  return {
    save: async (opId, plaintext) => {
      rows.set(opId, plaintext);
      return opId;
    },
    load: async (opId) => rows.get(opId),
  };
}

export function resolveProtectedResultVault(
  store: SecretStore | undefined | null,
  context: AdapterContext,
): ProtectedVault {
  if (!store) return createFailClosedVault();
  return createSecretStoreVault(store, context);
}

/**
 * Encrypts with the existing SecretStore. Does not invent a table or key
 * scheme: the store returns its own opaque ref (ciphertext).
 */
export function createSecretStoreVault(
  store: SecretStore,
  context: AdapterContext,
): ProtectedVault {
  const refs = new Map<string, string>();
  return {
    save: async (opId, plaintext) => {
      const record = await store.put(plaintext, context, { recordId: opId });
      refs.set(opId, record.ref);
      return record.ref;
    },
    load: async (opId, vaultRef) => {
      const ref = vaultRef ?? refs.get(opId);
      if (!ref) return undefined;
      return store.load(ref, opId);
    },
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
  try {
    const vaultRef = await vault.save(handle.handle, plaintext);
    const row = store.get(handle.handle);
    if (row) {
      row.vaultRef = vaultRef;
      delete row.plaintext;
    }
  } catch (error) {
    if (!(error instanceof ProtectedResultVaultDisabledError)) throw error;
    const row = store.get(handle.handle);
    if (row) delete row.plaintext;
  }
  return handle;
}

export async function recoverProtectedPlaintext(
  store: ProtectedResultStore,
  opId: string,
  vault?: ProtectedVault,
  storedResult?: unknown,
): Promise<string | undefined> {
  const row = store.get(opId);
  if (row?.plaintext) return row.plaintext;
  const vaultRef =
    row?.vaultRef ??
    (storedResult &&
    typeof storedResult === "object" &&
    !Array.isArray(storedResult) &&
    typeof (storedResult as { protectedVaultRef?: unknown }).protectedVaultRef === "string"
      ? (storedResult as { protectedVaultRef: string }).protectedVaultRef
      : undefined);
  return vault?.load(opId, vaultRef);
}

export function redactReplayResult(result: unknown, extras: readonly string[] = []): unknown {
  return stripVaultRef(redactProtectedTree(result, extras));
}

export function stripVaultRef(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVaultRef);
  if (!value || typeof value !== "object") return value;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === VAULT_REF_FIELD) continue;
    next[key] = stripVaultRef(item);
  }
  return next;
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

export async function protectPersistedEffectResult(input: {
  result: unknown;
  extras?: readonly string[];
  store: ProtectedResultStore;
  vault: ProtectedVault;
}): Promise<{ model: unknown; stored: unknown; handle?: ProtectedResultHandle }> {
  const extras = input.extras ?? [];
  const protectedPage = redactToolResultForModel(input.result, input.store);
  const model = stripVaultRef(redactProtectedTree(protectedPage.result, extras));
  if (!protectedPage.handle) return { model, stored: model };
  const row = input.store.get(protectedPage.handle.handle);
  const plaintext = row?.plaintext;
  if (!plaintext) {
    if (row) delete row.plaintext;
    return { model, stored: model, handle: protectedPage.handle };
  }
  try {
    const vaultRef = await input.vault.save(protectedPage.handle.handle, plaintext);
    if (row) {
      row.vaultRef = vaultRef;
      delete row.plaintext;
    }
    const stored =
      model && typeof model === "object" && !Array.isArray(model)
        ? { ...(model as Record<string, unknown>), [VAULT_REF_FIELD]: vaultRef }
        : { note: model, [VAULT_REF_FIELD]: vaultRef };
    return { model, stored, handle: protectedPage.handle };
  } catch (error) {
    if (!(error instanceof ProtectedResultVaultDisabledError)) throw error;
    if (row) delete row.plaintext;
    return { model, stored: model, handle: protectedPage.handle };
  }
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

export async function handoffProtectedResultDurable(
  store: ProtectedResultStore,
  opId: string,
  vault?: ProtectedVault,
  storedResult?: unknown,
): Promise<{ delivered: boolean; channel: string; op_id: string } | { error: string }> {
  const plaintext = await recoverProtectedPlaintext(store, opId, vault, storedResult);
  if (!plaintext) {
    return { error: "unknown op_id; hash cannot recover the secret" };
  }
  const row = store.get(opId);
  if (row) row.handle = { ...row.handle, status: "delivered" };
  return { delivered: true, channel: "secure card to the user", op_id: opId };
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}
