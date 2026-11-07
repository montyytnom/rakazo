import { pathToFileURL } from "node:url";

const adapters = process.argv[2];
if (!adapters) {
  throw new Error("adapters src path required");
}
const mod = await import(pathToFileURL(`${adapters}/isolated-capture.ts`).href);
process.stdout.write(`${JSON.stringify(mod.secretStoreCapabilityReport(), null, 2)}\n`);
