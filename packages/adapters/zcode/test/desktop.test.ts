import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hostTurnIdSchema,
  harnessInspectionSchema,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";
import type { HarnessOutput, HarnessSession } from "@codexhost/harness-adapter";
import { ZcodeAdapter } from "../src/adapter.js";
import { DesktopSettings } from "../src/desktop-settings.js";
import { parseDesktopPairing } from "../src/desktop-relay.js";
import { encodeModel } from "../src/models.js";
import { ZcodeError } from "../src/errors.js";
import { desktopService, required } from "./fixtures/desktop-service.js";

const pairing = `https://zcode.z.ai/remote/v4?sid=fixture-device&mid=fixture-desktop&hash=${encodeURIComponent(Buffer.alloc(32, 8).toString("base64"))}&app_version=3.12.3`;
const roots: string[] = [],
  adapters: ZcodeAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zcode-desktop-test-"));
  roots.push(root);
  const environment = { CODEXHOST_DATA_DIR: root },
    settings = new DesktopSettings(environment);
  await settings.set(pairing, root);
  const native = desktopService(root),
    factory = vi.fn(async () => native.service);
  const adapter = new ZcodeAdapter({ environment, desktopServiceFactory: factory });
  adapters.push(adapter);
  return { root, environment, settings, native, factory, adapter };
}
async function open(f: Awaited<ReturnType<typeof fixture>>, nativeRef?: NativeSessionRef) {
  const result = await f.adapter.open(
    nativeRef ? { kind: "resume", nativeRef, cwd: f.root } : { kind: "create", cwd: f.root },
  );
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  const session = result.value,
    output: HarnessOutput[] = [];
  const ended = (async () => {
    for await (const item of session.outputs) output.push(item);
  })();
  return { session, output, ended };
}
async function turn(
  session: HarnessSession,
  output: HarnessOutput[],
  id: string,
  prompt = "hello",
) {
  expect(
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse(id),
      input: [{ type: "text", text: prompt }],
    }),
  ).toMatchObject({ ok: true });
  await expect
    .poll(() =>
      output.some(
        (item) =>
          item.kind === "event" && item.event.type === "turn.completed" && item.event.turnId === id,
      ),
    )
    .toBe(true);
}

describe("ZCode Desktop backend through the public Adapter", () => {
  it("keeps repair controls available for malformed saved connection settings", async () => {
    const f = await fixture();
    await f.adapter.connection.get();
    await writeFile(path.join(f.settings.directory, "pairing"), "malformed-private-fixture");
    const result = await f.adapter.connection.get();
    expect(result).toMatchObject({
      ok: true,
      value: { supported: true, configured: true, cwd: null, restartRequired: true },
    });
    expect(JSON.stringify(result)).not.toContain("malformed-private-fixture");
    expect(await f.adapter.connection.set(null)).toMatchObject({
      ok: true,
      value: { configured: false },
    });
  });
  it("does not close a Session that begins native execution during resume", async () => {
    const f = await fixture(),
      current = await open(f);
    await turn(current.session, current.output, "persisted");
    const nativeRef = required(current.session.initialState.nativeRef);
    await current.session.close();
    const original = required(f.native.call.getMockImplementation());
    f.native.call.mockClear().mockImplementation(async (method, params) => {
      const value = await original(method, params);
      if (method !== "resumeSession") return value;
      const snapshot = required(f.native.saved.get(nativeRef.nativeSessionId));
      return { ...snapshot, session: { ...snapshot.session, status: "running" } };
    });
    expect(await f.adapter.open({ kind: "resume", cwd: f.root, nativeRef })).toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    expect(f.native.call.mock.calls.some(([method]) => method === "closeSession")).toBe(false);
    expect(f.native.active.has(nativeRef.nativeSessionId)).toBe(true);
  });
  it("uses the configured workspace for Picker inspection without a cwd and rejects another workspace", async () => {
    const f = await fixture();
    expect(await f.adapter.inspect()).toMatchObject({ status: "ready" });
    expect(f.factory).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: f.root }),
      expect.anything(),
      expect.anything(),
    );
    expect(await f.adapter.connection.get()).toMatchObject({ ok: true, value: { cwd: f.root } });
    expect(await f.adapter.open({ kind: "create", cwd: process.cwd() })).toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
    expect(await f.adapter.connection.set(pairing, "relative")).toMatchObject({
      ok: false,
      error: { code: "invalidRequest" },
    });
  });
  it("keeps an empty native catalog empty instead of switching billing backends", async () => {
    const f = await fixture(),
      original = required(f.native.call.getMockImplementation());
    f.native.call.mockImplementation(async (method, params) => {
      const value = await original(method, params);
      if (method !== "createSession") return value;
      const snapshot = required(f.native.saved.values().next().value);
      return { ...snapshot, settings: { ...snapshot.settings, model: { available: [] } } };
    });
    expect(await f.adapter.inspect({ cwd: f.root })).toMatchObject({
      status: "unavailable",
      error: { code: "authenticationRequired" },
    });
    expect(f.native.saved.size).toBe(0);
  });
  it.each(["foreign-workspace", "existing-messages", "running", "missing-projection"])(
    "does not close an unowned catalog receipt (%s)",
    async (kind) => {
      const f = await fixture(),
        original = required(f.native.call.getMockImplementation());
      f.native.call.mockImplementation(async (method, params) => {
        if (method !== "createSession") return original(method, params);
        return {
          session: {
            sessionId: "someone-else",
            status: kind === "running" ? "running" : "idle",
            workspace: { workspacePath: kind === "foreign-workspace" ? "/other" : f.root },
          },
          messages: kind === "existing-messages" ? [{}] : [],
          projection:
            kind === "missing-projection"
              ? undefined
              : { status: "idle", contextUsed: 0, contextWindow: 1 },
        };
      });
      expect(await f.adapter.inspect({ cwd: f.root })).toMatchObject({
        status: "unavailable",
        error: { code: "protocolError" },
      });
      expect(f.native.call.mock.calls.some(([method]) => method === "closeSession")).toBe(false);
      f.native.call.mockClear();
      expect(await f.adapter.inspect()).toMatchObject({ status: "unavailable" });
      expect(f.native.call).not.toHaveBeenCalled(); // no second create after an unconfirmed receipt
    },
  );
  it("cleans an owned deferred Session even if its catalog cannot be parsed", async () => {
    const f = await fixture(),
      original = required(f.native.call.getMockImplementation());
    f.native.call.mockImplementation(async (method, params) => {
      const value = await original(method, params);
      return method === "createSession"
        ? { ...required(f.native.saved.values().next().value), settings: { invalid: true } }
        : value;
    });
    expect(await f.adapter.inspect({ cwd: f.root })).toMatchObject({ status: "unavailable" });
    expect(f.native.saved.size).toBe(0);
    expect(f.native.call).toHaveBeenCalledWith(
      "closeSession",
      expect.objectContaining({ expectedPersistence: "deferred" }),
    );
  });
  it("preserves native empty-Session semantics and does not recreate a lost identity", async () => {
    const f = await fixture(),
      current = await open(f),
      nativeRef = required(current.session.initialState.nativeRef);
    await current.session.close();
    f.native.call.mockClear();
    expect(await f.adapter.open({ kind: "resume", cwd: f.root, nativeRef })).toMatchObject({
      ok: false,
      error: { code: "sessionNotFound" },
    });
    expect(f.native.call.mock.calls.some(([method]) => method === "createSession")).toBe(false);
  });
  it("rejects unvalidated history derivation and reports matching capabilities", async () => {
    const f = await fixture(),
      current = await open(f),
      sourceRef = required(current.session.initialState.nativeRef);
    expect(current.session.capabilities.history).toEqual({
      fork: false,
      forkAcrossCwd: false,
      rollbackLastTurn: false,
    });
    f.native.call.mockClear();
    expect(
      await f.adapter.open({ kind: "rollbackLastTurn", cwd: f.root, sourceRef }),
    ).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(f.native.call).not.toHaveBeenCalled();
  });
  it("ends accepted execution once after connection loss and never silently reconnects", async () => {
    const f = await fixture(),
      current = await open(f);
    await current.session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("disconnect"),
      input: [{ type: "text", text: "hang" }],
    });
    for (const listener of [...f.native.faults])
      listener(new ZcodeError("unavailable", "Connection lost", true));
    await current.ended;
    expect(await f.adapter.connection.get()).toMatchObject({
      ok: true,
      value: { restartRequired: true },
    });
    expect(
      current.output.filter(
        (item) => item.kind === "event" && item.event.type === "turn.completed",
      ),
    ).toHaveLength(1);
    expect(current.output).toContainEqual(
      expect.objectContaining({
        kind: "event",
        event: expect.objectContaining({ type: "session.faulted" }),
      }),
    );
    expect(await f.adapter.open({ kind: "create", cwd: f.root })).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
    expect(f.factory).toHaveBeenCalledTimes(1);
  });
  it("projects native account Models into the real inspection, with no fixed fallback catalog", async () => {
    const f = await fixture();
    const result = harnessInspectionSchema.parse(await f.adapter.inspect({ cwd: f.root }));
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.catalog.models.map((model) => model.label)).toEqual([
      "GLM-5.3 (fixture)",
      "GLM-5.3-Flash (fixture)",
    ]);
    expect(
      result.catalog.models.every((model) => model.ref.id.startsWith("zcode-desktop-v1.")),
    ).toBe(true);
    expect(f.native.saved.size).toBe(0);
    expect(f.native.call.mock.calls.map(([method]) => method)).toEqual([
      "readWorkspacePresentation",
      "createSession",
      "closeSession",
    ]);
    expect(f.native.call.mock.calls[1]?.[1]).toMatchObject({
      persistence: "deferred",
      titleGenerationEnabled: false,
      mcpServers: [],
    });
    expect(JSON.stringify(result)).not.toContain("passHash");
    expect(f.native.service.close).not.toHaveBeenCalled();
  });
  it("executes and resumes the same Desktop Session, not a stdio session with the same Model name", async () => {
    const f = await fixture(),
      current = await open(f);
    const ref = required(current.session.initialState.nativeRef);
    expect(ref.locator).toEqual({ backend: "desktop", desktopId: "fixture-desktop", cwd: f.root });
    expect(current.session.initialState.effectiveModel?.id).toMatch(/^zcode-desktop-v1\./u);
    await turn(current.session, current.output, "one");
    const before = await current.session.readSnapshot();
    expect(before.ok && before.value.turns).toHaveLength(1);
    await current.session.close();
    await current.ended;
    const resumed = await open(f, ref);
    expect(resumed.session.initialState.nativeRef).toEqual(ref);
    expect(await resumed.session.readSnapshot()).toEqual(before);
    await turn(resumed.session, resumed.output, "two");
    const after = await resumed.session.readSnapshot();
    expect(after.ok && after.value.turns).toHaveLength(2);
    expect(f.factory).toHaveBeenCalledTimes(1);
  });
  it("does not close another Session or the Desktop bridge when one Thread closes", async () => {
    const f = await fixture(),
      first = await open(f),
      second = await open(f);
    expect(first.session.initialState.nativeRef?.nativeSessionId).not.toBe(
      second.session.initialState.nativeRef?.nativeSessionId,
    );
    await first.session.close();
    await first.ended;
    expect(
      f.native.active.has(required(second.session.initialState.nativeRef).nativeSessionId),
    ).toBe(true);
    expect(f.native.service.close).not.toHaveBeenCalled();
    await turn(second.session, second.output, "second-session");
    await f.adapter.close();
    expect(f.native.service.close).toHaveBeenCalledTimes(1);
  });
  it("uses native V4 stop, waits for the terminal event, then supports the next Turn", async () => {
    const f = await fixture(),
      current = await open(f);
    await current.session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("cancel"),
      input: [{ type: "text", text: "hang" }],
    });
    expect(
      await current.session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("busy"),
        input: [{ type: "text", text: "second" }],
      }),
    ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    expect(
      await current.session.execute({
        type: "turn.cancel",
        turnId: hostTurnIdSchema.parse("cancel"),
      }),
    ).toMatchObject({ ok: true });
    await expect
      .poll(() =>
        current.output.some(
          (item) => item.kind === "event" && item.event.type === "turn.completed",
        ),
      )
      .toBe(true);
    await turn(current.session, current.output, "after-cancel");
    expect(
      current.output.filter(
        (item) => item.kind === "event" && item.event.type === "turn.completed",
      ),
    ).toHaveLength(2);
    expect(f.native.call).toHaveBeenCalledWith(
      "sendConversationCommandV4",
      expect.objectContaining({
        envelope: expect.objectContaining({ type: "stop", clientId: "fixture-client" }),
      }),
    );
  });
  it("maps a Host approval back to the native option, without handling account credentials", async () => {
    const f = await fixture(),
      current = await open(f);
    await current.session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("approval"),
      input: [{ type: "text", text: "approval" }],
    });
    const pending = current.output.find((item) => item.kind === "interaction");
    expect(pending?.kind).toBe("interaction");
    if (pending?.kind !== "interaction") return;
    expect(
      await current.session.execute({
        type: "interaction.respond",
        interactionId: pending.interaction.interactionId,
        response: { type: "approval", actionId: "allow-once" },
      }),
    ).toMatchObject({ ok: true });
    await expect
      .poll(() =>
        current.output.some(
          (item) => item.kind === "event" && item.event.type === "turn.completed",
        ),
      )
      .toBe(true);
    expect(f.native.call).toHaveBeenCalledWith(
      "sendConversationCommandV4",
      expect.objectContaining({
        envelope: expect.objectContaining({
          type: "resolveInteraction",
          payload: expect.objectContaining({ answer: { optionId: "allow-once" } }),
        }),
      }),
    );
    expect(
      f.native.call.mock.calls.some(([method]) => /provider|account|credential/iu.test(method)),
    ).toBe(false);
  });
  it("declares native environment ownership and rejects explicit overrides before opening", async () => {
    const f = await fixture();
    expect(await f.adapter.sessionEnvironmentScope({ kind: "create", cwd: f.root })).toBe("native");
    expect(
      await f.adapter.open({
        kind: "create",
        cwd: f.root,
        environment: { CODEXHOST_THREAD_ID: "private-thread" },
      }),
    ).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(f.factory).not.toHaveBeenCalled();
    const model = encodeModel({ providerId: "fixture", modelId: "model" });
    expect(await f.adapter.sessionEnvironmentScope({ kind: "create", cwd: f.root, model })).toBe(
      "session",
    );
  });
  it("keeps pairing changes pending until restart and never returns the stored secret", async () => {
    const f = await fixture();
    expect(await f.adapter.connection.get()).toMatchObject({
      ok: true,
      value: { configured: true, restartRequired: false },
    });
    expect((await stat(path.join(f.settings.directory, "pairing"))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path.join(f.settings.directory, "pairing"), "utf8"))).toEqual({
      url: pairing,
      cwd: f.root,
    });
    const result = await f.adapter.connection.set(null);
    expect(result).toMatchObject({ ok: true, value: { configured: false, restartRequired: true } });
    expect(JSON.stringify(result)).not.toContain(parseDesktopPairing(pairing).passHash);
    expect(await f.adapter.sessionEnvironmentScope({ kind: "create", cwd: f.root })).toBe("native");
    const restarted = new ZcodeAdapter({ environment: f.environment });
    adapters.push(restarted);
    expect(await restarted.sessionEnvironmentScope({ kind: "create", cwd: f.root })).toBe(
      "session",
    );
    const ref: NativeSessionRef = {
      harnessId: f.adapter.harnessId,
      nativeSessionId: "previous-desktop",
      locator: { cwd: f.root, backend: "desktop", desktopId: "fixture-desktop" },
      formatVersion: 1,
    };
    expect(await restarted.open({ kind: "resume", cwd: f.root, nativeRef: ref })).toMatchObject({
      ok: false,
      error: { code: "authenticationRequired" },
    });
  });
  it("rejects another paired Desktop instead of silently resuming on it", async () => {
    const f = await fixture(),
      current = await open(f);
    const ref = required(current.session.initialState.nativeRef);
    await current.session.close();
    expect(
      await f.adapter.open({
        kind: "resume",
        cwd: f.root,
        nativeRef: { ...ref, locator: { cwd: f.root, backend: "desktop", desktopId: "other" } },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
  });
  it("protects one pairing from another Host taking it over", async () => {
    const f = await fixture(),
      release = await f.settings.acquire("fixture-device");
    try {
      await expect(
        new DesktopSettings(f.environment).acquire("fixture-device"),
      ).rejects.toMatchObject({ code: "sessionBusy" });
    } finally {
      await release();
    }
    const next = await f.settings.acquire("fixture-device");
    await next();
  });
});
