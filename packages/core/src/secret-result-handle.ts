import { createHash } from "node:crypto";

export type ProtectedResultStatus = "issued" | "verified" | "delivered" | "withheld";

export type ProtectedResultHandle = {
  handle: string;
  hash: string;
  createdAt: string;
  status: ProtectedResultStatus;
};

export type HarvestSecretsOptions = {
  /** Subtrees that must never be mined for secrets (system prompt, tool schemas, turn context). */
  skipKeys?: ReadonlySet<string>;
  /** Skip chat messages whose role is system. */
  skipSystemRole?: boolean;
};

const PASSWORD_KEY = /^(password|passwd|pwd|temporaryPassword|newPassword|secret|otp)$/i;
const LABEL_SOURCE =
  String.raw`(?:temporary\s+password|new\s+password|generated\s+password|old\s+password|current\s+password|password|passwd|pwd|secret|otp|pin)`;
/**
 * Labeled harvest needs an explicit delimiter (`:`, `=`, `is`, `was`).
 * Bare whitespace after a trigger ("password through", "secret values") is not a secret.
 */
const LABELED_VALUE = new RegExp(
  String.raw`\b${LABEL_SOURCE}(?:\s*\*\*)?(?:\s*[:|=*]+\s*|\s+is\s+|\s+was\s+)\s*["']{0,2}([^\s"'*<>]+)`,
  "gi",
);
const JSON_LABELED =
  /"(?:password|passwd|pwd|secret|otp|pin|temporaryPassword|newPassword|oldPassword|currentPassword)"\s*:\s*"([^"]+)"/gi;
const GENERATED_PASSWORD_SOURCE =
  String.raw`\b(?:temporary password|new password|generated password|old password|current password)\s*[:=]\s*(\S+)`;
const STOP_WORDS = new Set(
  [
    "password",
    "reset",
    "successful",
    "required",
    "field",
    "complete",
    "completed",
    "true",
    "false",
    "null",
    "undefined",
    "withheld",
    "redacted",
    "protected",
    "result",
    "handle",
    "status",
  ].map((word) => word.toLowerCase()),
);

/** Request fields that are model-facing definitions, not secret sources. */
export const REQUEST_HARVEST_SKIP_KEYS: ReadonlySet<string> = new Set([
  "systemPrompt",
  "system",
  "tools",
  "turn_context",
  "turnContext",
  "toolDefinitions",
  "tool_choice",
]);

export function hashSecret(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function issueProtectedResult(
  plaintext: string,
  at: Date = new Date(),
  status: ProtectedResultStatus = "issued",
): ProtectedResultHandle {
  const hash = hashSecret(plaintext);
  return {
    handle: `op-${hash.slice(7, 15)}`,
    hash,
    createdAt: at.toISOString(),
    status,
  };
}

export function protectedResultNote(handle: ProtectedResultHandle): string {
  return `Protected result ${handle.handle} at ${handle.createdAt}, ${handle.hash}, status ${handle.status} — value withheld.`;
}

export function looksLikeSecretValue(value: string): boolean {
  const trimmed = value.trim();
  if (!looksLikeLabeledSecret(trimmed)) return false;
  // Hyphenated ids (item-1, SKU-A1b2) share mixed case + digits with generated
  // passwords. Unlabeled withhold requires a special that is not hyphen/underscore.
  if (isStructuredIdentifier(trimmed)) return false;
  const hasLower = /[a-z]/.test(trimmed);
  const hasUpper = /[A-Z]/.test(trimmed);
  const hasDigit = /\d/.test(trimmed);
  const hasSpecial = /[^A-Za-z0-9_-]/.test(trimmed);
  return hasLower && hasUpper && hasDigit && hasSpecial;
}

/** Prose harvest: a letter plus a digit or special. Dictionary words are not secrets. */
export function hasSecretValueShape(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const hasLetter = /[A-Za-z]/.test(trimmed);
  const hasDigit = /\d/.test(trimmed);
  const hasSpecial = /[^A-Za-z0-9]/.test(trimmed);
  return hasLetter && (hasDigit || hasSpecial);
}

/** Run/thread/group/tool ids: lowercase tokens joined by hyphens, optional trailing digits. */
function isStructuredIdentifier(value: string): boolean {
  return /^(?:[a-z][a-z0-9]*-)+[a-z0-9]+$/.test(value);
}

export function looksLikeLabeledSecret(value: string): boolean {
  const trimmed = value.trim().replace(/[.,;)}>\]]+$/, "");
  if (trimmed.length < 6 || trimmed.length > 128) return false;
  if (/\s/.test(trimmed)) return false;
  if (/^op-[a-f0-9]{8}$/i.test(trimmed)) return false;
  if (/^sha256:[a-f0-9]{64}$/i.test(trimmed)) return false;
  if (trimmed.startsWith("v2:")) return false;
  if (/^https?:/i.test(trimmed)) return false;
  // Trailing-`]` trim used to turn `[withheld]` into `[withheld` and reharvest.
  if (/^\[(withheld|redacted)/i.test(trimmed)) return false;
  if (/^(withheld|redacted)\]?$/i.test(trimmed)) return false;
  if (STOP_WORDS.has(trimmed.toLowerCase())) return false;
  return true;
}

export function redactProtectedTree(value: unknown, extras: readonly string[] = []): unknown {
  const banned = new Set(extras.filter(Boolean));
  return walk(value, banned);
}

export function extractGeneratedPasswords(text: string): string[] {
  return harvestSecretsFromText(text);
}

export function extractGeneratedPassword(text: string): string | undefined {
  return extractGeneratedPasswords(text)[0];
}

export function harvestSecretsFromText(text: string): string[] {
  const found: string[] = [];
  const add = (raw: string | undefined, requireShape: boolean) => {
    if (!raw) return;
    const candidate = raw.replace(/[.,;)}>\]]+$/, "");
    if (!looksLikeLabeledSecret(candidate)) return;
    if (requireShape && !hasSecretValueShape(candidate)) return;
    if (!found.includes(candidate)) found.push(candidate);
  };
  const labeled = new RegExp(LABELED_VALUE.source, "gi");
  for (const match of text.matchAll(labeled)) add(match[1], true);
  const markdown = new RegExp(
    String.raw`\b${LABEL_SOURCE}(?:\s*\*\*)?(?:\s*[:|=*]+\s*|\s+)\s*\x60([^\x60]+)\x60`,
    "gi",
  );
  for (const match of text.matchAll(markdown)) add(match[1], true);
  const jsonLabeled = new RegExp(JSON_LABELED.source, "gi");
  for (const match of text.matchAll(jsonLabeled)) add(match[1], false);
  const generated = new RegExp(GENERATED_PASSWORD_SOURCE, "gi");
  for (const match of text.matchAll(generated)) add(match[1], true);
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      harvestSecretsFromUnknown(JSON.parse(trimmed), found);
    } catch {
      // not JSON
    }
  }
  for (const fence of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const body = fence[1]?.trim() ?? "";
    if (!body.startsWith("{") && !body.startsWith("[")) continue;
    try {
      harvestSecretsFromUnknown(JSON.parse(body), found);
    } catch {
      // not JSON
    }
  }
  return found;
}

export function harvestSecretsFromUnknown(
  value: unknown,
  into: string[] = [],
  options?: HarvestSecretsOptions,
): string[] {
  if (typeof value === "string") {
    for (const secret of harvestSecretsFromText(value)) {
      if (!into.includes(secret)) into.push(secret);
    }
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) harvestSecretsFromUnknown(item, into, options);
    return into;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (options?.skipSystemRole && record.role === "system") return into;
    for (const [key, item] of Object.entries(record)) {
      if (options?.skipKeys?.has(key)) continue;
      if (PASSWORD_KEY.test(key) && typeof item === "string") {
        if (looksLikeLabeledSecret(item) && !into.includes(item)) into.push(item);
        continue;
      }
      harvestSecretsFromUnknown(item, into, options);
    }
  }
  return into;
}

/** Harvest only from transcript/tool results, never from system, tool defs, or turn context. */
export function harvestSecretsFromRequestContext(value: unknown, into: string[] = []): string[] {
  return harvestSecretsFromUnknown(value, into, {
    skipKeys: REQUEST_HARVEST_SKIP_KEYS,
    skipSystemRole: true,
  });
}

export function stripSecretEchoes(
  text: string,
  secrets: readonly string[],
): { text: string; echoed: boolean } {
  let next = text;
  let echoed = false;
  for (const secret of secrets) {
    if (!secret || !next.includes(secret)) continue;
    echoed = true;
    next = next.split(secret).join("[withheld]");
  }
  return { text: next, echoed };
}

/** Deep copy used to withhold harvested secrets from model-bound transcripts. */
export function stripSecretsFromUnknown(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return stripSecretEchoes(value, secrets).text;
  if (Array.isArray(value)) return value.map((item) => stripSecretsFromUnknown(item, secrets));
  if (value && typeof value === "object") {
    if (value instanceof Date) return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        stripSecretsFromUnknown(item, secrets),
      ]),
    );
  }
  return value;
}

/**
 * Production request strip. Identity (same reference) when no structured secrets
 * were harvested. Callers must not harvest system/tools/turn_context.
 */
export function stripSecretRequestContext<T>(ctx: T): T {
  const secrets = harvestSecretsFromRequestContext(ctx);
  if (secrets.length === 0) return ctx;
  return stripSecretsFromUnknown(ctx, secrets) as T;
}

export function stripSecretTranscriptMessages<T>(messages: T[]): T[] {
  const secrets = harvestSecretsFromUnknown(messages, [], { skipSystemRole: true });
  if (secrets.length === 0) return messages;
  return stripSecretsFromUnknown(messages, secrets) as T[];
}

export function secretsFromPriorAssistantText(texts: readonly string[]): string[] {
  const found: string[] = [];
  for (const text of texts) harvestSecretsFromUnknown(text, found);
  return found;
}

export function redactThrown(error: unknown, secrets: readonly string[]): Error {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  const next = new Error(stripSecretEchoes(message, secrets).text);
  next.name = error instanceof Error ? error.name : "Error";
  if (stack) next.stack = stripSecretEchoes(stack, secrets).text;
  return next;
}

function walk(value: unknown, banned: Set<string>): unknown {
  if (typeof value === "string") {
    if (banned.has(value) || looksLikeSecretValue(value)) return "[withheld]";
    let next = value;
    for (const secret of banned) {
      if (secret && next.includes(secret)) next = next.split(secret).join("[withheld]");
    }
    for (const generated of harvestSecretsFromText(next)) {
      next = next.split(generated).join("[withheld]");
    }
    return next;
  }
  if (Array.isArray(value)) return value.map((item) => walk(item, banned));
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      if (PASSWORD_KEY.test(key) && typeof item === "string") return [key, "[withheld]"];
      return [key, walk(item, banned)];
    });
    return Object.fromEntries(entries);
  }
  return value;
}
