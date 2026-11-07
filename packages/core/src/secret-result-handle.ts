import { createHash } from "node:crypto";

export type ProtectedResultStatus = "issued" | "verified" | "delivered" | "withheld";

export type ProtectedResultHandle = {
  handle: string;
  hash: string;
  createdAt: string;
  status: ProtectedResultStatus;
};

const PASSWORD_KEY = /^(password|passwd|pwd|temporaryPassword|newPassword|secret|otp)$/i;
const GENERATED_PASSWORD_SOURCE =
  String.raw`\b(?:temporary password|new password|generated password|old password|current password)\s*[:=]\s*(\S+)`;

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
  if (trimmed.length < 8 || trimmed.length > 128) return false;
  if (/\s/.test(trimmed)) return false;
  if (/^op-[a-f0-9]{8}$/.test(trimmed)) return false;
  if (/^sha256:[a-f0-9]{64}$/.test(trimmed)) return false;
  if (trimmed.startsWith("v2:")) return false;
  const classes = [
    /[a-z]/.test(trimmed),
    /[A-Z]/.test(trimmed),
    /\d/.test(trimmed),
    /[^A-Za-z0-9]/.test(trimmed),
  ].filter(Boolean).length;
  return classes >= 3;
}

export function redactProtectedTree(value: unknown, extras: readonly string[] = []): unknown {
  const banned = new Set(extras.filter(Boolean));
  return walk(value, banned);
}

export function extractGeneratedPasswords(text: string): string[] {
  const found: string[] = [];
  const re = new RegExp(GENERATED_PASSWORD_SOURCE, "gi");
  for (const match of text.matchAll(re)) {
    const candidate = match[1]?.replace(/[.,;}"']+$/, "");
    if (candidate && looksLikeSecretValue(candidate) && !found.includes(candidate)) {
      found.push(candidate);
    }
  }
  return found;
}

export function extractGeneratedPassword(text: string): string | undefined {
  return extractGeneratedPasswords(text)[0];
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

export function secretsFromPriorAssistantText(texts: readonly string[]): string[] {
  const found: string[] = [];
  for (const text of texts) {
    for (const generated of extractGeneratedPasswords(text)) {
      if (!found.includes(generated)) found.push(generated);
    }
  }
  return found;
}

function walk(value: unknown, banned: Set<string>): unknown {
  if (typeof value === "string") {
    if (banned.has(value) || looksLikeSecretValue(value)) return "[withheld]";
    let next = value;
    for (const secret of banned) {
      if (secret && next.includes(secret)) next = next.split(secret).join("[withheld]");
    }
    for (const generated of extractGeneratedPasswords(next)) {
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
