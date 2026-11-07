import { runIsolatedCaptureCli } from "../packages/adapters/src/isolated-capture.ts";

await runIsolatedCaptureCli(process.argv.slice(2));
