import {
  DEFAULT_IDLE_RELEASE_SETTINGS,
  idleReleaseSettingsSchema,
  type IdleReleaseSettings,
} from "@codexhost/shared-contracts";
import type { RendererModelClient } from "./renderer-model-client.js";
import {
  HARNESS_PREFERENCES_UPDATED_EVENT,
  rendererHarnessPreferences,
  rendererHarnessPreferenceStatus,
  writeRendererHarnessPreferences,
} from "./renderer-harness-preferences.js";

/** Legacy key is read by the one-time migration only. */
export const IDLE_RELEASE_STORAGE_KEY = "codexhost.idle-release.v1";
export const IDLE_RELEASE_CHANGE_EVENT = "codexhost:idle-release-changed";
export const IDLE_RELEASE_STATUS_EVENT = "codexhost:idle-release-status";
export type IdleReleaseSyncStatus = "pending" | "applied" | "unavailable" | "failed";
export function readIdleReleasePreference(owner: Window): IdleReleaseSettings {
  void owner;
  return { ...(rendererHarnessPreferences()?.values.idleRelease ?? DEFAULT_IDLE_RELEASE_SETTINGS) };
}
export function writeIdleReleasePreference(owner: Window, value: IdleReleaseSettings): boolean {
  const parsed = idleReleaseSettingsSchema.safeParse(value);
  if (
    !parsed.success ||
    !rendererHarnessPreferences() ||
    rendererHarnessPreferenceStatus() === "unavailable"
  )
    return false;
  void writeRendererHarnessPreferences(owner, "local", [
    { kind: "idleRelease", value: parsed.data },
  ]).catch(() => {});
  return true;
}
export const IDLE_RELEASE_REMOTE_STATUS_EVENT = "codexhost:idle-release-remote-status";
type RemoteClient = Pick<RendererModelClient, "setIdleReleaseSettings">;
interface RemoteHost {
  client: RemoteClient;
  status: IdleReleaseSyncStatus;
  attempted?: IdleReleaseSettings;
  inFlight: boolean;
}
type RemoteStatus = { hostId: string; status: IdleReleaseSyncStatus };
const remoteStatuses = new WeakMap<Window, readonly RemoteStatus[]>();

export function readIdleReleaseRemoteStatus(owner: Window): readonly RemoteStatus[] {
  return remoteStatuses.get(owner) ?? [];
}

function sameSettings(left: IdleReleaseSettings | undefined, right: IdleReleaseSettings): boolean {
  return left?.enabled === right.enabled && left.timeoutMinutes === right.timeoutMinutes;
}

/** Settings controls observe confirmed local Host policy and relay it to live SSH connections. */
export function installIdleReleasePreferenceSync(
  owner: Window,
  readSshClients?: () => ReadonlyMap<string, RemoteClient>,
) {
  const remotes = new Map<string, RemoteHost>();
  let disposed = false;
  const publishRemote = () => {
    const snapshot = [...remotes].map(([hostId, { status }]) => ({ hostId, status }));
    remoteStatuses.set(owner, snapshot);
    owner.dispatchEvent(new CustomEvent(IDLE_RELEASE_REMOTE_STATUS_EVENT, { detail: snapshot }));
  };
  const apply = () => {
    if (disposed || rendererHarnessPreferenceStatus() !== "applied") return;
    const settings = readIdleReleasePreference(owner);
    for (const [id, remote] of remotes) {
      if (remote.inFlight || sameSettings(remote.attempted, settings)) continue;
      remote.attempted = settings;
      if (!remote.client.setIdleReleaseSettings) continue;
      const applySettings = remote.client.setIdleReleaseSettings.bind(remote.client);
      remote.inFlight = true;
      remote.status = "pending";
      publishRemote();
      void (async () => {
        let status: IdleReleaseSyncStatus;
        try {
          const accepted = await applySettings(settings);
          status = sameSettings(accepted, settings) ? "applied" : "failed";
        } catch (error) {
          const code = (error as { code?: number } | null)?.code;
          status = code === -32601 || code === -32078 ? "unavailable" : "failed";
        } finally {
          remote.inFlight = false;
        }
        if (disposed || remotes.get(id) !== remote) return;
        if (sameSettings(readIdleReleasePreference(owner), settings)) {
          remote.status = status;
          publishRemote();
        }
        apply();
      })();
    }
  };
  const changed = (event: Event) => {
    if ((event as CustomEvent<{ hostId: string }>).detail?.hostId !== "local") return;
    owner.dispatchEvent(
      new CustomEvent(IDLE_RELEASE_STATUS_EVENT, { detail: rendererHarnessPreferenceStatus() }),
    );
    owner.dispatchEvent(new Event(IDLE_RELEASE_CHANGE_EVENT));
    apply();
  };
  owner.addEventListener(HARNESS_PREFERENCES_UPDATED_EVENT, changed);
  const connect = (clients: ReadonlyMap<string, RemoteClient>): void => {
    if (disposed) return;
    let connectionChanged = false;
    for (const id of remotes.keys()) {
      if (!clients.has(id)) {
        remotes.delete(id);
        connectionChanged = true;
      }
    }
    for (const [id, client] of clients) {
      if (remotes.get(id)?.client === client) continue;
      remotes.set(id, {
        client,
        status: client.setIdleReleaseSettings ? "pending" : "unavailable",
        inFlight: false,
      });
      connectionChanged = true;
    }
    if (connectionChanged) publishRemote();
    apply();
  };
  // A reconnect can leave the local Composer and DOM unchanged, so its route event is not sufficient.
  const timer = readSshClients
    ? owner.setInterval(() => {
        if (rendererHarnessPreferences()?.values.idleRelease) connect(readSshClients());
      }, 5_000)
    : undefined;
  return {
    connect,
    dispose() {
      disposed = true;
      owner.removeEventListener(HARNESS_PREFERENCES_UPDATED_EVENT, changed);
      if (timer !== undefined) owner.clearInterval(timer);
      remotes.clear();
      remoteStatuses.delete(owner);
    },
  };
}
