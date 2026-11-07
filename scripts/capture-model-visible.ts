import {
  captureBuiltinToolsJson,
  captureCallLimits,
  captureOverlayToolsJson,
} from "../packages/adapters/src/capture-harness.ts";

const overlayRoot = process.argv[2];
const base = captureBuiltinToolsJson();
const limits = captureCallLimits();
const overlay = await captureOverlayToolsJson(overlayRoot);
const payload = {
  label: "code-derived-not-captured",
  thinkingUnchanged: true,
  baseToolCount: base.tools.length,
  limits,
  overlayVariant: overlay?.variant ?? null,
  overlayToolCount: overlay?.tools.length ?? null,
  tools: overlay?.tools ?? base.tools,
};
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
