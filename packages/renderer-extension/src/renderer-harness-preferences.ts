/** Confirmed Host snapshots back synchronous Renderer preference readers. */
import {
  harnessDefaultConfigurationSchema,
  harnessPreferencePatchSchema,
  installedHarnessPluginIdSchema,
  idleReleaseSettingsSchema,
  type HarnessPreferenceSnapshot,
  type HarnessPreferenceOperation,
} from "@codexhost/shared-contracts";
import type { RendererModelClient } from "./renderer-model-client.js";

export const HARNESS_PREFERENCES_UPDATED_EVENT = "codexhost:harness-preferences-updated";
interface State {
  generation: number;
  snapshot?: HarnessPreferenceSnapshot;
  client: RendererModelClient | null;
  tail: Promise<unknown>;
  status: "pending" | "applied" | "unavailable" | "failed";
}
const states = new Map<string, State>();
const stateOf = (id: string) => {
  let state = states.get(id);
  if (!state) {
    state = { generation: 0, client: null, tail: Promise.resolve(), status: "pending" };
    states.set(id, state);
  }
  return state;
};
export function rendererHarnessPreferences(hostId = "local") {
  return stateOf(hostId).snapshot;
}
export function rendererHarnessPreferenceStatus(hostId = "local") {
  return stateOf(hostId).status;
}
export function rendererHarnessPreferenceGeneration(hostId = "local") {
  return stateOf(hostId).generation;
}
function notify(owner: Window, hostId: string) {
  owner.dispatchEvent(new CustomEvent(HARNESS_PREFERENCES_UPDATED_EVENT, { detail: { hostId } }));
}
function accept(owner: Window, hostId: string, snapshot: HarnessPreferenceSnapshot) {
  const state = stateOf(hostId);
  if (state.snapshot && snapshot.revision < state.snapshot.revision) return;
  const changed =
    state.status !== "applied" || JSON.stringify(state.snapshot) !== JSON.stringify(snapshot);
  state.snapshot = snapshot;
  state.status = "applied";
  if (changed) notify(owner, hostId);
}
export function writeRendererHarnessPreferences(
  owner: Window,
  hostId: string,
  operations: HarnessPreferenceOperation[],
) {
  const state = stateOf(hostId);
  const client = state.client;
  const generation = state.generation;
  state.status = "pending";
  notify(owner, hostId);
  const work = state.tail.then(async () => {
    if (
      !client?.patchHarnessPreferences ||
      client !== state.client ||
      generation !== state.generation
    )
      throw new Error("Harness preference owner is unavailable");
    const result = await client.patchHarnessPreferences({ scope: "external", operations });
    if (client === state.client && generation === state.generation) accept(owner, hostId, result);
  });
  state.tail = work.catch(() => {
    if (client === state.client && generation === state.generation) {
      state.status = "failed";
      notify(owner, hostId);
    }
  });
  return work;
}

function legacyOperations(owner: Window, hostId: string): HarnessPreferenceOperation[] {
  const operations: HarnessPreferenceOperation[] = [];
  try {
    const storage = owner.localStorage;
    const json = (key: string): unknown => {
      try {
        return JSON.parse(storage.getItem(key) ?? "null");
      } catch {
        return null;
      }
    };
    let legacyPermission: string | undefined;
    if (hostId === "local") {
      const idle = idleReleaseSettingsSchema.safeParse(json("codexhost.idle-release.v1"));
      if (idle.success) operations.push({ kind: "idleRelease", value: idle.data });
      const permission = storage.getItem("codexhost.claude-code.permission-mode.v1");
      if (permission) {
        const configuration = harnessDefaultConfigurationSchema.safeParse({
          permissionModeId: permission,
        });
        if (configuration.success) legacyPermission = configuration.data.permissionModeId;
      }
    }
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (!key?.startsWith("codexhost.model-favorites.v1:")) continue;
      const id = installedHarnessPluginIdSchema.safeParse(
        key.slice("codexhost.model-favorites.v1:".length),
      );
      if (!id.success || id.data === "codex") continue;
      const value: unknown = json(key);
      if (Array.isArray(value))
        operations.push({
          kind: "favorites",
          harnessId: id.data,
          modelIds: value.filter((id): id is string => typeof id === "string" && id.length > 0),
        });
    }
    const key =
      "codexhost.new-thread-preference.v1" +
      (hostId === "local" ? "" : `.host.${encodeURIComponent(hostId)}`);
    const value = json(key) as {
      lastAgent?: unknown;
      externalByAgent?: Record<string, unknown>;
    } | null;
    const agent = installedHarnessPluginIdSchema.safeParse(value?.lastAgent);
    if (agent.success) operations.push({ kind: "newThread", lastHarness: agent.data });
    for (const [id, config] of Object.entries(value?.externalByAgent ?? {})) {
      const parsedId = installedHarnessPluginIdSchema.safeParse(id);
      const parsed = harnessDefaultConfigurationSchema.safeParse(config);
      if (parsedId.success && parsedId.data !== "codex" && parsed.success)
        operations.push({
          kind: "newThread",
          harnessId: parsedId.data,
          configuration:
            id === "claude-code" && legacyPermission && !parsed.data.permissionModeId
              ? {
                  ...parsed.data,
                  permissionModeId: legacyPermission as typeof parsed.data.permissionModeId,
                }
              : parsed.data,
        });
    }
    if (
      legacyPermission &&
      !operations.some((op) => op.kind === "newThread" && op.harnessId === "claude-code")
    )
      operations.push({
        kind: "newThread",
        harnessId: installedHarnessPluginIdSchema.parse("claude-code"),
        configuration: {
          permissionModeId: legacyPermission as ReturnType<
            typeof harnessDefaultConfigurationSchema.parse
          >["permissionModeId"],
        },
      });
  } catch {
    /* Invalid legacy data never replaces confirmed Host state. */
  }
  return operations;
}

export function installRendererHarnessPreferenceSync(owner: Window) {
  const connections = new Map<string, { client: RendererModelClient | null; stop(): void }>();
  let closed = false;
  return {
    connect(hostId: string, client: RendererModelClient | null) {
      if (closed || connections.get(hostId)?.client === client) return;
      connections.get(hostId)?.stop();
      // Register before notifying: Renderer callbacks may synchronously resolve this route again.
      connections.set(hostId, { client, stop() {} });
      const state = stateOf(hostId);
      state.client = client;
      state.generation++;
      state.tail = Promise.resolve();
      delete state.snapshot;
      state.status = "pending";
      if (!client?.getHarnessPreferences || !client.patchHarnessPreferences) {
        state.status = "unavailable";
        notify(owner, hostId);
        return;
      }
      notify(owner, hostId);
      let busy = false;
      let dirty = false;
      let disposed = false;
      let migrated = false;
      const refresh = async () => {
        dirty = true;
        if (busy || disposed) return;
        busy = true;
        try {
          while (dirty && !disposed) {
            dirty = false;
            let snapshot = await client.getHarnessPreferences?.();
            if (!snapshot || disposed) return;
            if (!migrated) {
              const operations = legacyOperations(owner, hostId);
              if (operations.length) {
                const result = await client.patchHarnessPreferences?.(
                  harnessPreferencePatchSchema.parse({
                    scope: "external",
                    operations,
                    initializeOnly: true,
                  }),
                );
                if (result) snapshot = result;
              }
              migrated = true;
            }
            if (!disposed) accept(owner, hostId, snapshot);
          }
        } catch {
          if (!disposed) {
            state.status = "unavailable";
            notify(owner, hostId);
          }
        } finally {
          busy = false;
        }
      };
      const remove = client.subscribeHarnessPreferences?.(() => {
        void refresh();
      });
      const onFocus = () => {
        void refresh();
      };
      const onVisible = () => {
        if (owner.document.visibilityState === "visible") void refresh();
      };
      owner.addEventListener("focus", onFocus);
      owner.document?.addEventListener("visibilitychange", onVisible);
      connections.set(hostId, {
        client,
        stop() {
          disposed = true;
          remove?.();
          owner.removeEventListener("focus", onFocus);
          owner.document?.removeEventListener("visibilitychange", onVisible);
        },
      });
      void refresh();
    },
    dispose() {
      closed = true;
      for (const [id, connection] of connections) {
        connection.stop();
        const state = stateOf(id);
        if (state.client === connection.client) {
          state.client = null;
          state.generation++;
          delete state.snapshot;
          state.status = "unavailable";
        }
      }
      connections.clear();
    },
  };
}

export function rendererNewThreadPreferenceMemoryStorage(hostId = "local") {
  return {
    patch(operations: HarnessPreferenceOperation[]) {
      void writeRendererHarnessPreferences(window, hostId, operations).catch(() => {});
    },
    getItem() {
      const defaults = rendererHarnessPreferences(hostId)?.values.newThread;
      return defaults
        ? JSON.stringify({
            version: 1,
            lastAgent: defaults.lastHarness ?? "codex",
            externalByAgent: defaults.byHarness,
          })
        : null;
    },
  };
}
