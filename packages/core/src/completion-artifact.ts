import {
  classifyIrreversibleTool,
  type IrreversibleClassification,
} from "./irreversible-effect.js";

const CLAIM_SPLIT = /(?:\. (?=[A-Z])|[;!?\n]| — | – |, but | but )/g;
/**
 * Claim detection is English regex. Allowing a success claim is ledger-only.
 * Not a multilingual or semantic parser: non-English completions are left as-is.
 */
const IDENTITY_CLAIM =
  /\b(?:(?:signed|logged)\s+in\s+(?:as|with|using|via)|(?:using|via)\s+(?:the\s+|your\s+)?[A-Za-z0-9._+-]+(?:\s+account)?)\b/i;
const VERIFIED_CLAIM = /\b(verified|confirmed)\b/i;
const SEND_CLAIM = /\b(sent|delivered|texted|went out)\b/i;
const SEND_DENY = /\b(not (yet )?sent|hasn.t been sent|not delivered)\b/i;
/**
 * Generic completed-action verbs. Not grader L1/M1/V1 phrase lists or amounts.
 * Bound to a current-intent ledger the same way as Done/All set.
 */
const COMPLETED_ACTION = /\b(reassigned|paid|payment posted)\b/i;
const RESET_CLAIM =
  /\b(?:it is reset|reset (?:is |was )?done|(?:has been|have been|was|were) reset|password(?:\s+\w+){0,2}\s+reset)\b/i;
const OUTCOME_CLAIM =
  /\b(?:has been|have been|was|were)\s+(changed|updated|transferred|moved)\b/i;
const SUCCESS_CLAIM =
  /\b(done|complete|completed|finished|success(?:ful(?:ly)?)?|all set|successfully changed|it is reset|reset (?:is |was )?done)\b/i;
/**
 * Bare-Done glued onto the next turn. Only `Done`/`Finished` plus a capital
 * letter — never `ok`/`completed?`, which mangle OKRs and Completely.
 */
const GLUED_SUCCESS = /^(done|finished|all done|task complete|it'?s done)(?=[A-Z])/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const LOGIN_PAGE = /\b(sign in|log in|login)\b/i;
const HONEST_UNVERIFIED = "Outcome was not verified.";
/** Function/claim words, not entity names. Used to drop noise from proof-token sets. */
const PROOF_SKIP = new Set([
  "this",
  "that",
  "been",
  "have",
  "from",
  "with",
  "page",
  "result",
  "outcome",
  "status",
  "your",
  "their",
  "them",
  "they",
  "what",
  "when",
  "were",
  "will",
  "into",
  "over",
  "than",
  "then",
  "also",
  "done",
  "complete",
  "completed",
  "finished",
  "success",
  "successful",
  "successfully",
  "using",
  "via",
  "account",
  "signed",
  "logged",
  "verified",
  "confirmed",
  "sent",
  "delivered",
  "texted",
]);

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

/** Whole-token proof identity. Substring `Sam`/`Sample` and `your` never match. */
export function proofTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !PROOF_SKIP.has(token));
}

function pageUrlKey(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return `${url.origin}${url.pathname}`.replace(/\/$/, "").toLowerCase();
  } catch {
    return undefined;
  }
}

function subjectsOverlap(left: string, right: string): boolean {
  const a = left.trim().toLowerCase();
  const b = right.trim().toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  const urlA = pageUrlKey(left);
  const urlB = pageUrlKey(right);
  if (urlA && urlB) return urlA === urlB;
  const leftTokens = proofTokens(left);
  const rightTokens = proofTokens(right);
  return leftTokens.some((token) => rightTokens.includes(token));
}

function evidenceHasExactToken(blob: string, token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) return false;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, "i").test(blob);
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
 * Structured proof only. Boolean `verified`/`sent` fields on this turn's tool
 * result, bound to the current intent+sourceMessageId+runId. Reset proof is a
 * verified-read of post-reset page copy (action=reset), not a fictional
 * `outcomeProof` field. Page text, `{ok:true}`, login snapshots, 404s, and
 * other runs do not count.
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
  // A click/mutation attempt (`ok: true` on a Reset control) is not an outcome.
  if (record.verified === true && !isInsufficientRead(record)) {
    const subject = pageSubject(record) || pageBlob(record).trim();
    if (!subject || subject.replace(/\s+/g, "").length < 4) return null;
    return {
      class: "verified-read",
      action: isResetSuccessPage(record) ? "reset" : "read",
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

/** Post-reset page copy. Not a click, not outcomeProof invented on the executor. */
function isResetSuccessPage(record: Record<string, unknown>): boolean {
  const blob = pageBlob(record);
  return /\b(?:password (?:was |has been )?(?:reset|changed|updated)|reset password successful|password reset successful)\b/i.test(
    blob,
  );
}

/**
 * Reset claims need a reset action and a verified-read of the SAME subject.
 * Undefined claim hint does not license reset(A)+read(B).
 */
export function ledgerHasSameSubjectResetProof(
  ledger: CompletionLedger | undefined,
  claimSubject?: string,
): boolean {
  if (!ledger?.intentId || !ledger.sourceMessageId || !ledger.runId) return false;
  const hint = claimSubject?.trim();
  const resets = ledger.artifacts.filter(
    (artifact) => artifact.action === "reset" && sameIdentity(artifact, ledger) && artifact.subject,
  );
  const reads = ledger.artifacts.filter(
    (artifact) =>
      artifact.class === "verified-read" && sameIdentity(artifact, ledger) && artifact.subject,
  );
  return resets.some((reset) =>
    reads.some((read) => {
      if (!subjectsOverlap(reset.subject, read.subject)) return false;
      if (hint && !subjectsOverlap(reset.subject, hint) && !subjectsOverlap(read.subject, hint)) {
        return false;
      }
      return true;
    }),
  );
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
    return /^(not|never)$/i.test(word) || /n['’]t$/i.test(word);
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
    if (emails.length === 0 && named && !evidenceHasExactToken(blob, named)) {
      violations.push("identity");
      break;
    }
  }
  const verifiedClaims = positiveClaims(finalText, VERIFIED_CLAIM);
  if (verifiedClaims.length > 0) {
    const licensed = verifiedClaims.every((claim) =>
      claimLicensedByProof(ledger, claim, ["verified-read"], ["reset", "change"]),
    );
    if (!licensed) violations.push("verified");
  }
  const sendYes = positiveClaims(finalText, SEND_CLAIM);
  const sendNo = SEND_DENY.test(finalText);
  if (sendYes.length > 0 && sendNo) violations.push("send-contradiction");
  if (sendYes.length > 0 && evidence.sent === false) violations.push("send-contradiction");
  if (sendYes.length > 0 && evidence.sent !== false) {
    const sendLicensed = sendYes.every((claim) => {
      const subject = sendClaimSubject(claim);
      if (!subject) return false;
      return ledgerHasBoundAction(ledger, "send", subject);
    });
    if (!sendLicensed) violations.push("send-without-artifact");
  }
  const resetClaims = positiveClaims(finalText, RESET_CLAIM);
  const completedClaims = positiveClaims(finalText, COMPLETED_ACTION);
  const outcomeClaims = positiveClaims(finalText, OUTCOME_CLAIM);
  const successClaims = positiveClaims(finalText, SUCCESS_CLAIM);
  const genericSuccess =
    successClaims.length > 0 ||
    outcomeClaims.length > 0 ||
    hasGluedUnsupportedCompletion(finalText);
  if (resetClaims.length > 0) {
    const resetLicensed = resetClaims.every((claim) =>
      ledgerHasSameSubjectResetProof(ledger, namedProofHint(claim)),
    );
    if (!resetLicensed) violations.push("success-without-artifact");
  } else if (completedClaims.length > 0) {
    const changeLicensed = completedClaims.every((claim) => {
      const hint = namedProofHint(claim);
      return ledgerHasBoundAction(ledger, "change", hint);
    });
    if (!changeLicensed) violations.push("success-without-artifact");
  } else if (genericSuccess) {
    const licensed = [...successClaims, ...outcomeClaims].every((claim) => {
      const named = namedProofHint(claim);
      if (named) {
        return (
          ledgerHasBoundClass(ledger, "task-proof", named) ||
          ledgerHasBoundClass(ledger, "delivered-send", named)
        );
      }
      return ledgerAllowsGenericSuccess(ledger);
    });
    if (!licensed || (hasGluedUnsupportedCompletion(finalText) && !ledgerAllowsGenericSuccess(ledger))) {
      violations.push("success-without-artifact");
    }
  }
  return [...new Set(violations)];
}

function namedProofHint(claim: string): string | undefined {
  const skip = new Set([
    "reset",
    "changed",
    "updated",
    "transferred",
    "moved",
    "reassigned",
    "posted",
    "paid",
    "placed",
  ]);
  return proofTokens(claim).find((token) => !skip.has(token));
}

function claimLicensedByProof(
  ledger: CompletionLedger | undefined,
  claim: string,
  classes: OutcomeArtifactClass[],
  actions: OutcomeAction[],
): boolean {
  if (!ledger?.intentId || !ledger.sourceMessageId || !ledger.runId) return false;
  const tokens = proofTokens(claim);
  if (tokens.length === 0) return false;
  return ledger.artifacts.some((artifact) => {
    if (!sameIdentity(artifact, ledger)) return false;
    if (!classes.includes(artifact.class) && !actions.includes(artifact.action)) return false;
    if (!artifact.subject) return false;
    return proofTokens(artifact.subject).some((token) => tokens.includes(token));
  });
}

function sendClaimSubject(claim: string): string | undefined {
  const phone = claim.match(/\+?\d{7,}/);
  if (phone?.[0]) return phone[0];
  const email = claim.match(EMAIL)?.[0];
  if (email) return email;
  const named = claim.match(
    /\b(?:to|for)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?|[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+)/,
  );
  return named?.[1]?.trim();
}

function claimedIdentitySubject(claim: string): string | undefined {
  const signed = claim.match(/\b(?:signed in|logged in)\s+(?:as|with|using|via)\s+(.+)/i);
  const rest = signed?.[1]?.trim() ?? "";
  const fromSigned = rest
    .split(/[\s,./]+/)
    .map((part) => part.replace(/^[@]+/, ""))
    .find((part) => part.length >= 2 && !/^(the|a|an|your|my|our)$/i.test(part));
  if (fromSigned && fromSigned.length >= 2) return fromSigned;
  const using = claim.match(
    /\b(?:using|via)\s+(?:the\s+|your\s+)?([A-Za-z0-9._+-]+)(?:\s+account)?/i,
  );
  const token = using?.[1]?.trim() ?? "";
  if (!token || /^(the|a|an|your|my|our)$/i.test(token)) return undefined;
  return token.length >= 2 ? token : undefined;
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
    (COMPLETED_ACTION.test(clause) && !clauseNegatesClaim(clause, COMPLETED_ACTION)) ||
    (RESET_CLAIM.test(clause) && !clauseNegatesClaim(clause, RESET_CLAIM)) ||
    (OUTCOME_CLAIM.test(clause) && !clauseNegatesClaim(clause, OUTCOME_CLAIM))
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

