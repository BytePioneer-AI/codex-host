import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HarnessSession, HarnessOutput, HostEvent } from "@codexhost/harness-adapter";
import {
  hostTurnIdSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { TraeAdapter } from "../src/adapter.js";
import { modelRef } from "../src/configuration.js";
import { createTraeInstallation } from "../src/installation.js";

let dir: string;
let command: string;
let environment: NodeJS.ProcessEnv;
const adapters: TraeAdapter[] = [];
function adapter(extra: NodeJS.ProcessEnv = {}) {
  const a = new TraeAdapter({
    command,
    environment: { ...environment, ...extra },
    timeoutMs: 10000,
  });
  adapters.push(a);
  return a;
}
async function logs() {
  return (await readFile(String(environment.TRAE_TEST_LOG), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
async function open(a = adapter(), input = {}) {
  const result = await a.open({ kind: "create", cwd: dir, ...input });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
function observe(session: HarnessSession) {
  const outputs: HarnessOutput[] = [];
  const done = (async () => {
    for await (const output of session.outputs) outputs.push(output);
  })();
  return {
    outputs,
    done,
    events: () => outputs.flatMap((o) => (o.kind === "event" ? [o.event] : [])),
  };
}
async function until(predicate: () => boolean) {
  await expect.poll(predicate, { timeout: 5000, interval: 10 }).toBe(true);
}
let sequence = 0;
async function start(s: HarnessSession, text = "hello") {
  const turnId = hostTurnIdSchema.parse(`host-${++sequence}`);
  const r = await s.execute({ type: "turn.start", turnId, input: [{ type: "text", text }] });
  return { r, turnId };
}
function completed(events: HostEvent[]) {
  return events.filter((e) => e.type === "turn.completed");
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "trae-harness-"));
  const fixture = path.resolve("packages/adapters/trae/test/fixtures/app-server.mjs");
  command = path.join(dir, process.platform === "win32" ? "traecli.cmd" : "traecli");
  await writeFile(
    command,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
      : `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`,
    { mode: 0o755 },
  );
  environment = {
    TRAE_TEST_STORE: path.join(dir, "native-history.json"),
    TRAE_TEST_LOG: path.join(dir, "requests.jsonl"),
  };
});
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((a) => a.close()));
  await rm(dir, { recursive: true, force: true });
});

describe("Trae native app-server adapter", () => {
  it("inspects available native Models without creating history, caches by cwd and refreshes explicitly", async () => {
    const a = adapter();
    const first = await a.inspect({ cwd: dir });
    expect(first).toMatchObject({
      status: "ready",
      catalog: { models: [{ label: "Model A" }, { label: "Model B" }] },
    });
    expect(await a.inspect({ cwd: dir })).toEqual(first);
    expect((await logs()).filter((l) => l.method === "initialize")).toHaveLength(1);
    await a.inspect({ cwd: dir, refresh: true });
    const other = path.join(dir, "other");
    await mkdir(other);
    await a.inspect({ cwd: other });
    expect((await logs()).filter((l) => l.method === "initialize")).toHaveLength(3);
    expect((await logs()).some((l) => l.method.startsWith("thread/"))).toBe(false);
  });
  it.each([
    ["unauthenticated", "authenticationRequired"],
    ["empty", "configurationRequired"],
    ["malformed", "protocolError"],
  ])("classifies %s without leaking native errors", async (mode, code) => {
    expect(await adapter({ TRAE_TEST_MODE: mode }).inspect({ cwd: dir })).toMatchObject({
      status: mode === "malformed" ? "error" : "unavailable",
      error: { code },
    });
  });
  it("respects an explicit missing executable and validates cwd", async () => {
    const a = new TraeAdapter({ command: path.join(dir, "missing.exe") });
    adapters.push(a);
    expect(await a.inspect({ cwd: dir })).toMatchObject({ status: "notInstalled" });
    expect(await a.open({ kind: "create", cwd: "relative" })).toMatchObject({
      ok: false,
      error: { code: "invalidRequest" },
    });
  });
  it("lazily creates, streams Unicode, publishes durable identity, deduplicates completion and reads native history", async () => {
    const s = await open();
    const o = observe(s);
    expect(s.initialState).toEqual({});
    expect(await s.readSnapshot()).toEqual({ ok: true, value: { turns: [] } });
    expect((await logs()).some((l) => l.method === "thread/start")).toBe(false);
    const { r } = await start(s, "duplicates");
    expect(r.ok).toBe(true);
    await until(() => completed(o.events()).length === 1);
    const events = o.events();
    expect(events.filter((e) => e.type === "turn.started")).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item.updated",
        update: { type: "text.append", text: "Hello 世界" },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.usage.changed",
        usage: expect.objectContaining({ inputTokens: 8, outputTokens: 3 }),
      }),
    );
    const snap = await s.readSnapshot();
    expect(snap).toMatchObject({
      ok: true,
      value: {
        turns: [{ input: [{ text: "duplicates" }], items: [{ item: { text: "Hello 世界" } }] }],
        state: { nativeRef: { harnessId: "trae" }, effectiveModel: modelRef("model-a", "trae") },
      },
    });
    await s.close();
    await o.done;
    expect(
      await s.execute({ type: "turn.cancel", turnId: hostTurnIdSchema.parse("x") }),
    ).toMatchObject({ ok: false, error: { code: "invalidState" } });
  });
  it("rejects invalid input and native rejection without Turn events or sensitive diagnostics", async () => {
    const s = await open();
    const o = observe(s);
    expect((await start(s, " ")).r).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect((await start(s, "reject")).r).toMatchObject({
      ok: false,
      error: { code: "invalidRequest" },
    });
    const missing = (await start(s, "model-missing")).r;
    expect(missing).toMatchObject({ ok: false, error: { code: "nativeFailure" } });
    expect(JSON.stringify(missing)).not.toContain("secret-token");
    expect(o.events().filter((e) => e.type.startsWith("turn."))).toEqual([]);
    expect(JSON.stringify(o.outputs)).not.toContain("secret-token");
  });
  it("serializes Turns and waits for native cancellation before accepting the next one", async () => {
    const s = await open();
    const o = observe(s);
    const { turnId } = await start(s, "hang");
    expect((await start(s)).r).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    expect(
      await s.execute({ type: "turn.cancel", turnId: hostTurnIdSchema.parse("wrong") }),
    ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect(await s.execute({ type: "turn.cancel", turnId })).toMatchObject({ ok: true });
    expect(completed(o.events())).toHaveLength(0);
    await until(() => completed(o.events()).length === 1);
    expect(completed(o.events())[0]).toMatchObject({ outcome: { status: "cancelled" } });
    expect((await start(s)).r.ok).toBe(true);
    await until(() => completed(o.events()).length === 2);
  });
  it.each(["approval", "question"])(
    "round-trips a native %s request, rejects wrong responses and closes it",
    async (prompt) => {
      const s = await open();
      const o = observe(s);
      await start(s, prompt);
      await until(() => o.outputs.some((o) => o.kind === "interaction"));
      const output = o.outputs.find((o) => o.kind === "interaction");
      if (output?.kind !== "interaction") throw new Error("missing interaction");
      const interactionId = output.interaction.interactionId;
      expect(
        await s.execute({
          type: "interaction.respond",
          interactionId,
          response: { type: "approval", actionId: "wrong" },
        }),
      ).toMatchObject({ ok: false });
      const response =
        prompt === "approval"
          ? { type: "approval" as const, actionId: "accept" }
          : { type: "question" as const, answers: { q1: ["A"] } };
      expect(
        await s.execute({ type: "interaction.respond", interactionId, response }),
      ).toMatchObject({ ok: true });
      await until(() => completed(o.events()).length === 1);
      expect(o.events()).toContainEqual(
        expect.objectContaining({ type: "interaction.closed", reason: "responded" }),
      );
      expect(
        await s.execute({ type: "interaction.respond", interactionId, response }),
      ).toMatchObject({ ok: false });
    },
  );
  it("stages draft configuration, confirms native effective state, switches Models during a Turn and refuses unsupported Thinking", async () => {
    const s = await open();
    const o = observe(s);
    expect(
      await s.execute({
        type: "thinking.select",
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      }),
    ).toMatchObject({ ok: true });
    expect(o.events()).toEqual([]);
    await start(s, "hang");
    expect(o.events()).toContainEqual(
      expect.objectContaining({
        type: "session.state.changed",
        state: expect.objectContaining({ effectiveThinkingOptionId: "high" }),
      }),
    );
    expect(
      await s.execute({ type: "model.select", model: modelRef("model-b", "trae") }),
    ).toMatchObject({ ok: true });
    expect(
      o
        .events()
        .filter((e) => e.type === "session.state.changed")
        .at(-1),
    ).toMatchObject({
      state: { effectiveModel: modelRef("model-b", "trae"), availableThinkingOptions: [] },
    });
    expect(
      await s.execute({
        type: "thinking.select",
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      }),
    ).toMatchObject({ ok: false });
    expect(await s.execute({ type: "model.select", model: modelRef("unknown") })).toMatchObject({
      ok: false,
    });
  });
  it("enforces unattended access only after native confirmation and rejects a conflicting permission mode", async () => {
    const a = adapter();
    expect(
      await a.open({
        kind: "create",
        cwd: dir,
        executionPolicy: "unattended-full-access",
        permissionModeId: harnessPermissionModeIdSchema.parse("read-only"),
      }),
    ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    const s = await open(a, { executionPolicy: "unattended-full-access" });
    const o = observe(s);
    await start(s);
    await until(() => completed(o.events()).length === 1);
    expect(o.events()).toContainEqual(
      expect.objectContaining({
        type: "session.state.changed",
        state: expect.objectContaining({ effectivePermissionModeId: "full-access" }),
      }),
    );
    const no = await open(adapter({ TRAE_TEST_MODE: "ignore-permission" }), {
      executionPolicy: "unattended-full-access",
    });
    expect((await start(no)).r).toMatchObject({
      ok: false,
      error: { code: "configurationRequired" },
    });
    expect((await start(no, "retry")).r).toMatchObject({
      ok: false,
      error: { code: "configurationRequired" },
    });
  });
  it("resumes exact identity, propagates Session environment and derives exact Fork/rollback without changing the source", async () => {
    const a = adapter();
    const s = await open(a);
    const o = observe(s);
    await start(s, "first");
    await until(() => completed(o.events()).length === 1);
    await start(s, "second");
    await until(() => completed(o.events()).length === 2);
    const snap = await s.readSnapshot();
    if (!snap.ok || !snap.value.state?.nativeRef) throw new Error("missing ref");
    const ref = snap.value.state.nativeRef;
    const cp = snap.value.turns[0]?.checkpoint;
    if (!cp) throw new Error("missing checkpoint");
    await s.close();
    const resumed = await a.open({
      kind: "resume",
      nativeRef: ref,
      cwd: dir,
      environment: { TRAE_TEST_MARKER: "session-wins" },
    });
    expect(resumed).toMatchObject({ ok: true, value: { initialState: { nativeRef: ref } } });
    if (resumed.ok) await resumed.value.close();
    const fork = await a.open({ kind: "fork", sourceRef: ref, checkpoint: cp, cwd: dir });
    expect(fork.ok).toBe(true);
    if (fork.ok) {
      expect(fork.value.initialState.nativeRef?.nativeSessionId).not.toBe(ref.nativeSessionId);
      expect(await fork.value.readSnapshot()).toMatchObject({
        ok: true,
        value: { turns: [expect.objectContaining({ input: [{ type: "text", text: "first" }] })] },
      });
    }
    const rollback = await a.open({ kind: "rollbackLastTurn", sourceRef: ref, cwd: dir });
    expect(rollback.ok).toBe(true);
    if (rollback.ok)
      expect(await rollback.value.readSnapshot()).toMatchObject({
        ok: true,
        value: { turns: [expect.objectContaining({ input: [{ type: "text", text: "first" }] })] },
      });
    const source = JSON.parse(await readFile(String(environment.TRAE_TEST_STORE), "utf8"));
    expect(source[ref.nativeSessionId].turns).toHaveLength(2);
    expect(
      (await logs()).find((l) => l.method === "thread/resume" && l.marker === "session-wins"),
    ).toBeTruthy();
    const foreign = nativeSessionRefSchema.parse({ ...ref, harnessId: "pi" });
    expect(await a.open({ kind: "resume", nativeRef: foreign, cwd: dir })).toMatchObject({
      ok: false,
      error: { code: "invalidRequest" },
    });
  });
  it("settles one failed Turn and faults on a native process crash; closes idempotently", async () => {
    const a = adapter();
    const s = await open(a);
    const o = observe(s);
    await start(s, "crash");
    await until(() => o.events().some((e) => e.type === "session.faulted"));
    await o.done;
    expect(completed(o.events())).toHaveLength(1);
    expect(completed(o.events())[0]).toMatchObject({ outcome: { status: "failed" } });
    expect((await start(s)).r).toMatchObject({ ok: false, error: { code: "invalidState" } });
    await Promise.all([a.close(), a.close(), s.close()]);
    expect(await a.inspect({ cwd: dir })).toMatchObject({
      status: "error",
      error: { code: "invalidState" },
    });
  });
  it("rejects an inexact native Fork and leaves the source unchanged", async () => {
    const s = await open();
    const o = observe(s);
    await start(s, "one");
    await until(() => completed(o.events()).length === 1);
    await start(s, "two");
    await until(() => completed(o.events()).length === 2);
    const snap = await s.readSnapshot();
    if (!snap.ok || !snap.value.state?.nativeRef || !snap.value.turns[0]?.checkpoint)
      throw new Error("missing history");
    const sourceRef = snap.value.state.nativeRef;
    const checkpoint = snap.value.turns[0].checkpoint;
    await s.close();
    expect(
      await adapter({ TRAE_TEST_MODE: "bad-fork" }).open({
        kind: "fork",
        sourceRef,
        checkpoint,
        cwd: dir,
      }),
    ).toMatchObject({ ok: false, error: { code: "protocolError" } });
    const store = JSON.parse(await readFile(String(environment.TRAE_TEST_STORE), "utf8"));
    expect(store[sourceRef.nativeSessionId].turns).toHaveLength(2);
  });
  it("offers native manual update guidance without invoking an updater", async () => {
    const install = createTraeInstallation(environment, command);
    expect(await install("check")).toMatchObject({
      currentVersion: "0.213.1",
      canUpdate: false,
      latestVersionKind: "unknown",
    });
    await expect(install("update")).rejects.toThrow("traecli update");
  });
  it("observes a native autonomous Turn without duplicating its start or completion", async () => {
    const s = await open();
    const o = observe(s);
    await start(s, "autonomous");
    await until(() => completed(o.events()).length === 2);
    expect(o.events().filter((e) => e.type === "turn.started")).toHaveLength(1);
    expect(o.events().filter((e) => e.type === "turn.autonomous.started")).toHaveLength(1);
  });
  it("refuses an unconfirmed Model without sending the prompt", async () => {
    const s = await open(adapter({ TRAE_TEST_MODE: "ignore-model" }), {
      model: modelRef("model-b", "trae"),
    });
    const o = observe(s);
    expect((await start(s)).r).toMatchObject({
      ok: false,
      error: { code: "configurationRequired" },
    });
    expect((await logs()).some((l) => l.method === "turn/start")).toBe(false);
    expect(o.events().filter((e) => e.type === "turn.started")).toHaveLength(0);
  });
  it("closes a pending handshake and terminates outputs while a Turn waits for input", async () => {
    const a = adapter({ TRAE_TEST_MODE: "hang-handshake" });
    const inspecting = a.inspect({ cwd: dir });
    await expect
      .poll(async () => {
        try {
          return (await logs()).some((l) => l.method === "initialize");
        } catch {
          return false;
        }
      })
      .toBe(true);
    await a.close();
    expect(await inspecting).toMatchObject({ status: "error" });
    const s = await open();
    const o = observe(s);
    await start(s, "approval");
    await until(() => o.outputs.some((o) => o.kind === "interaction"));
    await s.close();
    await o.done;
    expect(o.events()).toContainEqual(
      expect.objectContaining({ type: "interaction.closed", reason: "cancelled" }),
    );
    expect(completed(o.events())).toHaveLength(1);
  });
});
