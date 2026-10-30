import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HostThreadSnapshot, HostTurnSnapshot } from "@codexhost/harness-adapter";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { MappingStore } from "@codexhost/mapping-store";
import { decodeThreadListRequest } from "@codexhost/protocol-core";
import {
  harnessIdSchema,
  hostItemIdSchema,
  hostThreadIdSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { listExternalThreadMetadata } from "../src/external-thread-list.js";
import { ExternalThreadRepository } from "../src/external-thread-repository.js";
import { ExternalThreadRuntime } from "../src/external-thread-runtime.js";

const directories: string[] = [];
const harnessId = harnessIdSchema.parse("antigravity");
const parentId = hostThreadIdSchema.parse("parent");
const sourceRef = nativeSessionRefSchema.parse({
  harnessId,
  nativeSessionId: "source",
  formatVersion: 1,
});
const replacementRef = nativeSessionRefSchema.parse({
  ...sourceRef,
  nativeSessionId: "replacement",
});

function turn(ref: NativeSessionRef, key: string, children: string[] = []): HostTurnSnapshot {
  return {
    nativeTurnRef: nativeTurnRefSchema.parse({ ...ref, nativeTurnKey: key }),
    input: [{ type: "text", text: key }],
    items: children.length
      ? [
          {
            item: {
              type: "subagentDelegation",
              itemId: hostItemIdSchema.parse(`spawn-${key}`),
              operation: "spawn",
              prompt: "Explore",
              subagents: children.map((id) => ({
                subagentId: id,
                nativeSubagentId: id,
                description: id,
                background: false,
                status: "completed",
              })),
            },
            outcome: { status: "succeeded" },
          },
        ]
      : [],
    outcome: { status: "succeeded" },
  };
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "external-subagents-"));
  directories.push(directory);
  const store = new MappingStore({ directory });
  const repository = new ExternalThreadRepository(store);
  await repository.initialize();
  const input = {
    harnessId,
    cwd: "/synthetic",
    title: "Parent",
    transportModelId: "codexhost/antigravity-native",
    ephemeral: false,
    historyMode: "paginated" as const,
  };
  await repository.createProvisional({
    ...input,
    hostThreadId: parentId,
    createRequestId: "parent",
  });
  const parent = await repository.commitNative(parentId, sourceRef);
  return { directory, input, store, repository, parent };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("External native child identity", () => {
  it.each([sourceRef, replacementRef])(
    "retains child and Turn IDs across rollback to $nativeSessionId",
    async (ref) => {
      const { directory, repository, parent } = await fixture();
      let reopened: ExternalThreadRepository | undefined;
      try {
        const before = await repository.alignSnapshot(parent, {
          turns: [turn(sourceRef, "first", ["retained"]), turn(sourceRef, "last", ["removed"])],
        });
        const child = (await repository.list()).find(
          (entry) => entry.subagent?.nativeSubagentId === "retained",
        );
        if (!child) throw new Error("Missing child");
        const childBefore = await repository.alignSnapshot(child, {
          turns: [turn(sourceRef, "retained:message", ["grandchild"])],
        });
        const grandchild = (await repository.list()).find(
          (entry) => entry.subagent?.nativeSubagentId === "grandchild",
        );
        if (!grandchild) throw new Error("Missing grandchild");
        const snapshot = { turns: [turn(ref, "first", ["retained"])] };
        const rolledBack = await repository.commitLastTurnRollback(before.record, ref, snapshot);
        const stored = await repository.find(child.hostThreadId);
        expect(stored?.nativeSessionRef).toEqual(ref);
        expect((await repository.find(grandchild.hostThreadId))?.nativeSessionRef).toEqual(ref);
        expect(stored?.turnMappings[0]).toMatchObject({
          hostTurnId: childBefore.record.turnMappings[0]?.hostTurnId,
          nativeTurnRef: {
            nativeSessionId: ref.nativeSessionId,
            nativeTurnKey: "retained:message",
          },
        });
        expect(rolledBack.turns[0]?.items).toContainEqual(
          expect.objectContaining({
            type: "collabAgentToolCall",
            receiverThreadIds: [child.hostThreadId],
          }),
        );
        expect(
          (await repository.list()).filter(
            (entry) => entry.subagent?.nativeSubagentId === "retained",
          ),
        ).toHaveLength(1);
        await repository.close();
        reopened = new ExternalThreadRepository(new MappingStore({ directory }));
        await reopened.initialize();
        const restored = await reopened.find(parentId);
        if (!restored) throw new Error("Missing parent after restart");
        const again = await reopened.alignSnapshot(restored, snapshot);
        expect(again.turns).toEqual(rolledBack.turns);
        expect(
          (await reopened.list()).filter(
            (entry) => entry.subagent?.nativeSubagentId === "retained",
          ),
        ).toHaveLength(1);
      } finally {
        await (reopened ?? repository).close();
      }
    },
  );

  it.each([
    { id: "child", pending: false },
    { id: "child", pending: true },
    { id: "grandchild", pending: false },
    { id: "grandchild", pending: true },
  ])(
    "reopens $id with the new parent ref after rollback (read pending: $pending)",
    async ({ id, pending }) => {
      const { repository, parent } = await fixture();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const readSnapshot = vi.fn(
        async ({
          parent: ref,
          nativeSubagentId,
        }: {
          parent: NativeSessionRef;
          nativeSubagentId: string;
        }) => {
          if (pending && ref.nativeSessionId === sourceRef.nativeSessionId) await gate;
          return {
            ok: true as const,
            value: { turns: [turn(ref, `${nativeSubagentId}:message`)] },
          };
        },
      );
      const adapter = Object.assign(new FakeHarnessAdapter(harnessId), {
        subagents: { readSnapshot },
      });
      const runtime = new ExternalThreadRuntime({
        adapters: new Map([["antigravity", adapter]]),
        repository,
        consumeOutputs: async () => undefined,
        diagnose: () => undefined,
      });
      try {
        const before = await repository.alignSnapshot(parent, {
          turns: [turn(sourceRef, "first", ["child"]), turn(sourceRef, "last")],
        });
        let child = (await repository.list()).find((entry) => entry.subagent);
        if (!child) throw new Error("Missing child");
        if (id === "grandchild") {
          await repository.alignSnapshot(child, {
            turns: [turn(sourceRef, "child:message", ["grandchild"])],
          });
          child = (await repository.list()).find(
            (entry) => entry.subagent?.nativeSubagentId === "grandchild",
          );
          if (!child) throw new Error("Missing grandchild");
        }
        const opened = await adapter.open({ kind: "create", cwd: parent.cwd });
        if (!opened.ok) throw new Error(opened.error.message);
        const current = runtime.register({
          record: before.record,
          session: opened.value,
          sessionId: parentId,
          thread: { id: parentId },
          turns: before.turns,
          restoredState: { nativeRef: sourceRef },
        });
        const reading = runtime.resolve(child.hostThreadId);
        if (pending) await vi.waitFor(() => expect(readSnapshot).toHaveBeenCalledTimes(1));
        else expect((await reading).kind).toBe("external");
        const next = await repository.commitLastTurnRollback(before.record, replacementRef, {
          turns: [turn(replacementRef, "first", ["child"])],
        });
        const replacement = await adapter.open({ kind: "create", cwd: parent.cwd });
        if (!replacement.ok) throw new Error(replacement.error.message);
        const replacing = runtime.replace(current, {
          record: next.record,
          session: replacement.value,
          sessionId: parentId,
          thread: { id: parentId },
          turns: next.turns,
          restoredState: { nativeRef: replacementRef },
        });
        release();
        await replacing;
        await reading;
        const reread = await runtime.resolve(child.hostThreadId);
        expect(reread.kind).toBe("external");
        if (reread.kind !== "external") throw new Error("Child could not be reopened");
        expect(reread.thread.record.nativeSessionRef).toEqual(replacementRef);
        expect(readSnapshot).toHaveBeenLastCalledWith({
          parent: replacementRef,
          nativeSubagentId: id,
          cwd: parent.cwd,
        });
      } finally {
        release();
        for (const thread of runtime.values()) await thread.session.close();
        await adapter.close();
        await repository.close();
      }
    },
  );

  it("does not list children left under a replaced parent Native Session", async () => {
    const { repository, parent } = await fixture();
    try {
      const before = await repository.alignSnapshot(parent, {
        turns: [turn(sourceRef, "first", ["retained"]), turn(sourceRef, "last", ["removed"])],
      });
      await repository.commitLastTurnRollback(before.record, replacementRef, {
        turns: [turn(replacementRef, "first", ["retained"])],
      });
      const query = decodeThreadListRequest({
        id: 1,
        method: "thread/list",
        params: {
          ancestorThreadId: parentId,
          sourceKinds: ["subAgentThreadSpawn"],
        },
      });
      if (!query) throw new Error("Invalid query");
      const page = listExternalThreadMetadata({
        records: await repository.list(),
        query,
        runtimeFor: () => null,
      });
      expect(page.data.map(({ thread }) => thread.name)).toEqual(["retained"]);
    } finally {
      await repository.close();
    }
  });

  it("does not reuse a removed child's ID when the replacement Session reuses a native child ID", async () => {
    const { repository, parent } = await fixture();
    try {
      const before = await repository.alignSnapshot(parent, {
        turns: [turn(sourceRef, "first"), turn(sourceRef, "last", ["reused"])],
      });
      const removed = (await repository.list()).find((entry) => entry.subagent);
      const next = await repository.commitLastTurnRollback(before.record, replacementRef, {
        turns: [turn(replacementRef, "first")],
      });
      const child = await repository.materializeSubagent(next.record, {
        subagentId: "reused",
        nativeSubagentId: "reused",
        description: "New child",
        background: false,
        status: "running",
      });
      expect(child?.hostThreadId).not.toBe(removed?.hostThreadId);
      expect(child?.nativeSessionRef).toEqual(replacementRef);
    } finally {
      await repository.close();
    }
  });

  it("keeps fork children separate without rebinding source children", async () => {
    const { input, repository, parent } = await fixture();
    try {
      await repository.alignSnapshot(parent, { turns: [turn(sourceRef, "first", ["child"])] });
      const sourceChild = (await repository.list()).find((entry) => entry.subagent);
      if (!sourceChild) throw new Error("Missing source child");
      const derived = await repository.createProvisional({
        ...input,
        hostThreadId: hostThreadIdSchema.parse("fork"),
        createRequestId: "fork",
      });
      await repository.commitDerivedSnapshot(derived, replacementRef, {
        turns: [turn(replacementRef, "first", ["child"])],
      });
      const children = (await repository.list()).filter((entry) => entry.subagent);
      expect(children).toHaveLength(2);
      expect(await repository.find(sourceChild.hostThreadId)).toEqual(sourceChild);
      expect(
        children.find((entry) => entry.subagent?.parentHostThreadId === "fork")?.nativeSessionRef,
      ).toEqual(replacementRef);
    } finally {
      await repository.close();
    }
  });

  it("uses indexed lookups for already materialized children", async () => {
    const { repository, store, parent } = await fixture();
    try {
      const snapshot: HostThreadSnapshot = { turns: [turn(sourceRef, "first", ["a", "b", "c"])] };
      const aligned = await repository.alignSnapshot(parent, snapshot);
      const list = vi.spyOn(store, "listThreads");
      const indexed = vi.spyOn(store, "getThreadByCreateRequest");
      await repository.alignSnapshot(aligned.record, snapshot);
      expect(list).not.toHaveBeenCalled();
      expect(indexed).toHaveBeenCalledTimes(3);
    } finally {
      await repository.close();
    }
  });

  it("shares one legacy scan across the whole snapshot", async () => {
    const { input, repository, store, parent } = await fixture();
    try {
      for (const id of ["a", "b", "c"]) {
        const hostThreadId = hostThreadIdSchema.parse(`legacy-${id}`);
        await repository.createProvisional({
          ...input,
          hostThreadId,
          createRequestId: `legacy-${id}`,
          subagent: { parentHostThreadId: parentId, nativeSubagentId: id },
        });
        await repository.commitNative(hostThreadId, sourceRef);
      }
      const list = vi.spyOn(store, "listThreads");
      const result = await repository.alignSnapshot(parent, {
        turns: [turn(sourceRef, "first", ["a", "b"]), turn(sourceRef, "second", ["c", "a"])],
      });
      expect(list).toHaveBeenCalledTimes(1);
      expect(result.turns[0]?.items).toContainEqual(
        expect.objectContaining({
          type: "collabAgentToolCall",
          receiverThreadIds: ["legacy-a", "legacy-b"],
        }),
      );
    } finally {
      await repository.close();
    }
  });
});
