import type { HarnessAdapter } from "@codexhost/harness-adapter";
import {
  harnessAccountInspectResultSchema,
  harnessAccountSnapshotSchema,
  harnessAccountSourceListResultSchema,
  type HarnessAccountInspectResult,
  type HarnessAccountListResult,
  type HarnessAccountSourceListResult,
  type HarnessId,
  type HarnessPluginDescriptor,
} from "@codexhost/shared-contracts";

const DEFAULT_ACCOUNT_INSPECTION_TIMEOUT_MS = 12_000;

function harnessName(
  harnessId: HarnessId,
  descriptors: readonly HarnessPluginDescriptor[],
): string {
  return descriptors.find((plugin) => plugin.id === harnessId)?.name ?? harnessId;
}

/** Only Adapters with native account telemetry become progressive query sources. */
export function listHarnessAccountSources(
  adapters: Iterable<HarnessAdapter>,
  descriptors: readonly HarnessPluginDescriptor[],
): HarnessAccountSourceListResult {
  return harnessAccountSourceListResultSchema.parse({
    sources: [...adapters].flatMap((adapter) =>
      adapter.inspectAccount
        ? [
            {
              harnessId: adapter.harnessId,
              harnessName: harnessName(adapter.harnessId, descriptors),
            },
          ]
        : [],
    ),
  });
}

/** A failed, unsupported, or malformed plugin produces an empty result without leaking diagnostics. */
export async function inspectHarnessAccount(
  adapter: HarnessAdapter,
  descriptors: readonly HarnessPluginDescriptor[],
  timeoutMs = DEFAULT_ACCOUNT_INSPECTION_TIMEOUT_MS,
): Promise<HarnessAccountInspectResult> {
  const identity = {
    harnessId: adapter.harnessId,
    harnessName: harnessName(adapter.harnessId, descriptors),
  };
  if (!adapter.inspectAccount) {
    return harnessAccountInspectResultSchema.parse({ ...identity, account: null });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => adapter.inspectAccount?.()),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    const parsed = harnessAccountSnapshotSchema.safeParse(value);
    return harnessAccountInspectResultSchema.parse({
      ...identity,
      account: parsed.success ? parsed.data : null,
    });
  } catch {
    return harnessAccountInspectResultSchema.parse({ ...identity, account: null });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Legacy aggregate interface retained for older Renderer clients. */
export async function inspectHarnessAccounts(
  adapters: Iterable<HarnessAdapter>,
  descriptors: readonly HarnessPluginDescriptor[],
  timeoutMs = DEFAULT_ACCOUNT_INSPECTION_TIMEOUT_MS,
): Promise<HarnessAccountListResult> {
  const inspections = await Promise.all(
    [...adapters].map((adapter) => inspectHarnessAccount(adapter, descriptors, timeoutMs)),
  );
  return {
    accounts: inspections.flatMap(({ harnessId, harnessName, account }) =>
      account ? [{ ...account, harnessId, harnessName }] : [],
    ),
  };
}
