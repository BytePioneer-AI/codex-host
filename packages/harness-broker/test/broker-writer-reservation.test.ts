import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  HarnessOutputChannel,
  type HarnessOutput,
  type HarnessSession,
  type HostCommand,
} from "@codexhost/harness-adapter";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import {
  harnessIdSchema,
  hostTurnIdSchema,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";
import { BrokeredHarnessAdapter, startHarnessBrokerServer } from "../src/index.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture value");
  return value;
}

async function fixture(writerRef: (ref: NativeSessionRef) => NativeSessionRef = (ref) => ref) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cx-reserve-"));
  const descriptorPath = path.join(root, "broker.json");
  const native = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
  const originalOpen = native.open.bind(native);
  const sessions: {
    ref: NativeSessionRef;
    channel: HarnessOutputChannel<HarnessOutput>;
    close: ReturnType<typeof vi.fn>;
  }[] = [];
  const open = vi.spyOn(native, "open").mockImplementation(async (input) => {
    const baseline = await originalOpen(input);
    if (!baseline.ok || input.kind !== "create") return baseline;
    const ref = writerRef(required(baseline.value.initialState.nativeRef));
    const channel = new HarnessOutputChannel<HarnessOutput>();
    const close = vi.fn(async () => {
      channel.end();
      await baseline.value.close();
    });
    sessions.push({ ref, channel, close });
    const session: HarnessSession = {
      harnessId: native.harnessId,
      capabilities: baseline.value.capabilities,
      initialState: {},
      nativeWriterRef: ref,
      initialUsage: null,
      outputs: channel.outputs,
      execute: vi.fn(async (command: HostCommand) => {
        if (command.type === "turn.start") return { ok: true, value: { turnId: command.turnId } };
        if (command.type === "turn.cancel")
          return { ok: true, value: { cancellationRequested: true } };
        if (command.type === "interaction.respond") return { ok: true, value: { accepted: true } };
        return { ok: true, value: { completed: true } };
      }) as HarnessSession["execute"],
      readSnapshot: async () => ({ ok: true, value: { turns: [], state: {} } }),
      close,
    };
    return { ok: true, value: session };
  });
  const server = await startHarnessBrokerServer({
    descriptorPath,
    socketPath:
      process.platform === "win32"
        ? `\\\\.\\pipe\\cx-reserve-${randomUUID()}`
        : path.join(root, "b.sock"),
    adapter: native,
  });
  const clients = [
    new BrokeredHarnessAdapter({ descriptorPath }),
    new BrokeredHarnessAdapter({ descriptorPath }),
  ] as const;
  return {
    root,
    native,
    clients,
    session: (index: number) => required(sessions[index]),
    open,
    async close() {
      await Promise.all(clients.map((client) => client.close()));
      await server.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("reserved native write identities", () => {
  it("allows concurrent independent creates without claiming durable native history", async () => {
    const f = await fixture();
    try {
      const opened = await Promise.all(
        f.clients.map((client) => client.open({ kind: "create", cwd: f.root })),
      );
      for (const result of opened) {
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error.message);
        expect(result.value.initialState.nativeRef).toBeUndefined();
      }
      const first = required(opened[0]);
      if (!first.ok) throw new Error(first.error.message);
      expect(f.session(0).ref.nativeSessionId).not.toBe(f.session(1).ref.nativeSessionId);
      await expect(
        f.clients[1].open({ kind: "resume", cwd: f.root, nativeRef: f.session(0).ref }),
      ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });
      expect(f.open).toHaveBeenCalledTimes(2);
      // A never-submitted prewarm must not prevent a second Session from executing.
      const second = required(opened[1]);
      if (!second.ok) throw new Error(second.error.message);
      await expect(
        second.value.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("second-turn"),
          input: [],
        }),
      ).resolves.toMatchObject({ ok: true });
      await first.value.close();
      await expect(
        f.clients[1].open({ kind: "resume", cwd: f.root, nativeRef: f.session(0).ref }),
      ).resolves.toMatchObject({ ok: true });
    } finally {
      await f.close();
    }
  });

  it("waits for an in-flight create to disclose its identity instead of rejecting another create", async () => {
    const f = await fixture();
    const started = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const implementation = required(f.open.getMockImplementation());
    f.open.mockImplementationOnce(async (input) => {
      started.resolve(undefined);
      await release.promise;
      return implementation(input);
    });
    try {
      const first = f.clients[0].open({ kind: "create", cwd: f.root });
      await started.promise;
      let secondSettled = false;
      const second = f.clients[1].open({ kind: "create", cwd: f.root }).then((result) => {
        secondSettled = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(secondSettled).toBe(false);
      release.resolve(undefined);
      expect((await first).ok).toBe(true);
      expect((await second).ok).toBe(true);
    } finally {
      release.resolve(undefined);
      await f.close();
    }
  });

  it("only publishes the native identity after its matching confirmation", async () => {
    const f = await fixture();
    try {
      const opened = await f.clients[0].open({ kind: "create", cwd: f.root });
      if (!opened.ok) throw new Error(opened.error.message);
      expect(opened.value.initialState.nativeRef).toBeUndefined();
      const output = opened.value.outputs[Symbol.asyncIterator]();
      const { channel, ref } = f.session(0);
      channel.emit({
        kind: "event",
        event: { type: "session.state.changed", state: { nativeRef: ref } },
      });
      expect(await output.next()).toMatchObject({
        value: { event: { type: "session.state.changed", state: { nativeRef: ref } } },
      });
      await expect(
        f.clients[1].open({ kind: "resume", cwd: f.root, nativeRef: ref }),
      ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    } finally {
      await f.close();
    }
  });

  it("faults an identity change instead of silently moving the writer reservation", async () => {
    const f = await fixture();
    try {
      const opened = await f.clients[0].open({ kind: "create", cwd: f.root });
      if (!opened.ok) throw new Error(opened.error.message);
      const output = opened.value.outputs[Symbol.asyncIterator]();
      const session = f.session(0);
      session.channel.emit({
        kind: "event",
        event: {
          type: "session.state.changed",
          state: { nativeRef: { ...session.ref, nativeSessionId: "unexpected" } },
        },
      });
      expect(await output.next()).toMatchObject({
        value: { event: { type: "session.faulted", error: { code: "protocolError" } } },
      });
      await vi.waitFor(() => expect(session.close).toHaveBeenCalled());
    } finally {
      await f.close();
    }
  });

  it("rejects a colliding reservation without closing the original writer", async () => {
    let firstRef: NativeSessionRef | undefined;
    const f = await fixture((ref) => (firstRef ??= ref));
    try {
      expect((await f.clients[0].open({ kind: "create", cwd: f.root })).ok).toBe(true);
      await expect(f.clients[1].open({ kind: "create", cwd: f.root })).resolves.toMatchObject({
        ok: false,
        error: { code: "sessionBusy" },
      });
      expect(f.session(0).close).not.toHaveBeenCalled();
      expect(f.session(1).close).toHaveBeenCalledOnce();
    } finally {
      await f.close();
    }
  });

  it("rejects a foreign reservation and releases the temporary create guard", async () => {
    let first = true;
    const f = await fixture((ref) => {
      if (!first) return ref;
      first = false;
      return { ...ref, harnessId: harnessIdSchema.parse("pi") };
    });
    try {
      await expect(f.clients[0].open({ kind: "create", cwd: f.root })).resolves.toMatchObject({
        ok: false,
        error: { code: "protocolError" },
      });
      expect(f.session(0).close).toHaveBeenCalledOnce();
      await expect(f.clients[1].open({ kind: "create", cwd: f.root })).resolves.toMatchObject({
        ok: true,
      });
    } finally {
      await f.close();
    }
  });
});
