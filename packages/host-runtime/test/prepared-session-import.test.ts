import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  HarnessSessionImportCapability,
  HarnessSessionImportSource,
} from "@codexhost/harness-adapter";
import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import { MappingStore } from "@codexhost/mapping-store";
import { harnessIdSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DELEGATION_THREAD_ID_ENV } from "../src/delegation-types.js";
import { ExternalThreadRepository } from "../src/external-thread-repository.js";
import {
  HarnessSessionImporter,
  type PreparedSessionImportOptions,
} from "../src/harness-session-import.js";
import { createFixture, stopFixture } from "./app-server-host-fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function openRepository(directory: string) {
  const repository = new ExternalThreadRepository(new MappingStore({ directory }));
  await repository.initialize();
  cleanup.push(() => repository.close());
  return repository;
}

async function fixture(destinationId = "source-session") {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "codexhost-prepared-import-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "mappings");
  const repository = await openRepository(directory);
  const base = new FakeHarnessAdapter(harnessIdSchema.parse("prepared-import"));
  const source: HarnessSessionImportSource = {
    candidate: {
      nativeSessionId: "source-session",
      title: "Existing native Session",
      cwd: root,
      running: false,
      updatedAt: 1,
    },
    nativeRef: {
      harnessId: base.harnessId,
      nativeSessionId: "source-session",
      formatVersion: 1,
    },
  };
  const destinationRef = { ...source.nativeRef, nativeSessionId: destinationId };
  const session = new FakeHarnessSession(base.harnessId, base.catalog, undefined, destinationRef);
  cleanup.push(() => session.close());
  const close = vi.spyOn(session, "close");
  const prepare = vi.fn<NonNullable<HarnessSessionImportCapability["prepareImport"]>>(async () => ({
    ok: true,
    value: { nativeRef: destinationRef, session },
  }));
  const adapter = Object.assign(base, {
    sessionImport: {
      listCandidates: vi.fn(async () => ({
        ok: true as const,
        value: ["source-session", "branch-session", "unrelated-session"].map((nativeSessionId) => ({
          ...source.candidate,
          nativeSessionId,
        })),
      })),
      resolveCandidate: vi.fn(async () => ({ ok: true as const, value: source })),
      prepareImport: prepare,
    },
  });
  const adopt = vi.fn<NonNullable<PreparedSessionImportOptions["adoptPreparedSession"]>>(
    async () => undefined,
  );
  const importer = (store = repository) =>
    new HarnessSessionImporter({
      harnessId: adapter.harnessId,
      adapter,
      repository: store,
      environment: { IMPORT_ENV: "preserved" },
      adoptPreparedSession: adopt,
    });
  return {
    directory,
    repository,
    source,
    destinationRef,
    adapter,
    session,
    close,
    prepare,
    adopt,
    importer,
  };
}

describe("Prepared native Session import", () => {
  it("commits a resumed Session before adoption or snapshot reads and keeps it open", async () => {
    const f = await fixture();
    const readSnapshot = vi.spyOn(f.session, "readSnapshot");
    f.adopt.mockImplementation(async (record, session) => {
      expect(await f.repository.find(record.hostThreadId)).toMatchObject({
        state: "ready",
        nativeSessionRef: f.source.nativeRef,
        importSourceRef: f.source.nativeRef,
      });
      expect(session).toBe(f.session);
      expect(readSnapshot).not.toHaveBeenCalled();
      await session.readSnapshot();
    });

    const outcome = await f.importer().import("source-session");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("Import failed");
    expect(f.prepare).toHaveBeenCalledExactlyOnceWith({
      source: f.source,
      environment: { IMPORT_ENV: "preserved", [DELEGATION_THREAD_ID_ENV]: outcome.threadId },
    });
    expect(f.adopt).toHaveBeenCalledOnce();
    expect(readSnapshot).toHaveBeenCalledOnce();
    expect(f.close).not.toHaveBeenCalled();
  });

  it("persists a derived ID and its source, hides both from discovery, and reuses it after restart", async () => {
    const f = await fixture("branch-session");
    const importer = f.importer();
    const outcome = await importer.import("source-session");
    if (!outcome.ok) throw new Error("Import failed");
    expect(await f.repository.find(outcome.threadId)).toMatchObject({
      state: "ready",
      nativeSessionRef: f.destinationRef,
      importSourceRef: f.source.nativeRef,
    });
    for (const nativeId of ["source-session", "branch-session"])
      expect(await importer.import(nativeId)).toMatchObject({
        ok: true,
        threadId: outcome.threadId,
      });
    expect(await importer.list()).toMatchObject({
      ok: true,
      total: 1,
      candidates: [{ nativeSessionId: "unrelated-session" }],
    });

    await f.repository.close();
    const restarted = f.importer(await openRepository(f.directory));
    for (const nativeId of ["source-session", "branch-session"])
      expect(await restarted.import(nativeId)).toMatchObject({
        ok: true,
        threadId: outcome.threadId,
      });
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.adapter.sessionImport.resolveCandidate).toHaveBeenCalledOnce();
    expect(f.adopt).toHaveBeenCalledOnce();
  });

  it("retains an unconfirmed import across restart and refuses to create it again", async () => {
    const f = await fixture("branch-session");
    f.prepare.mockRejectedValueOnce(new Error("Connection lost after native creation"));
    const outcome = await f.importer().import("source-session");
    expect(outcome).toMatchObject({ ok: false, error: { code: -32081 } });
    const pending = (await f.repository.list())[0];
    expect(pending).toMatchObject({ state: "creating", importSourceRef: f.source.nativeRef });
    expect(pending?.nativeSessionRef).toBeUndefined();

    await f.repository.close();
    const repository = await openRepository(f.directory);
    expect(await repository.list()).toEqual([pending]);
    const restarted = f.importer(repository);
    expect(await restarted.import("source-session")).toEqual(outcome);
    expect(await restarted.import("source-session")).toEqual(outcome);
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.adopt).not.toHaveBeenCalled();
  });

  it("removes a confirmed failed preparation so an explicit retry can succeed", async () => {
    const f = await fixture();
    f.prepare.mockResolvedValueOnce({
      ok: false,
      error: { code: "sessionBusy", message: "Cannot prepare Session", retryable: true },
    });
    const importer = f.importer();
    expect(await importer.import("source-session")).toMatchObject({
      ok: false,
      error: { code: -32072 },
    });
    expect(await f.repository.list()).toEqual([]);
    expect(await importer.import("source-session")).toMatchObject({ ok: true });
    expect(await f.repository.list()).toHaveLength(1);
    expect(f.prepare).toHaveBeenCalledTimes(2);
    expect(f.adopt).toHaveBeenCalledOnce();
  });

  it("keeps an import pending and closes the Session when persisting a known native ID fails", async () => {
    const f = await fixture("branch-session");
    vi.spyOn(f.repository, "commitNative").mockRejectedValueOnce(new Error("Disk write failed"));
    expect(await f.importer().import("source-session")).toMatchObject({
      ok: false,
      error: { code: -32081 },
    });
    expect(await f.repository.list()).toMatchObject([
      { state: "creating", importSourceRef: f.source.nativeRef },
    ]);
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.adopt).not.toHaveBeenCalled();

    await f.repository.close();
    const restarted = f.importer(await openRepository(f.directory));
    expect(await restarted.import("source-session")).toMatchObject({
      ok: false,
      error: { code: -32081 },
    });
    expect(f.prepare).toHaveBeenCalledOnce();
  });

  it("keeps a committed branch when adoption fails so reopening never forks again", async () => {
    const f = await fixture("branch-session");
    f.adopt.mockRejectedValueOnce(new Error("History could not be loaded"));
    const importer = f.importer();
    expect(await importer.import("source-session")).toMatchObject({
      ok: false,
      error: { code: -32082 },
    });
    const record = (await f.repository.list())[0];
    expect(record).toMatchObject({ state: "ready", nativeSessionRef: f.destinationRef });
    expect(f.close).toHaveBeenCalledOnce();
    expect(await importer.import("source-session")).toMatchObject({
      ok: true,
      threadId: record?.hostThreadId,
    });
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.adopt).toHaveBeenCalledOnce();
  });

  it("persists a known branch even when preparation has no live Session to adopt", async () => {
    const f = await fixture("branch-session");
    f.prepare.mockResolvedValueOnce({ ok: true, value: { nativeRef: f.destinationRef } });
    const outcome = await f.importer().import("source-session");
    if (!outcome.ok) throw new Error("Import failed");
    expect(await f.repository.find(outcome.threadId)).toMatchObject({
      state: "ready",
      nativeSessionRef: f.destinationRef,
    });
    expect(f.adopt).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
    expect(await f.importer().import("source-session")).toMatchObject({
      ok: true,
      threadId: outcome.threadId,
    });
    expect(f.prepare).toHaveBeenCalledOnce();
  });

  it("allows only one native preparation across concurrent importer instances", async () => {
    const f = await fixture("branch-session");
    const started = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    f.prepare.mockImplementation(async () => {
      started.resolve(undefined);
      await release.promise;
      return { ok: true, value: { nativeRef: f.destinationRef, session: f.session } };
    });
    const operations = [
      f.importer().import("source-session"),
      f.importer().import("source-session"),
    ];
    await started.promise;
    try {
      expect(await Promise.race(operations)).toMatchObject({
        ok: false,
        error: { code: -32081 },
      });
      expect(f.prepare).toHaveBeenCalledOnce();
    } finally {
      release.resolve(undefined);
    }
    const outcomes = await Promise.all(operations);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    const records = await f.repository.list();
    expect(records).toHaveLength(1);
    expect(await f.importer().import("source-session")).toMatchObject({
      ok: true,
      threadId: records[0]?.hostThreadId,
    });
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.adopt).toHaveBeenCalledOnce();
  });

  it.each(["prepare", "snapshot"])(
    "drains a pending %s before closing the Host and releases its imported Session once",
    async (phase) => {
      const f = await fixture("branch-session");
      const entered = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      if (phase === "prepare") {
        f.prepare.mockImplementation(async () => {
          entered.resolve(undefined);
          await release.promise;
          return { ok: true, value: { nativeRef: f.destinationRef, session: f.session } };
        });
      } else {
        const readSnapshot = f.session.readSnapshot.bind(f.session);
        vi.spyOn(f.session, "readSnapshot").mockImplementation(async () => {
          entered.resolve(undefined);
          await release.promise;
          return readSnapshot();
        });
      }
      const host = createFixture({
        additionalAdapters: new Map([[f.adapter.harnessId, f.adapter]]),
      });
      const adapterClose = vi.spyOn(f.adapter, "close");
      const storeClose = vi.spyOn(host.mappingStore, "close");
      try {
        await host.ready;
        const importing = host.host.handleClientRequest("codexhost/harness/session-import/import", {
          harnessId: f.adapter.harnessId,
          nativeSessionId: f.source.nativeRef.nativeSessionId,
        });
        await entered.promise;
        host.desktopInput.end();
        // Let the input-end handler reach its shutdown drain while native work is held.
        await new Promise<undefined>((resolve) => setImmediate(resolve, undefined));
        expect(adapterClose).not.toHaveBeenCalled();
        expect(storeClose).not.toHaveBeenCalled();
        expect(f.close).not.toHaveBeenCalled();
        release.resolve(undefined);
        expect(await importing).toMatchObject({ result: { threadId: expect.any(String) } });
        expect(await host.running).toBe(0);
        expect(adapterClose).toHaveBeenCalledOnce();
        expect(storeClose).toHaveBeenCalledOnce();
        expect(f.close).toHaveBeenCalledOnce();
      } finally {
        release.resolve(undefined);
        await stopFixture(host);
      }
    },
  );
});
