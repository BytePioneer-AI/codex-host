import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { HarnessOutput, HostEvent, HarnessSessionState } from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  harnessModelRefSchema,
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostTurnIdSchema,
} from "@codexhost/shared-contracts";

import {
  OMO_PERMISSION_MODE_CATALOG,
  OMO_PROBED_PERMISSION_PRESETS,
  omoPermissionModeCatalogFromProbe,
} from "../src/omo-configuration.js";
import { OmoHarnessSession } from "../src/omo-session.js";
import { OmoRpcSession, type OmoRpcProcessAdapter } from "../src/omo-rpc-session.js";

/**
 * Configuration-command tests against the synthetic session peer
 * (fake-omo.mjs, scenario "session"): the same OS-process transport the
 * production adapter uses, with a scripted engine. Selections must publish
 * `session.state.changed` only after the peer confirmed them natively.
 */
const fixture = path.join(import.meta.dirname, "fixtures", "fake-omo.mjs");
const roots: string[] = [];
const sessions: OmoHarnessSession[] = [];
const rpcs: OmoRpcSession[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  for (const rpc of rpcs.splice(0)) await rpc.close().catch(() => undefined);
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "omo-configuration-test-"));
  roots.push(directory);
  return directory;
}

/** Bounds a wait so a hung peer fails the test instead of the suite. */
function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

class OutputQueue {
  readonly #iterator: AsyncIterator<HarnessOutput>;

  constructor(outputs: AsyncIterable<HarnessOutput>) {
    this.#iterator = outputs[Symbol.asyncIterator]();
  }

  async nextEvent(timeoutMs = 5_000): Promise<HostEvent> {
    for (;;) {
      const result = await bounded(this.#iterator.next(), timeoutMs, "Session output");
      if (result.done) throw new Error("the output stream ended before the expected event");
      if (result.value.kind === "event") return result.value.event;
    }
  }

  async nextStateChanged(timeoutMs = 5_000): Promise<HarnessSessionState> {
    for (;;) {
      const event = await this.nextEvent(timeoutMs);
      if (event.type === "session.state.changed") return event.state;
    }
  }
}

interface ConfigProbe {
  setModels: Array<Record<string, unknown>>;
  setThinkingLevels: Array<Record<string, unknown>>;
  setPermissionPresets: Array<Record<string, unknown>>;
}

interface FixtureSession {
  session: OmoHarnessSession;
  queue: OutputQueue;
  rpc: OmoRpcSession;
  probe(): Promise<ConfigProbe>;
  controls(controls: Record<string, unknown>): Promise<void>;
}

async function createSessionFixture(
  environment: Record<string, string | undefined> = {},
): Promise<FixtureSession> {
  const cwd = temporaryDirectory();
  const processAdapter: OmoRpcProcessAdapter = {
    spawn(spawnOptions) {
      const child = spawn(process.execPath, [fixture], {
        cwd: spawnOptions.cwd,
        env: spawnOptions.environment,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      children.push(child);
      return child;
    },
  };
  const rpc = new OmoRpcSession(
    {
      cwd,
      environment: {
        FAKE_OMO_SCENARIO: "session",
        FAKE_OMO_PENDING_DIALOGS: "none",
        PI_TELEMETRY: "0",
        ...environment,
      },
      commandTimeoutMs: 2_000,
      startupTimeoutMs: 5_000,
      closeTimeoutMs: 500,
    },
    processAdapter,
  );
  rpcs.push(rpc);
  await rpc.start();
  const initialState: HarnessSessionState = rpc.state.sessionFile
    ? {
        nativeRef: {
          harnessId: harnessIdSchema.parse("omo"),
          nativeSessionId: rpc.state.sessionId ?? "synthetic-session-id",
          locator: { sessionPath: rpc.state.sessionFile, cwd },
          formatVersion: 1,
        },
      }
    : {};
  const session = new OmoHarnessSession(rpc, {
    initialState,
    commandTimeoutMs: 2_000,
    abortTimeoutMs: 1_000,
    cancelSettleTimeoutMs: 2_000,
    probeTimeoutMs: 300,
    settleGraceMs: 30,
    closeTurnTimeoutMs: 300,
  });
  sessions.push(session);
  return {
    session,
    queue: new OutputQueue(session.outputs),
    rpc,
    async probe() {
      const response = await rpc.send("probe.received");
      return response.data as ConfigProbe;
    },
    async controls(controls: Record<string, unknown>) {
      await rpc.send("set_controls", controls);
    },
  };
}

function modelSelect(id: string) {
  return { type: "model.select" as const, model: harnessModelRefSchema.parse({ id }) };
}

describe("OmO permission catalog freeze", () => {
  it("freezes the catalog the real engine was observed to accept", () => {
    expect(OMO_PROBED_PERMISSION_PRESETS).toEqual([
      "full-access",
      "workspace",
      "read-only",
      "ask",
      "accept-edits",
      "auto",
    ]);
    expect(harnessPermissionModeCatalogSchema.parse(OMO_PERMISSION_MODE_CATALOG)).toEqual(
      OMO_PERMISSION_MODE_CATALOG,
    );
    expect(OMO_PERMISSION_MODE_CATALOG.modes.map((mode) => mode.id)).toEqual([
      ...OMO_PROBED_PERMISSION_PRESETS,
    ]);
    expect(OMO_PERMISSION_MODE_CATALOG.defaultModeId).toBe("full-access");
    expect(
      OMO_PERMISSION_MODE_CATALOG.modes.find((mode) => mode.id === "full-access")?.dangerous,
    ).toBe(true);
  });

  it("builds a catalog from a synthetic observed set", () => {
    const catalog = omoPermissionModeCatalogFromProbe(["ask", "full-access"], "ask");
    expect(harnessPermissionModeCatalogSchema.parse(catalog)).toEqual(catalog);
    expect(catalog.modes.map((mode) => mode.id)).toEqual(["ask", "full-access"]);
    expect(catalog.defaultModeId).toBe("ask");
  });

  it("rejects probe results that cannot form a catalog", () => {
    expect(() => omoPermissionModeCatalogFromProbe([], "ask")).toThrowError(/accepted no preset/u);
    expect(() => omoPermissionModeCatalogFromProbe(["ask"], "full-access")).toThrowError(
      /default/u,
    );
    expect(() => omoPermissionModeCatalogFromProbe(["ask", "ask"], "ask")).toThrowError(
      /invalid preset/u,
    );
    expect(() => omoPermissionModeCatalogFromProbe(["ask", "not-a-preset"], "ask")).toThrowError(
      /no presentation/u,
    );
  });
});

describe("OmO model selection", () => {
  it("switches the model with session scope and publishes confirmed state", async () => {
    const fixtureSession = await createSessionFixture();
    const selected = await fixtureSession.session.execute(
      modelSelect("synthetic-provider/other-model"),
    );
    expect(selected).toEqual({ ok: true, value: { completed: true } });
    const state = await fixtureSession.queue.nextStateChanged();
    expect(state).toEqual({
      nativeRef: {
        harnessId: "omo",
        nativeSessionId: "synthetic-session-id",
        locator: {
          sessionPath: "/synthetic/agent/sessions/project/synthetic-session.jsonl",
          cwd: expect.any(String),
        },
        formatVersion: 1,
      },
      effectiveModel: { id: "synthetic-provider/other-model" },
      resolvedModelLabel: "Synthetic Other",
      effectiveThinkingOptionId: "medium",
      availableThinkingOptions: [
        { id: "off", label: "Off" },
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
      ],
      effectivePermissionModeId: "ask",
    });
    const frames = (await fixtureSession.probe()).setModels;
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      provider: "synthetic-provider",
      modelId: "other-model",
      scope: "session",
    });
    expect(typeof frames[0]?.effectId).toBe("string");
    await fixtureSession.session.close();
  });

  it("refuses an unknown model ref without writing to the engine", async () => {
    const fixtureSession = await createSessionFixture();
    const selected = await fixtureSession.session.execute(
      modelSelect("synthetic-provider/no-such-model"),
    );
    expect(selected).toMatchObject({
      ok: false,
      error: { code: "invalidRequest", retryable: false },
    });
    expect((await fixtureSession.probe()).setModels).toEqual([]);
    await fixtureSession.session.close();
  });

  it("maps a model_not_found refusal to a typed error and keeps the state", async () => {
    const fixtureSession = await createSessionFixture();
    await fixtureSession.controls({ modelError: "model_not_found" });
    const selected = await fixtureSession.session.execute(
      modelSelect("synthetic-provider/other-model"),
    );
    expect(selected).toMatchObject({
      ok: false,
      error: { code: "invalidRequest", retryable: false },
    });
    await expectPublishedOnlyAfterConfirmation(fixtureSession);
    await fixtureSession.session.close();
  });

  it("maps a context_budget refusal to a typed native failure", async () => {
    const fixtureSession = await createSessionFixture();
    await fixtureSession.controls({ modelError: "context_budget" });
    const selected = await fixtureSession.session.execute(
      modelSelect("synthetic-provider/other-model"),
    );
    expect(selected).toMatchObject({
      ok: false,
      error: { code: "nativeFailure", retryable: false },
    });
    await expectPublishedOnlyAfterConfirmation(fixtureSession);
    await fixtureSession.session.close();
  });

  it("does not publish state when the engine never activates the model", async () => {
    const fixtureSession = await createSessionFixture();
    await fixtureSession.controls({ confirmModel: false });
    const selected = await fixtureSession.session.execute(
      modelSelect("synthetic-provider/other-model"),
    );
    expect(selected).toMatchObject({
      ok: false,
      error: { code: "nativeFailure", retryable: false },
    });
    await expectPublishedOnlyAfterConfirmation(fixtureSession);
    await fixtureSession.session.close();
  });
});

describe("OmO thinking selection", () => {
  it("sets the session thinking level with turn scope and publishes confirmed state", async () => {
    const fixtureSession = await createSessionFixture();
    const selected = await fixtureSession.session.execute({
      type: "thinking.select",
      thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
    });
    expect(selected).toEqual({ ok: true, value: { completed: true } });
    const state = await fixtureSession.queue.nextStateChanged();
    expect(state.effectiveThinkingOptionId).toBe("high");
    expect(state.availableThinkingOptions?.map((option) => option.id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(state.effectiveModel).toEqual({ id: "synthetic-provider/synthetic-model" });
    const frames = (await fixtureSession.probe()).setThinkingLevels;
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ level: "high", scope: "turn" });
    expect(typeof frames[0]?.effectId).toBe("string");
    await fixtureSession.session.close();
  });

  it("refuses an unknown thinking option without writing to the engine", async () => {
    const fixtureSession = await createSessionFixture();
    const selected = await fixtureSession.session.execute({
      type: "thinking.select",
      thinkingOptionId: harnessThinkingOptionIdSchema.parse("ultra"),
    });
    expect(selected).toMatchObject({
      ok: false,
      error: { code: "invalidRequest", retryable: false },
    });
    expect((await fixtureSession.probe()).setThinkingLevels).toEqual([]);
    await fixtureSession.session.close();
  });

  it("keeps the state when the active model cannot apply the level", async () => {
    const fixtureSession = await createSessionFixture();
    await fixtureSession.controls({
      thinkingErrorMessage: "Thinking level low is not supported by the active model.",
    });
    const selected = await fixtureSession.session.execute({
      type: "thinking.select",
      thinkingOptionId: harnessThinkingOptionIdSchema.parse("low"),
    });
    expect(selected).toMatchObject({
      ok: false,
      error: { code: "nativeFailure", retryable: false },
    });
    await expectPublishedOnlyAfterConfirmation(fixtureSession);
    await fixtureSession.session.close();
  });

  it("does not publish state when the engine never applies the level", async () => {
    const fixtureSession = await createSessionFixture();
    await fixtureSession.controls({ confirmThinking: false });
    const selected = await fixtureSession.session.execute({
      type: "thinking.select",
      thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
    });
    expect(selected).toMatchObject({
      ok: false,
      error: { code: "nativeFailure", retryable: false },
    });
    await expectPublishedOnlyAfterConfirmation(fixtureSession);
    await fixtureSession.session.close();
  });
});

describe("OmO permission mode selection", () => {
  it("applies a catalog mode and publishes the confirmed preset", async () => {
    const fixtureSession = await createSessionFixture();
    const selected = await fixtureSession.session.execute({
      type: "permissionMode.select",
      permissionModeId: harnessPermissionModeIdSchema.parse("read-only"),
    });
    expect(selected).toEqual({ ok: true, value: { completed: true } });
    const state = await fixtureSession.queue.nextStateChanged();
    expect(state.effectivePermissionModeId).toBe("read-only");
    expect(state.effectiveModel).toEqual({ id: "synthetic-provider/synthetic-model" });
    const frames = (await fixtureSession.probe()).setPermissionPresets;
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ permissionPreset: "read-only" });
    // set_permission_preset is not an effect-ledger command.
    expect(frames[0]?.effectId).toBeUndefined();
    await fixtureSession.session.close();
  });

  it("refuses an unknown mode id without writing to the engine", async () => {
    const fixtureSession = await createSessionFixture();
    const selected = await fixtureSession.session.execute({
      type: "permissionMode.select",
      permissionModeId: harnessPermissionModeIdSchema.parse("yolo"),
    });
    expect(selected).toMatchObject({
      ok: false,
      error: { code: "invalidRequest", retryable: false },
    });
    expect((await fixtureSession.probe()).setPermissionPresets).toEqual([]);
    await fixtureSession.session.close();
  });

  it("reports a native invalid_launch_profile refusal without publishing state", async () => {
    const fixtureSession = await createSessionFixture();
    await fixtureSession.controls({ permissionError: "invalid_launch_profile" });
    const selected = await fixtureSession.session.execute({
      type: "permissionMode.select",
      permissionModeId: harnessPermissionModeIdSchema.parse("read-only"),
    });
    expect(selected).toMatchObject({
      ok: false,
      error: { code: "nativeFailure", retryable: false },
    });
    await expectPublishedOnlyAfterConfirmation(fixtureSession);
    await fixtureSession.session.close();
  });

  it("does not publish state when the applied confirmation is missing", async () => {
    const fixtureSession = await createSessionFixture();
    await fixtureSession.controls({ permissionStatus: "invalid" });
    const selected = await fixtureSession.session.execute({
      type: "permissionMode.select",
      permissionModeId: harnessPermissionModeIdSchema.parse("read-only"),
    });
    expect(selected).toMatchObject({
      ok: false,
      error: { code: "nativeFailure", retryable: false },
    });
    await expectPublishedOnlyAfterConfirmation(fixtureSession);
    await fixtureSession.session.close();
  });

  it("does not publish state when the engine never activates the preset", async () => {
    const fixtureSession = await createSessionFixture();
    await fixtureSession.controls({ confirmPermission: false });
    const selected = await fixtureSession.session.execute({
      type: "permissionMode.select",
      permissionModeId: harnessPermissionModeIdSchema.parse("read-only"),
    });
    expect(selected).toMatchObject({
      ok: false,
      error: { code: "nativeFailure", retryable: false },
    });
    await expectPublishedOnlyAfterConfirmation(fixtureSession);
    await fixtureSession.session.close();
  });
});

describe("OmO selection concurrency and lifecycle", () => {
  it("selects a model while a Turn streams", async () => {
    const fixtureSession = await createSessionFixture({
      FAKE_OMO_TURN_SCRIPT: "cancel",
    });
    const started = await fixtureSession.session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-mid-select"),
      input: [{ type: "text", text: "long running" }],
    });
    expect(started).toEqual({ ok: true, value: { turnId: "turn-mid-select" } });
    await fixtureSession.queue.nextEvent();

    const selected = await fixtureSession.session.execute(
      modelSelect("synthetic-provider/other-model"),
    );
    expect(selected).toEqual({ ok: true, value: { completed: true } });
    const state = await fixtureSession.queue.nextStateChanged();
    expect(state.effectiveModel).toEqual({ id: "synthetic-provider/other-model" });

    const cancelled = await fixtureSession.session.execute({
      type: "turn.cancel",
      turnId: hostTurnIdSchema.parse("turn-mid-select"),
    });
    expect(cancelled).toEqual({ ok: true, value: { cancellationRequested: true } });
    for (;;) {
      const event = await fixtureSession.queue.nextEvent();
      if (event.type === "turn.completed" && event.turnId === "turn-mid-select") {
        expect(event.outcome.status).toBe("cancelled");
        break;
      }
    }
    await fixtureSession.session.close();
  });

  it("refuses a second concurrent selection with a retryable busy error", async () => {
    const fixtureSession = await createSessionFixture();
    const [first, second] = await Promise.all([
      fixtureSession.session.execute(modelSelect("synthetic-provider/other-model")),
      fixtureSession.session.execute(modelSelect("synthetic-provider/synthetic-model")),
    ]);
    expect(first).toEqual({ ok: true, value: { completed: true } });
    expect(second).toMatchObject({
      ok: false,
      error: { code: "sessionBusy", retryable: true },
    });
    await fixtureSession.queue.nextStateChanged();
    await fixtureSession.session.close();
  });

  it("refuses selections after close", async () => {
    const fixtureSession = await createSessionFixture();
    await fixtureSession.session.close();
    await expect(
      fixtureSession.session.execute(modelSelect("synthetic-provider/other-model")),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
    await expect(
      fixtureSession.session.execute({
        type: "thinking.select",
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalidState" } });
  });
});

/**
 * A failed selection must publish nothing: after resetting the scripted
 * failure, the next successful selection's `session.state.changed` is the
 * first one the output stream carries.
 */
async function expectPublishedOnlyAfterConfirmation(fixtureSession: FixtureSession): Promise<void> {
  await fixtureSession.controls({
    thinkingErrorMessage: null,
    confirmThinking: true,
    confirmModel: true,
    confirmPermission: true,
  });
  const selected = await fixtureSession.session.execute({
    type: "thinking.select",
    thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
  });
  expect(selected).toEqual({ ok: true, value: { completed: true } });
  const state = await fixtureSession.queue.nextStateChanged();
  expect(state.effectiveThinkingOptionId).toBe("high");
}
