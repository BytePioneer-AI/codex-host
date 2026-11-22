import {
  accountBalanceSnapshotSchema,
  accountCreditsSnapshotSchema,
  type AccountBalanceSnapshot,
  type AccountCreditsSnapshot,
} from "@codexhost/shared-contracts";

/** Legacy caches can carry a private fetch timestamp; it is not quota presentation data. */
export function parseHarnessAccountCredits(value: unknown): AccountCreditsSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const publicValue = { ...value } as Record<string, unknown>;
  delete publicValue.fetchedAt;
  const parsed = accountCreditsSnapshotSchema.safeParse(publicValue);
  return parsed.success ? parsed.data : null;
}

/** A malformed Adapter balance is treated as unknown rather than failing the inspection. */
export function parseHarnessAccountBalance(value: unknown): AccountBalanceSnapshot | null {
  const parsed = accountBalanceSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
