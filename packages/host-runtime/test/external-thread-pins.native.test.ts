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
  "pins, restores and unpins with a real native backend, without a Desktop or native mirror Thread",
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
    const official = await prepareLocalCodex({
      stockCodexPath: executable ?? "",
      arguments: ["app-server"],
      environment,
      diagnosticOutput: diagnostics,
      deferStart: true,
    });
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
      await close();
      current = await open();
      expect(await current.handleClientRequest("codexhost/thread/pins/list", {})).toEqual({
        result: { threadIds: [threadId] },
      });
      const desktopRead = await current.handleClientRequest("thread/list", {
        sectionId: PINNED_THREAD_SECTION_ID,
        sortKey: "section_position",
        limit: 100,
      });
      expect(desktopRead).toMatchObject({
        result: { data: [{ id: threadId, section: { id: PINNED_THREAD_SECTION_ID } }] },
      });
      expect(
        await current.handleClientRequest("codexhost/thread/pins/set", { threadId, pinned: false }),
      ).toEqual({ result: { threadIds: [] } });
      await close();
      current = await open();
      expect(await current.handleClientRequest("codexhost/thread/pins/list", {})).toEqual({
        result: { threadIds: [] },
      });
      const native = await official.officialRuntimeScope.owner.controlRequest("thread/list", {
        limit: 100,
        useStateDbOnly: true,
      });
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
