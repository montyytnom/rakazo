import { createHash } from "node:crypto";
import { stableJsonValue } from "./approval-effect-key.js";

export type IrreversibleClass = "password-reset" | "send" | "purchase" | "secret-generate";

export type IrreversibleClassification = {
  class: IrreversibleClass;
  subject: string;
};

const CONTINUE_NUDGE = /^(continue|try again|retry|again)$/i;
const SEND_NAME =
  /(?:^|_|__)(send_mail|send_message|messages_send|mac_messages_send|sms_send|send_sms|send_text)(?:$|_)/i;
const PURCHASE_NAME = /place[_-]?order|submit[_-]?order|confirm[_-]?purchase/i;
const RESET_LABEL = /reset password|^reset$/i;
const ORDER_LABEL = /place your order|place order|buy now|submit order/i;

export function isContinueNudge(text: string): boolean {
  return CONTINUE_NUDGE.test(
    text
      .trim()
      .replace(/[.!]+$/g, "")
      .trim(),
  );
}

export function irreversibleIntentId(userText: string, priorIntentId?: string): string {
  if (priorIntentId && isContinueNudge(userText)) return priorIntentId;
  return digest(userText.trim());
}

export function resolveTurnIntentId(
  currentUserText: string,
  priorUserTexts: readonly string[] = [],
): string {
  if (!isContinueNudge(currentUserText)) return irreversibleIntentId(currentUserText);
  for (let index = priorUserTexts.length - 1; index >= 0; index -= 1) {
    const text = priorUserTexts[index]?.trim() ?? "";
    if (text && !isContinueNudge(text)) return irreversibleIntentId(text);
  }
  return irreversibleIntentId(currentUserText);
}

export function innerExecutedToolName(name: string, args: Record<string, unknown>): string {
  if (name === "installed_execute_tool" || name === "COMPOSIO_MULTI_EXECUTE_TOOL") {
    const inner = args.name ?? args.tool_name ?? args.tool;
    if (typeof inner === "string" && inner.trim()) return inner.trim();
  }
  return name;
}

export function classifyIrreversibleTool(
  name: string,
  args: Record<string, unknown> = {},
): IrreversibleClassification | null {
  const tool = innerExecutedToolName(name, args);
  if (name === "request_secret" && args.generate === true) {
    return {
      class: "secret-generate",
      subject: String(args.destination ?? args.origin ?? "secret"),
    };
  }
  if (SEND_NAME.test(tool)) {
    return { class: "send", subject: sendSubject(args) };
  }
  if (PURCHASE_NAME.test(tool)) {
    return { class: "purchase", subject: String(args.orderId ?? args.url ?? tool) };
  }
  return null;
}

export function classifyBrowserMutation(
  labels: readonly string[],
  pageUrl = "",
): IrreversibleClassification | null {
  if (labels.some((label) => RESET_LABEL.test(label.trim()))) {
    return { class: "password-reset", subject: pageSubject(pageUrl) };
  }
  if (labels.some((label) => ORDER_LABEL.test(label.trim()))) {
    return { class: "purchase", subject: pageSubject(pageUrl) };
  }
  return null;
}

export function threadIrreversibleEffectKey(input: {
  threadId: string;
  intentId: string;
  class: IrreversibleClass;
  subject: string;
}): string {
  return `irr:v1:${digest(
    stableJsonValue({
      threadId: input.threadId,
      intentId: input.intentId,
      class: input.class,
      subject: input.subject,
    }),
  )}`;
}

export function isThreadIrreversibleEffectKey(key: string): boolean {
  return /^irr:v1:[a-f0-9]{64}$/.test(key);
}

export function sameThreadIrreversibleOwner(input: {
  existingSpaceId: string;
  existingRequest: unknown;
  spaceId: string;
  threadId: string;
}): boolean {
  if (input.existingSpaceId !== input.spaceId) return false;
  const request = input.existingRequest;
  if (!request || typeof request !== "object" || Array.isArray(request)) return false;
  const threadId = (request as { threadId?: unknown }).threadId;
  return threadId === input.threadId;
}

export function irreversibleEffectRequest(
  classification: IrreversibleClassification,
  threadId: string,
  intentId: string,
  args: unknown,
): Record<string, unknown> {
  return {
    scope: "thread-intent",
    threadId,
    intentId,
    class: classification.class,
    subject: classification.subject,
    args,
  };
}

function sendSubject(args: Record<string, unknown>): string {
  const inner =
    args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
      ? (args.arguments as Record<string, unknown>)
      : args;
  const parts = [inner.to, inner.recipient, inner.handle, inner.phone, inner.contact, inner.subject]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  return parts.join("|") || "send";
}

function pageSubject(pageUrl: string): string {
  try {
    const url = new URL(pageUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return pageUrl || "page";
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
