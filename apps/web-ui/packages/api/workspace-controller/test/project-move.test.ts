import { describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { RemoteMock, openStream } from "@deepseek-ai/dsh-remote-mock";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { RemoteFailure, RemoteResult, TypertCodec } from "@deepseek-ai/dsh-typert-protocol";
import TYPERT_REMOTE from "../generated/remote.js";
import { apply as applyGateway } from "../../gateway/src/client/index.ts";
import { installConnection } from "../../../client/connection/src/client/index.ts";
import { apply as applyTypert } from "../../../typert/registry/src/client/index.ts";
import { createWorkspaceStateStream } from "../src/client/index.ts";
import { ClientWorkspaceModel, type WorkspaceRemote } from "../src/client/model.ts";
import { WorkspaceController } from "../src/client/service.ts";
import type {
  WorkspaceFollowFrame,
  WorkspaceId,
  WorkspaceLocalProject,
  WorkspaceMoveSessionToProjectRequest,
  WorkspaceMoveSessionToProjectValue,
} from "../src/types.ts";

// The browser export is a loader bundle. Load the same Gateway source in Node.
vi.mock("@deepseek-ai/dsh-api-gateway/client", () => import("../../gateway/src/client/index.ts"));

function descriptor(method: string) {
  const found = TYPERT_REMOTE.descriptors.find(
    (entry) => entry.namespace === "workspace" && entry.method === method,
  );
  if (!found) throw new Error(`missing descriptor for workspace/${method}`);
  return found;
}

function strictSchema(codec: TypertCodec) {
  if (codec.mode !== "strict") throw new Error(`expected strict codec, got ${codec.mode}`);
  return codec.create();
}

describe("workspace-controller project move contracts", () => {
  it("streams localProjects on baseline and incremental frames via Gateway", async () => {
    const endpoint = "workspace/follow";
    const initialProjects: WorkspaceLocalProject[] = [
      {
        id: "proj-alpha",
        name: "Project Alpha",
        sessionIds: ["s-1" as SessionId],
        workspaceIds: ["ws-a" as WorkspaceId],
      },
      { id: "proj-beta", name: "Project Beta", sessionIds: [] },
    ];
    const updatedProjects: WorkspaceLocalProject[] = [
      { id: "proj-alpha", name: "Project Alpha", sessionIds: [] },
      {
        id: "proj-beta",
        name: "Project Beta",
        sessionIds: ["s-1" as SessionId],
        workspaceIds: ["ws-b" as WorkspaceId],
      },
    ];
    const carrier = RemoteMock.create().stream(
      endpoint,
      openStream([
        {
          type: "baseline",
          value: {
            items: [],
            archivedSessionIds: [],
            pinnedSessionIds: [],
            localProjects: initialProjects,
            projectlessSessionIds: ["s-free"],
          },
        },
      ]),
    );
    const ctx = new Context();
    applyTypert(ctx);
    installConnection(ctx, { transport: { rpc: carrier.rpc } });
    applyGateway(ctx);
    await ctx.remote.$mount(TYPERT_REMOTE);
    const model = new ClientWorkspaceModel(ctx.remote.workspace);
    const stream = createWorkspaceStateStream(ctx.remote, {
      accept: model,
      failed: (error) => model.handleStreamFailure(error),
    });
    try {
      stream.start();
      await carrier.streams.opened(endpoint, 1);
      await vi.waitFor(() => {
        expect(model.getSnapshot().localProjects).toEqual(initialProjects);
        expect(model.getSnapshot().projectlessSessionIds).toEqual(["s-free"]);
      });
      carrier.streams.push(endpoint, { type: "localProjects", localProjects: updatedProjects });
      await vi.waitFor(() => {
        expect(model.getSnapshot().localProjects).toEqual(updatedProjects);
        expect(model.getSnapshot().projectlessSessionIds).toEqual([]);
      });
    } finally {
      await stream.dispose();
      await ctx.fiber.dispose();
    }
  });

  it("validates narrow {sessionId, projectId} moveSessionToProject wire schema and rejects extra fields", () => {
    const moveParam = strictSchema(descriptor("moveSessionToProject").parameters[0]!.codec);
    const moveResult = strictSchema(descriptor("moveSessionToProject").result);
    const followSchema = strictSchema(descriptor("follow").result);

    expect(moveParam.parse({ sessionId: "t-1", projectId: "proj-beta" })).toEqual({
      sessionId: "t-1",
      projectId: "proj-beta",
    });
    expect(() => moveParam.parse({ sessionId: "t-1", projectId: "" })).toThrow();
    expect(() => moveParam.parse({ sessionId: "t-1", projectId: null })).toThrow();
    expect(() =>
      moveParam.parse({ sessionId: "t-1", projectId: "proj-beta", sectionId: "sec-1" }),
    ).toThrow();
    expect(() =>
      moveParam.parse({ sessionId: "t-1", projectId: "proj-beta", cwd: "/tmp/other" }),
    ).toThrow();
    expect(() =>
      moveParam.parse({ sessionId: "t-1", projectId: "proj-beta", pinned: true }),
    ).toThrow();

    expect(moveResult.parse({ status: "confirmed", projectId: "proj-beta" })).toEqual({
      status: "confirmed",
      projectId: "proj-beta",
    });
    expect(moveResult.parse({ status: "unknown" })).toEqual({ status: "unknown" });
    expect(() => moveResult.parse({ projectId: "proj-beta" })).toThrow();
    expect(() => moveResult.parse({ status: "confirmed", projectId: "" })).toThrow();
    expect(() => moveResult.parse({ status: "unknown", projectId: "proj-beta" })).toThrow();

    const frame = followSchema.parse({
      type: "localProjects",
      localProjects: [{ id: "proj-alpha", name: "Alpha", sessionIds: ["t-1"] }],
      projectlessSessionIds: ["free"],
    }) as WorkspaceFollowFrame;
    expect(frame).toEqual({
      type: "localProjects",
      localProjects: [{ id: "proj-alpha", name: "Alpha", sessionIds: ["t-1"] }],
      projectlessSessionIds: ["free"],
    });
  });

  it("dispatches narrow {sessionId, projectId} without optimistic mutation or section/pin writes", async () => {
    const sentMoves: WorkspaceMoveSessionToProjectRequest[] = [];
    const remote = {
      moveSessionToProject: async (
        request: WorkspaceMoveSessionToProjectRequest,
      ): Promise<RemoteResult<WorkspaceMoveSessionToProjectValue>> => {
        sentMoves.push(request);
        if (request.projectId === "proj-missing") {
          return {
            ok: false,
            error: {
              code: "workspace/project-unavailable",
              message: "Project not found",
              details: {},
            } as RemoteFailure,
          };
        }
        if (request.projectId === "proj-unknown") {
          return { ok: true, value: { status: "unknown" } };
        }
        if (request.projectId === "proj-offline") {
          return {
            ok: false,
            error: {
              code: "gateway/internal",
              message: "Disconnected",
              details: {},
            } as RemoteFailure,
          };
        }
        if (request.projectId === "proj-mismatch") {
          return { ok: true, value: { status: "confirmed", projectId: "proj-other" } };
        }
        return { ok: true, value: { status: "confirmed", projectId: request.projectId } };
      },
    } as unknown as WorkspaceRemote;

    const model = new ClientWorkspaceModel(remote);
    const ctx = new Context();
    const controller = new WorkspaceController(ctx, model);

    model.replaceBaseline({
      items: [],
      archivedSessionIds: [],
      pinnedSessionIds: ["t-1" as SessionId],
      threadSections: [{ id: "sec-1", name: "Focus", threadIds: ["t-1" as SessionId] }],
      localProjects: [
        { id: "proj-alpha", name: "Alpha", sessionIds: ["t-1" as SessionId] },
        { id: "proj-beta", name: "Beta", sessionIds: [] },
      ],
    });

    const confirmed = await controller.moveSessionToProject("t-1" as SessionId, "proj-beta");
    expect(confirmed).toEqual({ status: "confirmed", projectId: "proj-beta" });
    expect(sentMoves).toEqual([{ sessionId: "t-1", projectId: "proj-beta" }]);
    expect(Object.keys(sentMoves[0]!).sort()).toEqual(["projectId", "sessionId"]);

    // Unknown outcome returns cleanly without throwing, optimistic mutation, or auto-retry
    const unknown = await controller.moveSessionToProject("t-1" as SessionId, "proj-unknown");
    expect(unknown).toEqual({ status: "unknown" });
    expect(sentMoves).toHaveLength(2);

    // No optimistic mutation: authoritative stream owns localProjects, sections, and pins.
    expect(model.getSnapshot().localProjects).toEqual([
      { id: "proj-alpha", name: "Alpha", sessionIds: ["t-1"] },
      { id: "proj-beta", name: "Beta", sessionIds: [] },
    ]);
    expect(model.getSnapshot().pinnedSessionIds).toEqual(["t-1"]);
    expect(model.getSnapshot().threadSections?.[0]?.threadIds).toEqual(["t-1"]);

    await expect(
      controller.moveSessionToProject("t-1" as SessionId, "proj-missing"),
    ).rejects.toThrow(
      /workspace move to project failed: workspace\/project-unavailable: Project not found/,
    );
    for (const projectId of ["proj-mismatch", "proj-offline"]) {
      await expect(controller.moveSessionToProject("t-1" as SessionId, projectId)).resolves.toEqual(
        {
          status: "unknown",
        },
      );
      expect(sentMoves.filter((call) => call.projectId === projectId)).toHaveLength(1);
    }
  });
});
