import type { RendererHostRouting } from "@codexhost/desktop-control/renderer-bindings";

import type { CodexSshConnection } from "./codex-ssh-adapter.js";
import type {
  RendererUsageStatisticsHostsProvider,
  RendererUsageStatisticsRequest,
} from "./console/pages/usage-statistics.js";

/**
 * Usage statistics transport for the Desktop settings page. Each Host aggregates only its own
 * machine, so the page reads one Host at a time: remote machines come from the Desktop's existing
 * connections, and a request for an unreachable machine fails instead of silently describing a
 * different one. The web console has only its local Host channel and does not use this source.
 */
export function createRendererUsageStatisticsSource(options: {
  routing(): RendererHostRouting | undefined;
  listConnections(): Promise<readonly CodexSshConnection[]>;
  disposed(): boolean;
}): { request: RendererUsageStatisticsRequest; hosts: RendererUsageStatisticsHostsProvider } {
  return {
    async request(method, params, hostId) {
      const route = options.routing()?.forHost(hostId);
      if (options.disposed() || !route) {
        throw new Error(`Host connection is unavailable (${hostId})`);
      }
      return route.manager.sendRequest(method, params);
    },
    async hosts() {
      // Connected machines, plus connections the Desktop has configured but not opened yet.
      const connections = await options.listConnections().catch(() => []);
      const names = new Map(
        connections.map((connection) => [connection.hostId, connection.displayName]),
      );
      const known = options.routing()?.knownHostIds?.() ?? [];
      return [...new Set([...known, ...names.keys()])].map((hostId) => {
        const label = names.get(hostId);
        return label === undefined ? { hostId } : { hostId, label };
      });
    },
  };
}
