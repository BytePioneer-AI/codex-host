import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type * as DesktopControl from "@codexhost/desktop-control";
import type { HarnessAdapter } from "@codexhost/harness-adapter";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { MappingStore, type StoredThreadRecordV1 } from "@codexhost/mapping-store";
import { harnessIdSchema, hostThreadIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createExternalThreadRecordInput,
  ExternalThreadRepository,
} from "../src/external-thread-repository.js";
import { installedHarnessPluginOptions } from "../src/installed-harness-plugins.js";
import { refreshNativeThreadCatalog } from "../src/native-thread-catalog.js";
import {
  createFixture,
  startExternalThread,
  startPiTurn,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

const requestRefresh = vi.hoisted(() =>
  vi.fn<(environment: NodeJS.ProcessEnv) => Promise<void>>(async () => undefined),
);
vi.mock("@codexhost/desktop-control", async (importOriginal) => ({
  ...(await importOriginal<typeof DesktopControl>()),
  requestDesktopThreadCatalogRefresh: requestRefresh,
}));

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  requestRefresh.mockReset();
  for (const close of cleanup.splice(0).reverse()) await close();
});

const harnessId = harnessIdSchema.parse("catalog-test");
const nativeRef = { harnessId, nativeSessionId: "published-session", formatVersion: 1 as const };
const sourceRef = { ...nativeRef, nativeSessionId: "source-session" };

async function directory() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-catalog-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function repositoryFixture() {
  const root = await directory();
  const beforeReplace = vi.fn<(record: StoredThreadRecordV1) => void>();
  const store = new MappingStore({ directory: root, beforeReplace });
  const published = vi.fn<(record: StoredThreadRecordV1) => Promise<void>>(async () => undefined);
  const repository = new ExternalThreadRepository(store, published);
  await repository.initialize();
  cleanup.push(() => repository.close());
  const input = createExternalThreadRecordInput({
    harnessId,
    cwd: root,
    transportModelId: "codexhost/catalog-test",
    ephemeral: false,
    historyMode: "paginated",
  });
  return { root, store, repository, published, beforeReplace, input };
}

describe("Native Thread publication", () => {
  it("publishes only after the ID is durable without waiting for a pending observer", async () => {
    const f = await repositoryFixture();
    const observed = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    f.published.mockImplementation(async (record) => {
      const disk = JSON.parse(
        await readFile(path.join(f.root, "threads", `${record.hostThreadId}.json`), "utf8"),
      );
      expect(disk).toMatchObject({ state: "ready", nativeSessionRef: nativeRef });
      observed.resolve(undefined);
      await release.promise;
    });
    const provisional = await f.repository.createProvisional({
      ...f.input,
      importSourceRef: sourceRef,
    });
    try {
      const committed = await f.repository.commitNative(provisional.hostThreadId, nativeRef);
      expect(committed).toMatchObject({ state: "ready", nativeSessionRef: nativeRef });
      await observed.promise;
      expect(f.published).toHaveBeenCalledOnce();
      await f.repository.commitNative(provisional.hostThreadId, nativeRef);
      expect(f.published).toHaveBeenCalledOnce();
    } finally {
      release.resolve(undefined);
    }
  });

  it.each(["throw", "reject"])(
    "ignores an observer %s after successful commit",
    async (failure) => {
      const f = await repositoryFixture();
      f.published.mockImplementation(() => {
        if (failure === "throw") throw new Error("Desktop unavailable");
        return Promise.reject(new Error("Desktop unavailable"));
      });
      const provisional = await f.repository.createProvisional({
        ...f.input,
        importSourceRef: sourceRef,
      });
      expect(await f.repository.commitNative(provisional.hostThreadId, nativeRef)).toMatchObject({
        state: "ready",
        nativeSessionRef: nativeRef,
      });
      expect(await f.repository.find(provisional.hostThreadId)).toMatchObject({ state: "ready" });
      expect(f.published).toHaveBeenCalledOnce();
    },
  );

  it.each(["ephemeral", "subagent", "same-ID import"])("does not publish a %s", async (kind) => {
    const f = await repositoryFixture();
    const provisional = await f.repository.createProvisional({
      ...f.input,
      ...(kind === "ephemeral" ? { ephemeral: true } : {}),
      ...(kind === "subagent"
        ? {
            subagent: {
              parentHostThreadId: hostThreadIdSchema.parse("parent"),
              nativeSubagentId: "native-child",
            },
          }
        : {}),
      ...(kind === "same-ID import" ? { importSourceRef: nativeRef } : {}),
    });
    const record = await f.repository.commitNative(provisional.hostThreadId, nativeRef);
    await f.repository.persistTurn(record, hostTurnIdSchema.parse("first-turn"), {
      ...nativeRef,
      nativeTurnKey: "native-first-turn",
    });
    expect(f.published).not.toHaveBeenCalled();
  });

  it.each(["derived import", "checkpoint Fork"])("publishes a %s exactly once", async (kind) => {
    const f = await repositoryFixture();
    const provisional = await f.repository.createProvisional({
      ...f.input,
      ...(kind === "derived import"
        ? { importSourceRef: sourceRef }
        : {
            forkSource: {
              hostThreadId: hostThreadIdSchema.parse("source-thread"),
              hostTurnId: hostTurnIdSchema.parse("boundary-turn"),
            },
          }),
    });
    if (kind === "checkpoint Fork")
      await f.repository.commitDerivedSnapshot(provisional, nativeRef, {
        turns: [
          {
            nativeTurnRef: { ...nativeRef, nativeTurnKey: "boundary" },
            input: [],
            items: [],
            outcome: { status: "succeeded" },
          },
        ],
      });
    else await f.repository.commitNative(provisional.hostThreadId, nativeRef);
    expect(f.published).toHaveBeenCalledOnce();
    expect(f.published).toHaveBeenCalledWith(
      expect.objectContaining({ state: "ready", nativeSessionRef: nativeRef }),
    );
    await f.repository.commitNative(provisional.hostThreadId, nativeRef);
    expect(f.published).toHaveBeenCalledOnce();
  });

  it("does not publish when persisting the native identity fails", async () => {
    const f = await repositoryFixture();
    const provisional = await f.repository.createProvisional({
      ...f.input,
      importSourceRef: sourceRef,
    });
    f.beforeReplace.mockImplementation((record) => {
      if (record.state === "ready") throw new Error("Disk write failed");
    });
    await expect(f.repository.commitNative(provisional.hostThreadId, nativeRef)).rejects.toThrow();
    expect(await f.repository.find(provisional.hostThreadId)).toMatchObject({ state: "creating" });
    expect(f.published).not.toHaveBeenCalled();
  });

  it("publishes a new Session only after its first Turn is persisted", async () => {
    const f = await repositoryFixture();
    const provisional = await f.repository.createProvisional(f.input);
    const created = await f.repository.commitNative(provisional.hostThreadId, nativeRef);
    expect(f.published).not.toHaveBeenCalled();
    f.beforeReplace.mockImplementation((record) => {
      if (record.turnMappings.length) throw new Error("Turn persistence failed");
    });
    const turnId = hostTurnIdSchema.parse("first-turn");
    const turnRef = { ...nativeRef, nativeTurnKey: "native-first-turn" };
    await expect(f.repository.persistTurn(created, turnId, turnRef)).rejects.toThrow();
    expect(f.published).not.toHaveBeenCalled();
    f.beforeReplace.mockReset();
    const first = await f.repository.persistTurn(created, turnId, turnRef);
    expect(f.published).toHaveBeenCalledExactlyOnceWith(first);
    await f.repository.persistTurn(first, hostTurnIdSchema.parse("second-turn"), {
      ...nativeRef,
      nativeTurnKey: "native-second-turn",
    });
    expect(f.published).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "notifies the Adapter after its first completed Turn, with no notification on resume (prewarm: %s)",
    async (prewarm) => {
      const published = vi.fn<NonNullable<HarnessAdapter["onSessionPublished"]>>(
        async () => undefined,
      );
      const adapter = Object.assign(new FakeHarnessAdapter(harnessIdSchema.parse("pi")), {
        onSessionPublished: published,
      });
      const host = createFixture({ externalAdapters: new Map([[adapter.harnessId, adapter]]) });
      try {
        const threadId = await startExternalThread(host, "codexhost/pi-native", 1, {
          codexhostPrewarm: prewarm,
        });
        expect(published).not.toHaveBeenCalled();
        if (prewarm) {
          expect(
            await host.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
          ).toMatchObject({
            state: "creating",
          });
        }
        await startPiTurn(host, threadId);
        await host.collector.waitFor((message) => message.method === "turn/started");
        expect(published).not.toHaveBeenCalled();
        adapter.sessions[0]?.succeedTurn();
        await host.collector.waitFor((message) => message.method === "turn/completed");
        const record = await host.mappingStore.getThread(hostThreadIdSchema.parse(threadId));
        expect(record).toMatchObject({ state: "ready" });
        expect(published).toHaveBeenCalledExactlyOnceWith(record?.nativeSessionRef);
        writeRequest(host.desktopInput, {
          id: 50,
          method: "thread/resume",
          params: { threadId, excludeTurns: true },
        });
        expect(await host.collector.waitFor((message) => message.id === 50)).not.toHaveProperty(
          "error",
        );
        expect(published).toHaveBeenCalledOnce();
      } finally {
        await stopFixture(host);
      }
    },
  );
});

describe("Connected Desktop catalog refresh", () => {
  const control = { CODEXHOST_CONTROL_PORT: "12345", CODEXHOST_CONTROL_NONCE: "a".repeat(32) };

  it("refreshes the same native home through a symbolic link", async () => {
    const root = await directory();
    const home = path.join(root, "native");
    const alias = path.join(root, "alias");
    await mkdir(home);
    await symlink(home, alias, process.platform === "win32" ? "junction" : "dir");
    await refreshNativeThreadCatalog(control, alias, home);
    expect(requestRefresh).toHaveBeenCalledExactlyOnceWith(control);
  });

  it("does not request an unavailable Controller, another home or an unreadable home", async () => {
    const root = await directory();
    const other = path.join(root, "other");
    await mkdir(other);
    await refreshNativeThreadCatalog({}, root, root);
    await refreshNativeThreadCatalog({ CODEXHOST_CONTROL_PORT: "12345" }, root, root);
    await refreshNativeThreadCatalog(control, other, root);
    await refreshNativeThreadCatalog(control, path.join(root, "missing"), root);
    expect(requestRefresh).not.toHaveBeenCalled();
  });

  it("ignores refresh failures without retrying", async () => {
    const home = await directory();
    requestRefresh.mockRejectedValueOnce(new Error("Controller disconnected"));
    await expect(refreshNativeThreadCatalog(control, home, home)).resolves.toBeUndefined();
    expect(requestRefresh).toHaveBeenCalledOnce();
  });

  it("offers local refresh without exposing it to a managed remote Harness", () => {
    expect(
      installedHarnessPluginOptions({}, false).pluginContext.refreshNativeThreadCatalog,
    ).toBeTypeOf("function");
    expect(installedHarnessPluginOptions({}, true).pluginContext).not.toHaveProperty(
      "refreshNativeThreadCatalog",
    );
    expect(requestRefresh).not.toHaveBeenCalled();
  });
});
