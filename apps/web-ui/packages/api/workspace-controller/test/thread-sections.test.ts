import { describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { RemoteMock, openStream } from "@deepseek-ai/dsh-remote-mock";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { RemoteError, type RemoteResult, type TypertCodec } from "@deepseek-ai/dsh-typert-protocol";
import TYPERT_REMOTE from "../generated/remote.js";
import { apply as applyGateway } from "../../gateway/src/client/index.ts";
import { installConnection } from "../../../client/connection/src/client/index.ts";
import { apply as applyTypert } from "../../../typert/registry/src/client/index.ts";
import { createWorkspaceStateStream } from "../src/client/index.ts";
import { ClientWorkspaceModel, type WorkspaceRemote } from "../src/client/model.ts";
import { WorkspaceController } from "../src/client/service.ts";
import type { WorkspaceFollowFrame, WorkspaceThreadSectionMutationValue } from "../src/types.ts";

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

  const futureAppearance = { icon: "unknown-v9", color: "custom-v9" };
  const mutations = [
    {
      method: "createThreadSection",
      request: { name: "Research" },
      invoke: (controller: WorkspaceController) => controller.createThreadSection("Research"),
      confirmed: {
        status: "confirmed",
        sectionId: "sec-new",
        section: { id: "sec-new", name: "Research", appearance: null },
        syncPending: false,
      },
      error: /workspace create thread section failed: gateway\/bad-request: Official rejected/,
    },
    {
      method: "updateThreadSection",
      request: { sectionId: "sec-1", name: "Renamed" },
      invoke: (controller: WorkspaceController) =>
        controller.updateThreadSection("sec-1", "Renamed"),
      confirmed: {
        status: "confirmed",
        sectionId: "sec-1",
        section: { id: "sec-1", name: "Renamed", appearance: futureAppearance },
        syncPending: true,
      },
      error: /workspace update thread section failed: gateway\/bad-request: Official rejected/,
    },
    {
      method: "deleteThreadSection",
      request: { sectionId: "sec-1" },
      invoke: (controller: WorkspaceController) => controller.deleteThreadSection("sec-1"),
      confirmed: { status: "confirmed", sectionId: "sec-1", section: null, syncPending: true },
      error: /workspace delete thread section failed: gateway\/bad-request: Official rejected/,
    },
  ] as const;

  it.each(mutations)("decodes $method parameters and results", ({ method, request, confirmed }) => {
    const entry = descriptor(method);
    const result = strictSchema(entry.result);
    expect(strictSchema(entry.parameters[0]!.codec).parse(request)).toEqual(request);
    expect(result.parse(confirmed)).toEqual(confirmed);
    expect(result.parse({ status: "unknown" })).toEqual({ status: "unknown" });
  });

  it("rejects a delete result without a status", () => {
    const result = strictSchema(descriptor("deleteThreadSection").result);
    expect(() => result.parse({ sectionId: "sec-1", deleted: true })).toThrow();
  });

  it("preserves unrecognized appearance in the Workspace model", () => {
    const model = new ClientWorkspaceModel({} as WorkspaceRemote);
    model.replaceThreadSections([
      {
        id: "sec-1",
        name: "Original",
        appearance: futureAppearance,
        threadIds: ["t-1" as SessionId],
      },
    ]);
    expect(model.getSnapshot().threadSections?.[0]?.appearance).toEqual(futureAppearance);
  });

  it.each(mutations)(
    "preserves confirmed, unknown and gateway errors for $method",
    async ({ method, request, invoke, confirmed, error }) => {
      const remoteCall =
        vi.fn<
          (input: typeof request) => Promise<RemoteResult<WorkspaceThreadSectionMutationValue>>
        >();
      const model = new ClientWorkspaceModel({
        [method]: remoteCall,
      } as unknown as WorkspaceRemote);
      const controller = new WorkspaceController(new Context(), model);
      remoteCall
        .mockResolvedValueOnce({ ok: true, value: confirmed })
        .mockResolvedValueOnce({ ok: true, value: { status: "unknown" } })
        .mockResolvedValueOnce({
          ok: false,
          error: new RemoteError("gateway/bad-request", "Official rejected", {}),
        });

      await expect(invoke(controller)).resolves.toEqual(confirmed);
      await expect(invoke(controller)).resolves.toEqual({ status: "unknown" });
      await expect(invoke(controller)).rejects.toThrow(error);
      expect(remoteCall.mock.calls).toEqual([[request], [request], [request]]);
    },
  );
});
