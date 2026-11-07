import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { EncryptedSecretStore } from "./secrets.js";
import {
  PROTECTED_RESULT_VAULT_BLOCKER,
  createFailClosedVault,
  createMemoryVault,
  createProtectedResultStore,
  createSecretStoreVault,
  handoffProtectedResult,
  handoffProtectedResultDurable,
  persistProtectedResultDurable,
  protectPersistedEffectResult,
  recoverProtectedPlaintext,
  redactReplayResult,
  redactToolResultForModel,
  resolveProtectedResultVault,
} from "./protected-result.js";

const FIXTURE = "FxNew#2207GenA";

const context: AdapterContext = {
  operationId: "op",
  traceId: "tr",
  spaceId: "space-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

describe("protected result persist path", () => {
  it("never returns plaintext to the model and hands off by handle only", () => {
    const store = createProtectedResultStore();
    const { result, handle } = redactToolResultForModel(
      { ok: true, tree: `Reset password successful. New password: ${FIXTURE}` },
      store,
    );
    expect(JSON.stringify(result)).not.toContain(FIXTURE);
    expect(handle?.handle).toMatch(/^op-/);
    const delivered = handoffProtectedResult(store, handle!.handle);
    expect(delivered).toEqual({
      delivered: true,
      channel: "secure card to the user",
      op_id: handle!.handle,
    });
    expect(JSON.stringify(delivered)).not.toContain(FIXTURE);
    expect(handoffProtectedResult(store, "op-missing")).toEqual({
      error: "unknown op_id; hash cannot recover the secret",
    });
  });

  it("replays a stored effect without re-exposing plaintext and cannot invert the hash", async () => {
    const store = createProtectedResultStore();
    const vault = createMemoryVault();
    const handle = await persistProtectedResultDurable(store, FIXTURE, vault);
    expect(await recoverProtectedPlaintext(store, handle.handle, vault)).toBe(FIXTURE);
    expect(JSON.stringify(redactReplayResult({ tree: `New password: ${FIXTURE}` }))).not.toContain(
      FIXTURE,
    );
    expect(JSON.stringify(handle)).not.toContain(FIXTURE);
    store.delete(handle.handle);
    expect(handoffProtectedResult(store, handle.handle)).toEqual({
      error: "unknown op_id; hash cannot recover the secret",
    });
    expect(await recoverProtectedPlaintext(store, handle.handle, vault)).toBe(FIXTURE);
  });

  it("fail-closed vault refuses plaintext persist and does not invent a storage key", async () => {
    const store = createProtectedResultStore();
    const vault = resolveProtectedResultVault(undefined, context);
    await expect(vault.save("op-x", FIXTURE)).rejects.toThrow(PROTECTED_RESULT_VAULT_BLOCKER);
    const protectedPage = await protectPersistedEffectResult({
      result: { tree: `New password: ${FIXTURE}` },
      store,
      vault: createFailClosedVault(),
    });
    expect(JSON.stringify(protectedPage.model)).not.toContain(FIXTURE);
    expect(JSON.stringify(protectedPage.stored)).not.toContain(FIXTURE);
    expect(JSON.stringify(protectedPage.stored)).not.toContain("protectedVaultRef");
    expect(store.get(protectedPage.handle!.handle)?.plaintext).toBeUndefined();
    expect(await handoffProtectedResultDurable(store, protectedPage.handle!.handle, vault)).toEqual({
      error: "unknown op_id; hash cannot recover the secret",
    });
  });

  it("encrypted SecretStore vault keeps an opaque ref and never returns plaintext on handoff", async () => {
    const secrets: SecretStore = new EncryptedSecretStore("test-only-protected-result-key");
    const store = createProtectedResultStore();
    const vault = createSecretStoreVault(secrets, context);
    const protectedPage = await protectPersistedEffectResult({
      result: { tree: `New password: ${FIXTURE}` },
      store,
      vault,
    });
    expect(JSON.stringify(protectedPage.model)).not.toContain(FIXTURE);
    expect(JSON.stringify(protectedPage.model)).not.toContain("protectedVaultRef");
    expect(JSON.stringify(protectedPage.stored)).not.toContain(FIXTURE);
    const ref = (protectedPage.stored as { protectedVaultRef?: string }).protectedVaultRef;
    expect(ref).toMatch(/^v2:/);
    expect(await recoverProtectedPlaintext(store, protectedPage.handle!.handle, vault)).toBe(
      FIXTURE,
    );
    const delivered = await handoffProtectedResultDurable(
      store,
      protectedPage.handle!.handle,
      vault,
      protectedPage.stored,
    );
    expect(delivered).toEqual({
      delivered: true,
      channel: "secure card to the user",
      op_id: protectedPage.handle!.handle,
    });
    expect(JSON.stringify(delivered)).not.toContain(FIXTURE);
    expect(JSON.stringify(redactReplayResult(protectedPage.stored))).not.toContain(
      "protectedVaultRef",
    );
  });
});
