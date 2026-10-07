import {
  harnessIdSchema,
  type CodexhostError,
  type HarnessPluginDescriptor,
} from "@codexhost/shared-contracts";
import type { RendererAgentAvailability } from "../agent-selection-state.js";
import type { RendererModelClient } from "../renderer-model-client.js";
import type {
  RendererConnectionDiagnostics,
  RendererConnectionSnapshot,
} from "../settings/pages.js";

/** The console consumes the local Host directory, never a compiled Harness list. */
export function createConsoleConnectionDiagnostics(
  client: RendererModelClient,
): RendererConnectionDiagnostics {
  let plugins: readonly HarnessPluginDescriptor[] = [];
  let directoryError: string | undefined;
  const availability = new Map<string, RendererAgentAvailability>();
  const errors = new Map<string, CodexhostError | null>();
  const webUi = new Map<string, boolean>();
  const listeners = new Set<() => void>();
  let pending: Promise<void> | null = null;
  const publish = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const inspectAll = (refresh: boolean): Promise<void> => {
    if (pending) return pending;
    pending = Promise.resolve()
      .then(async () => {
        try {
          if (!client.listHarnessPlugins)
            throw new Error("This Host does not support Harness plugin discovery");
          plugins = (await client.listHarnessPlugins()).plugins;
          directoryError = undefined;
        } catch (error) {
          directoryError = error instanceof Error ? error.message : String(error);
          return;
        }
        for (const { id } of plugins) availability.set(id, "checking");
        publish();
        await Promise.all(
          plugins.map(async ({ id }) => {
            try {
              const inspection = await client.inspectHarness({ harnessId: id, refresh });
              availability.set(id, inspection.status);
              webUi.set(id, inspection.status === "ready" && inspection.webUi?.open === true);
              const error = inspection.status === "ready" ? null : inspection.error;
              errors.set(
                id,
                error
                  ? {
                      code: error.code,
                      message: error.message,
                      retryable: error.retryable,
                      ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
                      ...(error.stage ? { stage: error.stage } : {}),
                      ...(error.durationMs !== undefined ? { durationMs: error.durationMs } : {}),
                      ...(error.stderrTail ? { stderrTail: error.stderrTail } : {}),
                    }
                  : null,
              );
            } catch (error) {
              availability.set(id, "error");
              webUi.set(id, false);
              errors.set(id, {
                code: "internalError",
                message: error instanceof Error ? error.message : String(error),
                retryable: true,
                stage: "request",
              });
            }
            publish();
          }),
        );
      })
      .finally(() => {
        pending = null;
        publish();
      });
    return pending;
  };
  let started = false;
  const installation = client.installation?.bind(client);
  return {
    ...(installation
      ? {
          installation: async (
            hostId: string,
            agent: string,
            action: "check" | "update" | "install",
          ) => {
            if (hostId !== "local")
              throw new Error("Web console installation only supports the local Host");
            return installation({ harnessId: harnessIdSchema.parse(agent), action });
          },
        }
      : {}),
    snapshot(): RendererConnectionSnapshot {
      if (!started) {
        started = true;
        void inspectAll(false);
      }
      return {
        adapter: { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
        hosts: [
          {
            hostId: "local",
            active: true,
            ...(directoryError ? { directoryError } : {}),
            agents: plugins.map((plugin) => ({
              agent: plugin.id,
              plugin,
              availability: availability.get(plugin.id) ?? "checking",
              error: errors.get(plugin.id) ?? null,
              ...(webUi.get(plugin.id) ? { webUiAvailable: true as const } : {}),
            })),
          },
        ],
      };
    },
    refresh: () => inspectAll(true),
    async openWebUi(_hostId, agent) {
      if (!client.openHarnessWebUi) throw new Error("Harness Web UI is unavailable");
      await client.openHarnessWebUi({ harnessId: harnessIdSchema.parse(agent) });
    },
    async getLaunchSettings(_hostId, agent) {
      if (!client.getHarnessLaunchSettings) throw new Error("Launch settings are unavailable");
      return client.getHarnessLaunchSettings({ harnessId: harnessIdSchema.parse(agent) });
    },
    async setLaunchSettings(_hostId, agent, path) {
      if (!client.setHarnessLaunchSettings) throw new Error("Launch settings are unavailable");
      return client.setHarnessLaunchSettings({ harnessId: harnessIdSchema.parse(agent), path });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
