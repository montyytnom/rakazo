function botdirSwitch(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[name]?.trim();
  return raw !== undefined && raw !== "" && raw !== "0" && raw.toLowerCase() !== "false";
}
function botdirNumber(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env[name]?.trim() || "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
export function botdirCardsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return botdirSwitch("RAKAZO_BOT_DIRECTORY_CARDS", env);
}
export function botdirWaitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return botdirSwitch("RAKAZO_BOT_ASK_WAIT", env);
}
export function botdirWaitMaxMs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.floor(botdirNumber("RAKAZO_BOT_ASK_WAIT_MAX_S", 600, env) * 1000);
}
export function botdirWaitDefaultMs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.min(Math.floor(botdirNumber("RAKAZO_BOT_ASK_WAIT_DEFAULT_S", 240, env) * 1000), botdirWaitMaxMs(env));
}
export function botdirWaitMaxHop(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RAKAZO_BOT_ASK_WAIT_MAX_HOP?.trim();
  const parsed = Number(raw);
  return raw !== undefined && raw !== "" && Number.isInteger(parsed) && parsed >= 0 ? parsed : 1;
}
export function botdirBudget(env: NodeJS.ProcessEnv = process.env): number {
  return botdirNumber("RAKAZO_BOT_DIRECTORY_MAX_CHARS", 3000, env);
}
