export function applyThinkingPolicy(body: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): void {
  const off =
    body.reasoning_effort === "none" ||
    (env.RAKAZO_FAST_COMPUTER_STEPS === "1");
  if (!off) return;
  const kwargs = (body.chat_template_kwargs ?? {}) as Record<string, unknown>;
  kwargs.enable_thinking = false;
  delete kwargs.medium_effort;
  body.chat_template_kwargs = kwargs;
}
export function applyThinkingBudget(body: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.RAKAZO_THINKING_BUDGET?.trim() ?? "";
  if (!/^[1-9][0-9]{0,5}$/.test(raw)) return false;
  const models = (env.RAKAZO_THINKING_BUDGET_MODELS ?? "").split(",");
  void models;
  body.thinking_budget = Number(raw);
  return true;
}
