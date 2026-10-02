import { harnessIdSchema, type CodexhostError } from "@codexhost/shared-contracts";

import {
  KNOWN_RENDERER_AGENTS,
  type ExternalRendererAgent,
  type RendererAgentAvailability,
} from "../agent-selection-state.js";
import type { RendererModelClient } from "../renderer-model-client.js";
import type {
  RendererConnectionDiagnostics,
  RendererConnectionSnapshot,
} from "../settings/pages.js";

const EXTERNAL_AGENTS = KNOWN_RENDERER_AGENTS.filter(
  (agent): agent is ExternalRendererAgent => agent !== "codex",
);

/**
 * Connection diagnostics for the local Host, derived the same way as inside
 * Codex: one Harness inspection per Agent (Agent IDs are Harness IDs).
 */
export function createConsoleConnectionDiagnostics(
  client: RendererModelClient,
): RendererConnectionDiagnostics {
  const availability = new Map<ExternalRendererAgent, RendererAgentAvailability>();
  const errors = new Map<ExternalRendererAgent, CodexhostError | null>();
  const webUi = new Map<ExternalRendererAgent, boolean>();
  const listeners = new Set<() => void>();
  let pending: Promise<void> | null = null;
  const publish = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const inspectAll = (refresh: boolean): Promise<void> => {
    if (pending) return pending;
    for (const agent of EXTERNAL_AGENTS) availability.set(agent, "checking");
    publish();
    pending = Promise.all(
      EXTERNAL_AGENTS.map(async (agent) => {
        try {
          const inspection = await client.inspectHarness({ harnessId: agent as never, refresh });
          availability.set(agent, inspection.status === "ready" ? "ready" : inspection.status);
          webUi.set(agent, inspection.status === "ready" && inspection.webUi?.open === true);
          errors.set(
            agent,
            inspection.status === "ready"
              ? null
              : {
                  code: inspection.error.code,
                  message: inspection.error.message,
                  retryable: inspection.error.retryable,
                  ...(inspection.error.diagnostic
                    ? { diagnostic: inspection.error.diagnostic }
                    : {}),
                  ...(inspection.error.stage ? { stage: inspection.error.stage } : {}),
                  ...(inspection.error.durationMs !== undefined
                    ? { durationMs: inspection.error.durationMs }
                    : {}),
                  ...(inspection.error.stderrTail
                    ? { stderrTail: inspection.error.stderrTail }
                    : {}),
                },
          );
        } catch (error) {
          availability.set(agent, "error");
          webUi.set(agent, false);
          errors.set(agent, {
            code: "internalError",
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
            stage: "request",
          });
        }
        publish();
      }),
    ).then(
      () => {
        pending = null;
      },
      () => {
        pending = null;
      },
    );
    return pending;
  };

  let started = false;
  const installation = client.installation?.bind(client);
  return {
    ...(installation
      ? ({
          installation: async (hostId, agent, action) => {
            if (hostId !== "local") {
              throw new Error("Web console installation only supports the local Host");
            }
            return installation({ harnessId: harnessIdSchema.parse(agent), action });
          },
        } satisfies Pick<RendererConnectionDiagnostics, "installation">)
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
            agents: EXTERNAL_AGENTS.map((agent) => ({
              agent,
              availability: availability.get(agent) ?? "checking",
              error: errors.get(agent) ?? null,
              ...(webUi.get(agent) ? { webUiAvailable: true as const } : {}),
            })),
          },
        ],
      };
    },
    refresh: () => inspectAll(true),
    async openWebUi(_hostId, agent) {
      if (!client.openHarnessWebUi) throw new Error("Harness Web UI is unavailable");
      await client.openHarnessWebUi({ harnessId: agent as never });
    },
    async getLaunchSettings(_hostId, agent) {
      if (!client.getHarnessLaunchSettings) throw new Error("Launch settings are unavailable");
      return client.getHarnessLaunchSettings({ harnessId: agent as never });
    },
    async setLaunchSettings(_hostId, agent, path) {
      if (!client.setHarnessLaunchSettings) throw new Error("Launch settings are unavailable");
      return client.setHarnessLaunchSettings({ harnessId: agent as never, path });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
