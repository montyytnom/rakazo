import { describe, expect, it } from "vitest";
import {
  createMemoryVault,
  createProtectedResultStore,
  handoffProtectedResult,
  persistProtectedResultDurable,
  recoverProtectedPlaintext,
  redactReplayResult,
  redactToolResultForModel,
} from "./protected-result.js";

const FIXTURE = "FxNew#2207GenA";

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
});
