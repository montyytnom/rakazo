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

  it("does not remap across a navigation or a duplicate label", async () => {
    const browser = new FakeBrowserProvider({
      pages: {
        "https://shop.example/p": {
          title: "Bags",
          html: `<!doctype html><html><head><title>Bags</title></head><body>
            <button>Add to cart</button>
            <button>Add to cart</button>
          </body></html>`,
        },
        "https://shop.example/other": {
          title: "Other",
          html: `<!doctype html><html><head><title>Other</title></head><body>
            <button>Add to cart</button>
          </body></html>`,
        },
      },
    });
    await browser.navigate(computer, { url: "https://shop.example/p" }, context);
    const firstSnap = await browser.snapshot(computer, {}, context);
    const memory = createRefMemory();
    rememberSnapshot(memory, firstSnap.elements, firstSnap.url);
    const staleRef = firstSnap.elements[0]!.ref;
    browser.sessions.get(pageBrowserSessionKey(computer, context)).invalidateRefs();
    const duplicate = await recoverStaleBrowserAct({
      browser,
      computer,
      context,
      actions: [{ kind: "click", ref: staleRef } satisfies BrowserActStep],
      memory,
    });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.recovered).toBe(false);
    await browser.navigate(computer, { url: "https://shop.example/other" }, context);
    rememberSnapshot(memory, firstSnap.elements, firstSnap.url);
    browser.sessions.get(pageBrowserSessionKey(computer, context)).invalidateRefs();
    const crossed = await recoverStaleBrowserAct({
      browser,
      computer,
      context,
      actions: [{ kind: "click", ref: staleRef } satisfies BrowserActStep],
      memory,
    });
    expect(crossed.ok).toBe(false);
    expect(crossed.error).toMatch(/Page changed/i);
  });

  it("does not re-click an irreversible reset control after a stale ref", async () => {
    const browser = new FakeBrowserProvider({
      pages: {
        "https://admin.example.test/u-1": {
          title: "User",
          html: `<!doctype html><html><head><title>User</title></head><body>
            <button>RESET PASSWORD</button>
          </body></html>`,
        },
      },
    });
    await browser.navigate(computer, { url: "https://admin.example.test/u-1" }, context);
    const firstSnap = await browser.snapshot(computer, {}, context);
    const memory = createRefMemory();
    rememberSnapshot(memory, firstSnap.elements, firstSnap.url);
    const staleRef = firstSnap.elements[0]!.ref;
    browser.sessions.get(pageBrowserSessionKey(computer, context)).invalidateRefs();
    const result = await recoverStaleBrowserAct({
      browser,
      computer,
      context,
      actions: [{ kind: "click", ref: staleRef } satisfies BrowserActStep],
      memory,
    });
    expect(result.ok).toBe(false);
    expect(result.recovered).toBe(false);
    expect(result.error).toMatch(/Irreversible control was not re-clicked/i);
  });
});
