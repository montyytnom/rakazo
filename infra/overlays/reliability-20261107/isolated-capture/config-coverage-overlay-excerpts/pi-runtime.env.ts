const envDefaultModel = process.env.PI_DEFAULT_MODEL?.trim();
const envDefaultProvider = process.env.PI_DEFAULT_PROVIDER?.trim() || "openrouter";
void envDefaultModel;
void envDefaultProvider;
void (process.env.OPENROUTER_API_KEY);
if (process.env.RAKAZO_ASSIST_HARNESS === "0") {
  void 0;
}
const n = Number(process.env.RAKAZO_ASSIST_PROVIDER_RETRIES ?? "2");
const warnAtRaw = Number(process.env.RAKAZO_ASSIST_SAME_ERROR_WARN ?? "3");
void n;
void warnAtRaw;
export function maxToolCallsPerTurn(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MAX_TOOL_CALLS_PER_TURN?.trim();
  return raw ? Number(raw) : 0;
}
export function subagentSteeringEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.RAKAZO_SUBAGENT_STEERING?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
export function runtidyGuardSummaryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.RAKAZO_GUARD_FINAL_SUMMARY?.trim();
  return raw !== undefined && raw !== "" && raw !== "0" && raw.toLowerCase() !== "false";
}
export function runtidyGuardSummaryTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.RAKAZO_GUARD_SUMMARY_TIMEOUT_MS ?? "90000");
  return Number.isFinite(raw) && raw >= 5_000 ? raw : 90_000;
}
export function streamRetryEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.STREAMRETRY_ENABLED ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}
