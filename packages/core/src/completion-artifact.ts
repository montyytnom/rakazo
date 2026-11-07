import { classifyIrreversibleTool } from "./irreversible-effect.js";

const CLAIM_SPLIT = /(?:\. (?=[A-Z])|[;!?\n]| — | – |, but | but )/g;
const NEGATIVE =
  /\b(not|n't|never|no new|unable|could ?n.t|failed|hasn't|haven't|isn't|wasn't|pending|blocked|still need|unverified|unconfirmed|waiting|until)\b/i;
const IDENTITY_CLAIM = /\b(signed in|logged in) as\b/i;
const LICENSE_CLAIM =
  /\b(reassigned|license (is )?now|moved the license|assigned (the )?license)\b/i;
const VERIFIED_CLAIM = /\b(verified|confirmed)\b/i;
const SEND_CLAIM = /\b(sent|delivered|texted)\b/i;
const SEND_DENY = /\b(not (yet )?sent|hasn.t been sent|not delivered)\b/i;
const LIMIT_AS_PAYMENT =
  /(17,?000(?:\.00)?[^.]{0,40}(?:payment|paid|ACH))|((?:payment|paid|ACH)[^.]{0,40}17,?000)/i;
const CREDIT_LIMIT = /credit limit/i;
/**
 * Claim *detection* is English regex. Allowing a success claim is ledger-only.
 * Not a multilingual or semantic parser: non-English completions are left as-is.
 */
const SUCCESS_CLAIM =
  /\b(done|complete|completed|success(?:ful(?:ly)?)?|all set|successfully changed|it is reset|reset (?:is |was )?done)\b/i;
/** Fallback Done concatenated onto the next assistant turn has no separator or word boundary. */
const GLUED_SUCCESS =
  /^(done|ok|okay|completed?|finished|all done|task complete|it'?s done)(?=[A-Za-z0-9_-])/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const LOGIN_PAGE = /\b(sign in|log in|login)\b/i;

export type ToolEvidence = {
  texts: string[];
  verified: boolean;
  sent: boolean | null;
};

export type OutcomeArtifactClass = "verified-read" | "delivered-send" | "task-proof";

export type OutcomeArtifact = {
  class: OutcomeArtifactClass;
  intentId: string;
  sourceMessageId: string;
  runId: string;
  subject?: string;
};

export type CompletionLedger = {
  intentId: string;
  sourceMessageId: string;
  runId: string;
  artifacts: OutcomeArtifact[];
};

export type ClaimViolation =
  | "identity"
  | "license"
  | "verified"
  | "send-contradiction"
  | "limit-as-payment"
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
      artifact.intentId === ledger.intentId &&
      artifact.sourceMessageId === ledger.sourceMessageId &&
      artifact.runId === ledger.runId &&
      (artifact.class === "verified-read" ||
        artifact.class === "delivered-send" ||
        artifact.class === "task-proof"),
  );
}

export function ledgerHasClass(
  ledger: CompletionLedger | undefined,
  className: OutcomeArtifactClass,
): boolean {
  if (!ledgerAllowsSuccess(ledger)) return false;
  return ledger!.artifacts.some(
    (artifact) =>
      artifact.class === className &&
      artifact.intentId === ledger!.intentId &&
      artifact.sourceMessageId === ledger!.sourceMessageId &&
      artifact.runId === ledger!.runId,
  );
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
}): OutcomeArtifact | null {
  const { result, toolName, intentId, sourceMessageId, runId } = input;
  if (!intentId || !sourceMessageId || !runId) return null;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;
  const args = input.args ?? {};
  const irreversible = classifyIrreversibleTool(toolName, args);
  if (record.outcomeProof === true) {
    if (record.intentId !== intentId || record.sourceMessageId !== sourceMessageId) return null;
    if (typeof record.runId === "string" && record.runId !== runId) return null;
    return { class: "task-proof", intentId, sourceMessageId, runId };
  }
  if (record.sent === true && irreversible?.class === "send") {
    return {
      class: "delivered-send",
      intentId,
      sourceMessageId,
      runId,
      subject: irreversible.subject,
    };
  }
  if (record.verified === true && !isInsufficientRead(record)) {
    return { class: "verified-read", intentId, sourceMessageId, runId };
  }
  return null;
}

function pageBlob(record: Record<string, unknown>): string {
  return `${record.tree ?? ""} ${record.header ?? ""} ${record.title ?? ""} ${record.url ?? ""}`;
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

export function positiveClaims(text: string, pattern: RegExp): string[] {
  return clauses(text).filter((clause) => pattern.test(clause) && !NEGATIVE.test(clause));
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
    if (emails.length === 0 && /as [^\s]+@[^\s]+/i.test(claim) && !blob.includes("@")) {
      violations.push("identity");
      break;
    }
  }
  if (positiveClaims(finalText, LICENSE_CLAIM).length > 0 && !/license/i.test(blob)) {
    violations.push("license");
  }
  if (positiveClaims(finalText, VERIFIED_CLAIM).length > 0 && !ledgerHasClass(ledger, "verified-read") && !ledgerHasClass(ledger, "task-proof")) {
    violations.push("verified");
  }
  const sendYes = positiveClaims(finalText, SEND_CLAIM).length > 0;
  const sendNo = SEND_DENY.test(finalText);
  if (sendYes && sendNo) violations.push("send-contradiction");
  if (sendYes && evidence.sent === false) violations.push("send-contradiction");
  if (LIMIT_AS_PAYMENT.test(finalText) && !CREDIT_LIMIT.test(finalText)) {
    violations.push("limit-as-payment");
  }
  if (
    !ledgerAllowsSuccess(ledger) &&
    (positiveClaims(finalText, SUCCESS_CLAIM).length > 0 || hasGluedUnsupportedCompletion(finalText))
  ) {
    violations.push("success-without-artifact");
  }
  return [...new Set(violations)];
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
  const violations = new Set(unsupportedClaims(finalText, evidence, ledger));
  if (violations.size === 0) return finalText;
  const kept = clauses(finalText).filter((clause) => {
    if (violations.has("identity") && IDENTITY_CLAIM.test(clause)) return false;
    if (violations.has("license") && LICENSE_CLAIM.test(clause)) return false;
    if (violations.has("verified") && VERIFIED_CLAIM.test(clause) && !NEGATIVE.test(clause)) {
      return false;
    }
    if (violations.has("limit-as-payment") && LIMIT_AS_PAYMENT.test(clause)) return false;
    return true;
  });
  let text = kept.join(". ").replace(/\s+/g, " ").trim();
  if (violations.has("send-contradiction")) {
    if (evidence.sent === true) text = stripSendDenial(text);
    else if (evidence.sent === false) {
      text = stripSendAffirmation(text);
      if (!text || /\bsent\b/i.test(text)) {
        text = "Delivery was not verified.";
      }
    } else text = `${text} Delivery was not verified.`.trim();
  }
  if (violations.has("license") && !/not (been )?(reassigned|done|verified)/i.test(text)) {
    text = `${text} License change was not verified.`.trim();
  }
  if (violations.has("identity") && !/not signed in|signed out|guest/i.test(text)) {
    text = `${text} Sign-in identity was not on the page.`.trim();
  }
  if (violations.has("success-without-artifact")) {
    const keptSuccess = clauses(text).flatMap((clause) => {
      const unglued = stripGluedSuccessPrefix(clause).trim();
      if (unglued !== clause.trim()) {
        if (!unglued) return [];
        if (SUCCESS_CLAIM.test(unglued) && !NEGATIVE.test(unglued)) return [];
        return [unglued];
      }
      if (SUCCESS_CLAIM.test(clause) && !NEGATIVE.test(clause)) return [];
      return [clause];
    });
    text = keptSuccess.join(". ").replace(/\s+/g, " ").trim();
    if (!text) text = "Outcome was not verified.";
  }
  return text.replace(/\s+/g, " ").trim();
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

function stripSendDenial(text: string): string {
  return clauses(text)
    .filter((clause) => !SEND_DENY.test(clause))
    .join(". ");
}

function stripSendAffirmation(text: string): string {
  return clauses(text)
    .filter((clause) => !SEND_CLAIM.test(clause))
    .join(". ");
}
