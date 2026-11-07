import type {
  AdapterContext,
  BrowserActResult,
  BrowserActStep,
  BrowserProvider,
  BrowserSnapshotNode,
  ComputerRef,
} from "@rakazo/adapter-kit";
import { classifyBrowserMutation } from "@rakazo/core";

export const STALE_ELEMENT_ERROR = /stale element ref|unknown element ref/i;
export const MAX_STALE_RECOVERIES = 1;

export type RefMemory = {
  byRef: Map<string, { role: string; name: string }>;
  lastUrl?: string;
};

export function createRefMemory(): RefMemory {
  return { byRef: new Map() };
}

export function rememberSnapshot(
  memory: RefMemory,
  elements: readonly BrowserSnapshotNode[] | undefined,
  url?: string,
) {
  if (url) memory.lastUrl = url;
  if (!elements) return;
  memory.byRef.clear();
  for (const element of elements) {
    memory.byRef.set(element.ref, { role: element.role, name: element.name });
  }
}

export function browserActLabels(args: Record<string, unknown>, memory: RefMemory): string[] {
  const actions = Array.isArray(args.actions) ? args.actions : [];
  const labels: string[] = [];
  for (const action of actions) {
    if (!action || typeof action !== "object") continue;
    const ref = (action as { ref?: unknown }).ref;
    if (typeof ref !== "string") continue;
    const known = memory.byRef.get(ref);
    if (known?.name) labels.push(known.name);
  }
  return labels;
}

export function isStaleElementError(error: string | undefined): boolean {
  return Boolean(error && STALE_ELEMENT_ERROR.test(error));
}

export function remapActions(
  actions: BrowserActStep[],
  memory: RefMemory,
  elements: readonly BrowserSnapshotNode[],
): BrowserActStep[] | undefined {
  const remapped: BrowserActStep[] = [];
  for (const action of actions) {
    if (!("ref" in action) || !action.ref) {
      remapped.push(action);
      continue;
    }
    const known = elements.some((element) => element.ref === action.ref);
    if (known) {
      remapped.push(action);
      continue;
    }
    const prior = memory.byRef.get(action.ref);
    if (!prior) return undefined;
    const matches = elements.filter(
      (element) => element.role === prior.role && element.name === prior.name,
    );
    if (matches.length !== 1) return undefined;
    remapped.push({ ...action, ref: matches[0]!.ref });
  }
  return remapped;
}

export async function recoverStaleBrowserAct(input: {
  browser: BrowserProvider;
  computer: ComputerRef;
  context: AdapterContext;
  actions: BrowserActStep[];
  memory: RefMemory;
}): Promise<BrowserActResult & { recovered?: boolean }> {
  const first = await input.browser.act(
    input.computer,
    { actions: input.actions, signal: input.context.signal },
    input.context,
  );
  if (first.ok || !isStaleElementError(first.error)) {
    rememberSnapshot(input.memory, first.elements, first.url);
    return first;
  }
  const snap = await input.browser.snapshot(
    input.computer,
    { signal: input.context.signal },
    input.context,
  );
  if (!samePage(input.memory.lastUrl, snap.url)) {
    rememberSnapshot(input.memory, snap.elements, snap.url);
    return {
      ...first,
      ok: false,
      url: snap.url || first.url,
      title: snap.title || first.title,
      tree: snap.tree,
      elements: snap.elements,
      recovered: false,
      error: `${first.error ?? "Stale element ref"}. Page changed or was unknown; use the new refs. Do not retry the old ref.`,
    };
  }
  const labels = browserActLabels({ actions: input.actions }, input.memory);
  if (classifyBrowserMutation(labels, input.memory.lastUrl ?? snap.url)) {
    rememberSnapshot(input.memory, snap.elements, snap.url);
    return {
      ...first,
      ok: false,
      url: snap.url || first.url,
      title: snap.title || first.title,
      tree: snap.tree,
      elements: snap.elements,
      recovered: false,
      error: `${first.error ?? "Stale element ref"}. Irreversible control was not re-clicked; use the new refs.`,
    };
  }
  const remapped = remapActions(input.actions, input.memory, snap.elements);
  rememberSnapshot(input.memory, snap.elements, snap.url);
  if (!remapped) {
    return {
      ...first,
      ok: false,
      url: snap.url || first.url,
      title: snap.title || first.title,
      tree: snap.tree,
      elements: snap.elements,
      recovered: false,
      error: `${first.error ?? "Stale element ref"}. Fresh snapshot taken; use the new refs. Do not retry the old ref.`,
    };
  }
  const second = await input.browser.act(
    input.computer,
    { actions: remapped, signal: input.context.signal },
    input.context,
  );
  rememberSnapshot(input.memory, second.elements ?? snap.elements, second.url ?? snap.url);
  if (second.ok) return { ...second, recovered: true };
  return {
    ...second,
    recovered: false,
    tree: second.tree ?? snap.tree,
    elements: second.elements ?? snap.elements,
    error: `${second.error ?? first.error ?? "Stale element ref"}. Fresh snapshot taken; use the new refs.`,
  };
}

export function samePage(left?: string, right?: string): boolean {
  if (!left || !right) return false;
  return pagePath(left) === pagePath(right);
}

function pagePath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}
