import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import { harnessIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { BrokeredHarnessAdapter, startHarnessBrokerServer } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cx-fork-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const descriptorPath = path.join(root, "broker.json");
  const native = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
  const open = vi.spyOn(native, "open");
  const server = await startHarnessBrokerServer({
    descriptorPath,
    socketPath:
      process.platform === "win32"
        ? `\\\\.\\pipe\\cx-fork-${randomUUID()}`
        : path.join(root, "b.sock"),
    adapter: native,
  });
  cleanups.push(() => server.close());
  const client = new BrokeredHarnessAdapter({ descriptorPath });
  const otherClient = new BrokeredHarnessAdapter({ descriptorPath });
  cleanups.push(() => Promise.all([client.close(), otherClient.close()]).then(() => undefined));
  const opened = await client.open({ kind: "create", cwd: root });
  if (!opened.ok) throw new Error(opened.error.message);
  const source = opened.value;
  await source.execute({
    type: "turn.start",
    turnId: hostTurnIdSchema.parse("source-turn-1"),
    input: [{ type: "text", text: "hello" }],
  });
  const nativeSource = native.sessions[0];
  if (!nativeSource) throw new Error("Missing native source Session");
  nativeSource.succeedTurn();
  const sourceRef = source.initialState.nativeRef;
  const checkpoint = nativeSource.persistedSnapshot().turns[0]?.checkpoint;
  if (!sourceRef || !checkpoint) throw new Error("Missing source Fork identity");
  return {
    root,
    native,
    nativeSource,
    open,
    client,
    otherClient,
    source,
    fork: { kind: "fork" as const, cwd: root, sourceRef, checkpoint },
  };
}

it.each([false, true])(
  "forks an open source with a later Turn running=%s without releasing either writer",
  async (running) => {
    const f = await fixture();
    const sourceClose = vi.spyOn(f.nativeSource, "close");
    if (running) {
      await f.source.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("source-turn-2"),
        input: [{ type: "text", text: "continue" }],
      });
    }
    const forked = await f.client.open(f.fork);
    expect(forked.ok).toBe(true);
    if (!forked.ok) throw new Error(forked.error.message);
    expect(f.open).toHaveBeenLastCalledWith(f.fork);
    const derivedRef = forked.value.initialState.nativeRef;
    if (!derivedRef) throw new Error("Missing derived Session identity");
    expect(derivedRef.nativeSessionId).not.toBe(f.fork.sourceRef.nativeSessionId);
    const snapshot = await forked.value.readSnapshot();
    if (!snapshot.ok) throw new Error(snapshot.error.message);
    expect(snapshot.value.turns).toHaveLength(1);
    for (const nativeRef of [f.fork.sourceRef, derivedRef]) {
      await expect(
        f.otherClient.open({ kind: "resume", cwd: f.root, nativeRef }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "sessionBusy" },
      });
    }
    await forked.value.close();
    await expect(
      f.otherClient.open({ kind: "resume", cwd: f.root, nativeRef: f.fork.sourceRef }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    expect(sourceClose).not.toHaveBeenCalled();
    if (running) f.nativeSource.succeedTurn();
    await expect(
      f.source.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("source-next"),
        input: [{ type: "text", text: "next" }],
      }),
    ).resolves.toMatchObject({ ok: true });
    f.nativeSource.succeedTurn();
  },
);

it("preserves the source writer after a failed Fork and allows a subsequent valid Fork", async () => {
  const f = await fixture();
  await expect(
    f.client.open({
      ...f.fork,
      checkpoint: { ...f.fork.checkpoint, checkpointId: "missing" },
    }),
  ).resolves.toMatchObject({ ok: false, error: { code: "checkpointNotFound" } });
  await expect(
    f.otherClient.open({ kind: "resume", cwd: f.root, nativeRef: f.fork.sourceRef }),
  ).resolves.toMatchObject({
    ok: false,
    error: { code: "sessionBusy" },
  });
  await expect(f.client.open(f.fork)).resolves.toMatchObject({ ok: true });
});

it("still rejects a Fork that would claim the source's existing write identity", async () => {
  const f = await fixture();
  const colliding = new FakeHarnessSession(
    f.native.harnessId,
    f.native.catalog,
    undefined,
    f.fork.sourceRef,
  );
  const close = vi.spyOn(colliding, "close");
  const sourceClose = vi.spyOn(f.nativeSource, "close");
  f.open.mockResolvedValueOnce({ ok: true, value: colliding });
  await expect(f.client.open(f.fork)).resolves.toMatchObject({
    ok: false,
    error: { code: "sessionBusy" },
  });
  expect(close).toHaveBeenCalledOnce();
  expect(sourceClose).not.toHaveBeenCalled();
  await expect(
    f.otherClient.open({ kind: "resume", cwd: f.root, nativeRef: f.fork.sourceRef }),
  ).resolves.toMatchObject({
    ok: false,
    error: { code: "sessionBusy" },
  });
});
