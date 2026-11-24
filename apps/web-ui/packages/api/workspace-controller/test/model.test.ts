import { describe, expect, it, vi } from "vitest";
import { ClientWorkspaceModel, type WorkspaceRemote } from "../src/client/model.ts";
import type { WorkspaceId, WorkspaceView } from "../src/types.ts";

// The browser export is a loader bundle. Load the same Gateway source in Node.
vi.mock("@deepseek-ai/dsh-api-gateway/client", () => import("../../gateway/src/client/index.ts"));

function makeWorkspace(input: {
  id: string;
  title?: string;
  path?: string;
  remote?: WorkspaceView["remote"];
}): WorkspaceView {
  return {
    workspaceId: input.id as WorkspaceId,
    title: input.title ?? input.id,
    path: input.path ?? `/work/${input.id}`,
    sessionIds: [],
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
    ...(input.remote ? { remote: input.remote } : {}),
  };
}

function createRemoteStub(overrides: Partial<WorkspaceRemote> = {}): WorkspaceRemote {
  return {
    delete: async () => ({ ok: true, value: { deleted: true } }),
    ...overrides,
  } as unknown as WorkspaceRemote;
}

describe("ClientWorkspaceModel removedIds lifecycle", () => {
  it("restores deterministic remote workspaces after server-pushed remove via upsert and baseline", () => {
    const model = new ClientWorkspaceModel(createRemoteStub());
    const remoteWs = makeWorkspace({
      id: "remote-workspace:W2hvbWUsIHByb2oxXQ",
      title: "proj1",
      remote: { hostId: "remote-peer:home", displayName: "home", state: "connected" },
    });

    model.replaceBaseline({
      items: [remoteWs],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    });
    expect(model.getSnapshot().items.map((item) => item.workspaceId)).toEqual([
      remoteWs.workspaceId,
    ]);

    model.removeView(remoteWs.workspaceId);
    expect(model.getSnapshot().items).toEqual([]);

    model.upsertView(remoteWs);
    expect(model.getSnapshot().items.map((item) => item.workspaceId)).toEqual([
      remoteWs.workspaceId,
    ]);

    model.removeView(remoteWs.workspaceId);
    expect(model.getSnapshot().items).toEqual([]);

    model.replaceBaseline({
      items: [remoteWs],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    });
    expect(model.getSnapshot().items.map((item) => item.workspaceId)).toEqual([
      remoteWs.workspaceId,
    ]);
  });

  it("keeps locally deleted workspaces suppressed against delayed upserts and baselines", async () => {
    const model = new ClientWorkspaceModel(createRemoteStub());
    const localWs = makeWorkspace({ id: "ws-local-1", title: "local" });

    model.replaceBaseline({
      items: [localWs],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    });

    const result = await model.delete(localWs.workspaceId);
    expect(result.ok).toBe(true);
    expect(model.getSnapshot().items).toEqual([]);

    model.upsertView(localWs);
    expect(model.getSnapshot().items).toEqual([]);

    model.replaceBaseline({
      items: [localWs],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    });
    expect(model.getSnapshot().items).toEqual([]);
  });
});
