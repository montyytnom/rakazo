import {
  captureBuiltinToolsJson,
  captureCallLimits,
  captureOverlayToolNames,
  reconstructOfflinePhases,
} from "../packages/adapters/src/capture-harness.ts";

const overlayRoot = process.argv[2];
const base = captureBuiltinToolsJson();
const limits = captureCallLimits();
const overlayNames = await captureOverlayToolNames(overlayRoot);
const phases = reconstructOfflinePhases({
  apiToolNames: overlayNames?.api ?? [],
  workerToolNames: overlayNames?.worker ?? [],
  limits,
  baseTools: base.tools,
});
const payload = {
  label: "code-derived-not-captured",
  kind: phases.kind,
  productionCapture: false,
  productionLiveCapture: phases.productionLiveCapture,
  thinkingUnchanged: true,
  baseToolCount: base.tools.length,
  limits,
  overlayWorkerToolCount: overlayNames?.worker?.length ?? null,
  overlayApiToolCount: overlayNames?.api?.length ?? null,
  apiWorkerNameDelta: phases.apiWorkerNameDelta,
  phases: {
    first: { toolCount: phases.phases.first.tools.length, params: limits },
    postbrowser: { toolCount: phases.phases.postbrowser.tools.length, params: limits },
    "guard-final": { toolCount: phases.phases["guard-final"].tools.length, params: limits },
  },
};
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
