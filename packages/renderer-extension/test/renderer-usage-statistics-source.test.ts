import { describe, expect, it, vi, type Mock } from "vitest";

import type { RendererHostRouting } from "@codexhost/desktop-control/renderer-bindings";

import { createRendererUsageStatisticsSource } from "../src/renderer-usage-statistics-source.js";

function routing(hosts: Record<string, Mock>): RendererHostRouting {
  return {
    forHost: (hostId) =>
      hosts[hostId]
        ? {
            hostId,
            manager: {
              sendRequest: hosts[hostId],
            },
          }
        : null,
    knownHostIds: () => Object.keys(hosts),
    hostIdForComposer: () => null,
    forComposer: () => null,
    dispose: () => undefined,
  } as unknown as RendererHostRouting;
}

function connection(hostId: string, displayName: string) {
  return {
    hostId,
    displayName,
    source: "codex-managed" as const,
    sshAlias: null,
    sshHost: "build-host",
    sshPort: null,
    identity: null,
    autoConnect: false,
  };
}

describe("desktop usage statistics transport", () => {
  it("sends a request to the selected machine, not to the local one", async () => {
    const local = vi.fn(async () => ({ local: true }));
    const remote = vi.fn(async () => ({ remote: true }));
    const source = createRendererUsageStatisticsSource({
      routing: () => routing({ local, "remote-ssh-codex-managed:fixture": remote }),
      listConnections: async () => [],
      disposed: () => false,
    });

    await expect(
      source.request(
        "codexhost/usage/statistics/get",
        { range: "30d" },
        "remote-ssh-codex-managed:fixture",
      ),
    ).resolves.toEqual({ remote: true });
    expect(remote).toHaveBeenCalledWith("codexhost/usage/statistics/get", { range: "30d" });
    expect(local).not.toHaveBeenCalled();
  });

  it("fails instead of describing another machine when the selected one is unreachable", async () => {
    const local = vi.fn(async () => ({ local: true }));
    const source = createRendererUsageStatisticsSource({
      routing: () => routing({ local }),
      listConnections: async () => [],
      disposed: () => false,
    });

    await expect(
      source.request("codexhost/usage/statistics/get", {}, "remote-ssh-discovered:mac"),
    ).rejects.toThrow("Host connection is unavailable (remote-ssh-discovered:mac)");
    expect(local).not.toHaveBeenCalled();
  });

  it("offers connected and configured machines under their connection names", async () => {
    const source = createRendererUsageStatisticsSource({
      routing: () => routing({ local: vi.fn(), "remote-ssh-codex-managed:fixture": vi.fn() }),
      listConnections: async () => [
        connection("remote-ssh-codex-managed:fixture", "Build machine"),
        connection("remote-ssh-codex-managed:second", "Laptop"),
      ],
      disposed: () => false,
    });

    expect(await source.hosts()).toEqual([
      { hostId: "local" },
      { hostId: "remote-ssh-codex-managed:fixture", label: "Build machine" },
      // Configured but not connected: listed so it can be picked and report its own error.
      { hostId: "remote-ssh-codex-managed:second", label: "Laptop" },
    ]);
  });

  it("still lists connected machines when the connection list is unavailable", async () => {
    const source = createRendererUsageStatisticsSource({
      routing: () => routing({ local: vi.fn(), "remote-ssh-codex-managed:fixture": vi.fn() }),
      listConnections: async () => {
        throw new Error("Remote connections are unavailable");
      },
      disposed: () => false,
    });

    expect(await source.hosts()).toEqual([
      { hostId: "local" },
      { hostId: "remote-ssh-codex-managed:fixture" },
    ]);
  });
});
