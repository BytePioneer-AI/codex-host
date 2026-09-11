import type { CodexAccountSummary } from "@codexhost/shared-contracts";

export interface CodexAccountDisplayName {
  readonly local: string;
  readonly domain: string | null;
  readonly full: string;
}

export function codexAccountDisplayName(account: CodexAccountSummary): CodexAccountDisplayName {
  const full = account.email ?? account.label;
  const separator = account.email?.lastIndexOf("@") ?? -1;
  if (!account.email || separator <= 0 || separator === account.email.length - 1) {
    return { local: full, domain: null, full };
  }
  return {
    local: account.email.slice(0, separator),
    domain: account.email.slice(separator + 1),
    full,
  };
}

export function codexAccountPresentationSignature(
  accounts: readonly CodexAccountSummary[],
): string {
  return accounts
    .map(({ accountId, label, email }) => `${accountId}\u0000${label}\u0000${email ?? ""}`)
    .join("\u0001");
}
