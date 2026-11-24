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
  WorkspaceCreateThreadSectionRequest,
  WorkspaceCreateThreadSectionValue,
  WorkspaceDeleteThreadSectionRequest,
  WorkspaceDeleteThreadSectionValue,
  WorkspaceFollowFrame,
  WorkspaceUpdateThreadSectionRequest,
  WorkspaceUpdateThreadSectionValue,
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

describe("workspace-controller thread section contracts", () => {
  it("opts in on the real Gateway stream and exposes the Host capability to Workspace consumers", async () => {
    const endpoint = "workspace/follow";
    const sections = [{ id: "s", name: "Research", appearance: null, threadIds: [] }];
    const carrier = RemoteMock.create().stream(
      endpoint,
      openStream([
        {
          type: "baseline",
          value: {
            items: [],
            archivedSessionIds: [],
            pinnedSessionIds: [],
            threadSectionsV1: true,
            threadSections: sections,
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
      expect(carrier.log.streams(endpoint)[0]?.args).toEqual([{ threadSectionsV1: true }]);
      await vi.waitFor(() => {
        expect(model.getSnapshot()).toMatchObject({
          threadSectionsV1: true,
          threadSections: sections,
        });
      });
      carrier.streams.push(endpoint, { type: "threadSections", threadSections: [] });
      await vi.waitFor(() => {
        expect(model.getSnapshot().threadSections).toEqual([]);
        expect(model.getSnapshot().threadSectionsV1).toBeUndefined();
      });
    } finally {
      await stream.dispose();
      await ctx.fiber.dispose();
    }
  });

  it("decodes follow frames with known, null, unknown, or omitted appearance", () => {
    const schema = strictSchema(descriptor("follow").result);
    const baseline = schema.parse({
      type: "baseline",
      value: {
        items: [],
        archivedSessionIds: [],
        pinnedSessionIds: [],
        threadSectionsV1: true,
        threadSections: [
          { id: "sec-legacy", name: "Legacy", threadIds: [] },
          { id: "sec-null", name: "Plain", appearance: null, threadIds: [] },
          {
            id: "sec-styled",
            name: "Styled",
            appearance: { icon: "star", color: "blue" },
            threadIds: ["s1"],
          },
          {
            id: "sec-future",
            name: "Future",
            appearance: { icon: "future-v2", color: "ultraviolet" },
            threadIds: [],
          },
        ],
      },
    }) as WorkspaceFollowFrame;
    expect(baseline.type).toBe("baseline");
    if (baseline.type !== "baseline") throw new Error("expected baseline");
    expect(baseline.value.threadSectionsV1).toBe(true);
    expect(baseline.value.threadSections).toHaveLength(4);

    const increment = schema.parse({
      type: "threadSections",
      threadSectionsV1: true,
      threadSections: [
        {
          id: "sec-empty",
          name: "Empty",
          appearance: { icon: null, color: "green" },
          threadIds: [],
        },
      ],
    }) as WorkspaceFollowFrame;
    expect(increment.type).toBe("threadSections");
    expect(increment).toMatchObject({ threadSectionsV1: true });
    const model = new ClientWorkspaceModel({} as WorkspaceRemote);
    model.replaceBaseline(baseline.value);
    expect(model.getSnapshot().threadSectionsV1).toBe(true);
    model.replaceThreadSections([]);
    expect(model.getSnapshot().threadSectionsV1).toBeUndefined();
  });

  it("validates create/update/delete confirmed, unknown, and delete section:null responses", () => {
    const createParam = strictSchema(descriptor("createThreadSection").parameters[0]!.codec);
    const createResult = strictSchema(descriptor("createThreadSection").result);
    expect(createParam.parse({ name: "Research" })).toEqual({ name: "Research" });
    expect(
      createResult.parse({
        status: "confirmed",
        sectionId: "sec-1",
        section: { id: "sec-1", name: "Research", appearance: null },
        syncPending: false,
      }),
    ).toEqual({
      status: "confirmed",
      sectionId: "sec-1",
      section: { id: "sec-1", name: "Research", appearance: null },
      syncPending: false,
    });
    expect(createResult.parse({ status: "unknown" })).toEqual({ status: "unknown" });

    const updateParam = strictSchema(descriptor("updateThreadSection").parameters[0]!.codec);
    const updateResult = strictSchema(descriptor("updateThreadSection").result);
    expect(updateParam.parse({ sectionId: "sec-1", name: "Renamed" })).toEqual({
      sectionId: "sec-1",
      name: "Renamed",
    });
    expect(
      updateResult.parse({
        status: "confirmed",
        sectionId: "sec-1",
        section: { id: "sec-1", name: "Renamed", appearance: { icon: "star", color: null } },
        syncPending: true,
      }),
    ).toEqual({
      status: "confirmed",
      sectionId: "sec-1",
      section: { id: "sec-1", name: "Renamed", appearance: { icon: "star", color: null } },
      syncPending: true,
    });
    expect(updateResult.parse({ status: "unknown" })).toEqual({ status: "unknown" });

    const deleteParam = strictSchema(descriptor("deleteThreadSection").parameters[0]!.codec);
    const deleteResult = strictSchema(descriptor("deleteThreadSection").result);
    expect(deleteParam.parse({ sectionId: "sec-1" })).toEqual({ sectionId: "sec-1" });
    expect(
      deleteResult.parse({
        status: "confirmed",
        sectionId: "sec-1",
        section: null,
        syncPending: true,
      }),
    ).toEqual({
      status: "confirmed",
      sectionId: "sec-1",
      section: null,
      syncPending: true,
    });
    expect(deleteResult.parse({ status: "unknown" })).toEqual({ status: "unknown" });
    expect(() => deleteResult.parse({ sectionId: "sec-1", deleted: true })).toThrow();
  });

  it("omits appearance on rename, preserves unknown appearance, and returns confirmed/unknown/errors", async () => {
    const sentCreate: WorkspaceCreateThreadSectionRequest[] = [];
    const sentUpdate: WorkspaceUpdateThreadSectionRequest[] = [];
    const sentDelete: WorkspaceDeleteThreadSectionRequest[] = [];

    const remote = {
      createThreadSection: async (
        request: WorkspaceCreateThreadSectionRequest,
      ): Promise<RemoteResult<WorkspaceCreateThreadSectionValue>> => {
        sentCreate.push(request);
        if (request.name === "Uncertain") {
          return { ok: true, value: { status: "unknown" } };
        }
        return {
          ok: true,
          value: {
            status: "confirmed",
            sectionId: "sec-new",
            section: { id: "sec-new", name: request.name, appearance: null },
            syncPending: false,
          },
        };
      },
      updateThreadSection: async (
        request: WorkspaceUpdateThreadSectionRequest,
      ): Promise<RemoteResult<WorkspaceUpdateThreadSectionValue>> => {
        sentUpdate.push(request);
        if (request.name === "fail") {
          return {
            ok: false,
            error: {
              code: "gateway/bad-request",
              message: "Official rejected",
              details: {},
            } as RemoteFailure,
          };
        }
        if (request.name === "unknown") {
          return { ok: true, value: { status: "unknown" } };
        }
        return {
          ok: true,
          value: {
            status: "confirmed",
            sectionId: request.sectionId,
            section: {
              id: request.sectionId,
              name: request.name,
              appearance: { icon: "unknown-v9", color: "custom-v9" },
            },
            syncPending: true,
          },
        };
      },
      deleteThreadSection: async (
        request: WorkspaceDeleteThreadSectionRequest,
      ): Promise<RemoteResult<WorkspaceDeleteThreadSectionValue>> => {
        sentDelete.push(request);
        if (request.sectionId === "sec-unknown") {
          return { ok: true, value: { status: "unknown" } };
        }
        return {
          ok: true,
          value: {
            status: "confirmed",
            sectionId: request.sectionId,
            section: null,
            syncPending: true,
          },
        };
      },
    } as unknown as WorkspaceRemote;

    const model = new ClientWorkspaceModel(remote);
    const ctx = new Context();
    const controller = new WorkspaceController(ctx, model);

    model.replaceThreadSections([
      {
        id: "sec-1",
        name: "Original",
        appearance: { icon: "unknown-v9", color: "custom-v9" },
        threadIds: ["t-1" as SessionId],
      },
    ]);
    expect(model.getSnapshot().threadSections?.[0]?.appearance).toEqual({
      icon: "unknown-v9",
      color: "custom-v9",
    });

    const created = await controller.createThreadSection("New Section");
    expect(created).toEqual({
      status: "confirmed",
      sectionId: "sec-new",
      section: { id: "sec-new", name: "New Section", appearance: null },
      syncPending: false,
    });
    expect(Object.hasOwn(sentCreate[0]!, "appearance")).toBe(false);

    const createdUnknown = await controller.createThreadSection("Uncertain");
    expect(createdUnknown).toEqual({ status: "unknown" });

    const updated = await controller.updateThreadSection("sec-1", "Renamed");
    expect(updated).toEqual({
      status: "confirmed",
      sectionId: "sec-1",
      section: {
        id: "sec-1",
        name: "Renamed",
        appearance: { icon: "unknown-v9", color: "custom-v9" },
      },
      syncPending: true,
    });
    expect(Object.hasOwn(sentUpdate[0]!, "appearance")).toBe(false);
    expect(sentUpdate[0]).toEqual({ sectionId: "sec-1", name: "Renamed" });

    const updatedUnknown = await controller.updateThreadSection("sec-1", "unknown");
    expect(updatedUnknown).toEqual({ status: "unknown" });

    await expect(controller.updateThreadSection("sec-1", "fail")).rejects.toThrow(
      /workspace update thread section failed: gateway\/bad-request: Official rejected/,
    );

    const deleted = await controller.deleteThreadSection("sec-1");
    expect(deleted).toEqual({
      status: "confirmed",
      sectionId: "sec-1",
      section: null,
      syncPending: true,
    });
    expect(sentDelete[0]).toEqual({ sectionId: "sec-1" });

    const deletedUnknown = await controller.deleteThreadSection("sec-unknown");
    expect(deletedUnknown).toEqual({ status: "unknown" });
  });
});
