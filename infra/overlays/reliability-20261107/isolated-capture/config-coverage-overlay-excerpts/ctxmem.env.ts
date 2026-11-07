export function ctxmemEnabled(): boolean {
  return process.env.RAKAZO_CTXMEM === "1";
}
export function ctxmemFactsEnabled(): boolean {
  return ctxmemEnabled() && process.env.RAKAZO_CTXMEM_FACTS !== "0";
}
export function todayIn(timeZone = process.env.RAKAZO_DEFAULT_TIMEZONE || "UTC"): string {
  return timeZone;
}
