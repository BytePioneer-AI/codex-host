import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HarnessResult, HarnessSession, OpenSessionInput } from "@codexhost/harness-adapter";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { MappingStore } from "@codexhost/mapping-store";
import {
  CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
  encodeClaudeTransportModel,
  encodeGrokTransportModel,
  encodePiTransportModel,
  type ExternalHarnessId,
  type JsonObject,
} from "@codexhost/protocol-core";
import {
  harnessCommandDescriptorSchema,
  harnessIdSchema,
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  hostItemIdSchema,
  hostThreadIdSchema,
  hostTurnIdSchema,
} from "@codexhost/shared-contracts";

import {
  method,
  requestId,
  messageParams,
  threadStatus,
  turnEvent,
  writeRequest,
  rollbackCapableAdapter,
  ResumeStateRollbackAdapter,
  createFixture,
  startExternalThread,
  startPiThread,
  startPiTurn,
  completePiTurn,
  stopFixture,
} from "./app-server-host-fixture.js";

describe("AppServerHost HarnessAdapter projection", () => {
  it("selects a registered non-Pi Thread Model through its owning Session", async () => {
    const pi = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const claude = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const fixture = createFixture({
      externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([
        ["pi", pi],
        ["claude-code", claude],
      ]),
    });
    const threadId = await startExternalThread(fixture, CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID);
    const model = claude.catalog.models[1]?.ref;
    if (!model) throw new Error("Fake Claude catalog has no secondary Model");

    writeRequest(fixture.desktopInput, {
      id: 33,
      method: "codexhost/thread/model/select",
      params: { threadId, model },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 33)),
    ).resolves.toMatchObject({
      id: 33,
      result: { effectiveModel: model, effectiveThinkingOptionId: "off" },
    });
    expect(claude.sessions[0]?.state.effectiveModel).toEqual(model);
    expect(pi.sessions).toHaveLength(0);
    await stopFixture(fixture);
  });

  it("routes Permission Mode through the owning capable Session and preserves rejection", async () => {
    const pi = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const claudeSeed = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const permissionModes = harnessPermissionModeCatalogSchema.parse({
      modes: [
        { id: "default", label: "Default" },
        { id: "auto", label: "Auto" },
        { id: "bypassPermissions", label: "Bypass", dangerous: true },
      ],
      defaultModeId: "default",
    });
    const claude = new FakeHarnessAdapter(
      harnessIdSchema.parse("claude-code"),
      claudeSeed.catalog,
      false,
      false,
      null,
      permissionModes,
    );
    const fixture = createFixture({
      externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([
        ["pi", pi],
        ["claude-code", claude],
      ]),
    });
    const model = claude.catalog.defaultModel;
    if (!model) throw new Error("Fake Claude catalog has no default Model");
    const defaultMode = harnessPermissionModeIdSchema.parse("default");
    const threadId = await startExternalThread(
      fixture,
      encodeClaudeTransportModel(model, defaultMode),
      36,
    );
    const auto = harnessPermissionModeIdSchema.parse("auto");

    writeRequest(fixture.desktopInput, {
      id: 37,
      method: "codexhost/thread/permission-mode/select",
      params: { threadId, permissionModeId: auto },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 37)),
    ).resolves.toMatchObject({
      result: { effectiveModel: model, effectivePermissionModeId: auto },
    });
    expect(claude.sessions[0]?.state.effectivePermissionModeId).toBe(auto);
    await expect(
      fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
    ).resolves.toMatchObject({
      transportModelId: encodeClaudeTransportModel(model, auto),
    });
    expect(pi.sessions).toHaveLength(0);

    claude.sessions[0]?.rejectNextPermissionModeSelection({
      code: "nativeFailure",
      message: "Policy rejected bypass",
      retryable: false,
    });
    writeRequest(fixture.desktopInput, {
      id: 38,
      method: "codexhost/thread/permission-mode/select",
      params: {
        threadId,
        permissionModeId: harnessPermissionModeIdSchema.parse("bypassPermissions"),
      },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 38)),
    ).resolves.toMatchObject({
      error: { code: -32078, message: "Policy rejected bypass" },
    });
    expect(claude.sessions[0]?.state.effectivePermissionModeId).toBe(auto);
    await stopFixture(fixture);
  });

  it("rejects live Grok Permission Mode changes without rewriting mapping", async () => {
    const permissionModes = harnessPermissionModeCatalogSchema.parse({
      modes: [
        { id: "default", label: "Default" },
        { id: "always-approve", label: "Always approve", dangerous: true },
      ],
      defaultModeId: "default",
    });
    const grok = new FakeHarnessAdapter(
      harnessIdSchema.parse("grok"),
      undefined,
      true,
      true,
      null,
      permissionModes,
      false,
      "atCreate",
    );
    const fixture = createFixture({
      externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([["grok", grok]]),
    });
    const model = grok.catalog.defaultModel;
    if (!model) throw new Error("Fake Grok catalog has no default Model");
    const defaultMode = harnessPermissionModeIdSchema.parse("default");
    const alwaysApprove = harnessPermissionModeIdSchema.parse("always-approve");
    const transportModelId = encodeGrokTransportModel(model, defaultMode);
    const threadId = await startExternalThread(fixture, transportModelId, 50);
    const session = grok.sessions[0];
    if (!session) throw new Error("Fake Grok Session was not opened");
    const execute = vi.spyOn(session, "execute");

    writeRequest(fixture.desktopInput, {
      id: 51,
      method: "codexhost/thread/permission-mode/select",
      params: { threadId, permissionModeId: alwaysApprove },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 51)),
    ).resolves.toMatchObject({
      error: { code: -32078, message: "Permission Mode is fixed at Session creation" },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(session.state.effectivePermissionModeId).toBe(defaultMode);
    await expect(
      fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
    ).resolves.toMatchObject({ transportModelId });

    await stopFixture(fixture);
  });

  it("selects existing Thread Thinking from ordered complete Session state", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startPiThread(fixture);
    const off = fixture.adapter.catalog.thinkingOptions.find(({ id }) => id === "off")?.id;
    if (!off) throw new Error("Fake catalog has no Off Thinking option");

    writeRequest(fixture.desktopInput, {
      id: 34,
      method: "codexhost/thread/thinking/select",
      params: { threadId, thinkingOptionId: off },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 34)),
    ).resolves.toMatchObject({
      id: 34,
      result: {
        effectiveModel: fixture.adapter.catalog.defaultModel,
        effectiveThinkingOptionId: "off",
        availableThinkingOptions: [
          { id: "off", label: "Off" },
          { id: "high", label: "High" },
        ],
      },
    });
    expect(fixture.adapter.sessions[0]?.state.effectiveThinkingOptionId).toBe("off");
    await expect(
      fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
    ).resolves.toMatchObject({
      transportModelId: encodePiTransportModel(fixture.adapter.catalog.defaultModel, off),
    });
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("rejects fixed Model control for an unknown or Codex-owned Thread locally", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const model = fixture.adapter.catalog.models[0]?.ref;
    if (!model) throw new Error("Fake catalog is empty");

    writeRequest(fixture.desktopInput, {
      id: 35,
      method: "codexhost/thread/model/select",
      params: { threadId: "official-thread", model },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 35)),
    ).resolves.toMatchObject({ error: { code: -32078 } });
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("rejects a Pi Model selection while its Turn is active", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    await startPiTurn(fixture, threadId);
    const model = fixture.adapter.catalog.models[1]?.ref;
    if (!model) throw new Error("Fake catalog has no secondary Model");

    writeRequest(fixture.desktopInput, {
      id: 32,
      method: "codexhost/thread/model/select",
      params: { threadId, model },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 32)),
    ).resolves.toMatchObject({
      error: { code: -32078, message: expect.stringContaining("active") },
    });
    const off = fixture.adapter.catalog.thinkingOptions.find(({ id }) => id === "off")?.id;
    if (!off) throw new Error("Fake catalog has no Off Thinking option");
    writeRequest(fixture.desktopInput, {
      id: 36,
      method: "codexhost/thread/thinking/select",
      params: { threadId, thinkingOptionId: off },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 36)),
    ).resolves.toMatchObject({
      error: { code: -32078, message: expect.stringContaining("active") },
    });
    fixture.adapter.sessions[0]?.succeedTurn();
    await stopFixture(fixture);
  });

  it("binds a selected Pi Model and Thinking carrier to create and later Turn routing", async () => {
    const fixture = createFixture();
    const model = fixture.adapter.catalog.models[1]?.ref;
    if (!model) throw new Error("Fake catalog has no secondary Model");
    const low = fixture.adapter.catalog.thinkingOptions.find(({ id }) => id === "low")?.id;
    if (!low) throw new Error("Fake catalog has no Low Thinking option");
    const carrier = encodePiTransportModel(model, low);
    const threadId = await startPiThread(fixture, carrier);

    expect(fixture.adapter.sessions[0]?.initialState).toMatchObject({
      effectiveModel: model,
      effectiveThinkingOptionId: low,
    });
    expect(
      (fixture.collector.messages.find((message) => requestId(message, 1))?.result as JsonObject)
        .model,
    ).toBe(carrier);
    writeRequest(fixture.desktopInput, {
      id: 33,
      method: "turn/start",
      params: {
        threadId,
        model: carrier,
        input: [{ type: "text", text: "selected" }],
      },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 33)),
    ).resolves.toMatchObject({ result: { turn: { status: "inProgress" } } });
    fixture.adapter.sessions[0]?.succeedTurn();
    await stopFixture(fixture);
  });

  it("rejects malformed selected Pi carriers without forwarding or stopping Host", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);

    writeRequest(fixture.desktopInput, {
      id: 34,
      method: "thread/start",
      params: { model: "codexhost/pi-native@provider/model", cwd: "/synthetic" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 34)),
    ).resolves.toMatchObject({
      error: { code: -32602, message: expect.stringContaining("Model Ref") },
    });
    expect(fixture.adapter.sessions).toHaveLength(0);
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("projects early Adapter outputs after the turn/start response and supports thread/read", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");

    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "turn/start",
      params: { threadId, input: [{ type: "text", text: "synthetic" }] },
    });
    await fixture.collector.waitFor((message) => requestId(message, 2));
    session.appendText("fake output");
    await fixture.collector.waitFor((message) => method(message, "item/started"));
    session.succeedTurn();
    await fixture.collector.waitFor((message) => method(message, "turn/completed"));

    const responseIndex = fixture.collector.messages.findIndex((message) => requestId(message, 2));
    const startedIndex = fixture.collector.messages.findIndex((message) =>
      method(message, "turn/started"),
    );
    expect(responseIndex).toBeGreaterThanOrEqual(0);
    expect(startedIndex).toBeGreaterThan(responseIndex);

    writeRequest(fixture.desktopInput, {
      id: 3,
      method: "thread/read",
      params: { threadId, includeTurns: true },
    });
    const readResponse = await fixture.collector.waitFor((message) => requestId(message, 3));
    expect(readResponse).toMatchObject({
      result: { thread: { turns: [{ status: "completed" }] } },
    });
    await stopFixture(fixture);
  });

  it("projects autonomous Harness Turn input in the live turn/started payload", async () => {
    const fixture = createFixture();
    await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    const turnId = hostTurnIdSchema.parse("autonomous-turn");

    session.publishAutonomousTurn(turnId, [
      { type: "text", text: "native follow-up" },
      { type: "text", text: "second line" },
    ]);

    await expect(
      fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId)),
    ).resolves.toMatchObject({
      params: {
        turn: {
          id: turnId,
          items: [
            {
              type: "userMessage",
              content: [
                { type: "text", text: "native follow-up" },
                { type: "text", text: "second line" },
              ],
            },
          ],
        },
      },
    });
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
    await stopFixture(fixture);
  });

  it("reads static Harness command catalogs without inspection or opening a Session", async () => {
    const fixture = createFixture();
    const catalog = {
      commands: [
        harnessCommandDescriptorSchema.parse({
          id: "fake.compact",
          invocation: "/compact",
          label: "Compact",
          argumentMode: "none",
        }),
      ],
    };
    Object.assign(fixture.adapter, { commandCatalog: catalog });
    const inspect = vi.spyOn(fixture.adapter, "inspect");
    const open = vi.spyOn(fixture.adapter, "open");
    writeRequest(fixture.desktopInput, {
      id: 1,
      method: "codexhost/harness/commands/inspect",
      params: { harnessId: "pi" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 1)),
    ).resolves.toMatchObject({ result: catalog });
    expect(inspect).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(fixture.adapter.sessions).toHaveLength(0);

    for (const [id, params, code] of [
      [2, { threadId: "unused" }, -32602],
      [3, { harnessId: "missing" }, -32077],
    ] as const) {
      writeRequest(fixture.desktopInput, {
        id,
        method: "codexhost/harness/commands/inspect",
        params,
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, id)),
      ).resolves.toMatchObject({ error: { code } });
    }
    Object.assign(fixture.adapter, { commandCatalog: { commands: [{ id: "invalid" }] } });
    writeRequest(fixture.desktopInput, {
      id: 4,
      method: "codexhost/harness/commands/inspect",
      params: { harnessId: "pi" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 4)),
    ).resolves.toMatchObject({ error: { code: -32078 } });
    expect(open).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("acknowledges an accepted Harness command through the public command contract", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    session.commands = {
      list: async () => ({
        ok: true,
        value: {
          commands: [
            harnessCommandDescriptorSchema.parse({
              id: "fake.compact",
              invocation: "/compact",
              label: "Compact",
              argumentMode: "none" as const,
            }),
          ],
        },
      }),
      execute: async ({ turnId }) => {
        session.publishEphemeralCommand(turnId, {
          type: "contextCompaction",
          itemId: hostItemIdSchema.parse("fake-command-compaction-item"),
        });
        return {
          ok: true,
          value: { turnId },
        };
      },
    };
    const turnId = hostTurnIdSchema.parse("manual-compact");

    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "codexhost/thread/command/execute",
      params: { threadId, commandId: "fake.compact", turnId },
    });

    await expect(
      fixture.collector.waitFor((message) => requestId(message, 2)),
    ).resolves.toMatchObject({ result: { accepted: true, turnId } });
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));

    const nextTurnId = await startPiTurn(fixture, threadId, 3);
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", nextTurnId));
    session.succeedTurn();
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", nextTurnId));
    await stopFixture(fixture);
  });

  it("serializes command catalog admission and releases it after discovery failure", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    let resolveCatalog:
      | ((value: {
          ok: false;
          error: {
            code: "unavailable";
            message: string;
            retryable: true;
          };
        }) => void)
      | undefined;
    const descriptor = harnessCommandDescriptorSchema.parse({
      id: "fake.compact",
      invocation: "/compact",
      label: "Compact",
      argumentMode: "none",
    });
    const list = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveCatalog = resolve;
          }),
      )
      .mockResolvedValue({ ok: true, value: { commands: [descriptor] } });
    const execute = vi.fn(async ({ turnId }) => {
      session.publishEphemeralCommand(turnId, {
        type: "contextCompaction",
        itemId: hostItemIdSchema.parse(`retried-command-${turnId}`),
      });
      return { ok: true as const, value: { turnId } };
    });
    session.commands = { list, execute };

    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "codexhost/thread/command/execute",
      params: { threadId, commandId: "fake.compact" },
    });
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
    writeRequest(fixture.desktopInput, {
      id: 3,
      method: "codexhost/thread/command/execute",
      params: { threadId, commandId: "fake.compact" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 3)),
    ).resolves.toMatchObject({ error: { code: -32072 } });

    resolveCatalog?.({
      ok: false,
      error: { code: "unavailable", message: "catalog offline", retryable: true },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 2)),
    ).resolves.toMatchObject({ error: { code: -32078, message: "catalog offline" } });

    writeRequest(fixture.desktopInput, {
      id: 4,
      method: "codexhost/thread/command/execute",
      params: { threadId, commandId: "fake.compact" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 4)),
    ).resolves.toMatchObject({ result: { accepted: true } });
    expect(execute).toHaveBeenCalledOnce();
    await stopFixture(fixture);
  });

  it("preserves ordinary prompt whitespace without command discovery", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    const list = vi.fn();
    const executeCommand = vi.fn();
    session.commands = { list, execute: executeCommand };
    const execute = vi.spyOn(session, "execute");
    const text = " \ntext /compact text \n";

    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "turn/start",
      params: { threadId, input: [{ type: "text", text }] },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 2)),
    ).resolves.toMatchObject({ result: { turn: { status: "inProgress" } } });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ type: "turn.start", input: [{ type: "text", text }] }),
    );
    expect(list).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it.each([
    ["bare", "/compact"],
    ["space", "/compact "],
    ["newline", "/compact\n"],
    ["space before newline", "/compact \n"],
    ["surrounding whitespace", " \n/compact\t\r\n"],
  ])("recognizes compact without instructions: %s", async (_name, text) => {
    const fixture = createFixture();
    try {
      const threadId = await startPiThread(fixture);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      session.commands = {
        list: async () => ({
          ok: true,
          value: {
            commands: [
              harnessCommandDescriptorSchema.parse({
                id: "fake.compact",
                invocation: "/compact",
                label: "Compact",
                argumentMode: "text",
              }),
            ],
          },
        }),
        execute: async ({ turnId, arguments: arguments_ }) => {
          expect(arguments_).toBeUndefined();
          session.publishEphemeralCommand(turnId, {
            type: "contextCompaction",
            itemId: hostItemIdSchema.parse("compact-whitespace-test"),
          });
          return { ok: true, value: { turnId } };
        },
      };
      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "turn/start",
        params: { threadId, input: [{ type: "text", text }] },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 2)),
      ).resolves.toMatchObject({ result: { turn: { status: "inProgress" } } });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("projects a Harness command's native compaction Item through the existing UI lane", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    session.commands = {
      list: async () => ({
        ok: true,
        value: {
          commands: [
            harnessCommandDescriptorSchema.parse({
              id: "fake.compact",
              invocation: "/compact",
              label: "Compact",
              argumentMode: "text" as const,
            }),
          ],
        },
      }),
      execute: async ({ turnId, commandId, arguments: arguments_ }) => {
        expect(commandId).toBe("fake.compact");
        expect(arguments_).toEqual({ text: "Keep implementation details" });
        session.publishEphemeralCommand(turnId, {
          type: "contextCompaction",
          itemId: hostItemIdSchema.parse("fake-compaction-item"),
        });
        return { ok: true, value: { turnId } };
      },
    };

    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "turn/start",
      params: {
        threadId,
        input: [{ type: "text", text: "/compact Keep implementation details" }],
      },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 2)),
    ).resolves.toMatchObject({ result: { turn: { status: "inProgress" } } });
    await expect(
      fixture.collector.waitFor(
        (message) =>
          method(message, "item/started") &&
          (messageParams(message).item as JsonObject | undefined)?.type === "contextCompaction",
      ),
    ).resolves.toMatchObject({ params: { item: { type: "contextCompaction" } } });
    await expect(
      fixture.collector.waitFor(
        (message) =>
          method(message, "item/completed") &&
          (messageParams(message).item as JsonObject | undefined)?.type === "contextCompaction",
      ),
    ).resolves.toMatchObject({ params: { item: { type: "contextCompaction" } } });
    await fixture.collector.waitFor((message) => method(message, "turn/completed"));
    expect(session.persistedSnapshot().turns).toHaveLength(0);
    await stopFixture(fixture);
  });

  it("projects live and historical Reasoning through the native summary lane", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");

    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "turn/start",
      params: { threadId, input: [{ type: "text", text: "reasoning" }] },
    });
    await fixture.collector.waitFor((message) => requestId(message, 2));
    const reasoningId = session.startReasoning("visible ");
    await expect(
      fixture.collector.waitFor(
        (message) =>
          method(message, "item/started") &&
          ((message.params as JsonObject).item as JsonObject | undefined)?.id ===
            `${reasoningId}-summary`,
      ),
    ).resolves.toMatchObject({
      params: { item: { type: "reasoning", summary: [], content: [] } },
    });
    await fixture.collector.waitFor((message) =>
      method(message, "item/reasoning/summaryPartAdded"),
    );
    session.appendReasoning(reasoningId, "analysis");
    await expect(
      fixture.collector.waitFor(
        (message) =>
          method(message, "item/reasoning/summaryTextDelta") &&
          (message.params as JsonObject).delta === "analysis",
      ),
    ).resolves.toMatchObject({ params: { summaryIndex: 0 } });
    session.completeItem(reasoningId, { status: "succeeded" });
    await fixture.collector.waitFor(
      (message) =>
        method(message, "item/completed") &&
        ((message.params as JsonObject).item as JsonObject | undefined)?.id === reasoningId,
    );
    session.appendText("answer");
    session.succeedTurn();
    const completed = await fixture.collector.waitFor((message) =>
      method(message, "turn/completed"),
    );
    expect(completed).toMatchObject({
      params: {
        turn: {
          items: [
            {
              id: `${reasoningId}-summary`,
              type: "reasoning",
              summary: ["visible analysis"],
              content: [],
            },
            {
              id: reasoningId,
              type: "commandExecution",
              command: "thinking",
              aggregatedOutput: "visible analysis",
            },
            { type: "agentMessage", text: "answer" },
          ],
        },
      },
    });

    writeRequest(fixture.desktopInput, {
      id: 3,
      method: "thread/read",
      params: { threadId, includeTurns: true },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 3)),
    ).resolves.toMatchObject({
      result: {
        thread: {
          turns: [
            {
              items: [
                { type: "userMessage" },
                {
                  id: `${reasoningId}-summary`,
                  type: "reasoning",
                  summary: ["visible analysis"],
                  content: [],
                },
                {
                  id: reasoningId,
                  type: "commandExecution",
                  command: "thinking",
                  aggregatedOutput: "visible analysis",
                },
                { type: "agentMessage", text: "answer" },
              ],
            },
          ],
        },
      },
    });
    await stopFixture(fixture);
  });

  it("notifies Renderer when reliable Usage arrives before Context Usage", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");

    const turnId = await startPiTurn(fixture, threadId, 2);
    session.publishUsage(
      { cacheHitRatePercent: 0, totalCostUsd: 0.01, inputTokens: 9, outputTokens: 122 },
      hostTurnIdSchema.parse(turnId),
    );

    await expect(
      fixture.collector.waitFor(
        (message) =>
          method(message, "codexhost/thread/usage/updated") &&
          messageParams(message).threadId === threadId,
      ),
    ).resolves.toEqual({
      method: "codexhost/thread/usage/updated",
      params: { threadId },
    });
    expect(
      fixture.collector.messages.some(
        (message) =>
          method(message, "thread/tokenUsage/updated") &&
          messageParams(message).threadId === threadId,
      ),
    ).toBe(false);

    session.succeedTurn();
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
    await stopFixture(fixture);
  });

  it("orders early and terminal Usage updates and replays current Usage after thread/read", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    session.publishUsageOnNextTurn({
      totalTokens: 30,
      contextUsedTokens: 20,
      contextWindowTokens: 100,
    });

    const turnId = await startPiTurn(fixture, threadId, 2);
    const earlyUsage = await fixture.collector.waitFor(
      (message) =>
        method(message, "thread/tokenUsage/updated") &&
        messageParams(message).threadId === threadId,
    );
    expect(earlyUsage).toMatchObject({
      params: {
        threadId,
        turnId,
        tokenUsage: {
          total: { totalTokens: 30 },
          last: { totalTokens: 20, inputTokens: 20 },
          modelContextWindow: 100,
        },
      },
    });
    const responseIndex = fixture.collector.messages.findIndex((message) => requestId(message, 2));
    const earlyUsageIndex = fixture.collector.messages.indexOf(earlyUsage);
    expect(earlyUsageIndex).toBeGreaterThan(responseIndex);

    session.succeedTurn();
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
    await fixture.collector.waitFor((message) => threadStatus(message, threadId, "idle"));
    session.publishUsage(
      { totalTokens: 44, contextUsedTokens: 25, contextWindowTokens: 100 },
      hostTurnIdSchema.parse(turnId),
    );
    await vi.waitFor(() => {
      expect(
        fixture.collector.messages.filter(
          (message) =>
            method(message, "thread/tokenUsage/updated") &&
            ((messageParams(message).tokenUsage as JsonObject).total as JsonObject).totalTokens ===
              44,
        ),
      ).toHaveLength(1);
    });
    const terminalIndex = fixture.collector.messages.findIndex((message) =>
      turnEvent(message, "turn/completed", turnId),
    );
    const idleIndex = fixture.collector.messages.findIndex((message) =>
      threadStatus(message, threadId, "idle"),
    );
    const terminalUsageIndex = fixture.collector.messages.findIndex(
      (message) =>
        method(message, "thread/tokenUsage/updated") &&
        ((messageParams(message).tokenUsage as JsonObject).total as JsonObject).totalTokens === 44,
    );
    expect(idleIndex).toBeGreaterThan(terminalIndex);
    expect(terminalUsageIndex).toBeGreaterThan(idleIndex);

    writeRequest(fixture.desktopInput, {
      id: 3,
      method: "thread/read",
      params: { threadId, includeTurns: true },
    });
    await fixture.collector.waitFor((message) => requestId(message, 3));
    await vi.waitFor(() => {
      expect(
        fixture.collector.messages.filter(
          (message) =>
            method(message, "thread/tokenUsage/updated") &&
            ((messageParams(message).tokenUsage as JsonObject).total as JsonObject).totalTokens ===
              44,
        ),
      ).toHaveLength(2);
    });
    const readResponseIndex = fixture.collector.messages.findIndex((message) =>
      requestId(message, 3),
    );
    const replayIndex = fixture.collector.messages.findLastIndex(
      (message) =>
        method(message, "thread/tokenUsage/updated") &&
        ((messageParams(message).tokenUsage as JsonObject).total as JsonObject).totalTokens === 44,
    );
    expect(replayIndex).toBeGreaterThan(readResponseIndex);

    const stored = await fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId));
    expect(JSON.stringify(stored)).not.toMatch(/"(?:usage|cost|context|requestId|refreshCache)"/i);
    await stopFixture(fixture);
  });

  it("keeps Usage isolated across registered Harness Threads", async () => {
    const piAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const claudeAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const fixture = createFixture({
      externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([
        ["pi", piAdapter],
        ["claude-code", claudeAdapter],
      ]),
    });
    const piThreadId = await startExternalThread(fixture, "codexhost/pi-native", 10);
    const claudeThreadId = await startExternalThread(
      fixture,
      CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
      11,
    );
    const piTurnId = await completePiTurn(fixture, piThreadId, 12, 0);
    const claudeTurnId = await completePiTurn(
      { ...fixture, adapter: claudeAdapter },
      claudeThreadId,
      13,
      0,
    );
    piAdapter.sessions[0]?.publishUsage(
      { totalTokens: 10, contextUsedTokens: 2, contextWindowTokens: 100 },
      hostTurnIdSchema.parse(piTurnId),
    );
    claudeAdapter.sessions[0]?.publishUsage(
      { totalTokens: 90, contextUsedTokens: 70, contextWindowTokens: 200 },
      hostTurnIdSchema.parse(claudeTurnId),
    );

    await expect(
      fixture.collector.waitFor(
        (message) =>
          method(message, "thread/tokenUsage/updated") &&
          messageParams(message).threadId === piThreadId,
      ),
    ).resolves.toMatchObject({ params: { tokenUsage: { total: { totalTokens: 10 } } } });
    await expect(
      fixture.collector.waitFor(
        (message) =>
          method(message, "thread/tokenUsage/updated") &&
          messageParams(message).threadId === claudeThreadId,
      ),
    ).resolves.toMatchObject({ params: { tokenUsage: { total: { totalTokens: 90 } } } });
    await stopFixture(fixture);
  });

  it("routes exact Usage refresh only to the owning External Session", async () => {
    const piAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const claudeAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const fixture = createFixture({
      externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([
        ["pi", piAdapter],
        ["claude-code", claudeAdapter],
      ]),
    });
    const piThreadId = await startExternalThread(fixture, "codexhost/pi-native", 60);
    const claudeThreadId = await startExternalThread(
      fixture,
      CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
      61,
    );

    writeRequest(fixture.desktopInput, {
      id: 62,
      method: "codexhost/thread/usage/inspect",
      params: { threadId: claudeThreadId, refresh: "exact" },
    });
    await fixture.collector.waitFor((message) => requestId(message, 62));
    expect(claudeAdapter.sessions[0]?.usageRefreshes).toBe(1);
    expect(piAdapter.sessions[0]?.usageRefreshes).toBe(0);

    writeRequest(fixture.desktopInput, {
      id: 63,
      method: "codexhost/thread/usage/inspect",
      params: { threadId: piThreadId, refresh: "newer" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 63)),
    ).resolves.toMatchObject({ error: { code: -32602 } });
    expect(piAdapter.sessions[0]?.usageRefreshes).toBe(0);
    await stopFixture(fixture);
  });

  it("round-trips Claude.ai plan-window fields through Thread Usage inspection without writing accountCredits", async () => {
    const claudeAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const fixture = createFixture({
      externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([
        ["claude-code", claudeAdapter],
      ]),
    });
    const claudeThreadId = await startExternalThread(
      fixture,
      CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
      70,
    );
    const claudeTurnId = await completePiTurn(
      { ...fixture, adapter: claudeAdapter },
      claudeThreadId,
      71,
      0,
    );
    claudeAdapter.sessions[0]?.publishUsage(
      {
        cacheHitRatePercent: 99,
        totalCostUsd: 1.373,
        contextUsedTokens: 50,
        contextWindowTokens: 200,
        planFiveHourUsedPercent: 45,
        planFiveHourResetsAtUnix: 1_756_130_400,
      },
      hostTurnIdSchema.parse(claudeTurnId),
    );
    await fixture.collector.waitFor(
      (message) =>
        method(message, "thread/tokenUsage/updated") &&
        messageParams(message).threadId === claudeThreadId,
    );

    writeRequest(fixture.desktopInput, {
      id: 72,
      method: "codexhost/thread/usage/inspect",
      params: { threadId: claudeThreadId, refresh: "exact" },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 72))).resolves.toEqual({
      id: 72,
      result: {
        threadId: claudeThreadId,
        usage: {
          cacheHitRatePercent: 99,
          totalCostUsd: 1.373,
          contextUsedTokens: 50,
          contextWindowTokens: 200,
          planFiveHourUsedPercent: 45,
          planFiveHourResetsAtUnix: 1_756_130_400,
        },
      },
    });
    expect(claudeAdapter.sessions[0]?.usageRefreshes).toBe(1);

    writeRequest(fixture.desktopInput, {
      id: 73,
      method: "codexhost/thread/usage/inspect",
      params: { threadId: "official-thread", refresh: "exact" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 73)),
    ).resolves.toMatchObject({ error: { code: -32602 } });
    await stopFixture(fixture);
  });

  it("keeps the source Permission Mode when a Fork opens on the Harness default", async () => {
    const permissionModes = harnessPermissionModeCatalogSchema.parse({
      modes: [
        { id: "default", label: "Default" },
        { id: "auto", label: "Auto" },
      ],
      defaultModeId: "default",
    });
    const adapter = new DefaultOnForkAdapter(
      harnessIdSchema.parse("pi"),
      undefined,
      true,
      true,
      null,
      permissionModes,
    );
    const fixture = createFixture({ externalAdapters: new Map([["pi", adapter]]) });
    const sourceThreadId = await startPiThread(fixture);
    const auto = harnessPermissionModeIdSchema.parse("auto");
    writeRequest(fixture.desktopInput, {
      id: 20,
      method: "codexhost/thread/permission-mode/select",
      params: { threadId: sourceThreadId, permissionModeId: auto },
    });
    await fixture.collector.waitFor((message) => requestId(message, 20));
    await completePiTurn(fixture, sourceThreadId, 21);

    writeRequest(fixture.desktopInput, {
      id: 22,
      method: "thread/fork",
      params: { threadId: sourceThreadId },
    });
    const forkResponse = await fixture.collector.waitFor((message) => requestId(message, 22));
    expect(forkResponse.error).toBeUndefined();
    expect(adapter.forkedWithDefault).toBe(true);
    expect(adapter.sessions.at(-1)?.state.effectivePermissionModeId).toBe(auto);
    await stopFixture(fixture);
  });

  it("forks external inclusive, exclusive, and tail boundaries without reusing Host Turn IDs", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const sourceThreadId = await startPiThread(fixture);
    const sourceTurnIds: [string, string, string] = [
      await completePiTurn(fixture, sourceThreadId, 2),
      await completePiTurn(fixture, sourceThreadId, 3),
      await completePiTurn(fixture, sourceThreadId, 4),
    ];

    const forkRequest = async (id: number, params: JsonObject): Promise<JsonObject> => {
      writeRequest(fixture.desktopInput, {
        id,
        method: "thread/fork",
        params: { threadId: sourceThreadId, ...params },
      });
      const response = await fixture.collector.waitFor((message) => requestId(message, id));
      const result = response.result as JsonObject;
      return result.thread as JsonObject;
    };

    const inclusive = await forkRequest(10, {
      lastTurnId: sourceTurnIds[0],
      cwd: "/synthetic-worktree/inclusive",
      runtimeWorkspaceRoots: ["/synthetic-worktree/inclusive", "/synthetic"],
    });
    const exclusive = await forkRequest(11, { beforeTurnId: sourceTurnIds[1] });
    const tail = await forkRequest(12, {});
    const excluded = await forkRequest(13, { excludeTurns: true });

    expect(inclusive).toMatchObject({
      forkedFromId: sourceThreadId,
      parentThreadId: null,
      cwd: "/synthetic-worktree/inclusive",
      turns: [expect.objectContaining({ status: "completed" })],
    });
    expect(exclusive.turns).toHaveLength(1);
    expect(tail.turns).toHaveLength(3);
    expect(excluded.turns).toEqual([]);
    const inclusiveTurnId = (inclusive.turns as JsonObject[])[0]?.id;
    expect(inclusiveTurnId).not.toBe(sourceTurnIds[0]);
    expect(inclusive.id).not.toBe(sourceThreadId);
    expect(exclusive.id).not.toBe(inclusive.id);

    const responseIndex = fixture.collector.messages.findIndex((message) => requestId(message, 10));
    const notificationIndex = fixture.collector.messages.findIndex(
      (message) =>
        method(message, "thread/started") &&
        (messageParams(message).thread as JsonObject | undefined)?.id === inclusive.id,
    );
    expect(notificationIndex).toBeGreaterThan(responseIndex);

    await completePiTurn(fixture, inclusive.id as string, 20, 1);
    await completePiTurn(fixture, sourceThreadId, 21, 0);
    await expect(fixture.adapter.sessions[1]?.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{}, {}] },
    });
    await expect(fixture.adapter.sessions[0]?.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{}, {}, {}, {}] },
    });
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("forks a completed boundary while a later source Turn is still running", async () => {
    const fixture = createFixture();
    const sourceThreadId = await startPiThread(fixture);
    const completedTurnId = await completePiTurn(fixture, sourceThreadId, 2);
    const activeTurnId = await startPiTurn(fixture, sourceThreadId, 3);
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", activeTurnId));

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/fork",
      params: { threadId: sourceThreadId, lastTurnId: completedTurnId },
    });
    const response = await fixture.collector.waitFor((message) => requestId(message, 10));
    expect(response).toMatchObject({ result: { thread: { turns: [{}] } } });
    expect(fixture.adapter.sessions).toHaveLength(2);

    const sourceSession = fixture.adapter.sessions[0];
    if (!sourceSession) throw new Error("Fake source Session was not opened");
    sourceSession.succeedTurn();
    await fixture.collector.waitFor((message) =>
      turnEvent(message, "turn/completed", activeTurnId),
    );
    await expect(sourceSession.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{}, {}] },
    });
    await stopFixture(fixture);
  });

  it("uses only completed source Turns for tail Fork and Desktop rollback while running", async () => {
    const fixture = createFixture();
    const sourceThreadId = await startPiThread(fixture);
    await completePiTurn(fixture, sourceThreadId, 2);
    await completePiTurn(fixture, sourceThreadId, 3);
    await completePiTurn(fixture, sourceThreadId, 4);
    const activeTurnId = await startPiTurn(fixture, sourceThreadId, 5);
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", activeTurnId));

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/fork",
      params: { threadId: sourceThreadId },
    });
    const forkResponse = await fixture.collector.waitFor((message) => requestId(message, 10));
    expect(forkResponse).toMatchObject({ result: { thread: { turns: [{}, {}, {}] } } });
    const derivedId = ((forkResponse.result as JsonObject).thread as JsonObject).id;
    if (typeof derivedId !== "string") throw new Error("Fork response has no derived Thread ID");

    writeRequest(fixture.desktopInput, {
      id: 11,
      method: "thread/rollback",
      params: { threadId: derivedId, numTurns: 3 },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 11)),
    ).resolves.toMatchObject({ result: { thread: { id: derivedId, turns: [{}] } } });

    const sourceSession = fixture.adapter.sessions[0];
    if (!sourceSession) throw new Error("Fake source Session was not opened");
    sourceSession.succeedTurn();
    await fixture.collector.waitFor((message) =>
      turnEvent(message, "turn/completed", activeTurnId),
    );
    await expect(sourceSession.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{}, {}, {}, {}] },
    });
    await stopFixture(fixture);
  });

  it("rejects a running source that has no completed Fork Checkpoint", async () => {
    const fixture = createFixture();
    const sourceThreadId = await startPiThread(fixture);
    const activeTurnId = await startPiTurn(fixture, sourceThreadId, 2);
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", activeTurnId));

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/fork",
      params: { threadId: sourceThreadId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 10)),
    ).resolves.toMatchObject({
      error: { code: -32080, message: "External Fork Checkpoint is unavailable" },
    });
    expect(fixture.adapter.sessions).toHaveLength(1);

    const sourceSession = fixture.adapter.sessions[0];
    if (!sourceSession) throw new Error("Fake source Session was not opened");
    sourceSession.succeedTurn();
    await fixture.collector.waitFor((message) =>
      turnEvent(message, "turn/completed", activeTurnId),
    );
    await stopFixture(fixture);
  });

  it("routes a fixed Renderer Fork intent through the existing external Fork implementation", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const sourceThreadId = await startPiThread(fixture);
    const firstTurnId = await completePiTurn(fixture, sourceThreadId, 2);
    await completePiTurn(fixture, sourceThreadId, 3);

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "codexhost/thread/fork",
      params: { threadId: sourceThreadId, lastTurnId: firstTurnId },
    });
    const response = await fixture.collector.waitFor((message) => requestId(message, 10));
    expect(response).toMatchObject({ result: { threadId: expect.any(String) } });
    const derivedId = (response.result as JsonObject).threadId;
    if (typeof derivedId !== "string") throw new Error("Renderer Fork has no derived Thread ID");
    expect(derivedId).not.toBe(sourceThreadId);
    await expect(
      fixture.mappingStore.getThread(hostThreadIdSchema.parse(derivedId)),
    ).resolves.toMatchObject({
      forkSource: { hostThreadId: sourceThreadId, hostTurnId: firstTurnId },
      turnMappings: [{}],
    });
    const responseIndex = fixture.collector.messages.findIndex((message) => requestId(message, 10));
    const notificationIndex = fixture.collector.messages.findIndex(
      (message) =>
        method(message, "thread/started") &&
        (messageParams(message).thread as JsonObject | undefined)?.id === derivedId,
    );
    expect(notificationIndex).toBeGreaterThan(responseIndex);
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("acknowledges Desktop unsubscribe without inventing an external subscription", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startPiThread(fixture);
    await completePiTurn(fixture, threadId, 2);

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/unsubscribe",
      params: { threadId },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 10))).resolves.toEqual({
      id: 10,
      result: { status: "notSubscribed" },
    });
    await expect(fixture.adapter.sessions[0]?.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{}] },
    });

    writeRequest(fixture.desktopInput, {
      id: 11,
      method: "thread/resume",
      params: { threadId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 11)),
    ).resolves.toMatchObject({ result: { thread: { id: threadId, turns: [{}] } } });
    expect(fixture.adapter.sessions).toHaveLength(1);
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("rolls back the current External Thread by exactly one Turn", async () => {
    const adapter = rollbackCapableAdapter();
    const fixture = createFixture({ externalAdapters: new Map([["pi", adapter]]) });
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startPiThread(fixture);
    const firstTurnId = await completePiTurn(fixture, threadId, 2);
    await completePiTurn(fixture, threadId, 3);
    const before = await fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId));

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/rollback",
      params: { threadId, numTurns: 1 },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 10)),
    ).resolves.toMatchObject({
      result: { thread: { id: threadId, turns: [{ id: firstTurnId }] } },
    });
    await expect(
      fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
    ).resolves.toMatchObject({
      hostThreadId: threadId,
      nativeSessionRef: { nativeSessionId: "fake-session-2" },
      transportModelId: before?.transportModelId,
      turnMappings: [{ hostTurnId: firstTurnId }],
    });
    expect(adapter.sessions[1]?.initialState).toMatchObject({
      effectiveModel: adapter.sessions[0]?.state.effectiveModel,
      effectiveThinkingOptionId: adapter.sessions[0]?.state.effectiveThinkingOptionId,
    });
    await expect(adapter.sessions[0]?.readSnapshot()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    await completePiTurn(fixture, threadId, 11, 1);
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("restores configuration before reading a resume-state rollback replacement", async () => {
    const permissionModes = harnessPermissionModeCatalogSchema.parse({
      modes: [
        { id: "default", label: "Default" },
        { id: "auto", label: "Auto" },
      ],
      defaultModeId: "default",
    });
    const adapter = new ResumeStateRollbackAdapter(
      harnessIdSchema.parse("pi"),
      undefined,
      true,
      true,
      null,
      permissionModes,
      true,
    );
    const fixture = createFixture({ externalAdapters: new Map([["pi", adapter]]) });
    const threadId = await startPiThread(fixture);
    const model = adapter.catalog.models[1]?.ref;
    if (!model) throw new Error("Fake catalog has no secondary Model");
    const thinkingOptionId = "low";
    const permissionModeId = harnessPermissionModeIdSchema.parse("auto");

    writeRequest(fixture.desktopInput, {
      id: 40,
      method: "codexhost/thread/model/select",
      params: { threadId, model },
    });
    await fixture.collector.waitFor((message) => requestId(message, 40));
    writeRequest(fixture.desktopInput, {
      id: 41,
      method: "codexhost/thread/thinking/select",
      params: { threadId, thinkingOptionId },
    });
    await fixture.collector.waitFor((message) => requestId(message, 41));
    writeRequest(fixture.desktopInput, {
      id: 42,
      method: "codexhost/thread/permission-mode/select",
      params: { threadId, permissionModeId },
    });
    await fixture.collector.waitFor((message) => requestId(message, 42));

    const firstTurnId = await completePiTurn(fixture, threadId, 43);
    await completePiTurn(fixture, threadId, 44);
    writeRequest(fixture.desktopInput, {
      id: 45,
      method: "thread/rollback",
      params: { threadId, numTurns: 1 },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 45)),
    ).resolves.toMatchObject({
      result: { thread: { id: threadId, turns: [{ id: firstTurnId }] } },
    });

    const expectedConfiguration = {
      effectiveModel: model,
      effectiveThinkingOptionId: thinkingOptionId,
      effectivePermissionModeId: permissionModeId,
    };
    expect(adapter.rollbackReplacementStateAtFirstRead).toMatchObject(expectedConfiguration);
    expect(adapter.sessions[1]?.state).toMatchObject(expectedConfiguration);
    await stopFixture(fixture);
  });

  it("reverts the latest completed Turn of a paginated External Thread", async () => {
    const adapter = rollbackCapableAdapter();
    const fixture = createFixture({ externalAdapters: new Map([["pi", adapter]]) });
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startExternalThread(fixture, "codexhost/pi-native", 1, {
      historyMode: "paginated",
    });
    const firstTurnId = await completePiTurn(fixture, threadId, 2);
    const lastTurnId = await completePiTurn(fixture, threadId, 3);

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/revert",
      params: { threadId, beforeTurnId: lastTurnId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 10)),
    ).resolves.toMatchObject({ result: { thread: { id: threadId, turns: [] } } });
    await expect(
      fixture.collector.waitFor((message) => method(message, "thread/reverted")),
    ).resolves.toEqual({ method: "thread/reverted", params: { threadId } });
    await expect(
      fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
    ).resolves.toMatchObject({
      nativeSessionRef: { nativeSessionId: "fake-session-2" },
      turnMappings: [{ hostTurnId: firstTurnId }],
    });
    expect(adapter.sessions).toHaveLength(2);
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("rejects a stale paginated Revert boundary without changing history", async () => {
    const adapter = rollbackCapableAdapter();
    const fixture = createFixture({ externalAdapters: new Map([["pi", adapter]]) });
    const threadId = await startExternalThread(fixture, "codexhost/pi-native", 1, {
      historyMode: "paginated",
    });
    await completePiTurn(fixture, threadId, 2);
    const before = await fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId));

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/revert",
      params: { threadId, beforeTurnId: "stale-turn" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 10)),
    ).resolves.toMatchObject({ error: { code: -32080 } });
    await expect(
      fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
    ).resolves.toEqual(before);
    expect(adapter.sessions).toHaveLength(1);
    await stopFixture(fixture);
  });

  it("rolls the only current External Turn back to empty history", async () => {
    const adapter = rollbackCapableAdapter();
    const fixture = createFixture({ externalAdapters: new Map([["pi", adapter]]) });
    const threadId = await startPiThread(fixture);
    await completePiTurn(fixture, threadId, 2);

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/rollback",
      params: { threadId, numTurns: 1 },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 10)),
    ).resolves.toMatchObject({ result: { thread: { id: threadId, turns: [] } } });
    await expect(
      fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
    ).resolves.toMatchObject({
      nativeSessionRef: { nativeSessionId: "fake-session-2" },
      turnMappings: [],
    });
    await completePiTurn(fixture, threadId, 11, 1);
    await stopFixture(fixture);
  });

  it("rejects current last-Turn rollback while active or for multiple Turns", async () => {
    const adapter = rollbackCapableAdapter();
    const fixture = createFixture({ externalAdapters: new Map([["pi", adapter]]) });
    const threadId = await startPiThread(fixture);
    await completePiTurn(fixture, threadId, 2);

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/rollback",
      params: { threadId, numTurns: 2 },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 10)),
    ).resolves.toMatchObject({ error: { code: -32076 } });

    const activeTurnId = await startPiTurn(fixture, threadId, 11);
    writeRequest(fixture.desktopInput, {
      id: 12,
      method: "thread/rollback",
      params: { threadId, numTurns: 1 },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 12)),
    ).resolves.toMatchObject({ error: { code: -32072 } });
    expect(adapter.sessions).toHaveLength(1);
    adapter.sessions[0]?.succeedTurn();
    await fixture.collector.waitFor((message) =>
      turnEvent(message, "turn/completed", activeTurnId),
    );
    await stopFixture(fixture);
  });

  it("keeps the current Session authoritative when last-Turn persistence fails", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-host-last-turn-failure-"));
    let failRollbackCommit = false;
    const mappingStore = new MappingStore({
      directory,
      beforeReplace(record) {
        if (failRollbackCommit && record.state === "ready" && record.turnMappings.length === 1) {
          throw new Error("synthetic last-Turn rollback failure");
        }
      },
    });
    const adapter = rollbackCapableAdapter();
    const fixture = createFixture({
      externalAdapters: new Map([["pi", adapter]]),
      mappingStore,
      mappingStoreDirectory: directory,
    });
    const threadId = await startPiThread(fixture);
    await completePiTurn(fixture, threadId, 2);
    await completePiTurn(fixture, threadId, 3);
    const before = await mappingStore.getThread(hostThreadIdSchema.parse(threadId));
    failRollbackCommit = true;

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/rollback",
      params: { threadId, numTurns: 1 },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 10)),
    ).resolves.toMatchObject({ error: { code: -32081 } });
    await expect(mappingStore.getThread(hostThreadIdSchema.parse(threadId))).resolves.toEqual(
      before,
    );
    await expect(adapter.sessions[0]?.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{}, {}] },
    });
    await expect(adapter.sessions[1]?.readSnapshot()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    await completePiTurn(fixture, threadId, 11, 0);
    await stopFixture(fixture);
  });

  it("realizes Desktop Worktree tail-Fork plus rollback as one exact derived prefix", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const sourceThreadId = await startPiThread(fixture);
    const sourceTurnIds = [
      await completePiTurn(fixture, sourceThreadId, 2),
      await completePiTurn(fixture, sourceThreadId, 3),
      await completePiTurn(fixture, sourceThreadId, 4),
    ];

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/fork",
      params: {
        threadId: sourceThreadId,
        cwd: "/synthetic-worktree",
        runtimeWorkspaceRoots: ["/synthetic-worktree", "/synthetic"],
      },
    });
    const forkResponse = await fixture.collector.waitFor((message) => requestId(message, 10));
    expect(forkResponse.result).toMatchObject({
      cwd: "/synthetic-worktree",
      runtimeWorkspaceRoots: ["/synthetic-worktree", "/synthetic"],
    });
    const forkedThread = (forkResponse.result as JsonObject).thread as JsonObject;
    const derivedId = forkedThread.id;
    const initialDerivedTurns = forkedThread.turns as JsonObject[];
    if (typeof derivedId !== "string") throw new Error("Tail Fork response has no Thread ID");
    expect(forkedThread.cwd).toBe("/synthetic-worktree");
    expect(initialDerivedTurns).toHaveLength(3);

    writeRequest(fixture.desktopInput, {
      id: 11,
      method: "thread/rollback",
      params: { threadId: derivedId, numTurns: 2 },
    });
    const rollbackResponse = await fixture.collector.waitFor((message) => requestId(message, 11));
    const rolledBack = (rollbackResponse.result as JsonObject).thread as JsonObject;
    expect(rolledBack).toMatchObject({
      id: derivedId,
      forkedFromId: sourceThreadId,
      turns: [{ id: initialDerivedTurns[0]?.id, status: "completed" }],
    });
    const derivedRecord = await fixture.mappingStore.getThread(hostThreadIdSchema.parse(derivedId));
    expect(derivedRecord).toMatchObject({
      nativeSessionRef: { nativeSessionId: "fake-session-3" },
      cwd: "/synthetic-worktree",
      forkSource: { hostThreadId: sourceThreadId, hostTurnId: sourceTurnIds[0] },
      turnMappings: [
        {
          hostTurnId: initialDerivedTurns[0]?.id,
          nativeTurnRef: { nativeSessionId: "fake-session-3" },
          nativeCheckpointRef: { nativeSessionId: "fake-session-3" },
        },
      ],
    });
    expect(fixture.adapter.sessions[0]?.cwd).toBe("/synthetic");
    expect(fixture.adapter.sessions[1]?.cwd).toBe("/synthetic-worktree");
    expect(fixture.adapter.sessions[2]?.cwd).toBe("/synthetic-worktree");
    await expect(fixture.adapter.sessions[1]?.readSnapshot()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    await expect(fixture.adapter.sessions[0]?.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{}, {}, {}] },
    });

    await completePiTurn(fixture, derivedId, 20, 2);
    await completePiTurn(fixture, sourceThreadId, 21, 0);
    await expect(fixture.adapter.sessions[2]?.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{}, {}] },
    });
    await expect(fixture.adapter.sessions[0]?.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{}, {}, {}, {}] },
    });
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("rejects rollback when an external Thread is not an untouched derived prefix", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const sourceThreadId = await startPiThread(fixture);
    await completePiTurn(fixture, sourceThreadId, 2);
    await completePiTurn(fixture, sourceThreadId, 3);

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/rollback",
      params: { threadId: sourceThreadId, numTurns: 1 },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 10)),
    ).resolves.toMatchObject({ error: { code: -32076 } });

    writeRequest(fixture.desktopInput, {
      id: 11,
      method: "thread/fork",
      params: { threadId: sourceThreadId },
    });
    const forkResponse = await fixture.collector.waitFor((message) => requestId(message, 11));
    const derivedId = ((forkResponse.result as JsonObject).thread as JsonObject).id;
    if (typeof derivedId !== "string") throw new Error("Tail Fork response has no Thread ID");
    await completePiTurn(fixture, derivedId, 12, 1);

    writeRequest(fixture.desktopInput, {
      id: 13,
      method: "thread/rollback",
      params: { threadId: derivedId, numTurns: 1 },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 13)),
    ).resolves.toMatchObject({ error: { code: -32076 } });
    expect(fixture.adapter.sessions).toHaveLength(2);
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("commits excluded Fork mappings before a later thread/read", async () => {
    const fixture = createFixture();
    const sourceThreadId = await startPiThread(fixture);
    await completePiTurn(fixture, sourceThreadId, 2);
    await completePiTurn(fixture, sourceThreadId, 3);

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/fork",
      params: { threadId: sourceThreadId, excludeTurns: true },
    });
    const forked = await fixture.collector.waitFor((message) => requestId(message, 10));
    const derivedId = ((forked.result as JsonObject).thread as JsonObject).id;
    if (typeof derivedId !== "string") throw new Error("Fork response has no derived Thread ID");
    writeRequest(fixture.desktopInput, {
      id: 11,
      method: "thread/read",
      params: { threadId: derivedId, includeTurns: true },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 11)),
    ).resolves.toMatchObject({ result: { thread: { turns: [{}, {}] } } });
    await stopFixture(fixture);
  });

  it("reads and updates persisted external metadata without restoring history", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-host-metadata-test-"));
    const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const opened = await adapter.open({ kind: "create", cwd: "/persisted" });
    if (!opened.ok || !opened.value.initialState.nativeRef) {
      throw new Error("Fake persisted Session was not created");
    }
    const source = adapter.sessions[0];
    if (!source) throw new Error("Fake persisted Session was not opened");
    const threadId = hostThreadIdSchema.parse("metadata-thread");
    const store = new MappingStore({ directory });
    await store.initialize();
    await store.createProvisional({
      hostThreadId: threadId,
      createRequestId: "metadata-create",
      harnessId: adapter.harnessId,
      cwd: "/persisted",
      title: "Before",
      transportModelId: "codexhost/pi-native",
      ephemeral: false,
      historyMode: "paginated",
    });
    await store.commitReady({
      hostThreadId: threadId,
      nativeSessionRef: opened.value.initialState.nativeRef,
    });
    await store.close();

    const fixture = createFixture({
      externalAdapters: new Map([["pi", adapter]]),
      mappingStoreDirectory: directory,
    });
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);

    writeRequest(fixture.desktopInput, {
      id: 51,
      method: "thread/name/set",
      params: { threadId, name: "After" },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 51))).resolves.toEqual({
      id: 51,
      result: {},
    });

    writeRequest(fixture.desktopInput, {
      id: 52,
      method: "thread/read",
      params: { threadId, includeTurns: false },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 52)),
    ).resolves.toMatchObject({ result: { thread: { id: threadId, name: "After", turns: [] } } });
    writeRequest(fixture.desktopInput, {
      id: 53,
      method: "thread/read",
      params: { threadId, includeTurns: true },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 53)),
    ).resolves.toMatchObject({ error: { code: -32602 } });
    expect(source.snapshotReads).toBe(0);
    expect(adapter.sessions).toHaveLength(1);
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("restores Store-owned external read, resume, and Fork on demand", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-host-restart-test-"));
    const adapter = new FakeHarnessAdapter(
      harnessIdSchema.parse("pi"),
      undefined,
      undefined,
      undefined,
      { totalTokens: 77, contextUsedTokens: 33, contextWindowTokens: 200 },
    );
    const opened = await adapter.open({ kind: "create", cwd: "/persisted" });
    if (!opened.ok) throw new Error(opened.error.message);
    const source = opened.value;
    const persistedTurnId = hostTurnIdSchema.parse("persisted-turn");
    await source.execute({
      type: "turn.start",
      turnId: persistedTurnId,
      input: [{ type: "text", text: "persisted question" }],
    });
    const fakeSource = adapter.sessions[0];
    if (!fakeSource) throw new Error("Fake persisted Session was not opened");
    fakeSource.appendText("persisted answer");
    fakeSource.succeedTurn();
    const snapshot = await source.readSnapshot();
    if (!snapshot.ok || !source.initialState.nativeRef || !snapshot.value.turns[0]) {
      throw new Error("Fake persisted Snapshot was not created");
    }

    const threadId = hostThreadIdSchema.parse("persisted-thread");
    const store = new MappingStore({ directory });
    await store.initialize();
    await store.createProvisional({
      hostThreadId: threadId,
      createRequestId: "persisted-create",
      harnessId: adapter.harnessId,
      cwd: "/persisted",
      title: "Persisted Pi",
      transportModelId: "codexhost/pi-native",
      ephemeral: false,
      historyMode: "legacy",
    });
    await store.commitReady({
      hostThreadId: threadId,
      nativeSessionRef: source.initialState.nativeRef,
      turnMappings: [
        {
          hostTurnId: persistedTurnId,
          nativeTurnRef: snapshot.value.turns[0].nativeTurnRef,
          nativeCheckpointRef: snapshot.value.turns[0].checkpoint,
        },
      ],
    });
    await store.close();

    const restoredModel = adapter.catalog.models[1]?.ref;
    if (!restoredModel) throw new Error("Fake Adapter has no restored Model");
    fakeSource.setStateForSnapshot({
      ...fakeSource.state,
      effectiveModel: restoredModel,
      resolvedModelLabel: "Fake Secondary",
    });

    const fixture = createFixture({
      externalAdapters: new Map([["pi", adapter]]),
      mappingStoreDirectory: directory,
    });
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    writeRequest(fixture.desktopInput, {
      id: 60,
      method: "thread/read",
      params: { threadId, includeTurns: true },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 60)),
    ).resolves.toMatchObject({
      result: {
        thread: {
          id: threadId,
          name: "Persisted Pi",
          turns: [{ id: persistedTurnId, status: "completed" }],
        },
      },
    });
    const restoredUsage = await fixture.collector.waitFor((message) =>
      method(message, "thread/tokenUsage/updated"),
    );
    expect(restoredUsage).toMatchObject({
      params: {
        threadId,
        turnId: persistedTurnId,
        tokenUsage: { total: { totalTokens: 77 }, modelContextWindow: 200 },
      },
    });
    expect(fixture.collector.messages.indexOf(restoredUsage)).toBeGreaterThan(
      fixture.collector.messages.findIndex((message) => requestId(message, 60)),
    );
    expect(fakeSource.snapshotReads).toBe(2);

    writeRequest(fixture.desktopInput, {
      id: 64,
      method: "codexhost/thread/usage/inspect",
      params: { threadId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 64)),
    ).resolves.toMatchObject({
      result: {
        threadId,
        usage: {
          totalTokens: 77,
          contextUsedTokens: 33,
          contextWindowTokens: 200,
        },
      },
    });

    writeRequest(fixture.desktopInput, {
      id: 63,
      method: "codexhost/thread/inspect",
      params: { threadId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 63)),
    ).resolves.toMatchObject({
      result: {
        owner: "external",
        effectiveModel: restoredModel,
        resolvedModelLabel: "Fake Secondary",
      },
    });

    writeRequest(fixture.desktopInput, {
      id: 61,
      method: "thread/resume",
      params: { threadId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 61)),
    ).resolves.toMatchObject({
      result: {
        thread: { id: threadId, turns: [{ id: persistedTurnId }] },
        model: "codexhost/pi-native",
        initialTurnsPage: null,
      },
    });

    writeRequest(fixture.desktopInput, {
      id: 62,
      method: "thread/fork",
      params: {
        threadId,
        lastTurnId: persistedTurnId,
        cwd: "/persisted-worktree",
        runtimeWorkspaceRoots: ["/persisted-worktree", "/persisted"],
      },
    });
    const restartedFork = await fixture.collector.waitFor((message) => requestId(message, 62));
    expect(restartedFork).toMatchObject({
      result: {
        cwd: "/persisted-worktree",
        thread: {
          id: expect.not.stringMatching(/^persisted-thread$/u),
          cwd: "/persisted-worktree",
          forkedFromId: threadId,
          turns: [{ status: "completed" }],
        },
      },
    });
    const restartedDerivedId = ((restartedFork.result as JsonObject).thread as JsonObject).id;
    if (typeof restartedDerivedId !== "string") throw new Error("Restarted Fork has no ID");
    await expect(
      fixture.mappingStore.getThread(hostThreadIdSchema.parse(restartedDerivedId)),
    ).resolves.toMatchObject({ cwd: "/persisted-worktree" });
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });
});

/** Mirrors Claude Code: a forked Native Session starts on the Harness default Permission Mode. */
class DefaultOnForkAdapter extends FakeHarnessAdapter {
  forkedWithDefault = false;

  override async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    const opened = await super.open(input);
    if (opened.ok && input.kind === "fork" && this.permissionModes) {
      const reset = await opened.value.execute({
        type: "permissionMode.select",
        permissionModeId: this.permissionModes.defaultModeId,
      });
      this.forkedWithDefault = reset.ok;
    }
    return opened;
  }
}
