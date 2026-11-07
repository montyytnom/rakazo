import type { AdapterContext, BrowserActStep, ComputerRef } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { FakeBrowserProvider } from "./fake-browser.js";
import { pageBrowserSessionKey } from "./page-browser-session.js";
import {
  browserActLabels,
  createRefMemory,
  recoverStaleBrowserAct,
  rememberSnapshot,
} from "./stale-element-recovery.js";

const context: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const computer: ComputerRef = {
  id: "c1",
  botId: "b1",
  kind: "fake",
  providerRef: "c1",
};

const page = {
  "https://shop.example/p": {
    title: "Bags",
    html: `<!doctype html><html><head><title>Bags</title></head><body>
      <button>Add to cart</button>
    </body></html>`,
  },
};

describe("stale element recovery", () => {
  it("takes a fresh snapshot and remaps a stale ref once", async () => {
    const browser = new FakeBrowserProvider({ pages: page });
    await browser.navigate(computer, { url: "https://shop.example/p" }, context);
    const firstSnap = await browser.snapshot(computer, {}, context);
    const memory = createRefMemory();
    rememberSnapshot(memory, firstSnap.elements, firstSnap.url);
    const staleRef = firstSnap.elements[0]?.ref;
    expect(staleRef).toBeTruthy();
    expect(browserActLabels({ actions: [{ kind: "click", ref: staleRef }] }, memory)).toEqual([
      "Add to cart",
    ]);
    browser.sessions.get(pageBrowserSessionKey(computer, context)).invalidateRefs();
    const result = await recoverStaleBrowserAct({
      browser,
      computer,
      context,
      actions: [{ kind: "click", ref: staleRef! } satisfies BrowserActStep],
      memory,
    });
    expect(result.ok).toBe(true);
    expect(result.recovered).toBe(true);
  });
});
