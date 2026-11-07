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
  /** Skip labelled-prose harvest (user envelopes, untrusted page blobs). */
  skipLabeledText?: boolean;
  /** Tool name when the walked value is that tool's args or result. */
  toolName?: string;
};

/** Tool-declared / JSON secret fields. Values are withheld regardless of shape. */
export const STRUCTURED_SECRET_KEY =
  /^(password|passwd|pwd|secret|otp|pin|temporaryPassword|newPassword|oldPassword|currentPassword|generatedPassword)$/i;

/**
 * Per-tool field contract. `secret` is not always a value: browser_act
 * fill_secret uses it as the saved-login NAME. add_mcp_server.secret is a token.
 */
export function structuredFieldRole(
  key: string,
  record: Record<string, unknown>,
  toolName?: string,
): "value" | "name" | "none" {
  if (/^secret$/i.test(key)) {
    if (String(record.kind ?? "") === "fill_secret") return "name";
    if (toolName === "browser_act") return "name";
    if (toolName === "add_mcp_server") return "value";
  }
  if (!STRUCTURED_SECRET_KEY.test(key)) return "none";
  return "value";
}

const PASSWORD_KEY = STRUCTURED_SECRET_KEY;
const GENERATED_PASSWORD_SOURCE =
  String.raw`\b(?:temporary password|new password|generated password|old password|current password|temp(?:orary)? pw)\s*[:=]\s*["']{0,2}([^\s"'*<>]+)`;
/**
 * History fallback only. Bare `password through` is not a secret. `pin:` / `otp:`
 * in untrusted page text is not metadata and must not harvest.
 */
const HISTORY_LABELED_VALUE = new RegExp(
  String.raw`\b(?:password|passwd|pwd)(?:\s*\*\*)?(?:\s*[:|=*]+\s*|\s+is\s+|\s+was\s+)\s*["']{0,2}([^\s"'*<>]+)`,
  "gi",
);
const JSON_LABELED =
  /"(?:password|passwd|pwd|secret|otp|pin|temporaryPassword|newPassword|oldPassword|currentPassword)"\s*:\s*"([^"]+)"/gi;
const STOP_WORDS = new Set(
  [
    "password",
    "reset",
    "successful",
    "required",
    "field",
    "fields",
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
    "through",
    "values",
    "placeholders",
    "change",
    "again",
    "using",
    "never",
    "only",
    "saved",
    "generate",
    "request",
    "login",
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

/** Untrusted page blobs: labelled "new password: X" is not structured provenance. */
export const UNTRUSTED_PAGE_KEYS: ReadonlySet<string> = new Set([
  "tree",
  "header",
  "title",
  "url",
  "html",
  "snapshot",
]);

const TURN_CONTEXT_BLOCK = /<turn_context\b[^>]*>[\s\S]*?(<\/turn_context>|$)/gi;

/** Production turn_context is embedded in the user envelope, not a JSON key. */
export function stripEmbeddedTurnContext(text: string): string {
  return text.replace(TURN_CONTEXT_BLOCK, " ");
}

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

function isUntrustedPageShape(value: unknown): boolean {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;
    try {
      return isUntrustedPageShape(JSON.parse(trimmed));
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) return value.some(isUntrustedPageShape);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return "tree" in record || "html" in record || "snapshot" in record;
}

export function isStructuredSecretKey(key: string): boolean {
  return STRUCTURED_SECRET_KEY.test(key);
}

export function isWithheldMarker(value: string): boolean {
  return /^\[(withheld|redacted)/i.test(value.trim());
}

/** Any nonempty structured-field value is a secret, including hunter / 1234 / item-1. */
export function isStructuredSecretValue(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && !isWithheldMarker(trimmed);
}

/**
 * Shape heuristic for GLOBAL replace of labeled-history values only.
 * Not an authority to mark refs/SKUs as secrets, and not required for
 * structured fields or SecretStore known values.
 */
export function looksLikeSecretValue(value: string): boolean {
  const trimmed = value.trim();
  if (!looksLikeLabeledSecret(trimmed)) return false;
  if (isStructuredIdentifier(trimmed)) return false;
  const hasLower = /[a-z]/.test(trimmed);
  const hasUpper = /[A-Z]/.test(trimmed);
  const hasDigit = /\d/.test(trimmed);
  const hasSpecial = /[^A-Za-z0-9_-]/.test(trimmed);
  return hasLower && hasUpper && hasDigit && hasSpecial;
}

export function hasSecretValueShape(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const hasLetter = /[A-Za-z]/.test(trimmed);
  const hasDigit = /\d/.test(trimmed);
  const hasSpecial = /[^A-Za-z0-9_-]/.test(trimmed);
  return hasLetter && (hasDigit || hasSpecial);
}

function isStructuredIdentifier(value: string): boolean {
  return /^(?:[a-z][a-z0-9]*-)+[a-z0-9]+$/.test(value);
}

export function looksLikeLabeledSecret(value: string): boolean {
  const trimmed = value.trim().replace(/[.,;)}>\]]+$/, "");
  if (trimmed.length < 1 || trimmed.length > 128) return false;
  if (/\s/.test(trimmed)) return false;
  if (/^op-[a-f0-9]{8}$/i.test(trimmed)) return false;
  if (/^sha256:[a-f0-9]{64}$/i.test(trimmed)) return false;
  if (trimmed.startsWith("v2:")) return false;
  if (/^https?:/i.test(trimmed)) return false;
  if (/^\[(withheld|redacted)/i.test(trimmed)) return false;
  if (/^(withheld|redacted)\]?$/i.test(trimmed)) return false;
  if (STOP_WORDS.has(trimmed.toLowerCase())) return false;
  return true;
}

/** Global-replace only unique-looking values, never common words or hyphenated ids. */
export function shouldGlobalReplaceSecret(value: string): boolean {
  const trimmed = value.trim().replace(/[.,;)}>\]]+$/, "");
  if (!looksLikeLabeledSecret(trimmed)) return false;
  if (trimmed.length < 6) return false;
  if (isStructuredIdentifier(trimmed)) return false;
  if (STOP_WORDS.has(trimmed.toLowerCase())) return false;
  return hasSecretValueShape(trimmed);
}

export function redactProtectedTree(value: unknown, extras: readonly string[] = []): unknown {
  const harvested = harvestSecretsFromUnknown(value, [], undefined);
  const banned = new Set([...extras.filter(Boolean), ...harvested]);
  return walk(value, banned, undefined);
}

export function extractGeneratedPasswords(text: string): string[] {
  return harvestLabeledValuesFromText(text);
}

export function extractGeneratedPassword(text: string): string | undefined {
  return extractGeneratedPasswords(text)[0];
}

function addCandidate(found: string[], raw: string | undefined, globalOnly: boolean): void {
  if (!raw) return;
  const candidate = raw.replace(/^["']+|["']+$/g, "").replace(/[.,;)}>\]]+$/, "");
  if (!looksLikeLabeledSecret(candidate)) return;
  if (globalOnly && !shouldGlobalReplaceSecret(candidate)) return;
  if (!found.includes(candidate)) found.push(candidate);
}

function harvestLabeledValuesFromText(text: string, globalOnly = false): string[] {
  const found: string[] = [];
  const generated = new RegExp(GENERATED_PASSWORD_SOURCE, "gi");
  for (const match of text.matchAll(generated)) addCandidate(found, match[1], globalOnly);
  const labeled = new RegExp(HISTORY_LABELED_VALUE.source, "gi");
  for (const match of text.matchAll(labeled)) addCandidate(found, match[1], globalOnly);
  const markdown = new RegExp(
    String.raw`\b(?:temporary password|new password|generated password|old password|current password|password)(?:\s*\*\*)?(?:\s*[:|=*]+\s*|\s+)\s*\x60([^\x60]+)\x60`,
    "gi",
  );
  for (const match of text.matchAll(markdown)) addCandidate(found, match[1], globalOnly);
  const jsonLabeled = new RegExp(JSON_LABELED.source, "gi");
  for (const match of text.matchAll(jsonLabeled)) addCandidate(found, match[1], globalOnly);
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      harvestSecretsFromUnknown(JSON.parse(trimmed), found, undefined, globalOnly);
    } catch {
      // not JSON
    }
  }
  for (const fence of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const body = fence[1]?.trim() ?? "";
    if (!body.startsWith("{") && !body.startsWith("[")) continue;
    try {
      harvestSecretsFromUnknown(JSON.parse(body), found, undefined, globalOnly);
    } catch {
      // not JSON
    }
  }
  return found;
}

/**
 * Labeled-history harvest for global replace. Dictionary/numeric values in prose
 * are not listed. Structured JSON fields still join the known-echo set via
 * harvestSecretsFromUnknown (any shape, context-safe replace).
 */
export function harvestSecretsFromText(text: string): string[] {
  return harvestLabeledValuesFromText(text, true);
}

/** Structured-field / SecretStore echo membership: any shape, not tiny tokens. */
export function isKnownEchoSecret(value: string): boolean {
  const trimmed = value.trim();
  if (!isStructuredSecretValue(trimmed)) return false;
  if (STOP_WORDS.has(trimmed.toLowerCase())) return false;
  if (trimmed.length < 4) return false;
  return true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SECRET_SPAN_HINT =
  /\b(?:password|passwd|pwd|pin|otp|code|secret|token|login|logged|signed)\b|\blog(?:ged)?\s+in\b/i;

function replaceTokenNearSecretSpan(text: string, secret: string): string {
  if (!text.includes(secret)) return text;
  const pattern = new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(secret)}(?![A-Za-z0-9_-])`, "g");
  return text.replace(pattern, (match, offset: number) => {
    const start = Math.max(0, offset - 32);
    const window = text.slice(start, offset + match.length + 32);
    return SECRET_SPAN_HINT.test(window) ? "[withheld]" : match;
  });
}

/**
 * Context-safe known-secret replace. Unique mixed-shape secrets use substring
 * (they may be glued). Common numeric/dictionary values use token bounds and
 * only replace next to a secret-span hint, so pin 2026 does not erase a date.
 */
export function replaceKnownSecret(text: string, secret: string): string {
  if (!secret) return text;
  if (!shouldGlobalReplaceSecret(secret)) {
    return replaceTokenNearSecretSpan(text, secret);
  }
  let next = text.split(secret).join("[withheld]");
  next = next.replace(new RegExp(escapeRegExp(secret), "gi"), "[withheld]");
  if (secret.length >= 8) {
    const keep = Math.max(6, secret.length - 2);
    const prefix = secret.slice(0, keep);
    const suffix = secret.slice(-keep);
    next = next.split(prefix).join("[withheld]");
    if (suffix !== prefix) next = next.split(suffix).join("[withheld]");
  }
  const spaced = secret.split("").map(escapeRegExp).join("\\s*");
  next = next.replace(new RegExp(spaced, "g"), "[withheld]");
  return next;
}

export function redactLabeledSecretSpans(text: string): string {
  let next = text;
  const replaceSpan = (pattern: RegExp) => {
    next = next.replace(new RegExp(pattern.source, "gi"), (full, value: string) => {
      const candidate = value.replace(/[.,;)}>\]]+$/, "");
      if (STOP_WORDS.has(candidate.toLowerCase())) return full;
      if (isWithheldMarker(candidate)) return full;
      if (candidate.length < 4 && !/\d/.test(candidate)) return full;
      if (!looksLikeLabeledSecret(candidate) && !isStructuredSecretValue(candidate)) return full;
      return full.replace(value, "[withheld]");
    });
  };
  replaceSpan(new RegExp(GENERATED_PASSWORD_SOURCE, "gi"));
  replaceSpan(new RegExp(HISTORY_LABELED_VALUE.source, "gi"));
  replaceSpan(JSON_LABELED);
  return next;
}

export function harvestSecretsFromUnknown(
  value: unknown,
  into: string[] = [],
  options?: HarvestSecretsOptions,
  globalOnly = true,
): string[] {
  if (typeof value === "string") {
    const source = stripEmbeddedTurnContext(value);
    const trimmed = source.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        harvestSecretsFromUnknown(
          parsed,
          into,
          { ...options, skipLabeledText: Boolean(options?.skipLabeledText) || isUntrustedPageShape(parsed) },
          globalOnly,
        );
        return into;
      } catch {
        // not JSON — fall through
      }
    }
    if (options?.skipLabeledText) return into;
    for (const secret of harvestLabeledValuesFromText(source, globalOnly)) {
      if (!into.includes(secret)) into.push(secret);
    }
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) harvestSecretsFromUnknown(item, into, options, globalOnly);
    return into;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (options?.skipSystemRole && record.role === "system") return into;
    if (record.role === "user") {
      harvestSecretsFromUnknown(record.content, into, { ...options, skipLabeledText: true }, globalOnly);
      return into;
    }
    for (const [key, item] of Object.entries(record)) {
      if (options?.skipKeys?.has(key)) continue;
      if (UNTRUSTED_PAGE_KEYS.has(key) && typeof item === "string" && isUntrustedPageShape(record)) {
        continue;
      }
      if (record.type === "text" && key === "text" && typeof item === "string") {
        harvestSecretsFromUnknown(
          item,
          into,
          {
            ...options,
            skipLabeledText: Boolean(options?.skipLabeledText) || isUntrustedPageShape(item),
          },
          globalOnly,
        );
        continue;
      }
      const role = structuredFieldRole(key, record, options?.toolName);
      if (role === "name") continue;
      if (role === "value" && typeof item === "string") {
        if (isKnownEchoSecret(item) && !into.includes(item)) into.push(item);
        continue;
      }
      harvestSecretsFromUnknown(item, into, options, globalOnly);
    }
  }
  return into;
}

/** Args+result harvest using the tool's field contract, not a generic `secret` key. */
export function harvestSecretsFromTool(
  toolName: string,
  args: unknown,
  result: unknown,
): string[] {
  const found: string[] = [];
  const skipLabeled = /^(browser_|computer_observe)/.test(toolName);
  harvestSecretsFromUnknown(args, found, { toolName });
  harvestSecretsFromUnknown(result, found, {
    toolName,
    skipLabeledText: skipLabeled,
  });
  return found;
}

export function harvestSecretsFromRequestContext(value: unknown, into: string[] = []): string[] {
  return harvestSecretsFromUnknown(value, into, {
    skipKeys: REQUEST_HARVEST_SKIP_KEYS,
    skipSystemRole: true,
  });
}

/**
 * Replace caller-supplied known secrets (SecretStore extras + structured-field
 * values of any shape). Visibility is context-safe, not shape-gated.
 */
export function stripSecretEchoes(
  text: string,
  secrets: readonly string[],
): { text: string; echoed: boolean } {
  let next = text;
  let echoed = false;
  for (const secret of secrets) {
    const replaced = replaceKnownSecret(next, secret);
    if (replaced === next) continue;
    echoed = true;
    next = replaced;
  }
  return { text: next, echoed };
}

export function stripSecretsFromUnknown(value: unknown, secrets: readonly string[]): unknown {
  return walk(value, new Set(secrets.filter(Boolean)), undefined, "echo-and-label");
}

export function stripSecretRequestContext<T>(ctx: T): T {
  const secrets = harvestSecretsFromRequestContext(ctx);
  const redacted = walk(ctx, new Set(secrets), {
    skipKeys: REQUEST_HARVEST_SKIP_KEYS,
    skipSystemRole: true,
  }, "request");
  if (redacted === ctx) return ctx;
  return redacted as T;
}

export function stripSecretTranscriptMessages<T>(messages: T[]): T[] {
  const secrets = harvestSecretsFromUnknown(messages, [], { skipSystemRole: true });
  const redacted = walk(messages, new Set(secrets), { skipSystemRole: true }, "echo-and-label");
  if (redacted === messages) return messages;
  return redacted as T[];
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

type WalkMode = "echo-only" | "echo-and-label" | "request";

function walk(
  value: unknown,
  banned: Set<string>,
  options: HarvestSecretsOptions | undefined,
  mode: WalkMode = "echo-and-label",
): unknown {
  if (typeof value === "string") {
    if (banned.has(value)) return "[withheld]";
    let next = value;
    for (const secret of banned) next = replaceKnownSecret(next, secret);
    if (mode !== "echo-only") {
      next = redactLabeledSecretSpans(next);
      for (const generated of harvestSecretsFromText(next)) {
        next = replaceKnownSecret(next, generated);
      }
    }
    return next;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const next = walk(item, banned, options, mode);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? items : value;
  }
  if (value && typeof value === "object") {
    if (value instanceof Date) return value;
    const record = value as Record<string, unknown>;
    if (options?.skipSystemRole && record.role === "system") {
      // No-rewrite: system-role definition text is identity.
      return value;
    }
    if (record.role === "user") {
      return walkObject(record, banned, { ...options, skipLabeledText: true }, "echo-only");
    }
    return walkObject(record, banned, options, mode);
  }
  return value;
}

function walkObject(
  record: Record<string, unknown>,
  banned: Set<string>,
  options: HarvestSecretsOptions | undefined,
  mode: WalkMode,
): unknown {
  let changed = false;
  const entries = Object.entries(record).map(([key, item]) => {
    if (options?.skipKeys?.has(key) || (mode === "request" && REQUEST_HARVEST_SKIP_KEYS.has(key))) {
      // No-rewrite: definition trees stay byte-identical even when a known
      // secret from messages also appears in system/tools/turn_context.
      return [key, item];
    }
    const role = structuredFieldRole(key, record, options?.toolName);
    if (role === "name") {
      return [key, item];
    }
    if (role === "value" && typeof item === "string" && isStructuredSecretValue(item)) {
      changed = true;
      return [key, "[withheld]"];
    }
    const next = walk(item, banned, options, mode);
    if (next !== item) changed = true;
    return [key, next];
  });
  return changed ? Object.fromEntries(entries) : record;
}
