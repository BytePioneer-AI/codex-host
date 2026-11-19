import { harnessIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";
import type { RendererAgentAvailability } from "../../src/agent-selection-state.js";
import type {
  RendererConnectionDiagnostics,
  RendererConnectionHostSnapshot,
} from "../../src/settings/connections-page.js";
import { loadSessionImportSources } from "../../src/settings/session-import-sources.js";

function fixture(status?: RendererAgentAvailability) {
  const harnesses = ["pi", "grok"].map((id) => ({
    harnessId: harnessIdSchema.parse(id),
    name: id,
  }));
  const client = {
    hostId: "remote-1",
    listSessionImportSources: vi.fn(async () => ({ harnesses })),
    listHarnessSessions: vi.fn(),
    importHarnessSession: vi.fn(),
  };
  const host = (
    hostId: string,
    availability: RendererAgentAvailability,
  ): RendererConnectionHostSnapshot => ({
    hostId,
    active: false,
    agents: harnesses.map(({ harnessId }) => ({ agent: harnessId, availability, error: null })),
  });
  let hosts = [host("local", "notInstalled"), ...(status ? [host("remote-1", status)] : [])];
  const refresh = vi.fn(async () => {
    const remote = host("remote-1", "ready");
    hosts = [
      host("local", "notInstalled"),
      {
        ...remote,
        agents: remote.agents.map((agent) => ({
          ...agent,
          availability: agent.agent === "grok" ? "notInstalled" : "ready",
        })),
      },
    ];
  });
  const diagnostics: RendererConnectionDiagnostics = {
    snapshot: () => ({
      adapter: { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
      hosts,
    }),
    refresh,
    subscribe: () => () => undefined,
  };
  const controller = new AbortController();
  const load = (force = false) =>
    loadSessionImportSources(client, diagnostics, controller.signal, force);
  return { client, diagnostics, refresh, controller, load };
}

describe("Session import connection diagnostics", () => {
  it.each(["ready", "notInstalled", "unavailable", "error"] as const)(
    "reuses the selected Host's complete %s cache",
    async (status) => {
      const { load, refresh } = fixture(status);
      expect((await load()).map(({ name }) => name)).toEqual(
        status === "notInstalled" ? [] : ["pi", "grok"],
      );
      expect(refresh).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "checking"] as const)(
    "checks an absent or pending cache (%s) before exposing sources",
    async (status) => {
      const { load, refresh } = fixture(status);
      expect((await load()).map(({ name }) => name)).toEqual(["pi"]);
      expect(refresh).toHaveBeenCalledExactlyOnceWith("remote-1");
      await load();
      expect(refresh).toHaveBeenCalledTimes(1);
    },
  );

  it("rechecks a complete cache on explicit refresh", async () => {
    const { load, refresh } = fixture("notInstalled");
    expect(await load()).toEqual([]);
    expect((await load(true)).map(({ name }) => name)).toEqual(["pi"]);
    expect(refresh).toHaveBeenCalledExactlyOnceWith("remote-1");
  });

  it("reads diagnostics after asynchronous source discovery completes", async () => {
    const { load, refresh, client } = fixture();
    const sources = await client.listSessionImportSources();
    client.listSessionImportSources.mockImplementation(async () => {
      await refresh();
      return sources;
    });
    expect((await load()).map(({ name }) => name)).toEqual(["pi"]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not expose unchecked sources if inspection returns no result", async () => {
    const { load, refresh } = fixture();
    refresh.mockResolvedValue(undefined);
    await expect(load()).rejects.toThrow("diagnostics are incomplete");
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("reports inspection failure instead of returning all sources", async () => {
    const { load, refresh } = fixture();
    refresh.mockRejectedValue(new Error("Host disconnected"));
    await expect(load()).rejects.toThrow("Host disconnected");
  });

  it("discards inspection results when the page changes Host or closes", async () => {
    const { load, refresh, controller } = fixture();
    refresh.mockImplementation(async () => {
      controller.abort();
    });
    await expect(load()).rejects.toMatchObject({ name: "AbortError" });
  });
});
