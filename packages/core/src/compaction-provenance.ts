const FACT_LINE =
  /^(?:[-*]\s*)?(?:current facts:\s*)?(.*(?:signed in|logged in|account|email).+)$/i;
const UNVERIFIED_MARK =
  /\b(claimed:|unverified|not (yet )?verified|never (shown|seen)|not signed in)\b/i;
const IDENTITY_EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const VERIFIED_MARKER = /"verified"\s*:\s*true|\bverified\s*:\s*true\b/i;

export function rewriteUnverifiedClaims(summary: string, transcript = ""): string {
  const verified = VERIFIED_MARKER.test(transcript);
  return summary
    .split(/\n/)
    .map((line) => {
      if (!FACT_LINE.test(line)) return line;
      if (UNVERIFIED_MARK.test(line)) return line;
      const email = line.match(IDENTITY_EMAIL)?.[0];
      if (verified && email && transcript.toLowerCase().includes(email.toLowerCase())) {
        return line;
      }
      if (/\b(done|verified|confirmed|created|logged in|signed in)\b/i.test(line)) {
        const body = line.replace(/^([-*]\s*)/, "").replace(/^Current facts:\s*/i, "");
        const prefix = line.startsWith("-") || line.startsWith("*") ? "- " : "";
        return `${prefix}claimed: ${body}`;
      }
      return line;
    })
    .join("\n");
}

export function promotesUnverifiedIdentity(summary: string, pageText = ""): boolean {
  const email = summary.match(IDENTITY_EMAIL)?.[0];
  if (!email) return false;
  if (UNVERIFIED_MARK.test(summary)) return false;
  if (VERIFIED_MARKER.test(pageText) && pageText.toLowerCase().includes(email.toLowerCase())) {
    return false;
  }
  if (pageText.toLowerCase().includes(email.toLowerCase()) && VERIFIED_MARKER.test(pageText)) {
    return false;
  }
  return /\b(signed in|logged in|account)\b/i.test(summary);
}

export function preferFreshToolFacts(summary: string, freshToolText: string): string {
  if (!freshToolText.trim()) return rewriteUnverifiedClaims(summary);
  if (promotesUnverifiedIdentity(summary, freshToolText)) {
    return rewriteUnverifiedClaims(
      summary
        .split(/\n/)
        .filter((line) => !IDENTITY_EMAIL.test(line) || UNVERIFIED_MARK.test(line))
        .join("\n"),
      freshToolText,
    );
  }
  return rewriteUnverifiedClaims(summary, freshToolText);
}
