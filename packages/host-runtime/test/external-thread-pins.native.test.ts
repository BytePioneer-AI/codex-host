import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { MappingStore } from "@codexhost/mapping-store";
import { harnessIdSchema } from "@codexhost/shared-contracts";
import type { JsonObject } from "@codexhost/protocol-core";
import { AppServerHost } from "../src/app-server-host.js";
import { prepareLocalCodex } from "../src/native-account-host.js";
import { SharedThreadOwner } from "../src/shared-thread-owner.js";
import { PINNED_THREAD_SECTION_ID } from "../src/external-thread-pins.js";

const executable = process.env.CODEXHOST_TEST_STOCK_CODEX;

it.skipIf(!executable)(
  "persists official and External pins in their owners with a real backend, without Desktop or model requests",
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-headless-pins-"));
    const environment = {
      PATH: process.env.PATH,
      HOME: directory,
      USERPROFILE: directory,
      CODEX_HOME: path.join(directory, "native"),
      CODEXHOST_DATA_DIR: path.join(directory, "host"),
    };
    const diagnostics = new PassThrough();
    diagnostics.resume();
    const startNative = () =>
      prepareLocalCodex({
        stockCodexPath: executable ?? "",
        arguments: ["app-server"],
        environment,
        diagnosticOutput: diagnostics,
        deferStart: true,
      });
    let official = await startNative();
    let host: AppServerHost | undefined;
    let owner: SharedThreadOwner | undefined;
    let running: Promise<number> | undefined;
    const close = async () => {
      host?.close();
      await running;
      owner?.close();
    };
    const open = async () => {
      const store = new MappingStore({ directory: environment.CODEXHOST_DATA_DIR });
      await store.initialize();
      owner = new SharedThreadOwner();
      host = new AppServerHost({
        stockCodexPath: executable ?? "",
        arguments: [],
        environment,
        externalOnly: true,
        desktopInput: owner.input,
        desktopOutput: owner.output,
        diagnosticOutput: diagnostics,
        officialRuntimeScope: official.officialRuntimeScope,
        accountControl: official.accountControl,
        mappingStore: store,
        externalAdapters: new Map([["pi", new FakeHarnessAdapter(harnessIdSchema.parse("pi"))]]),
      });
      running = host.run();
      return host;
    };
    try {
      let current = await open();
      expect(official.officialRuntimeScope.owner.running).toBe(false);
      const started = await current.handleClientRequest("thread/start", {
        model: "codexhost/pi-native",
        cwd: directory,
      });
      if (!("result" in started)) throw new Error(started.error.message);
      const threadId = String(((started.result as JsonObject).thread as JsonObject).id);
      const pin = await current.handleClientRequest("codexhost/thread/pins/set", {
        threadId,
        pinned: true,
      });
      expect(pin).toEqual({ result: { threadIds: [threadId] } });
      expect(official.officialRuntimeScope.owner.running).toBe(true);
      const created = await current.handleClientRequest("thread/start", { cwd: directory });
      if (!("result" in created)) throw new Error(created.error.message);
      const nativeId = String(((created.result as JsonObject).thread as JsonObject).id);
      expect(
        await current.handleClientRequest("codexhost/thread/pins/set", {
          threadId: nativeId,
          pinned: true,
        }),
      ).toEqual({ result: { threadIds: [nativeId, threadId] } });
      expect(
        await official.officialRuntimeScope.owner.controlRequest("thread/read", {
          threadId: nativeId,
        }),
      ).toMatchObject({
        result: { thread: { id: nativeId, section: { id: PINNED_THREAD_SECTION_ID } } },
      });
      await close();
      await official.close();
      official = await startNative();
      current = await open();
      expect(await current.handleClientRequest("codexhost/thread/pins/list", {})).toEqual({
        result: { threadIds: [nativeId, threadId] },
      });
      const desktop = owner?.connect();
      if (!desktop) throw new Error("Missing Desktop test connection");
      const desktopRead = await desktop.request("thread/list", {
        sectionId: PINNED_THREAD_SECTION_ID,
        sortKey: "section_position",
        limit: 100,
      });
      expect(desktopRead).toMatchObject({
        result: {
          data: [
            { id: nativeId, section: { id: PINNED_THREAD_SECTION_ID } },
            { id: threadId, section: { id: PINNED_THREAD_SECTION_ID } },
          ],
        },
      });
      // A Desktop protocol move is the same official mutation, not a Web pin copy.
      expect(
        await desktop.request("thread/section/move", {
          threadId: nativeId,
          sectionId: null,
          beforeThreadId: null,
        }),
      ).toMatchObject({ result: {} });
      expect(await current.handleClientRequest("codexhost/thread/pins/list", {})).toEqual({
        result: { threadIds: [threadId] },
      });
      expect(
        await desktop.request("thread/section/move", {
          threadId: nativeId,
          sectionId: PINNED_THREAD_SECTION_ID,
          beforeThreadId: threadId,
        }),
      ).toMatchObject({ result: {} });
      expect(await current.handleClientRequest("codexhost/thread/pins/list", {})).toEqual({
        result: { threadIds: [nativeId, threadId] },
      });
      expect(
        await current.handleClientRequest("codexhost/thread/pins/set", {
          threadId: nativeId,
          pinned: false,
        }),
      ).toEqual({ result: { threadIds: [threadId] } });
      expect(
        await official.officialRuntimeScope.owner.controlRequest("thread/read", {
          threadId: nativeId,
        }),
      ).toMatchObject({ result: { thread: { id: nativeId, section: null } } });
      expect(
        await current.handleClientRequest("codexhost/thread/pins/set", { threadId, pinned: false }),
      ).toEqual({ result: { threadIds: [] } });
      desktop.close();
      await close();
      await official.close();
      official = await startNative();
      current = await open();
      expect(await current.handleClientRequest("codexhost/thread/pins/list", {})).toEqual({
        result: { threadIds: [] },
      });
      const native = await official.officialRuntimeScope.owner.controlRequest("thread/list", {
        limit: 100,
        useStateDbOnly: true,
      });
      // An empty official Thread is not in the ordinary list after leaving its section.
      expect(native).toMatchObject({ result: { data: [] } });
      expect(existsSync(path.join(environment.CODEX_HOME, ".codex-global-state.json"))).toBe(false);
    } finally {
      await close();
      await official.close();
      diagnostics.end();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
