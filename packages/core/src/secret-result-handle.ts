import { createHash } from "node:crypto";

export type ProtectedResultStatus = "issued" | "verified" | "delivered" | "withheld";

export type ProtectedResultHandle = {
  handle: string;
  hash: string;
  createdAt: string;
  status: ProtectedResultStatus;
};

const PASSWORD_KEY = /^(password|passwd|pwd|temporaryPassword|newPassword|secret|otp)$/i;
const LABEL_SOURCE =
  String.raw`(?:temporary\s+password|new\s+password|generated\s+password|old\s+password|current\s+password|password|passwd|pwd|secret|otp|pin)`;
const LABELED_VALUE = new RegExp(
  String.raw`\b${LABEL_SOURCE}(?:\s*\*\*)?(?:\s*[:|=*]+\s*|\s+is\s+|\s+was\s+|\s+)\s*["']{0,2}([^\s"'*<>]+)`,
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
  const classes = [
    /[a-z]/.test(trimmed),
    /[A-Z]/.test(trimmed),
    /\d/.test(trimmed),
    /[^A-Za-z0-9]/.test(trimmed),
  ].filter(Boolean).length;
  return classes >= 3;
}

export function looksLikeLabeledSecret(value: string): boolean {
  const trimmed = value.trim().replace(/[.,;)}>\]]+$/, "");
  if (trimmed.length < 6 || trimmed.length > 128) return false;
  if (/\s/.test(trimmed)) return false;
  if (/^op-[a-f0-9]{8}$/i.test(trimmed)) return false;
  if (/^sha256:[a-f0-9]{64}$/i.test(trimmed)) return false;
  if (trimmed.startsWith("v2:")) return false;
  if (/^https?:/i.test(trimmed)) return false;
  if (/^\[(withheld|redacted)\]$/i.test(trimmed)) return false;
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
  const add = (raw: string | undefined) => {
    if (!raw) return;
    const candidate = raw.replace(/[.,;)}>\]]+$/, "");
    if (looksLikeLabeledSecret(candidate) && !found.includes(candidate)) found.push(candidate);
  };
  const labeled = new RegExp(LABELED_VALUE.source, "gi");
  for (const match of text.matchAll(labeled)) add(match[1]);
  const markdown = new RegExp(
    String.raw`\b${LABEL_SOURCE}(?:\s*\*\*)?(?:\s*[:|=*]+\s*|\s+)\s*\x60([^\x60]+)\x60`,
    "gi",
  );
  for (const match of text.matchAll(markdown)) add(match[1]);
  const jsonLabeled = new RegExp(JSON_LABELED.source, "gi");
  for (const match of text.matchAll(jsonLabeled)) add(match[1]);
  const generated = new RegExp(GENERATED_PASSWORD_SOURCE, "gi");
  for (const match of text.matchAll(generated)) add(match[1]);
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

export function harvestSecretsFromUnknown(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") {
    for (const secret of harvestSecretsFromText(value)) {
      if (!into.includes(secret)) into.push(secret);
    }
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) harvestSecretsFromUnknown(item, into);
    return into;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (PASSWORD_KEY.test(key) && typeof item === "string") {
        if (looksLikeLabeledSecret(item) && !into.includes(item)) into.push(item);
        continue;
      }
      harvestSecretsFromUnknown(item, into);
    }
  }
  return into;
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
