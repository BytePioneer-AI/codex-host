import type { HarnessAdapter } from "@codexhost/harness-adapter";
import {
  harnessAccountSnapshotSchema,
  type HarnessAccountListResult,
  type HarnessPluginDescriptor,
} from "@codexhost/shared-contracts";

/** A failed/unsupported plugin must not hide other accounts or leak native diagnostics. */
export async function inspectHarnessAccounts(
  adapters: Iterable<HarnessAdapter>,
  descriptors: readonly HarnessPluginDescriptor[],
  timeoutMs = 12_000,
): Promise<HarnessAccountListResult> {
  const accounts = await Promise.all(
    [...adapters].map(async (adapter) => {
      if (!adapter.inspectAccount) return null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const value = await Promise.race([
          Promise.resolve().then(() => adapter.inspectAccount?.()),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), timeoutMs);
          }),
        ]);
        const parsed = harnessAccountSnapshotSchema.safeParse(value);
        if (!parsed.success) return null;
        return {
          ...parsed.data,
          harnessId: adapter.harnessId,
          harnessName:
            descriptors.find((plugin) => plugin.id === adapter.harnessId)?.name ??
            adapter.harnessId,
        };
      } catch {
        return null;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }),
  );
  return { accounts: accounts.filter((account) => account !== null) };
}
