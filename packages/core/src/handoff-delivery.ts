export function intentDeliveryKey(sourceMessageId: string, intent: "result" | "status"): string {
  return `auto-outcome:${sourceMessageId}:${intent}`;
}

export function runDeliveryKey(runId: string, intent: "result" | "status"): string {
  return `auto-outcome:${runId}:${intent}`;
}

export function sameFinalText(left: string, right: string): boolean {
  return normalize(left) === normalize(right);
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
