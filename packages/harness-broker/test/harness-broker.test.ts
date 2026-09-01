import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HarnessOutputChannel,
  type HarnessAdapter,
  type HarnessOutput,
  type HarnessSession,
  type HostCommand,
} from "@codexhost/harness-adapter";
import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import {
  harnessIdSchema,
  harnessPermissionModeCatalogSchema,
  hostTurnIdSchema,
} from "@codexhost/shared-contracts";
import {
  BrokeredHarnessAdapter,
  HARNESS_BROKER_MAX_PENDING_REQUESTS,
  startHarnessBrokerServer,
} from "../src/index.js";

const roots: string[] = [];

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("macOS Aqua Harness broker", () => {
  it.skipIf(process.platform === "win32")(
    "refuses to replace a non-socket entry at the broker socket path",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-harness-broker-"));
      roots.push(root);
      const descriptorPath = path.join(root, "broker-v1.json");
      const socketPath = path.join(root, "broker.sock");
      await writeFile(socketPath, "user-owned-content", "utf8");
      const native = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));

      await expect(
        startHarnessBrokerServer({ descriptorPath, socketPath, adapter: native }),
      ).rejects.toThrow("must not replace a non-socket entry");
      await expect(readFile(socketPath, "utf8")).resolves.toBe("user-owned-content");
      await native.close();
    },
  );

  it("round-trips inspect, open, execute, streamed output, and close", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-harness-broker-"));
    roots.push(root);
    const descriptorPath = path.join(root, "broker-v1.json");
    const socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\codexhost-harness-broker-${process.pid}-${randomUUID()}`
        : path.join(root, "broker.sock");
    const native = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const nativeOpen = vi.spyOn(native, "open");
    const server = await startHarnessBrokerServer({ descriptorPath, socketPath, adapter: native });
    const adapter = new BrokeredHarnessAdapter({ descriptorPath });

    await expect(adapter.inspect({ cwd: root })).resolves.toMatchObject({
      status: "ready",
    });
    const opened = await adapter.open({
      kind: "create",
      cwd: root,
      environment: { ANTHROPIC_API_KEY: "must-not-cross-the-broker" },
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.error.message);
    const output = opened.value.outputs[Symbol.asyncIterator]();
    const accepted = await opened.value.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("broker-turn-1"),
      input: [{ type: "text", text: "ping" }],
    });
    expect(accepted).toEqual({ ok: true, value: { turnId: "broker-turn-1" } });
    await expect(output.next()).resolves.toMatchObject({
      done: false,
      value: { kind: "event", event: { type: "turn.started", turnId: "broker-turn-1" } },
    });
    await expect(output.next()).resolves.toMatchObject({
      done: false,
      value: { kind: "event", event: { type: "item.started", turnId: "broker-turn-1" } },
    });

    expect(native.sessions).toHaveLength(1);
    expect(native.sessions[0]?.cwd).toBe(root);
    expect(nativeOpen).toHaveBeenCalledWith({ kind: "create", cwd: root });
    await opened.value.close();
    await adapter.close();
    await server.close();
  });

  it.each([
    ["token", (descriptor: Record<string, unknown>) => ({ ...descriptor, token: "0".repeat(64) })],
    ["protocol", (descriptor: Record<string, unknown>) => ({ ...descriptor, protocolVersion: 2 })],
    [
      "generation",
      (descriptor: Record<string, unknown>) => ({ ...descriptor, generation: randomUUID() }),
    ],
  ])("fails closed for a descriptor with the wrong %s", async (_field, mutate) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-harness-broker-"));
    roots.push(root);
    const descriptorPath = path.join(root, "broker-v1.json");
    const socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\codexhost-harness-broker-${process.pid}-${randomUUID()}`
        : path.join(root, "broker.sock");
    const native = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const server = await startHarnessBrokerServer({ descriptorPath, socketPath, adapter: native });
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(descriptorPath, `${JSON.stringify(mutate(descriptor))}\n`, "utf8");
    const adapter = new BrokeredHarnessAdapter({ descriptorPath });

    const inspection = await adapter.inspect();
    expect(inspection).toMatchObject({
      status: "unavailable",
      error: { code: "unavailable", stage: "harnessBroker" },
    });
    if (inspection.status === "unavailable") {
      expect(inspection.error.message).not.toContain(String(descriptor.token));
      expect(inspection.error.message).not.toContain("0".repeat(64));
    }
    await adapter.close();
    await server.close();
  });

  it("fail-closes before processing a packed frame batch beyond the server queue cap", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-harness-broker-"));
    roots.push(root);
    const descriptorPath = path.join(root, "broker-v1.json");
    const socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\codexhost-harness-broker-${process.pid}-${randomUUID()}`
        : path.join(root, "broker.sock");
    const native = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const inspect = vi.spyOn(native, "inspect");
    const server = await startHarnessBrokerServer({ descriptorPath, socketPath, adapter: native });
    const socket = net.createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const frames = [
      {
        version: 1,
        generation: server.descriptor.generation,
        sequence: 1,
        kind: "hello",
        token: server.descriptor.token,
      },
      ...Array.from({ length: HARNESS_BROKER_MAX_PENDING_REQUESTS + 1 }, (_, index) => ({
        version: 1,
        generation: server.descriptor.generation,
        sequence: index + 2,
        kind: "request",
        id: randomUUID(),
        method: "adapter.inspect",
        params: {},
      })),
    ];
    socket.write(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`);

    await closed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(inspect).not.toHaveBeenCalled();
    await server.close();
  });

  it("rejects a second writer before opening the same native Session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-harness-broker-"));
    roots.push(root);
    const descriptorPath = path.join(root, "broker-v1.json");
    const socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\codexhost-harness-broker-${process.pid}-${randomUUID()}`
        : path.join(root, "broker.sock");
    const native = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const otherCwd = path.join(root, "other-cwd");
    await mkdir(otherCwd);
    const nativeOpen = vi.spyOn(native, "open");
    const server = await startHarnessBrokerServer({ descriptorPath, socketPath, adapter: native });
    const firstAdapter = new BrokeredHarnessAdapter({ descriptorPath });
    const first = await firstAdapter.open({ kind: "create", cwd: root });
    if (!first.ok || !first.value.initialState.nativeRef) throw new Error("fixture failed to open");
    const secondAdapter = new BrokeredHarnessAdapter({ descriptorPath });

    await expect(
      secondAdapter.open({
        kind: "resume",
        cwd: otherCwd,
        nativeRef: first.value.initialState.nativeRef,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    expect(nativeOpen).toHaveBeenCalledTimes(1);

    await first.value.close();
    await firstAdapter.close();
    await secondAdapter.close();
    await server.close();
  });

  it("reserves a known native writer before awaiting the native open", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-harness-broker-"));
    roots.push(root);
    const otherCwd = path.join(root, "other-cwd");
    await mkdir(otherCwd);
    const descriptorPath = path.join(root, "broker-v1.json");
    const socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\codexhost-harness-broker-${process.pid}-${randomUUID()}`
        : path.join(root, "broker.sock");
    const native = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const seeded = await native.open({ kind: "create", cwd: root });
    const nativeRef = seeded.ok ? seeded.value.initialState.nativeRef : undefined;
    if (!nativeRef) throw new Error("fixture failed to seed a Native Session");
    const originalOpen = native.open.bind(native);
    const openStarted = deferred();
    const releaseOpen = deferred();
    const nativeOpen = vi.spyOn(native, "open").mockImplementation(async (input) => {
      if (input.kind === "resume") {
        openStarted.resolve();
        await releaseOpen.promise;
      }
      return originalOpen(input);
    });
    const server = await startHarnessBrokerServer({ descriptorPath, socketPath, adapter: native });
    const firstAdapter = new BrokeredHarnessAdapter({ descriptorPath });
    const secondAdapter = new BrokeredHarnessAdapter({ descriptorPath });

    const firstOpen = firstAdapter.open({ kind: "resume", cwd: root, nativeRef });
    await openStarted.promise;
    const secondOpen = secondAdapter.open({ kind: "resume", cwd: otherCwd, nativeRef });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(nativeOpen).toHaveBeenCalledTimes(1);
    releaseOpen.resolve();

    const first = await firstOpen;
    if (!first.ok) throw new Error(first.error.message);
    await expect(secondOpen).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    expect(nativeOpen).toHaveBeenCalledTimes(1);

    await first.value.close();
    await firstAdapter.close();
    await secondAdapter.close();
    await server.close();
  });

  it("fail-closes delayed create writes until the bootstrap turn claims native identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-harness-broker-"));
    roots.push(root);
    const otherCwd = path.join(root, "other-cwd");
    await mkdir(otherCwd);
    const descriptorPath = path.join(root, "broker-v1.json");
    const socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\codexhost-harness-broker-${process.pid}-${randomUUID()}`
        : path.join(root, "broker.sock");
    const harnessId = harnessIdSchema.parse("claude-code");
    const fixture = new FakeHarnessAdapter(harnessId);
    const model = fixture.catalog.defaultModel ?? fixture.catalog.models[0]?.ref;
    if (!model) throw new Error("fixture Model is unavailable");
    const nativeRef = {
      harnessId,
      nativeSessionId: "delayed-create-native-session",
      formatVersion: 1 as const,
    };
    const channel = new HarnessOutputChannel<HarnessOutput>();
    const baseline = new FakeHarnessSession(
      harnessId,
      fixture.catalog,
      model,
      nativeRef,
      { turns: [] },
      true,
      root,
    );
    const execute = vi.fn(async (command: HostCommand) => {
      if (command.type === "turn.start") {
        channel.emit({
          kind: "event",
          event: {
            type: "session.state.changed",
            state: { nativeRef, effectiveModel: model },
          },
        });
        channel.emit({ kind: "event", event: { type: "turn.started", turnId: command.turnId } });
        return { ok: true, value: { turnId: command.turnId } };
      }
      if (command.type === "turn.cancel") {
        return { ok: true, value: { cancellationRequested: true } };
      }
      if (command.type === "interaction.respond") {
        return { ok: true, value: { accepted: true } };
      }
      return { ok: true, value: { completed: true } };
    });
    const nativeSession: HarnessSession = {
      harnessId,
      capabilities: baseline.capabilities,
      initialState: {},
      initialUsage: null,
      outputs: channel.outputs,
      execute: execute as HarnessSession["execute"],
      readSnapshot: async () => ({ ok: true, value: { turns: [], state: { nativeRef } } }),
      close: async () => channel.end(),
    };
    const openStarted = deferred();
    const releaseOpen = deferred();
    const open = vi.fn(async () => {
      openStarted.resolve();
      await releaseOpen.promise;
      return { ok: true as const, value: nativeSession };
    });
    const native: HarnessAdapter = {
      harnessId,
      inspect: (input) => fixture.inspect(input),
      open,
      close: () => nativeSession.close(),
    };
    const server = await startHarnessBrokerServer({ descriptorPath, socketPath, adapter: native });
    const firstAdapter = new BrokeredHarnessAdapter({ descriptorPath });
    const firstOpen = firstAdapter.open({ kind: "create", cwd: root });
    await openStarted.promise;
    const secondAdapter = new BrokeredHarnessAdapter({ descriptorPath });
    const resumeWhileNativeOpenIsPending = secondAdapter.open({
      kind: "resume",
      cwd: otherCwd,
      nativeRef,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(open).toHaveBeenCalledTimes(1);
    releaseOpen.resolve();
    const first = await firstOpen;
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value.initialState.nativeRef).toBeUndefined();
    const output = first.value.outputs[Symbol.asyncIterator]();
    await expect(first.value.execute({ type: "model.select", model })).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy", stage: "harnessBroker.identity" },
    });
    expect(execute).not.toHaveBeenCalled();

    await expect(resumeWhileNativeOpenIsPending).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    await expect(secondAdapter.open({ kind: "create", cwd: otherCwd })).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    expect(open).toHaveBeenCalledTimes(1);

    await expect(
      first.value.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("bootstrap-identity-turn"),
        input: [{ type: "text", text: "claim identity" }],
      }),
    ).resolves.toEqual({ ok: true, value: { turnId: "bootstrap-identity-turn" } });
    await expect(output.next()).resolves.toMatchObject({
      value: {
        kind: "event",
        event: { type: "session.state.changed", state: { nativeRef } },
      },
    });
    await expect(
      secondAdapter.open({ kind: "resume", cwd: otherCwd, nativeRef }),
    ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    expect(open).toHaveBeenCalledTimes(1);
    await expect(first.value.execute({ type: "model.select", model })).resolves.toEqual({
      ok: true,
      value: { completed: true },
    });

    await first.value.close();
    await firstAdapter.close();
    await secondAdapter.close();
    await server.close();
  });

  it("drops delayed output from the retired generation without closing its replacement", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-harness-broker-"));
    roots.push(root);
    const descriptorPath = path.join(root, "broker-v1.json");
    const socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\codexhost-harness-broker-${process.pid}-${randomUUID()}`
        : path.join(root, "broker.sock");
    const harnessId = harnessIdSchema.parse("claude-code");
    const fixture = new FakeHarnessAdapter(harnessId);
    const nativeRef = {
      harnessId,
      nativeSessionId: "generation-race-native-session",
      formatVersion: 1 as const,
    };
    const staleGate = deferred();
    const sessions: FakeHarnessSession[] = [];
    const open = vi.fn(async () => {
      const session = new FakeHarnessSession(
        harnessId,
        fixture.catalog,
        undefined,
        nativeRef,
        { turns: [] },
        true,
        root,
      );
      if (sessions.length === 0) {
        const originalOutputs = session.outputs;
        const delayedOutputs: AsyncIterable<HarnessOutput> = {
          async *[Symbol.asyncIterator]() {
            for await (const output of originalOutputs) yield output;
            await staleGate.promise;
            yield {
              kind: "event",
              event: {
                type: "session.faulted",
                error: {
                  code: "nativeFailure",
                  message: "stale output from retired native child",
                  retryable: true,
                },
              },
            };
          },
        };
        Object.defineProperty(session, "outputs", { value: delayedOutputs, configurable: true });
      }
      sessions.push(session);
      return { ok: true as const, value: session };
    });
    const native: HarnessAdapter = {
      harnessId,
      inspect: (input) => fixture.inspect(input),
      open,
      close: async () =>
        Promise.all(sessions.map((session) => session.close())).then(() => undefined),
    };
    const server = await startHarnessBrokerServer({ descriptorPath, socketPath, adapter: native });
    const adapter = new BrokeredHarnessAdapter({ descriptorPath });
    const opened = await adapter.open({ kind: "create", cwd: root });
    if (!opened.ok) throw new Error(opened.error.message);
    const output = opened.value.outputs[Symbol.asyncIterator]();
    const firstNativeSession = sessions[0];
    if (!firstNativeSession) throw new Error("first native Session is unavailable");
    firstNativeSession.fault({
      code: "authenticationRequired",
      message: "native login changed",
      retryable: true,
    });
    await expect(output.next()).resolves.toMatchObject({
      value: { kind: "event", event: { type: "session.faulted" } },
    });

    const secondTurn = opened.value.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("generation-race-second-turn"),
      input: [{ type: "text", text: "explicit reopen" }],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(open).toHaveBeenCalledTimes(1);
    staleGate.resolve();
    await expect(secondTurn).resolves.toMatchObject({ ok: true });
    expect(open).toHaveBeenCalledTimes(2);
    const replacement = sessions[1];
    if (!replacement) throw new Error("replacement native Session is unavailable");
    replacement.succeedTurn();

    await expect(
      opened.value.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("generation-race-third-turn"),
        input: [{ type: "text", text: "replacement remains active" }],
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(open).toHaveBeenCalledTimes(2);

    await opened.value.close();
    await adapter.close();
    await server.close();
  });

  it("reopens once after a terminal authentication failure and restores selection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-harness-broker-"));
    roots.push(root);
    const descriptorPath = path.join(root, "broker-v1.json");
    const socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\codexhost-harness-broker-${process.pid}-${randomUUID()}`
        : path.join(root, "broker.sock");
    const harnessId = harnessIdSchema.parse("claude-code");
    const permissionModes = harnessPermissionModeCatalogSchema.parse({
      modes: [
        { id: "ask", label: "Ask", description: "Ask before native actions" },
        { id: "bypass", label: "Bypass", description: "Use native bypass mode" },
      ],
      defaultModeId: "ask",
    });
    const fixture = new FakeHarnessAdapter(harnessId, undefined, true, true, null, permissionModes);
    const nativeRef = {
      harnessId,
      nativeSessionId: "native-session-preserved",
      formatVersion: 1 as const,
    };
    const sessions: FakeHarnessSession[] = [];
    const open = vi.fn(async () => {
      const session = new FakeHarnessSession(
        harnessId,
        fixture.catalog,
        undefined,
        nativeRef,
        { turns: [] },
        true,
        root,
        true,
        undefined,
        null,
        permissionModes,
        permissionModes.defaultModeId,
      );
      sessions.push(session);
      return { ok: true as const, value: session };
    });
    const native: HarnessAdapter = {
      harnessId,
      inspect: (input) => fixture.inspect(input),
      open,
      close: async () =>
        Promise.all(sessions.map((session) => session.close())).then(() => undefined),
    };
    const server = await startHarnessBrokerServer({ descriptorPath, socketPath, adapter: native });
    const adapter = new BrokeredHarnessAdapter({ descriptorPath });
    const opened = await adapter.open({ kind: "create", cwd: root });
    if (!opened.ok) throw new Error(opened.error.message);
    const outputs = opened.value.outputs[Symbol.asyncIterator]();
    const selectedModel = fixture.catalog.models[1];
    const selectedThinking = fixture.catalog.thinkingOptions[1];
    const selectedPermission = permissionModes.modes[1];
    const firstNativeSession = sessions[0];
    if (!selectedModel || !selectedThinking || !selectedPermission || !firstNativeSession) {
      throw new Error("fixture selection is unavailable");
    }
    await opened.value.execute({ type: "model.select", model: selectedModel.ref });
    await opened.value.execute({
      type: "thinking.select",
      thinkingOptionId: selectedThinking.id,
    });
    await opened.value.execute({
      type: "permissionMode.select",
      permissionModeId: selectedPermission.id,
    });
    const failedTurnId = hostTurnIdSchema.parse("broker-auth-failed-turn");
    await opened.value.execute({
      type: "turn.start",
      turnId: failedTurnId,
      input: [{ type: "text", text: "first turn sees expired OAuth" }],
    });
    firstNativeSession.failTurn({
      code: "authenticationRequired",
      message: "OAuth session expired and could not be refreshed",
      retryable: true,
    });
    let observedAuthenticationTerminal = false;
    for (let index = 0; index < 10 && !observedAuthenticationTerminal; index += 1) {
      const next = await outputs.next();
      observedAuthenticationTerminal =
        !next.done &&
        next.value.kind === "event" &&
        next.value.event.type === "turn.completed" &&
        next.value.event.turnId === failedTurnId &&
        next.value.event.outcome.status === "failed" &&
        next.value.event.outcome.error.code === "authenticationRequired";
    }
    expect(observedAuthenticationTerminal).toBe(true);

    await expect(
      opened.value.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("broker-reopen-turn"),
        input: [{ type: "text", text: "resume after login" }],
      }),
    ).resolves.toEqual({ ok: true, value: { turnId: "broker-reopen-turn" } });
    expect(open).toHaveBeenCalledTimes(2);
    expect(sessions[1]?.state.nativeRef).toEqual(nativeRef);
    expect(sessions[1]?.state.effectiveModel).toEqual(selectedModel.ref);
    expect(sessions[1]?.state.effectiveThinkingOptionId).toBe(selectedThinking.id);
    expect(sessions[1]?.state.effectivePermissionModeId).toBe(selectedPermission.id);
    expect(opened.value.initialState.nativeRef).toEqual(nativeRef);

    await opened.value.close();
    await adapter.close();
    await server.close();
  });
});
