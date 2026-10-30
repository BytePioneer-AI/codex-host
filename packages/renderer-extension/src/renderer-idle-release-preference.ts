import {
  DEFAULT_IDLE_RELEASE_SETTINGS,
  idleReleaseSettingsSchema,
  type IdleReleaseSettings,
} from "@codexhost/shared-contracts";
import type { RendererModelClient } from "./renderer-model-client.js";
import { RendererMethodUnavailableError } from "./renderer-request-sender.js";

export const IDLE_RELEASE_STORAGE_KEY = "codexhost.idle-release.v1";
export const IDLE_RELEASE_CHANGE_EVENT = "codexhost:idle-release-changed";
export const IDLE_RELEASE_STATUS_EVENT = "codexhost:idle-release-status";
export type IdleReleaseSyncStatus = "pending" | "applied" | "unavailable" | "failed";

export function readIdleReleasePreference(owner: Window): IdleReleaseSettings {
  try {
    const raw = owner.localStorage.getItem(IDLE_RELEASE_STORAGE_KEY);
    const parsed = idleReleaseSettingsSchema.safeParse(raw ? JSON.parse(raw) : null);
    if (parsed.success) return parsed.data;
  } catch {
    /* An unavailable preference store must not enable resource release. */
  }
  return { ...DEFAULT_IDLE_RELEASE_SETTINGS };
}

export function writeIdleReleasePreference(owner: Window, value: IdleReleaseSettings): boolean {
  const parsed = idleReleaseSettingsSchema.safeParse(value);
  if (!parsed.success) return false;
  try {
    owner.localStorage.setItem(IDLE_RELEASE_STORAGE_KEY, JSON.stringify(parsed.data));
  } catch {
    return false;
  }
  owner.dispatchEvent(new Event(IDLE_RELEASE_CHANGE_EVENT));
  return true;
}

/** One connection synchronizer per Renderer installation; never uses the active remote route. */
export function installIdleReleasePreferenceSync(owner: Window): {
  connect(client: RendererModelClient | null): void;
  dispose(): void;
} {
  let client: RendererModelClient | null = null;
  let disposed = false;
  let generation = 0;
  let work = { pending: false, dirty: false };
  const publish = (value: IdleReleaseSyncStatus): void => {
    owner.dispatchEvent(new CustomEvent(IDLE_RELEASE_STATUS_EVENT, { detail: value }));
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
        if (!target.setIdleReleaseSettings) {
          publish("unavailable");
          continue;
        }
        // Read at send time, never replay a window's cached preference on reconnect.
        const settings = readIdleReleasePreference(owner);
        publish("pending");
        try {
          await target.setIdleReleaseSettings(settings);
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
    if (event.key === IDLE_RELEASE_STORAGE_KEY || event.key === null) changed();
  };
  owner.addEventListener(IDLE_RELEASE_CHANGE_EVENT, changed);
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
      owner.removeEventListener(IDLE_RELEASE_CHANGE_EVENT, changed);
      owner.removeEventListener("storage", storage);
    },
  };
}
