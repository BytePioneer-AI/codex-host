import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import { decodeExternalTransportSelection, type JsonObject } from "@codexhost/protocol-core";
import {
  encodeHarnessPluginRoute,
  harnessPluginRouteSchema,
  harnessIdSchema,
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  hostThreadIdSchema,
} from "@codexhost/shared-contracts";
import type { DelegationControlApi } from "../src/delegation-types.js";

import {
  method,
  requestId,
  requiredMessageId,
  turnEvent,
  writeRequest,
  readJsonLine,
  answerOfficialParentCwd,
  createFixture,
  startExternalThread,
  startPiThread,
  startPiTurn,
  completePiTurn,
  stopFixture,
} from "./app-server-host-fixture.js";

describe("AppServerHost idle resource release", () => {
  it.each(["auto", "default"] as const)(
    "resumes delegated Claude with its saved %s permission after idle release",
    async (expectedMode) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
      const permissionModes = harnessPermissionModeCatalogSchema.parse({
        modes: [
          { id: "default", label: "Default" },
          { id: "auto", label: "Auto" },
        ],
        defaultModeId: "default",
      });
      const adapter = new FakeHarnessAdapter(
        harnessIdSchema.parse("claude-code"),
        undefined,
        true,
        true,
        null,
        permissionModes,
      );
      const nativeOpen = adapter.open.bind(adapter);
      vi.spyOn(adapter, "open").mockImplementation(async (input) => {
        if (input.kind !== "create" || input.executionPolicy !== "unattended-full-access") {
          return nativeOpen(input);
        }
        const opened = await nativeOpen({
          ...input,
          permissionModeId: harnessPermissionModeIdSchema.parse("auto"),
        });
        if (!opened.ok) return opened;
        // Claude publishes native identity and effective configuration after startup.
        Object.defineProperty(opened.value, "initialState", { value: {} });
        await opened.value.execute({
          type: "permissionMode.select",
          permissionModeId: harnessPermissionModeIdSchema.parse("auto"),
        });
        return opened;
      });
      let delegationApi: DelegationControlApi | undefined;
      const fixture = createFixture({
        externalAdapters: new Map([["claude-code", adapter]]),
        onDelegationApi: (api) => {
          delegationApi = api;
          return undefined;
        },
      });
      let resumed: FakeHarnessSession | undefined;
      try {
        await fixture.ready;
        if (!delegationApi) throw new Error("Delegation API was not registered");
        const starting = delegationApi.start({
          harnessId: "claude-code",
          task: "check permissions",
          cwd: "/synthetic",
          parentThreadId: "parent-thread",
        });
        await answerOfficialParentCwd(fixture);
        const started = await starting;
        const threadId = hostThreadIdSchema.parse(started.threadId);
        const source = adapter.sessions[0];
        if (!source) throw new Error("Missing delegated Session");
        const stored = await fixture.mappingStore.getThread(threadId);
        source.succeedTurn();
        await fixture.collector.waitFor((message) =>
          turnEvent(message, "turn/completed", started.turnId),
        );
        expect(
          decodeExternalTransportSelection("claude-code", stored?.transportModelId),
        ).toMatchObject({ permissionModeId: "auto" });
        if (expectedMode === "default") {
          writeRequest(fixture.desktopInput, {
            id: 900,
            method: "codexhost/thread/permission-mode/select",
            params: { threadId, permissionModeId: expectedMode },
          });
          expect(
            await fixture.collector.waitFor((message) => requestId(message, 900)),
          ).toMatchObject({ result: { effectivePermissionModeId: expectedMode } });
        }
        const snapshot = await source.readSnapshot();
        if (!snapshot.ok) throw new Error(snapshot.error.message);
        const close = vi.spyOn(source, "close");
        vi.mocked(adapter.open).mockImplementation(async (input) => {
          if (input.kind !== "resume") return nativeOpen(input);
          resumed = new FakeHarnessSession(
            adapter.harnessId,
            adapter.catalog,
            input.model,
            input.nativeRef,
            snapshot.value,
            true,
            input.cwd,
            true,
            input.thinkingOptionId,
            null,
            permissionModes,
          );
          expect(resumed.state.effectivePermissionModeId).toBe("default");
          return { ok: true, value: resumed };
        });
        writeRequest(fixture.desktopInput, {
          id: 901,
          method: "codexhost/settings/idle-release/set",
          params: { enabled: true, timeoutMinutes: 10 },
        });
        await fixture.collector.waitFor((message) => requestId(message, 901));
        await vi.advanceTimersByTimeAsync(11 * 60_000);
        expect(close).toHaveBeenCalledOnce();
        const next = await delegationApi.send({ threadId, message: "continue" });
        if (!resumed) throw new Error("Missing resumed Session");
        expect(resumed.state.effectivePermissionModeId).toBe(expectedMode);
        resumed.succeedTurn();
        await fixture.collector.waitFor((message) =>
          turnEvent(message, "turn/completed", next.turnId),
        );
      } finally {
        fixture.host.close();
        await stopFixture(fixture);
        vi.useRealTimers();
      }
    },
  );

  it("validates settings locally without forwarding them to the official server", async () => {
    const fixture = createFixture();
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 900,
        method: "codexhost/settings/idle-release/set",
        params: { enabled: true, timeoutMinutes: 4 },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 900))).toMatchObject({
        error: { code: -32602 },
      });
      writeRequest(fixture.desktopInput, {
        id: 901,
        method: "codexhost/settings/idle-release/set",
        params: { enabled: false, timeoutMinutes: 30 },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 901))).toMatchObject({
        result: { enabled: false, timeoutMinutes: 30 },
      });
      expect(fixture.official.stdin.read()).toBeNull();
    } finally {
      await stopFixture(fixture);
    }
  });

  it("silently releases an idle session and resumes its history for another Turn", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await completePiTurn(fixture, threadId, 2);
      const source = fixture.adapter.sessions[0];
      if (!source) throw new Error("Missing source Session");
      const snapshot = await source.readSnapshot();
      if (!snapshot.ok) throw new Error(snapshot.error.message);
      const close = vi.spyOn(source, "close");
      const nativeOpen = fixture.adapter.open.bind(fixture.adapter);
      let resumed: FakeHarnessSession | undefined;
      const open = vi.spyOn(fixture.adapter, "open").mockImplementation(async (input) => {
        if (input.kind !== "resume") return nativeOpen(input);
        resumed = new FakeHarnessSession(
          fixture.adapter.harnessId,
          fixture.adapter.catalog,
          undefined,
          input.nativeRef,
          snapshot.value,
        );
        return { ok: true, value: resumed };
      });
      writeRequest(fixture.desktopInput, {
        id: 900,
        method: "codexhost/settings/idle-release/set",
        params: { enabled: true, timeoutMinutes: 10 },
      });
      await fixture.collector.waitFor((message) => requestId(message, 900));
      await vi.advanceTimersByTimeAsync(9 * 60_000);
      writeRequest(fixture.desktopInput, {
        id: 910,
        method: "codexhost/sessions/loaded/list",
        params: {},
      });
      const listing = await fixture.collector.waitFor((message) => requestId(message, 910));
      expect(listing).toMatchObject({
        result: [{ threadId, state: "idle", reason: "timeout", inactiveMs: 9 * 60_000 }],
      });
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(close).toHaveBeenCalledTimes(1);
      writeRequest(fixture.desktopInput, {
        id: 911,
        method: "codexhost/sessions/loaded/list",
        params: {},
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 911))).toMatchObject({
        result: [],
      });
      expect(open).not.toHaveBeenCalled();
      expect(fixture.collector.messages.some((message) => method(message, "thread/closed"))).toBe(
        false,
      );
      writeRequest(fixture.desktopInput, {
        id: 901,
        method: "thread/read",
        params: { threadId, includeTurns: false },
      });
      await fixture.collector.waitFor((message) => requestId(message, 901));
      expect(open).not.toHaveBeenCalled();
      writeRequest(fixture.desktopInput, {
        id: 902,
        method: "thread/read",
        params: { threadId, includeTurns: true },
      });
      const history = await fixture.collector.waitFor((message) => requestId(message, 902));
      expect(history).not.toHaveProperty("error");
      expect(JSON.stringify(history)).toContain(turnId);
      expect(open).toHaveBeenCalledTimes(1);
      const nextTurn = await startPiTurn(fixture, threadId, 903);
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", nextTurn));
      if (!resumed) throw new Error("Missing resumed Session");
      resumed.appendText("after idle release");
      resumed.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", nextTurn));
    } finally {
      await stopFixture(fixture);
      vi.useRealTimers();
    }
  });

  it("keeps an active Turn loaded even beyond the configured timeout", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const turnId = await startPiTurn(fixture, threadId);
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Missing Session");
      const close = vi.spyOn(session, "close");
      writeRequest(fixture.desktopInput, {
        id: 900,
        method: "codexhost/settings/idle-release/set",
        params: { enabled: true, timeoutMinutes: 10 },
      });
      await fixture.collector.waitFor((message) => requestId(message, 900));
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      expect(close).not.toHaveBeenCalled();
      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
    } finally {
      await stopFixture(fixture);
      vi.useRealTimers();
    }
  });
});

describe("AppServerHost official forwarding", () => {
  it.each([
    { method: "codexhost/unknown", params: {} },
    {
      method: "thread/start",
      params: { model: "gpt-5", cwd: "/synthetic", unknownParam: "opaque" },
    },
    {
      method: "turn/start",
      params: {
        threadId: "official-thread",
        input: [{ type: "text", text: "synthetic" }],
        unknownParam: "opaque",
      },
    },
  ])("forwards $method unchanged and relays backend errors", async ({ method, params }) => {
    const fixture = createFixture();
    try {
      await fixture.ready;
      const request = { id: 1, method, params };
      writeRequest(fixture.desktopInput, request);
      expect(await readJsonLine(fixture.official.stdin)).toEqual(request);
      const response = { id: 1, error: { code: -32601, message: "Synthetic backend error" } };
      writeRequest(fixture.official.stdout, response);
      expect(await fixture.collector.waitFor((message) => requestId(message, 1))).toEqual(response);
    } finally {
      await stopFixture(fixture);
    }
  });
});

describe("AppServerHost installed Harness plugins", () => {
  // A cold plugin import has a 10s per-plugin loader budget; RPC checks remain 2s.
  it("discovers an unknown plugin, serves its descriptor, routes a Thread, and closes it", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-plugin-host-"));
    const location = path.join(directory, "sample-agent");
    mkdirSync(location);
    writeFileSync(
      path.join(directory, "enabled.json"),
      JSON.stringify({ version: 1, enabled: ["sample-agent"] }),
    );
    writeFileSync(
      path.join(location, "manifest.json"),
      JSON.stringify({
        manifestVersion: 1,
        id: "sample-agent",
        name: "Sample Agent",
        version: "1.0.0",
        adapterApiVersion: 1,
        entry: "index.mjs",
      }),
    );
    writeFileSync(
      path.join(location, "index.mjs"),
      `
      import { FakeHarnessAdapter } from ${JSON.stringify(pathToFileURL(path.resolve("packages/harness-adapter/dist/testing.js")).href)};
      import { writeFileSync } from "node:fs";
      let accountInspections = 0;
      export function createHarnessAdapter() {
        const adapter = new FakeHarnessAdapter("sample-agent");
        adapter.inspectAccount = async () => ({ email: "sample@example.com", credits: { usedPercent: ++accountInspections, periodType: "weekly" } });
        const close = adapter.close.bind(adapter);
        adapter.close = async () => { await close(); writeFileSync(new URL("closed", import.meta.url), "yes"); };
        return adapter;
      }
    `,
    );
    const fixture = createFixture({ pluginDirectory: directory, externalAdapters: new Map() });
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 901,
        method: "codexhost/harness/plugins/list",
        params: {},
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 901))).toMatchObject({
        result: { plugins: [{ id: "sample-agent", name: "Sample Agent", version: "1.0.0" }] },
      });
      writeRequest(fixture.desktopInput, {
        id: 907,
        method: "codexhost/harness/accounts/sources",
        params: {},
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 907))).toMatchObject({
        result: {
          sources: [{ harnessId: "sample-agent", harnessName: "Sample Agent" }],
        },
      });
      writeRequest(fixture.desktopInput, {
        id: 908,
        method: "codexhost/harness/accounts/inspect",
        params: { harnessId: "sample-agent" },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 908))).toMatchObject({
        result: {
          harnessId: "sample-agent",
          harnessName: "Sample Agent",
          account: {
            email: "sample@example.com",
            credits: { usedPercent: 1 },
          },
        },
      });
      writeRequest(fixture.desktopInput, {
        id: 902,
        method: "codexhost/harness/inspect",
        params: { harnessId: "sample-agent" },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 902))).toMatchObject({
        result: { status: "ready" },
      });
      writeRequest(fixture.desktopInput, {
        id: 905,
        method: "codexhost/harness/accounts/list",
        params: {},
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 905))).toMatchObject({
        result: {
          accounts: [
            {
              harnessId: "sample-agent",
              harnessName: "Sample Agent",
              email: "sample@example.com",
              credits: { usedPercent: 1 },
            },
          ],
        },
      });
      writeRequest(fixture.desktopInput, {
        id: 909,
        method: "codexhost/harness/accounts/inspect",
        params: { harnessId: "sample-agent", refresh: true },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 909))).toMatchObject({
        result: {
          harnessId: "sample-agent",
          account: { credits: { usedPercent: 2 } },
        },
      });
      writeRequest(fixture.desktopInput, {
        id: 906,
        method: "codexhost/harness/accounts/list",
        params: { token: "invalid" },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 906))).toMatchObject({
        error: { code: -32602 },
      });
      const model = encodeHarnessPluginRoute(
        harnessPluginRouteSchema.parse({ harnessId: "sample-agent" }),
      );
      const threadId = await startExternalThread(fixture, model, 903);
      expect(
        await fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
      ).toMatchObject({ harnessId: "sample-agent" });
      expect(fixture.official.stdin.readableLength).toBe(0);
      writeRequest(fixture.desktopInput, { id: 904, method: "initialize", params: {} });
      const initialize = await readJsonLine(fixture.official.stdin);
      expect(initialize).toMatchObject({ method: "initialize" });
      writeRequest(fixture.official.stdout, {
        id: requiredMessageId(initialize),
        result: { userAgent: "official" },
      });
      expect(await readJsonLine(fixture.official.stdin)).toMatchObject({ method: "initialized" });
      expect(await fixture.collector.waitFor((message) => requestId(message, 904))).toMatchObject({
        result: { userAgent: "official" },
      });
    } finally {
      await stopFixture(fixture);
      try {
        expect(readFileSync(path.join(location, "closed"), "utf8")).toBe("yes");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }, 15_000);

  it("keeps Qoder Global and CN Threads on distinct shared plugin routes", async () => {
    const ids = [harnessIdSchema.parse("qoder"), harnessIdSchema.parse("qoder-cn")];
    const fixture = createFixture({
      externalAdapters: new Map(ids.map((id) => [id, new FakeHarnessAdapter(id)])),
    });
    try {
      await fixture.ready;
      const threads: string[] = [];
      for (const [index, id] of ids.entries()) {
        const model = encodeHarnessPluginRoute({ harnessId: id });
        const threadId = await startExternalThread(fixture, model, 950 + index);
        threads.push(threadId);
        expect(
          await fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
        ).toMatchObject({ harnessId: id });
      }
      expect(new Set(threads).size).toBe(2);
      expect(fixture.official.stdin.readableLength).toBe(0);
    } finally {
      await stopFixture(fixture);
    }
  });

  const pluginWaitMethods = [
    "codexhost/harness/inspect",
    "codexhost/harness/commands/inspect",
    "thread/start",
    "thread/resume",
  ];
  it.each(pluginWaitMethods)(
    "keeps official requests moving during plugin loading: %s",
    async (blockedMethod) => {
      const directory = mkdtempSync(path.join(tmpdir(), "codexhost-plugin-parallel-"));
      const location = path.join(directory, "slow-agent");
      const release = path.join(directory, "release");
      mkdirSync(location);
      writeFileSync(
        path.join(directory, "enabled.json"),
        JSON.stringify({ version: 1, enabled: ["slow-agent"] }),
      );
      writeFileSync(
        path.join(location, "manifest.json"),
        JSON.stringify({
          manifestVersion: 1,
          id: "slow-agent",
          name: "Slow Agent",
          version: "1.0.0",
          adapterApiVersion: 1,
          entry: "index.mjs",
        }),
      );
      writeFileSync(
        path.join(location, "index.mjs"),
        `
      import { access, writeFile } from "node:fs/promises";
      import { FakeHarnessAdapter } from ${JSON.stringify(pathToFileURL(path.resolve("packages/harness-adapter/dist/testing.js")).href)};
      const release = ${JSON.stringify(pathToFileURL(release).href)};
      async function waitForRelease() {
        for (;;) {
          try {
            await access(new URL(release));
            return;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
      }
      export async function createHarnessAdapter() {
        await writeFile(new URL("started", import.meta.url), "yes");
        await waitForRelease();
        const adapter = new FakeHarnessAdapter("slow-agent");
        await adapter.open({ kind: "create", cwd: "/synthetic" });
        return adapter;
      }
    `,
      );
      const fixture = createFixture({ pluginDirectory: directory, externalAdapters: new Map() });
      try {
        await fixture.ready;
        await vi.waitFor(() => expect(readdirSync(location)).toContain("started"));
        writeRequest(fixture.desktopInput, {
          id: 918,
          method: "initialize",
          params: { clientInfo: { name: "startup-test", version: "1" } },
        });
        const initialize = await readJsonLine(fixture.official.stdin);
        expect(initialize.method).toBe("initialize");
        writeRequest(fixture.official.stdout, {
          id: requiredMessageId(initialize),
          result: { userAgent: "test" },
        });
        expect(await fixture.collector.waitFor((message) => requestId(message, 918))).toMatchObject(
          {
            result: { userAgent: "test" },
          },
        );
        expect((await readJsonLine(fixture.official.stdin)).method).toBe("initialized");
        const model = encodeHarnessPluginRoute(
          harnessPluginRouteSchema.parse({ harnessId: "slow-agent" }),
        );
        for (const id of ["persisted-thread", "other-thread"]) {
          const hostThreadId = hostThreadIdSchema.parse(id);
          await fixture.mappingStore.createProvisional({
            hostThreadId,
            createRequestId: id,
            harnessId: harnessIdSchema.parse("slow-agent"),
            cwd: "/synthetic",
            title: "Persisted",
            transportModelId: model,
            ephemeral: false,
            historyMode: "legacy",
          });
          await fixture.mappingStore.commitReady({
            hostThreadId,
            nativeSessionRef: {
              harnessId: harnessIdSchema.parse("slow-agent"),
              nativeSessionId:
                id === "persisted-thread" ? "fake-session-1" : "other-native-session",
              formatVersion: 1,
            },
          });
        }
        writeRequest(fixture.desktopInput, {
          id: 920,
          method: blockedMethod,
          params:
            blockedMethod === "thread/start"
              ? { model, cwd: "/synthetic" }
              : blockedMethod === "thread/resume"
                ? { threadId: "persisted-thread" }
                : { harnessId: "slow-agent" },
        });
        if (blockedMethod === "thread/resume") {
          writeRequest(fixture.desktopInput, {
            id: 921,
            method: "thread/name/set",
            params: { threadId: "persisted-thread", name: "After resume" },
          });
          writeRequest(fixture.desktopInput, {
            id: 922,
            method: "thread/name/set",
            params: { threadId: "other-thread", name: "Independent" },
          });
          expect(
            await fixture.collector.waitFor((message) => requestId(message, 922)),
          ).toHaveProperty("result");
          expect(fixture.collector.messages.some((message) => requestId(message, 921))).toBe(false);
        }
        writeRequest(fixture.desktopInput, { id: 919, method: "model/list", params: {} });
        const models = await readJsonLine(fixture.official.stdin);
        expect(models.method).toBe("model/list");
        writeRequest(fixture.official.stdout, {
          id: requiredMessageId(models),
          result: { data: [] },
        });
        expect(await fixture.collector.waitFor((message) => requestId(message, 919))).toMatchObject(
          {
            result: { data: [] },
          },
        );
        expect(fixture.collector.messages.some((message) => requestId(message, 920))).toBe(false);
        writeFileSync(release, "ok");
        const completed = await fixture.collector.waitFor((message) => requestId(message, 920));
        expect(completed).toHaveProperty("result");
        if (blockedMethod === "thread/resume") {
          expect(completed).toMatchObject({ result: { thread: { id: "persisted-thread" } } });
          const renamed = await fixture.collector.waitFor((message) => requestId(message, 921));
          expect(renamed).toHaveProperty("result");
          expect(fixture.collector.messages.indexOf(renamed)).toBeGreaterThan(
            fixture.collector.messages.indexOf(completed),
          );
        }
        expect(fixture.official.stdin.readableLength).toBe(0);
      } finally {
        writeFileSync(release, "ok");
        fixture.host.close();
        try {
          await stopFixture(fixture);
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    },
    10_000,
  );

  it.each(["close", "eof"])(
    "cancels blocked plugin loads on %s",
    async (ending) => {
      const ids = ["a-agent", "b-agent", "c-agent", "d-agent", "e-agent"];
      const directory = mkdtempSync(path.join(tmpdir(), "codexhost-plugin-close-"));
      const started = path.join(directory, "started");
      const finished = path.join(directory, "finished");
      mkdirSync(started);
      mkdirSync(finished);
      const release = path.join(directory, "release");
      writeFileSync(
        path.join(directory, "enabled.json"),
        JSON.stringify({ version: 1, enabled: ids }),
      );
      for (const id of ids) {
        const location = path.join(directory, id);
        mkdirSync(location);
        writeFileSync(
          path.join(location, "manifest.json"),
          JSON.stringify({
            manifestVersion: 1,
            id,
            name: id,
            version: "1.0.0",
            adapterApiVersion: 1,
            entry: "index.mjs",
          }),
        );
        writeFileSync(
          path.join(location, "index.mjs"),
          `
      import { access, writeFile } from "node:fs/promises";
      import { FakeHarnessAdapter } from ${JSON.stringify(pathToFileURL(path.resolve("packages/harness-adapter/dist/testing.js")).href)};
      const started = ${JSON.stringify(pathToFileURL(path.join(started, id)).href)};
      const finished = ${JSON.stringify(pathToFileURL(path.join(finished, id)).href)};
      const release = ${JSON.stringify(pathToFileURL(release).href)};
      export async function createHarnessAdapter() {
        await writeFile(new URL(started), "yes");
        try {
          for (;;) {
            try {
              await access(new URL(release));
              return new FakeHarnessAdapter(${JSON.stringify(id)});
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
          }
        } finally {
          await writeFile(new URL(finished), "yes");
        }
      }
    `,
        );
      }
      const fixture = createFixture({ pluginDirectory: directory, externalAdapters: new Map() });
      try {
        await fixture.ready;
        await vi.waitFor(() => expect(readdirSync(started)).toHaveLength(4));
        writeRequest(fixture.desktopInput, {
          id: 925,
          method: "codexhost/harness/commands/inspect",
          params: { harnessId: "a-agent" },
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (ending === "close") fixture.host.close();
        else fixture.desktopInput.end();
        let exitCode: number | undefined;
        void fixture.running.then(
          (code) => {
            exitCode = code;
          },
          () => undefined,
        );
        await vi.waitFor(() => expect(exitCode).toBe(0));
        expect(readdirSync(started).sort()).toEqual(["a-agent", "b-agent", "c-agent", "d-agent"]);
      } finally {
        fixture.host.close();
        writeFileSync(release, "ok");
        await vi.waitFor(() =>
          expect(readdirSync(finished).sort()).toEqual(readdirSync(started).sort()),
        );
        try {
          await stopFixture(fixture);
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    },
    3_000,
  );

  it.each(["thread/start", "thread/resume", "codexhost/thread/command/execute"])(
    "drains an admitted Session open before EOF cleanup: %s",
    async (requestMethod) => {
      const fixture = createFixture();
      const release = Promise.withResolvers<undefined>();
      const opened = Promise.withResolvers<undefined>();
      const closeAdapter = vi.spyOn(fixture.adapter, "close");
      try {
        await fixture.ready;
        if (requestMethod !== "thread/start") {
          const seed = await fixture.adapter.open({ kind: "create", cwd: "/synthetic" });
          if (!seed.ok || !seed.value.initialState.nativeRef) {
            throw new Error("Cannot seed a native Session");
          }
          const hostThreadId = hostThreadIdSchema.parse("persisted-thread");
          await fixture.mappingStore.createProvisional({
            hostThreadId,
            createRequestId: "930",
            harnessId: harnessIdSchema.parse("pi"),
            cwd: "/synthetic",
            title: "Persisted",
            transportModelId: "codexhost/pi-native",
            ephemeral: false,
            historyMode: "legacy",
          });
          await fixture.mappingStore.commitReady({
            hostThreadId,
            nativeSessionRef: seed.value.initialState.nativeRef,
          });
        }
        const open = fixture.adapter.open.bind(fixture.adapter);
        vi.spyOn(fixture.adapter, "open").mockImplementation(async (input) => {
          const result = await open(input);
          opened.resolve(undefined);
          await release.promise;
          return result;
        });
        writeRequest(fixture.desktopInput, {
          id: 930,
          method: requestMethod,
          params:
            requestMethod === "thread/start"
              ? { model: "codexhost/pi-native", cwd: "/synthetic" }
              : { threadId: "persisted-thread", commandId: "compact" },
        });
        await opened.promise;
        writeRequest(fixture.desktopInput, { id: 931, method: "model/list", params: {} });
        expect((await readJsonLine(fixture.official.stdin)).method).toBe("model/list");
        fixture.desktopInput.end();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(closeAdapter).not.toHaveBeenCalled();
        release.resolve(undefined);
        await expect(fixture.running).resolves.toBe(0);
        expect(closeAdapter).toHaveBeenCalledOnce();
        const response = await fixture.collector.waitFor((message) => requestId(message, 930));
        if (requestMethod === "codexhost/thread/command/execute") {
          expect(response).toMatchObject({ error: { code: -32078 } });
        } else {
          expect(response).toHaveProperty("result");
        }
        expect(fixture.diagnosticOutput.read()?.toString() ?? "").not.toContain("closed");
      } finally {
        release.resolve(undefined);
        fixture.host.close();
        await stopFixture(fixture);
      }
    },
  );

  it("binds DeepSeek Session Import after its Adapter has been dynamically loaded", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-dynamic-import-"));
    const location = path.join(directory, "deepseek-harness");
    mkdirSync(location);
    writeFileSync(
      path.join(directory, "enabled.json"),
      JSON.stringify({ version: 1, enabled: ["deepseek-harness"] }),
    );
    writeFileSync(
      path.join(location, "manifest.json"),
      JSON.stringify({
        manifestVersion: 1,
        id: "deepseek-harness",
        name: "DeepSeek Harness",
        version: "1",
        adapterApiVersion: 1,
        entry: "plugin.mjs",
      }),
    );
    writeFileSync(
      path.join(location, "plugin.mjs"),
      `
      import { FakeHarnessAdapter } from ${JSON.stringify(pathToFileURL(path.resolve("packages/harness-adapter/dist/testing.js")).href)};
      export function createHarnessAdapter() {
        const adapter = new FakeHarnessAdapter("deepseek-harness");
        adapter.sessionImport = {
          listCandidates: async () => ({ ok: true, value: [] }),
          resolveCandidate: async () => ({ ok: false, error: { code: "sessionNotFound", message: "Missing", retryable: false } }),
        };
        return adapter;
      }
    `,
    );
    const fixture = createFixture({ pluginDirectory: directory, externalAdapters: new Map() });
    try {
      writeRequest(fixture.desktopInput, {
        id: 910,
        method: "codexhost/deepseek/modern-session/list",
        params: {},
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 910))).toMatchObject({
        result: { candidates: [] },
      });
      writeRequest(fixture.desktopInput, {
        id: 911,
        method: "codexhost/harness/session-import/sources",
        params: {},
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 911))).toMatchObject({
        result: { harnesses: [{ harnessId: "deepseek-harness", name: "DeepSeek Harness" }] },
      });
    } finally {
      try {
        await stopFixture(fixture);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it("persists launch settings through Host RPC and applies them only to the next plugin factory", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-launch-rpc-"));
    const location = path.join(directory, "sample-agent");
    const entrypoint = path.join(directory, "installed-app");
    const received = path.join(directory, "received.json");
    mkdirSync(location);
    mkdirSync(entrypoint);
    writeFileSync(
      path.join(directory, "enabled.json"),
      JSON.stringify({ version: 1, enabled: ["sample-agent"] }),
    );
    writeFileSync(
      path.join(location, "manifest.json"),
      JSON.stringify({
        manifestVersion: 1,
        id: "sample-agent",
        name: "Sample",
        version: "1",
        adapterApiVersion: 1,
        entry: "plugin.mjs",
        launchCommand: true,
      }),
    );
    writeFileSync(
      path.join(location, "plugin.mjs"),
      `
      import { writeFileSync } from "node:fs";
      import { FakeHarnessAdapter } from ${JSON.stringify(pathToFileURL(path.resolve("packages/harness-adapter/dist/testing.js")).href)};
      export function createHarnessAdapter(context) {
        writeFileSync(${JSON.stringify(received)}, JSON.stringify(context.launchCommand ?? null));
        return new FakeHarnessAdapter("sample-agent");
      }
    `,
    );
    const options = {
      pluginDirectory: directory,
      environment: { CODEXHOST_DATA_DIR: path.join(directory, "data") },
    };
    let fixture = createFixture(options);
    let id = 960;
    const request = async (method: string, params: JsonObject) => {
      const requestIdValue = id++;
      writeRequest(fixture.desktopInput, { id: requestIdValue, method, params });
      return fixture.collector.waitFor((message) => requestId(message, requestIdValue));
    };
    try {
      const get = "codexhost/harness/launch-settings/get",
        set = "codexhost/harness/launch-settings/set";
      expect(await request(get, { harnessId: "sample-agent" })).toMatchObject({
        result: { path: null, restartRequired: false },
      });
      expect(await request(set, { harnessId: "sample-agent", path: entrypoint })).toMatchObject({
        result: { path: entrypoint, restartRequired: true },
      });
      expect(JSON.parse(readFileSync(received, "utf8"))).toBeNull();
      for (const params of [
        { harnessId: "pi", path: entrypoint },
        { harnessId: "missing-agent", path: entrypoint },
        { harnessId: "../escape", path: entrypoint },
        { harnessId: "sample-agent", path: "relative.cjs" },
        { harnessId: "sample-agent", path: entrypoint, extra: true },
      ])
        expect(await request(set, params)).toMatchObject({ error: { code: -32602 } });
      expect(fixture.official.stdin.readableLength).toBe(0);
      await stopFixture(fixture);
      fixture = createFixture(options);
      expect(await request(get, { harnessId: "sample-agent" })).toMatchObject({
        result: { path: entrypoint, restartRequired: false },
      });
      expect(JSON.parse(readFileSync(received, "utf8"))).toBe(entrypoint);
      expect(await request(set, { harnessId: "sample-agent", path: null })).toMatchObject({
        result: { path: null, restartRequired: true },
      });
    } finally {
      await stopFixture(fixture);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("validates catalog parameters and leaves uninstalled routes out of the official stream", async () => {
    const fixture = createFixture();
    try {
      writeRequest(fixture.desktopInput, {
        id: 911,
        method: "codexhost/harness/plugins/list",
        params: { directory: "/untrusted" },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 911))).toMatchObject({
        error: { code: -32602 },
      });
      writeRequest(fixture.desktopInput, {
        id: 912,
        method: "thread/start",
        params: {
          model: encodeHarnessPluginRoute(
            harnessPluginRouteSchema.parse({ harnessId: "missing-agent" }),
          ),
          cwd: "/synthetic",
        },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 912))).toHaveProperty(
        "error",
      );
      writeRequest(fixture.desktopInput, {
        id: 913,
        method: "thread/start",
        params: { model: "codexhost/plugin-v1@invalid", cwd: "/synthetic" },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 913))).toHaveProperty(
        "error",
      );
      expect(fixture.official.stdin.readableLength).toBe(0);
    } finally {
      await stopFixture(fixture);
    }
  });
});
