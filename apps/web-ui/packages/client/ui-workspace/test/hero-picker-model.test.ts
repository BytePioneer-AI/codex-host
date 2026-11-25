import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkspaceId, WorkspaceView } from "@deepseek-ai/dsh-api-workspace-controller/client";
import {
  buildHeroLocationOptions,
  filterHeroLocations,
  filterHeroProjects,
  findCreatedRemoteWorkspace,
  hostKeyOfWorkspace,
  parseConfiguredRemotePeers,
  workspaceParentHint,
} from "../src/client/hero-picker-model.ts";

function makeWorkspace(overrides: Partial<WorkspaceView> & { workspaceId: string }): WorkspaceView {
  return {
    title: overrides.workspaceId,
    path: `/work/${overrides.workspaceId}`,
    sessionIds: [],
    ...overrides,
    workspaceId: overrides.workspaceId as WorkspaceId,
  } as WorkspaceView;
}

describe("hero-picker-model", () => {
  it("merges workspace-derived hosts with configured zero-workspace peers", () => {
    const workspaces = [
      makeWorkspace({
        workspaceId: "ws-local",
        title: "codex-host",
        path: "/Users/me/Code/codex-host",
      }),
      makeWorkspace({
        workspaceId: "ws-vps-1",
        title: "api-gateway",
        path: "/srv/api-gateway",
        remote: {
          hostId: "remote-peer:vps",
          displayName: "美VPS",
          state: "connected",
        },
      }),
    ];

    const locations = buildHeroLocationOptions(workspaces, [
      { hostId: "remote-peer:vps", name: "美VPS Pro", state: "connected", enabled: true },
      { hostId: "remote-peer:gpu", name: "GPU节点", state: "connected", enabled: true },
      { hostId: "remote-peer:off", name: "Disabled", state: "offline", enabled: false },
    ]);

    assert.deepEqual(
      locations.map((item) => ({
        key: item.key,
        name: item.displayName,
        count: item.workspaces.length,
      })),
      [
        { key: "local", name: undefined, count: 1 },
        { key: "remote-peer:vps", name: "美VPS Pro", count: 1 },
        { key: "remote-peer:gpu", name: "GPU节点", count: 0 },
      ],
    );
  });

  it("excludes workspace-derived remote hosts when configured peer is explicitly disabled", () => {
    const workspaces = [
      makeWorkspace({
        workspaceId: "ws-local",
        title: "codex-host",
        path: "/Users/me/Code/codex-host",
      }),
      makeWorkspace({
        workspaceId: "ws-disabled-1",
        title: "remote-api",
        path: "/srv/remote-api",
        remote: {
          hostId: "remote-peer:disabled-box",
          displayName: "停用节点",
          state: "disabled",
        },
      }),
    ];

    const locations = buildHeroLocationOptions(workspaces, [
      { hostId: "remote-peer:disabled-box", name: "停用节点", state: "disabled", enabled: false },
    ]);

    assert.deepEqual(
      locations.map((item) => item.key),
      ["local"],
    );
  });

  it("filters locations and projects case-insensitively across title and path", () => {
    const workspaces = [
      makeWorkspace({ workspaceId: "w1", title: "codex-host", path: "/Users/me/Code/codex-host" }),
      makeWorkspace({ workspaceId: "w2", title: "web-app", path: "/Users/me/Projects/web-app" }),
    ];
    const locations = buildHeroLocationOptions(workspaces, [
      { hostId: "remote-peer:us-vps", name: "美VPS", state: "connected", enabled: true },
    ]);

    assert.deepEqual(
      filterHeroLocations(locations, "vps", "此计算机").map((item) => item.key),
      ["remote-peer:us-vps"],
    );
    assert.deepEqual(
      filterHeroLocations(locations, "计算机", "此计算机").map((item) => item.key),
      ["local"],
    );

    assert.deepEqual(
      filterHeroProjects(workspaces, "projects", (w) => w.title).map((w) => w.workspaceId),
      ["w2"],
    );
  });

  it("derives immediate parent folder hints without redundant or root segments", () => {
    assert.equal(workspaceParentHint("/Users/me/Code/codex-host", "codex-host"), "Code");
    assert.equal(workspaceParentHint("/Users/me", "me"), undefined);
    assert.equal(workspaceParentHint("/srv/srv", "srv"), undefined);
    assert.equal(workspaceParentHint("/single", "single"), undefined);
  });

  it("resolves workspace host keys and parses remote-peer RPC responses safely", () => {
    const workspaces = [
      makeWorkspace({ workspaceId: "local-1", title: "app" }),
      makeWorkspace({
        workspaceId: "remote-peer:vps::/srv/api",
        title: "api",
        path: "/srv/api",
        remote: { hostId: "remote-peer:vps", displayName: "美VPS", state: "connected" },
      }),
    ];

    assert.equal(hostKeyOfWorkspace(workspaces, "local-1"), "local");
    assert.equal(hostKeyOfWorkspace(workspaces, "remote-peer:vps::/srv/api"), "remote-peer:vps");
    assert.equal(hostKeyOfWorkspace(workspaces, undefined), "local");

    assert.equal(
      findCreatedRemoteWorkspace(workspaces, {
        hostId: "remote-peer:vps",
        path: "/srv/api/",
      })?.workspaceId,
      "remote-peer:vps::/srv/api",
    );

    assert.deepEqual(
      parseConfiguredRemotePeers({
        result: {
          ok: true,
          value: {
            peers: [
              { hostId: "remote-peer:a", name: "Host A", state: "connected", enabled: true },
              { hostId: "", name: "Invalid", state: "connected" },
            ],
          },
        },
      }),
      [{ hostId: "remote-peer:a", name: "Host A", state: "connected", enabled: true }],
    );
  });
});
