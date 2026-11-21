import {
  DEFAULT_DELEGATION_CAPACITY_SETTINGS,
  delegationCapacitySettingsSchema,
  type DelegationCapacitySettings,
} from "@codexhost/shared-contracts";
import type { RendererModelClient } from "./renderer-model-client.js";
import { RendererMethodUnavailableError } from "./renderer-request-sender.js";

export const DELEGATION_CAPACITY_STORAGE_KEY = "codexhost.delegation-capacity.v1";
export const DELEGATION_CAPACITY_CHANGE_EVENT = "codexhost:delegation-capacity-changed";
export const DELEGATION_CAPACITY_STATUS_EVENT = "codexhost:delegation-capacity-status";
export type DelegationCapacitySyncStatus = "pending" | "applied" | "unavailable" | "failed";

export function readDelegationCapacityPreference(owner: Window): DelegationCapacitySettings {
  try {
    const raw = owner.localStorage.getItem(DELEGATION_CAPACITY_STORAGE_KEY);
    const parsed = delegationCapacitySettingsSchema.safeParse(raw ? JSON.parse(raw) : null);
    if (parsed.success) return parsed.data;
  } catch {
    /* An unavailable preference store must not start queueing delegations. */
  }
  return { ...DEFAULT_DELEGATION_CAPACITY_SETTINGS };
}

export function writeDelegationCapacityPreference(
  owner: Window,
  value: DelegationCapacitySettings,
): boolean {
  const parsed = delegationCapacitySettingsSchema.safeParse(value);
  if (!parsed.success) return false;
  try {
    owner.localStorage.setItem(DELEGATION_CAPACITY_STORAGE_KEY, JSON.stringify(parsed.data));
  } catch {
    return false;
  }
  owner.dispatchEvent(new Event(DELEGATION_CAPACITY_CHANGE_EVENT));
  return true;
}

/** One connection synchronizer per Renderer installation; never uses the active remote route. */
export function installDelegationCapacityPreferenceSync(owner: Window): {
  connect(client: RendererModelClient | null): void;
  dispose(): void;
} {
  let client: RendererModelClient | null = null;
  let disposed = false;
  let generation = 0;
  let work = { pending: false, dirty: false };
  const publish = (value: DelegationCapacitySyncStatus): void => {
    owner.dispatchEvent(new CustomEvent(DELEGATION_CAPACITY_STATUS_EVENT, { detail: value }));
  };
  const sync = async (): Promise<void> => {
    const currentWork = work;
    const version = generation;
    currentWork.dirty = true;
    if (currentWork.pending || disposed) return;
    currentWork.pending = true;
    try {
      while (currentWork.dirty && !disposed && version === generation) {
        currentWork.dirty = false;
        const target = client;
        if (!target) {
          publish("pending");
          continue;
        }
        if (!target.setDelegationCapacitySettings) {
          publish("unavailable");
          continue;
        }
        // Read at send time, never replay a window's cached preference on reconnect.
        const settings = readDelegationCapacityPreference(owner);
        publish("pending");
        try {
          await target.setDelegationCapacitySettings(settings);
          if (!disposed && version === generation && !currentWork.dirty) publish("applied");
        } catch (error) {
          if (!disposed && version === generation) {
            publish(error instanceof RendererMethodUnavailableError ? "unavailable" : "failed");
          }
        }
      }
    } finally {
      currentWork.pending = false;
    }
  };
  const changed = (): void => {
    void sync();
  };
  const storage = (event: StorageEvent): void => {
    if (event.key === DELEGATION_CAPACITY_STORAGE_KEY || event.key === null) changed();
  };
  owner.addEventListener(DELEGATION_CAPACITY_CHANGE_EVENT, changed);
  owner.addEventListener("storage", storage);
  return {
    connect(next) {
      if (disposed) return;
      if (next === client) return;
      client = next;
      generation += 1;
      work = { pending: false, dirty: false };
      void sync();
    },
    dispose() {
      disposed = true;
      generation += 1;
      client = null;
      owner.removeEventListener(DELEGATION_CAPACITY_CHANGE_EVENT, changed);
      owner.removeEventListener("storage", storage);
    },
  };
}
