import type { HarnessAdapter } from "@codexhost/harness-adapter";
import {
  harnessAccountInspectResultSchema,
  harnessAccountSnapshotSchema,
  harnessAccountSourceListResultSchema,
  type HarnessAccountInspectResult,
  type HarnessAccountListResult,
  type HarnessAccountSnapshot,
  type HarnessAccountSourceListResult,
  type HarnessId,
  type HarnessPluginDescriptor,
} from "@codexhost/shared-contracts";

const DEFAULT_ACCOUNT_INSPECTION_TIMEOUT_MS = 12_000;
const DEFAULT_ACCOUNT_CACHE_TTL_MS = 15_000;

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
      adapter.inspectAccount || adapter.inspectAccounts
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
  if (!adapter.inspectAccount && !adapter.inspectAccounts) {
    return harnessAccountInspectResultSchema.parse({ ...identity, account: null });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      Promise.resolve().then(async (): Promise<unknown> =>
        adapter.inspectAccounts ? adapter.inspectAccounts() : adapter.inspectAccount?.(),
      ),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    const accounts = projectAccountSnapshots(value);
    return harnessAccountInspectResultSchema.parse({
      ...identity,
      account: accounts[0] ?? null,
      ...(accounts.length > 1 ? { accounts } : {}),
    });
  } catch {
    return harnessAccountInspectResultSchema.parse({ ...identity, account: null });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const MAX_HARNESS_ACCOUNT_SNAPSHOTS = 8;

function projectAccountSnapshots(value: unknown): HarnessAccountSnapshot[] {
  const candidates = Array.isArray(value) ? value : value == null ? [] : [value];
  const accounts: HarnessAccountSnapshot[] = [];
  for (const candidate of candidates) {
    if (accounts.length >= MAX_HARNESS_ACCOUNT_SNAPSHOTS) break;
    const parsed = harnessAccountSnapshotSchema.safeParse(candidate);
    if (parsed.success) accounts.push(parsed.data);
  }
  return accounts;
}

/** Rows exposed to settings, including every Billing Source from one inspection. */
export function listedHarnessAccounts(
  result: HarnessAccountInspectResult,
): HarnessAccountListResult["accounts"] {
  const rows = result.accounts ?? (result.account ? [result.account] : []);
  return rows.map((account) => ({
    ...account,
    harnessId: result.harnessId,
    harnessName: result.harnessName,
  }));
}

interface CachedHarnessAccountInspection {
  readonly result: HarnessAccountInspectResult;
  readonly freshUntil: number;
}

/** Per-Harness result cache shared by progressive and legacy account inspection routes. */
export class HarnessAccountInspectionCache {
  readonly #results = new Map<HarnessId, CachedHarnessAccountInspection>();
  readonly #flights = new Map<HarnessId, Promise<HarnessAccountInspectResult>>();

  constructor(
    private readonly ttlMs = DEFAULT_ACCOUNT_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  inspect(
    adapter: HarnessAdapter,
    descriptors: readonly HarnessPluginDescriptor[],
    refresh = false,
  ): Promise<HarnessAccountInspectResult> {
    const cached = this.#results.get(adapter.harnessId);
    if (!refresh && cached && this.now() < cached.freshUntil) {
      return Promise.resolve(cached.result);
    }
    const active = this.#flights.get(adapter.harnessId);
    if (active) return active;
    const flight = inspectHarnessAccount(adapter, descriptors)
      .then((result) => {
        this.#results.set(adapter.harnessId, {
          result,
          freshUntil: this.now() + this.ttlMs,
        });
        return result;
      })
      .finally(() => {
        if (this.#flights.get(adapter.harnessId) === flight) {
          this.#flights.delete(adapter.harnessId);
        }
      });
    this.#flights.set(adapter.harnessId, flight);
    return flight;
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
    accounts: inspections.flatMap((result) => listedHarnessAccounts(result)),
  };
}
