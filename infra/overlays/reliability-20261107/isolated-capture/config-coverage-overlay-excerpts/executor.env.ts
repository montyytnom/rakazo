// Overlay executor.ts env reads (assist / schedule / approval). Source semantics, not name guessing.
export function overlayExecutorEnvCites(env: NodeJS.ProcessEnv = process.env): void {
  void (process.env.RAKAZO_ASSIST_PROMPT !== "0");
  if (process.env.RAKAZO_ASSIST_PROMPT === "0") return;
  const disabledRaw = process.env.RAKAZO_ASSIST_DEFAULT_DISABLED_TOOLS;
  void disabledRaw;
  if (process.env.RAKAZO_ASSIST_STABLE_PREFIX === "0") return;
  void (process.env.RAKAZO_ASSIST_PROMPT === "0");
  if (process.env.RAKAZO_ASSIST_SCHEDULE_GUARD === "0") return;
  void (process.env.RAKAZO_ASSIST_SCHEDULE_GUARD !== "0" && process.env.RAKAZO_DEFAULT_TIMEZONE?.trim());
  const tz = process.env.RAKAZO_DEFAULT_TIMEZONE?.trim();
  void tz;
  if (process.env.RAKAZO_ALWAYS_OVERRIDE?.trim() === "0") return;
  void (process.env.RAKAZO_APPROVAL_RACE_FIX?.trim() !== "0");
  if (process.env.RAKAZO_ASSIST_HARNESS === "0") return;
  const dedupe = process.env.RAKAZO_DEDUPE_FINAL_POSTS?.trim();
  void dedupe;
  void env;
}
