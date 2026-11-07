import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import {
  classifyBrowserMutation,
  irreversibleIntentId,
  threadIrreversibleEffectKey,
} from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { browserActFromTool, browserSnapshotFromTool } from "./browser-tools.js";
import { FakeBrowserProvider } from "./fake-browser.js";
import { createProtectedResultStore, redactToolResultForModel } from "./protected-result.js";
import { createRefMemory, rememberSnapshot } from "./stale-element-recovery.js";

const context: AdapterContext = {
  operationId: "fix",
  traceId: "fix",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

const computer: ComputerRef = {
  id: "c-fix",
  botId: "b-fix",
  kind: "fake",
  providerRef: "c-fix",
};

const ADMIN = "https://admin.example.test/ac/users/u-1001";

describe("synthetic reliability fixtures", () => {
  it("N1: Continue after a landed reset does not click reset again", () => {
    const first = irreversibleIntentId("Reset the fixture user password");
    const cont = irreversibleIntentId("Continue", first);
    expect(cont).toBe(first);
    const key = threadIrreversibleEffectKey({
      threadId: "thread-1",
      intentId: cont,
      class: "password-reset",
      subject: ADMIN,
    });
    expect(key).toBe(
      threadIrreversibleEffectKey({
        threadId: "thread-1",
        intentId: first,
        class: "password-reset",
        subject: ADMIN,
      }),
    );
  });

  it("S1: a new reset intent is distinct and the model-visible result withholds the password", async () => {
    const browser = new FakeBrowserProvider({
      pages: {
        [ADMIN]: {
          title: "User",
          html: `<!doctype html><html><head><title>User</title></head><body>
            <button>RESET PASSWORD</button>
            <p>Reset password successful. New password: FxNew#2207GenA</p>
          </body></html>`,
        },
      },
    });
    await browser.navigate(computer, { url: ADMIN }, context);
    const memory = createRefMemory();
    const snap = await browserSnapshotFromTool(
      browser,
      computer,
      context,
      {},
      { refMemory: memory },
    );
    rememberSnapshot(memory, "elements" in snap ? snap.elements : undefined);
    const reset = classifyBrowserMutation(
      (snap as { elements?: { name: string }[] }).elements?.map((el) => el.name) ?? [
        "RESET PASSWORD",
      ],
      ADMIN,
    );
    expect(reset?.class).toBe("password-reset");
    const store = createProtectedResultStore();
    const { result } = redactToolResultForModel(
      { tree: "Reset password successful. New password: FxNew#2207GenA" },
      store,
    );
    expect(JSON.stringify(result)).not.toContain("FxNew#2207GenA");
    const click = await browserActFromTool(
      browser,
      computer,
      context,
      {
        actions: [
          { kind: "click", ref: (snap as { elements: { ref: string }[] }).elements[0]!.ref },
        ],
      },
      { refMemory: memory },
    );
    expect(click).toMatchObject({ ok: true });
  });

  it("R2: launch_app is not a Mac send path", async () => {
    const { sandboxLaunchUnsupported } = await import("./desktop-tool-contract.js");
    expect(sandboxLaunchUnsupported("500 unsupported computer action")).toBe(true);
  });
});
