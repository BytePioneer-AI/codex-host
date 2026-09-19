import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import { ZcodeAdapter } from "../src/adapter.js";

const adapters: ZcodeAdapter[] = [],
  roots: string[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function createFixture(profile: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "zcode-lifecycle-"));
  roots.push(root);
  const adapter = new ZcodeAdapter({
    command: path.resolve("packages/adapters/zcode/test/fixtures/app-server.cjs"),
    timeoutMs: 1000,
    environment: {
      ...process.env,
      CODEXHOST_DATA_DIR: root,
      ZCODE_FIXTURE_STORE: path.join(root, "sessions.json"),
      ZCODE_FIXTURE_DUPLICATES: "1",
      ZCODE_FIXTURE_PROFILE: profile,
    },
  });
  adapters.push(adapter);
  const opened = await adapter.open({ kind: "create", cwd: root });
  if (!opened.ok) throw new Error(JSON.stringify(opened.error));
  const session = opened.value,
    outputs: HarnessOutput[] = [];
  const ended = (async () => {
    for await (const output of session.outputs) outputs.push(output);
  })();
  return { adapter, root, session, outputs, ended };
}
describe.each(["workspace", "process"])("ZCode %s session lifecycle", (profile) => {
  const fixture = () => createFixture(profile);
  it.each(["trailing-separator", "junction"])(
    "resumes the same workspace via %s and continues writing",
    async (variant) => {
      const f = await fixture();
      const nativeRef = required(f.session.initialState.nativeRef);
      await f.session.close();
      await f.ended;
      const cwd = variant === "junction" ? path.join(f.root, "目录 Alias") : f.root + path.sep;
      if (variant === "junction") await symlink(f.root, cwd, "junction");
      const resumed = await f.adapter.open({ kind: "resume", nativeRef, cwd });
      if (!resumed.ok) throw new Error(JSON.stringify(resumed.error));
      expect(resumed.value.initialState.nativeRef?.nativeSessionId).toBe(nativeRef.nativeSessionId);
      const output: HarnessOutput[] = [];
      const ended = (async () => {
        for await (const item of resumed.value.outputs) output.push(item);
      })();
      expect(
        await resumed.value.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("after-resume"),
          input: [{ type: "text", text: "continue" }],
        }),
      ).toMatchObject({ ok: true });
      await expect
        .poll(() =>
          output.some((item) => item.kind === "event" && item.event.type === "turn.completed"),
        )
        .toBe(true);
      const snapshot = await resumed.value.readSnapshot();
      expect(snapshot.ok && snapshot.value.turns).toHaveLength(1);
      await resumed.value.close();
      await ended;
    },
  );

  it("rejects a different requested or native workspace without replacing the session", async () => {
    const f = await fixture();
    const nativeRef = required(f.session.initialState.nativeRef);
    await f.session.close();
    const other = path.join(f.root, "Other");
    await mkdir(other);
    expect(await f.adapter.open({ kind: "resume", nativeRef, cwd: other })).toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
    expect(
      await f.adapter.open({
        kind: "resume",
        nativeRef,
        cwd: f.root,
        environment: { ZCODE_FIXTURE_RESUME_WORKSPACE: other },
      }),
    ).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(await f.adapter.open({ kind: "resume", nativeRef, cwd: f.root })).toMatchObject({
      ok: true,
    });
  });

  it("buffers early notifications, deduplicates terminal events and resumes persistent identity", async () => {
    const f = await fixture(),
      turnId = hostTurnIdSchema.parse("turn");
    expect(
      await f.session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "hello" }],
      }),
    ).toMatchObject({ ok: true });
    await expect
      .poll(
        () =>
          f.outputs.filter((o) => o.kind === "event" && o.event.type === "turn.completed").length,
      )
      .toBe(1);
    expect(
      f.outputs.filter((o) => o.kind === "event" && o.event.type === "turn.started"),
    ).toHaveLength(1);
    const snapshot = await f.session.readSnapshot();
    expect(snapshot.ok && snapshot.value.turns).toHaveLength(1);
    expect(
      await f.adapter.open({
        kind: "resume",
        nativeRef: required(f.session.initialState.nativeRef),
        cwd: f.root,
      }),
    ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    await f.session.close();
    await f.ended;
    const resumed = await f.adapter.open({
      kind: "resume",
      nativeRef: required(f.session.initialState.nativeRef),
      cwd: f.root,
    });
    if (!resumed.ok) throw new Error(JSON.stringify(resumed));
    expect(await resumed.value.readSnapshot()).toEqual(snapshot);
  });
  it.each(["exit", "malformed"])(
    "settles an accepted turn exactly once on %s and closes the output stream",
    async (prompt) => {
      const f = await fixture();
      expect(
        await f.session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("failure"),
          input: [{ type: "text", text: prompt }],
        }),
      ).toMatchObject({ ok: true });
      await f.ended;
      const completed = f.outputs.filter(
        (o) => o.kind === "event" && o.event.type === "turn.completed",
      );
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({ event: { outcome: { status: "failed" } } });
      expect(
        f.outputs.filter((o) => o.kind === "event" && o.event.type === "session.faulted"),
      ).toHaveLength(1);
      expect(await f.session.readSnapshot()).toMatchObject({ ok: false });
    },
  );
  it("closes an active process, settles cancellation and permits idempotent cleanup", async () => {
    const f = await fixture();
    await f.session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("close"),
      input: [{ type: "text", text: "hang" }],
    });
    await Promise.all([f.session.close(), f.session.close()]);
    await f.ended;
    expect(
      f.outputs.filter((o) => o.kind === "event" && o.event.type === "turn.completed"),
    ).toMatchObject([{ event: { outcome: { status: "cancelled" } } }]);
  });
});

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Missing native fixture value");
  return value;
}
