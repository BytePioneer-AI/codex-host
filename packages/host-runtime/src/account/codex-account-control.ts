import { z } from "zod";
import {
  codexAccountPlanTypeSchema,
  type CodexAccountListResult,
  type CodexAccountSummary,
} from "@codexhost/shared-contracts";

/** Current-only Codex identity. Credentials never cross this boundary. */
export interface CodexAccountControl {
  snapshot(): CodexAccountListResult;
  /** Re-read the official current identity without changing native auth. */
  refresh?(): Promise<CodexAccountListResult>;
  currentAccountId(): string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Map official `account/read` to a display snapshot. Never stores credential copies. */
export function currentCodexAccountFromOfficialRead(result: unknown): CodexAccountSummary | null {
  if (!isRecord(result) || !isRecord(result.account) || result.account.type !== "chatgpt") {
    return null;
  }
  const email = z.string().email().max(320).safeParse(result.account.email);
  const plan = codexAccountPlanTypeSchema.safeParse(result.account.planType);
  const candidate =
    typeof result.account.accountId === "string"
      ? result.account.accountId
      : typeof result.account.id === "string"
        ? result.account.id
        : "current";
  const accountId = /^[A-Za-z0-9._~-]{1,256}$/u.test(candidate) ? candidate : "current";
  return {
    accountId,
    label: email.success ? email.data : "Codex",
    ...(email.success ? { email: email.data } : {}),
    ...(plan.success ? { planType: plan.data } : {}),
  };
}

/** Read-only projection of the official current Codex identity. */
export class SingleNativeCodexAccount implements CodexAccountControl {
  readonly refresh?: () => Promise<CodexAccountListResult>;

  constructor(
    private readonly summary: () => CodexAccountListResult,
    refreshCurrent?: () => Promise<CodexAccountListResult>,
  ) {
    if (refreshCurrent) this.refresh = refreshCurrent;
  }

  snapshot(): CodexAccountListResult {
    return this.summary();
  }
  currentAccountId(): string | null {
    return this.summary().currentAccountId;
  }
}
