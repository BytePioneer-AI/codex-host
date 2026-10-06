const EMAIL_PATTERN = /([^\s@]+)@([^\s@]+\.[^\s@]+)/gu;
const MASK = "****";

/**
 * Hide the middle of an email's local part, keeping both ends recognizable to the owner.
 * The mask has a fixed width so it does not reveal the local part's length; the domain stays.
 */
export function maskEmailLocalPart(local: string): string {
  const chars = Array.from(local);
  if (chars.length <= 1) return MASK;
  if (chars.length <= 4) return `${chars[0]}${MASK}${chars.length > 2 ? chars.at(-1) : ""}`;
  return `${chars.slice(0, 2).join("")}${MASK}${chars.slice(-2).join("")}`;
}

/** Mask every email inside a display string; non-email names such as "DeepSeek" are unchanged. */
export function maskEmails(text: string): string {
  return text.replace(
    EMAIL_PATTERN,
    (_match, local: string, domain: string) => `${maskEmailLocalPart(local)}@${domain}`,
  );
}

export function accountDisplayText(text: string, hideEmails: boolean): string {
  return hideEmails ? maskEmails(text) : text;
}
