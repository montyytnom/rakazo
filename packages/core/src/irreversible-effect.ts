import { createHash } from "node:crypto";
import { stableJsonValue } from "./approval-effect-key.js";

export type IrreversibleClass = "password-reset" | "send" | "purchase" | "secret-generate";

export type IrreversibleClassification = {
  class: IrreversibleClass;
  subject: string;
};

export type UserTurnRef = {
  id?: string | null;
  text: string;
};

export type TurnIntent = {
  intentId: string;
  authorized: boolean;
  sourceMessageId: string | null;
  fromNudge: boolean;
};

export const UNAUTHORIZED_IRREVERSIBLE =
  "This irreversible action is not bound to a live user message. Ask the user to repeat the request. Do not retry from a summary.";

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
  return digest(`unbound:${userText.trim()}`);
}

export function resolveTurnIntent(
  current: UserTurnRef,
  prior: readonly UserTurnRef[] = [],
): TurnIntent {
  if (!isContinueNudge(current.text)) {
    return bindTurn(current, false);
  }
  for (let index = prior.length - 1; index >= 0; index -= 1) {
    const turn = prior[index];
    const text = turn?.text?.trim() ?? "";
    if (!text || isContinueNudge(text)) continue;
    return bindTurn({ id: turn?.id, text }, true);
  }
  return {
    intentId: digest(`unbound-nudge:${current.text.trim()}`),
    authorized: false,
    sourceMessageId: null,
    fromNudge: true,
  };
}

export function resolveTurnIntentId(
  currentUserText: string,
  priorUserTexts: readonly string[] = [],
): string {
  return resolveTurnIntent(
    { text: currentUserText },
    priorUserTexts.map((text) => ({ text })),
  ).intentId;
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
  subject?: string;
}): string {
  void input.subject;
  return `irr:v1:${digest(
    stableJsonValue({
      threadId: input.threadId,
      intentId: input.intentId,
      class: input.class,
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
  intentId?: string;
}): boolean {
  if (input.existingSpaceId !== input.spaceId) return false;
  const request = input.existingRequest;
  if (!request || typeof request !== "object" || Array.isArray(request)) return false;
  const record = request as { threadId?: unknown; intentId?: unknown };
  if (record.threadId !== input.threadId) return false;
  if (input.intentId && record.intentId !== input.intentId) return false;
  return true;
}

export function irreversibleEffectRequest(
  classification: IrreversibleClassification,
  threadId: string,
  intentId: string,
  args: unknown,
  sourceMessageId?: string | null,
): Record<string, unknown> {
  return {
    scope: "thread-intent",
    threadId,
    intentId,
    sourceMessageId: sourceMessageId ?? null,
    class: classification.class,
    subject: classification.subject,
    args,
  };
}

function bindTurn(turn: UserTurnRef, fromNudge: boolean): TurnIntent {
  const id = turn.id?.trim() ?? "";
  if (id) {
    return {
      intentId: digest(`msg:${id}`),
      authorized: true,
      sourceMessageId: id,
      fromNudge,
    };
  }
  return {
    intentId: digest(`unbound:${turn.text.trim()}`),
    authorized: false,
    sourceMessageId: null,
    fromNudge,
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
