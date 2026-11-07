import {
  classifyIrreversibleTool,
  type IrreversibleClassification,
} from "./irreversible-effect.js";

const CLAIM_SPLIT = /(?:\. (?=[A-Z])|[;!?\n]| — | – |, but | but )/g;
/**
 * Claim detection is English regex. Allowing a success claim is ledger-only.
 * Not a multilingual or semantic parser: non-English completions are left as-is.
 */
const IDENTITY_CLAIM = /\b(signed in|logged in)\s+(as|with|using|via)\b/i;
const VERIFIED_CLAIM = /\b(verified|confirmed)\b/i;
const SEND_CLAIM = /\b(sent|delivered|texted|went out)\b/i;
const SEND_DENY = /\b(not (yet )?sent|hasn.t been sent|not delivered)\b/i;
/**
 * Generic completed-action verbs. Not grader L1/M1/V1 phrase lists or amounts.
 * Bound to a current-intent ledger the same way as Done/All set.
 */
const COMPLETED_ACTION = /\b(reassigned|posted|paid)\b/i;
const RESET_CLAIM = /\b(it is reset|reset (?:is |was )?done)\b/i;
const SUCCESS_CLAIM =
  /\b(done|complete|completed|finished|success(?:ful(?:ly)?)?|all set|successfully changed|it is reset|reset (?:is |was )?done)\b/i;
/** Fallback Done concatenated onto the next assistant turn has no separator or word boundary. */
const GLUED_SUCCESS =
  /^(done|ok|okay|completed?|finished|all done|task complete|it'?s done)(?=[A-Za-z0-9_-])/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const LOGIN_PAGE = /\b(sign in|log in|login)\b/i;
const HONEST_UNVERIFIED = "Outcome was not verified.";

export type ToolEvidence = {
  texts: string[];
  verified: boolean;
  sent: boolean | null;
};

export type OutcomeArtifactClass = "verified-read" | "delivered-send" | "task-proof";
export type OutcomeAction = "read" | "send" | "reset" | "change";

export type OutcomeArtifact = {
  class: OutcomeArtifactClass;
  action: OutcomeAction;
  intentId: string;
  sourceMessageId: string;
  runId: string;
  subject: string;
};

export type CompletionLedger = {
  intentId: string;
  sourceMessageId: string;
  runId: string;
  artifacts: OutcomeArtifact[];
};

export type ClaimViolation =
  | "identity"
  | "verified"
  | "send-contradiction"
  | "send-without-artifact"
  | "success-without-artifact";

export function emptyCompletionLedger(input: {
  intentId: string;
  sourceMessageId: string;
  runId: string;
}): CompletionLedger {
  return {
    intentId: input.intentId,
    sourceMessageId: input.sourceMessageId,
    runId: input.runId,
    artifacts: [],
  };
}

export function ledgerAllowsSuccess(ledger: CompletionLedger | undefined): boolean {
  if (!ledger?.intentId || !ledger.sourceMessageId || !ledger.runId) return false;
  return ledger.artifacts.some(
    (artifact) =>
      sameIdentity(artifact, ledger) &&
      (artifact.class === "verified-read" ||
        artifact.class === "delivered-send" ||
        artifact.class === "task-proof"),
  );
}

/** Done/All set/finished need task-proof or a delivered send, not a verified-read of an unrelated page. */
export function ledgerAllowsGenericSuccess(ledger: CompletionLedger | undefined): boolean {
  return ledgerHasClass(ledger, "task-proof") || ledgerHasClass(ledger, "delivered-send");
}

export function ledgerHasClass(
  ledger: CompletionLedger | undefined,
  className: OutcomeArtifactClass,
): boolean {
  if (!ledger?.intentId || !ledger.sourceMessageId || !ledger.runId) return false;
  return ledger.artifacts.some(
    (artifact) => artifact.class === className && sameIdentity(artifact, ledger),
  );
}

function sameIdentity(
  artifact: OutcomeArtifact,
  ledger: CompletionLedger,
): boolean {
  return (
    artifact.intentId === ledger.intentId &&
    artifact.sourceMessageId === ledger.sourceMessageId &&
    artifact.runId === ledger.runId
  );
}

function subjectsOverlap(left: string, right: string): boolean {
  const a = left.trim().toLowerCase();
  const b = right.trim().toLowerCase();
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

export function ledgerHasBoundClass(
  ledger: CompletionLedger | undefined,
  className: OutcomeArtifactClass,
  claimSubject?: string,
): boolean {
  if (!ledgerHasClass(ledger, className)) return false;
  const hint = claimSubject?.trim();
  if (!hint) return true;
  return ledger!.artifacts.some((artifact) => {
    if (artifact.class !== className || !sameIdentity(artifact, ledger!)) return false;
    if (!artifact.subject) return false;
    return subjectsOverlap(artifact.subject, hint);
  });
}

export function ledgerHasBoundAction(
  ledger: CompletionLedger | undefined,
  action: OutcomeAction,
  claimSubject?: string,
): boolean {
  if (!ledger?.intentId || !ledger.sourceMessageId || !ledger.runId) return false;
  const hint = claimSubject?.trim();
  return ledger.artifacts.some((artifact) => {
    if (artifact.action !== action || !sameIdentity(artifact, ledger)) return false;
    if (!hint) return true;
    return Boolean(artifact.subject) && subjectsOverlap(artifact.subject, hint);
  });
}

/**
 * Structured proof only. Boolean `verified`/`sent`/`outcomeProof` fields on this
 * turn's tool result, bound to the current intent+sourceMessageId+runId.
 * Page text, `{ok:true}`, login snapshots, 404s, and other runs do not count.
 */
export function bindOutcomeArtifact(input: {
  result: unknown;
  toolName: string;
  args?: Record<string, unknown>;
  intentId: string;
  sourceMessageId: string;
  runId: string;
  classification?: IrreversibleClassification | null;
}): OutcomeArtifact | null {
  const { result, toolName, intentId, sourceMessageId, runId } = input;
  if (!intentId || !sourceMessageId || !runId) return null;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;
  const args = input.args ?? {};
  const irreversible = input.classification ?? classifyIrreversibleTool(toolName, args);
  if (record.outcomeProof === true) {
    if (record.intentId !== intentId || record.sourceMessageId !== sourceMessageId) return null;
    if (typeof record.runId === "string" && record.runId !== runId) return null;
    const subject =
      (typeof record.subject === "string" && record.subject.trim()) ||
      irreversible?.subject ||
      toolName;
    return {
      class: "task-proof",
      action: irreversible?.class === "password-reset" ? "reset" : "change",
      intentId,
      sourceMessageId,
      runId,
      subject,
    };
  }
  if (record.sent === true && irreversible?.class === "send") {
    return {
      class: "delivered-send",
      action: "send",
      intentId,
      sourceMessageId,
      runId,
      subject: irreversible.subject,
    };
  }
  if (irreversible?.class === "password-reset" && record.ok === true && !isInsufficientRead(record)) {
    return {
      class: "task-proof",
      action: "reset",
      intentId,
      sourceMessageId,
      runId,
      subject: irreversible.subject,
    };
  }
  if (record.verified === true && !isInsufficientRead(record)) {
    const subject = pageSubject(record) || pageBlob(record).trim();
    if (!subject || subject.replace(/\s+/g, "").length < 4) return null;
    return {
      class: "verified-read",
      action: "read",
      intentId,
      sourceMessageId,
      runId,
      subject,
    };
  }
  return null;
}

function pageBlob(record: Record<string, unknown>): string {
  return `${record.tree ?? ""} ${record.header ?? ""} ${record.title ?? ""} ${record.url ?? ""}`;
}

function pageSubject(record: Record<string, unknown>): string | undefined {
  const url = typeof record.url === "string" ? record.url.trim() : "";
  const title = typeof record.title === "string" ? record.title.trim() : "";
  return url || title || undefined;
}

function isInsufficientRead(record: Record<string, unknown>): boolean {
  const blob = pageBlob(record);
  if (LOGIN_PAGE.test(blob)) return true;
  if (/\b404\b/.test(blob) || /not found/i.test(blob)) return true;
  return false;
}

export function clauses(text: string): string[] {
  return text
    .split(CLAIM_SPLIT)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Negation counts only in the few tokens immediately before the claim, not later in the clause. */
export function clauseNegatesAt(clause: string, index: number): boolean {
  const before = clause.slice(Math.max(0, index - 28), index);
  const tokens = before.trim().split(/\s+/).slice(-3);
  return tokens.some((token) => {
    const word = token.replace(/[^A-Za-z']/g, "");
    return /^(not|never|no)$/i.test(word) || /n['’]t$/i.test(word);
  });
}

export function positiveClaims(text: string, pattern: RegExp): string[] {
  return clauses(text).filter((clause) => {
    const match = clause.match(pattern);
    if (!match || match.index === undefined) return false;
    if (clauseNegatesAt(clause, match.index)) return false;
    return true;
  });
}

export function collectToolEvidence(results: readonly unknown[]): ToolEvidence {
  const texts = results.map(resultText).filter(Boolean);
  const blob = texts.join("\n");
  const verified = /"verified"\s*:\s*true/.test(blob) || /\bverified\s*:\s*true\b/i.test(blob);
  let sent: boolean | null = null;
  if (/"sent"\s*:\s*true/.test(blob) || /"state"\s*:\s*"Delivered"/.test(blob)) sent = true;
  if (/"sent"\s*:\s*false/.test(blob) || SEND_DENY.test(blob)) sent = false;
  return { texts, verified, sent };
}

export function unsupportedClaims(
  finalText: string,
  evidence: ToolEvidence,
  ledger?: CompletionLedger,
): ClaimViolation[] {
  const blob = evidence.texts.join("\n");
  const violations: ClaimViolation[] = [];
  const identity = positiveClaims(finalText, IDENTITY_CLAIM);
  for (const claim of identity) {
    const emails = claim.match(EMAIL) ?? [];
    if (emails.some((email) => !blob.toLowerCase().includes(email.toLowerCase()))) {
      violations.push("identity");
      break;
    }
    const named = claimedIdentitySubject(claim);
    if (emails.length === 0 && named && !blob.toLowerCase().includes(named.toLowerCase())) {
      violations.push("identity");
      break;
    }
  }
  const verifiedClaims = positiveClaims(finalText, VERIFIED_CLAIM);
  if (verifiedClaims.length > 0) {
    const licensed = verifiedClaims.every((claim) => {
      const subject = claimResourceSubject(claim);
      if (ledgerHasClass(ledger, "task-proof") && !subject) return true;
      if (!subject) return false;
      return (
        ledgerHasBoundClass(ledger, "verified-read", subject) ||
        ledgerHasBoundAction(ledger, "reset", subject) ||
        ledgerHasBoundAction(ledger, "change", subject)
      );
    });
    if (!licensed) violations.push("verified");
  }
  const sendYes = positiveClaims(finalText, SEND_CLAIM);
  const sendNo = SEND_DENY.test(finalText);
  if (sendYes.length > 0 && sendNo) violations.push("send-contradiction");
  if (sendYes.length > 0 && evidence.sent === false) violations.push("send-contradiction");
  if (sendYes.length > 0 && evidence.sent !== false) {
    const sendLicensed = sendYes.every((claim) => {
      const subject = sendClaimSubject(claim);
      return ledgerHasBoundAction(ledger, "send", subject);
    });
    if (!sendLicensed) violations.push("send-without-artifact");
  }
  const resetClaims = positiveClaims(finalText, RESET_CLAIM);
  const completedClaims = positiveClaims(finalText, COMPLETED_ACTION);
  const genericSuccess =
    positiveClaims(finalText, SUCCESS_CLAIM).length > 0 || hasGluedUnsupportedCompletion(finalText);
  if (resetClaims.length > 0 && !ledgerHasBoundAction(ledger, "reset")) {
    violations.push("success-without-artifact");
  } else if (
    completedClaims.length > 0 &&
    !ledgerHasClass(ledger, "task-proof") &&
    !ledgerHasBoundAction(ledger, "change")
  ) {
    violations.push("success-without-artifact");
  } else if (genericSuccess && !ledgerAllowsGenericSuccess(ledger)) {
    violations.push("success-without-artifact");
  }
  return [...new Set(violations)];
}

function claimResourceSubject(claim: string): string | undefined {
  const match = claim.match(/(.{0,48}?)\b(verified|confirmed)\b/i);
  const before = match?.[1]?.trim() ?? "";
  const tokens = before
    .split(/[\s:/?#]+/)
    .map((token) => token.replace(/[^A-Za-z0-9-]/g, ""))
    .filter(
      (token) =>
        token.length >= 4 &&
        !/^(this|that|been|have|from|with|page|result|outcome|status|been)$/i.test(token),
    );
  return tokens.at(-1);
}

function sendClaimSubject(claim: string): string | undefined {
  const phone = claim.match(/\+?\d{7,}/);
  if (phone?.[0]) return phone[0];
  const email = claim.match(EMAIL)?.[0];
  if (email) return email;
  return undefined;
}

function claimedIdentitySubject(claim: string): string | undefined {
  const match = claim.match(/\b(?:signed in|logged in)\s+(?:as|with|using|via)\s+(.+)/i);
  const rest = match?.[1]?.trim() ?? "";
  const token =
    rest
      .split(/[\s,./]+/)
      .map((part) => part.replace(/^[@]+/, ""))
      .find((part) => part.length >= 2 && !/^(the|a|an)$/i.test(part)) ?? "";
  if (token.length < 2) return undefined;
  return token;
}

/** Terminal final after a bare-done follow-up may glue the fallback Done to the next turn. */
export function hasGluedUnsupportedCompletion(text: string): boolean {
  return GLUED_SUCCESS.test(text.trim());
}

export function stripGluedSuccessPrefix(text: string): string {
  return text.replace(GLUED_SUCCESS, "");
}

export function sanitizeFinalText(
  finalText: string,
  evidence: ToolEvidence,
  ledger?: CompletionLedger,
): string {
  const trimmedIn = finalText.trim();
  if (!trimmedIn) return HONEST_UNVERIFIED;
  const violations = new Set(unsupportedClaims(finalText, evidence, ledger));
  if (violations.size === 0) return finalText;
  let parts = clauses(finalText).filter((clause) => {
    if (violations.has("identity") && IDENTITY_CLAIM.test(clause)) return false;
    if (violations.has("verified") && VERIFIED_CLAIM.test(clause) && !clauseNegatesClaim(clause, VERIFIED_CLAIM)) {
      return false;
    }
    return true;
  });
  if (violations.has("send-contradiction")) {
    if (evidence.sent === true) parts = parts.filter((clause) => !SEND_DENY.test(clause));
    else if (evidence.sent === false) {
      parts = parts.filter((clause) => !SEND_CLAIM.test(clause));
      if (parts.length === 0) return "Delivery was not verified.";
    } else parts.push("Delivery was not verified.");
  }
  if (violations.has("send-without-artifact")) {
    parts = parts.filter((clause) => !SEND_CLAIM.test(clause));
    if (parts.length === 0) return "Delivery was not verified.";
  }
  if (violations.has("identity") && !parts.some((clause) => /not signed in|signed out|guest/i.test(clause))) {
    parts.push("Sign-in identity was not on the page.");
  }
  if (violations.has("success-without-artifact")) {
    parts = parts.flatMap((clause) => {
      const unglued = stripGluedSuccessPrefix(clause).trim();
      if (unglued !== clause.trim()) {
        if (!unglued) return [];
        if (actionClaimUnverified(unglued)) return [];
        return [unglued];
      }
      if (actionClaimUnverified(clause)) return [];
      return [clause];
    });
  }
  const text = parts.join(". ").replace(/\s+/g, " ").trim();
  return text || HONEST_UNVERIFIED;
}

function actionClaimUnverified(clause: string): boolean {
  return (
    (SUCCESS_CLAIM.test(clause) && !clauseNegatesClaim(clause, SUCCESS_CLAIM)) ||
    (COMPLETED_ACTION.test(clause) && !clauseNegatesClaim(clause, COMPLETED_ACTION))
  );
}

function clauseNegatesClaim(clause: string, pattern: RegExp): boolean {
  const match = clause.match(pattern);
  if (!match || match.index === undefined) return false;
  return clauseNegatesAt(clause, match.index);
}

/** @deprecated Blob `verified`/`sent` is not an intent-bound ledger. Prefer ledgerAllowsSuccess. */
export function headlineAllowsDone(evidence: ToolEvidence): boolean {
  void evidence;
  return false;
}

function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return "";
  }
}

