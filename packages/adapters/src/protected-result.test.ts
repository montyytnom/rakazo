import { describe, expect, it } from "vitest";
import {
  createProtectedResultStore,
  handoffProtectedResult,
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
    expect(handoffProtectedResult(store, "op-missing")).toEqual({ error: "unknown op_id" });
  });
});
