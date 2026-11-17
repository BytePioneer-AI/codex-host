import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessOutput, HarnessSession } from "@codexhost/harness-adapter";
import {
  harnessInspectionSchema,
  hostTurnIdSchema,
  hostInteractionIdSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
} from "@codexhost/shared-contracts";
import { TraeCliAdapter } from "../src/adapter.js";
import { createHarnessAdapter } from "../src/plugin.js";
import { modelRef, thinkingRef } from "../src/configuration.js";

const owned: { root: string; adapters: TraeCliAdapter[] }[] = [];
async function fixture(scenario = "normal") {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-trae acp-"));
  const script = fileURLToPath(new URL("./fixtures/acp.mjs", import.meta.url));
  const command = path.join(root, process.platform === "win32" ? "traecli.cmd" : "traecli");
  await writeFile(
    command,
    process.platform === "win32"
      ? `@"${process.execPath}" "${script}" %*\r\n`
      : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' "$@"\n`,
    { mode: 0o755 },
  );
  const environment = {
    ...process.env,
    CODEXHOST_TRAE_CLI_COMMAND: command,
    TRAE_FIXTURE_ROOT: root,
    TRAE_FIXTURE_SCENARIO: scenario,
  };
  const adapter = new TraeCliAdapter({ environment, timeoutMs: 2_000 });
  const owners = { root, adapters: [adapter] };
  owned.push(owners);
  const audit = async () => {
    try {
      return (await readFile(path.join(root, "audit.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              method: string;
              params: Record<string, unknown>;
              pid: number;
              scope?: string;
            },
        );
    } catch {
      return [];
    }
  };
  const next = (variant = scenario) => {
    const adapter = new TraeCliAdapter({
      environment: { ...environment, TRAE_FIXTURE_SCENARIO: variant },
      timeoutMs: 2_000,
    });
    owners.adapters.push(adapter);
    return adapter;
  };
  return {
    root,
    environment,
    adapter,
    audit,
    next,
    track: (adapter: TraeCliAdapter) => owners.adapters.push(adapter),
  };
}
afterEach(async () => {
  for (const owner of owned.splice(0)) {
    await Promise.all(owner.adapters.map((adapter) => adapter.close()));
    const relative = path.relative(os.tmpdir(), owner.root);
    if (!relative.startsWith("codexhost-trae acp-") || relative.includes(path.sep))
      throw new Error("Unsafe fixture cleanup");
    await rm(owner.root, { recursive: true, force: true });
  }
});
async function open(adapter: TraeCliAdapter, cwd: string) {
  const result = await adapter.open({ kind: "create", cwd });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
const start = (id: string, text: string) => ({
  type: "turn.start" as const,
  turnId: hostTurnIdSchema.parse(id),
  input: [{ type: "text" as const, text }],
});
function outputs(session: HarnessSession) {
  const values: HarnessOutput[] = [];
  const done = (async () => {
    for await (const value of session.outputs) values.push(value);
  })();
  const wait = async (predicate: (value: HarnessOutput) => boolean) => {
    let result: HarnessOutput | undefined;
    await expect.poll(() => (result = values.find(predicate)), { timeout: 4_000 }).toBeDefined();
    if (!result) throw new Error("Expected output was not received");
    return result;
  };
  const completed = (id: string) =>
    wait(
      (value) =>
        value.kind === "event" &&
        value.event.type === "turn.completed" &&
        value.event.turnId === id,
    );
  return { values, done, wait, completed };
}

describe("TRAE CLI ACP public behavior through an owned native process", () => {
  it("inspects and caches the CLI catalog without session/new or prompt; factory update stays manual", async () => {
    const f = await fixture();
    const inspected = await f.adapter.inspect({ cwd: f.root });
    expect(harnessInspectionSchema.parse(inspected)).toMatchObject({
      status: "ready",
      catalog: {
        models: [{ ref: modelRef("provider/model-a") }, { ref: modelRef("provider/model-b") }],
      },
    });
    expect(inspected).not.toHaveProperty("catalog.defaultModel");
    const first = await f.audit();
    await f.adapter.inspect({ cwd: f.root });
    expect(await f.audit()).toEqual(first);
    await f.adapter.inspect({ cwd: f.root, refresh: true });
    const methods = (await f.audit()).map((row) => row.method);
    expect(methods.filter((method) => method === "models")).toHaveLength(2);
    expect(methods).not.toContain("session/new");
    expect(methods).not.toContain("session/prompt");
    const plugin = createHarnessAdapter({
      environment: f.environment,
      platform: process.platform,
      managedRemoteHost: false,
    });
    f.track(plugin);
    expect(await plugin.installation("check")).toMatchObject({
      currentVersion: "0.213.1",
      canUpdate: false,
      latestVersionKind: "unknown",
    });
  });
  it("returns authenticationRequired without invoking a browser or writing a Session", async () => {
    const f = await fixture("no-auth");
    expect(await f.adapter.inspect({ cwd: f.root })).toMatchObject({
      status: "unavailable",
      error: { code: "authenticationRequired" },
    });
    expect(await f.adapter.open({ kind: "create", cwd: f.root })).toMatchObject({
      ok: false,
      error: { code: "authenticationRequired" },
    });
    expect((await f.audit()).map((row) => row.method)).not.toContain("authenticate");
    expect((await f.audit()).map((row) => row.method)).not.toContain("session/new");
  });
  it("leaves prewarmed drafts uncreated, propagates Session env and makes cold replay identities stable", async () => {
    const f = await fixture();
    const opened = await f.adapter.open({
      kind: "create",
      cwd: f.root,
      model: modelRef("provider/model-b"),
      environment: { TRAE_FIXTURE_VALUE: "thread-specific" },
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value,
      out = outputs(session);
    expect(await session.readSnapshot()).toMatchObject({ ok: true, value: { turns: [] } });
    expect((await f.audit()).some((row) => row.method === "session/new")).toBe(false);
    await session.execute(start("one", "hello"));
    expect(await out.completed("one")).toMatchObject({
      event: { outcome: { status: "succeeded" } },
    });
    const before = await session.readSnapshot();
    if (!before.ok) throw new Error(before.error.message);
    expect(before.value.turns[0]).toMatchObject({
      input: [{ text: "hello" }],
      outcome: { status: "succeeded" },
      model: modelRef("provider/model-b"),
    });
    expect((await f.audit()).find((row) => row.method === "session/prompt")?.scope).toBe(
      "thread-specific",
    );
    const ref = session.initialState.nativeRef;
    if (!ref) throw new Error("Native identity was not confirmed");
    const refs = before.value.turns.map((turn) => turn.nativeTurnRef);
    await session.close();
    await out.done;
    const reopened = await f
      .next()
      .open({ kind: "resume", cwd: f.root, nativeRef: ref, knownTurnRefs: refs });
    if (!reopened.ok) throw new Error(reopened.error.message);
    const second = reopened.value,
      out2 = outputs(second),
      snapshot = await second.readSnapshot();
    if (!snapshot.ok) throw new Error(snapshot.error.message);
    expect(snapshot.value.turns[0]?.nativeTurnRef).toEqual(refs[0]);
    expect(snapshot.value.turns[0]?.items).toEqual(before.value.turns[0]?.items);
    expect(snapshot.value.turns[0]?.outcome.status).toBe("unknown");
    await second.execute(start("two", "continue"));
    expect(await out2.completed("two")).toMatchObject({
      event: { outcome: { status: "succeeded" } },
    });
    expect((await f.audit()).filter((row) => row.method === "session/prompt")).toHaveLength(2);
    await second.close();
    await out2.done;
  });
  it("projects text, tool output and confirmed diff contents rather than only a final string", async () => {
    const f = await fixture(),
      session = await open(f.adapter, f.root),
      out = outputs(session);
    await session.execute(start("tool-turn", "tool"));
    await out.completed("tool-turn");
    expect(out.values).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          type: "item.completed",
          snapshot: expect.objectContaining({
            item: expect.objectContaining({
              type: "toolExecution",
              output: { content: [{ type: "text", text: "tool-output" }] },
            }),
          }),
        }),
      }),
    );
    expect(out.values).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          type: "item.completed",
          snapshot: expect.objectContaining({
            item: expect.objectContaining({
              type: "fileChange",
              changes: [
                expect.objectContaining({
                  path: "sample.txt",
                  unifiedDiff: expect.stringContaining("+after"),
                }),
              ],
            }),
          }),
        }),
      }),
    );
    await session.close();
    await out.done;
  });
  it.each(["yes", "no"])(
    "round-trips the actual approval choice %s and rejects stale responses",
    async (actionId) => {
      const f = await fixture(),
        session = await open(f.adapter, f.root),
        out = outputs(session);
      await session.execute(start("approval", "approve"));
      const requested = await out.wait((value) => value.kind === "interaction");
      if (requested.kind !== "interaction") throw new Error("No interaction");
      expect(
        await session.execute({
          type: "interaction.respond",
          interactionId: hostInteractionIdSchema.parse("foreign"),
          response: { type: "approval", actionId },
        }),
      ).toMatchObject({ ok: false });
      const command = {
        type: "interaction.respond" as const,
        interactionId: requested.interaction.interactionId,
        response: { type: "approval" as const, actionId },
      };
      expect(await session.execute(command)).toMatchObject({ ok: true });
      expect(await session.execute(command)).toMatchObject({ ok: false });
      await out.completed("approval");
      expect((await f.audit()).find((row) => row.method === "permission-result")?.params).toEqual({
        outcome: { outcome: "selected", optionId: actionId },
      });
      await session.close();
      await out.done;
    },
  );
  it("maps supported form questions and returns the selected native value", async () => {
    const f = await fixture(),
      session = await open(f.adapter, f.root),
      out = outputs(session);
    await session.execute(start("question", "question"));
    const requested = await out.wait((value) => value.kind === "interaction");
    if (requested.kind !== "interaction") throw new Error("No question");
    expect(requested.interaction.type).toBe("question");
    expect(
      await session.execute({
        type: "interaction.respond",
        interactionId: requested.interaction.interactionId,
        response: { type: "question", answers: { colour: ["blue"] } },
      }),
    ).toMatchObject({ ok: true });
    await out.completed("question");
    expect((await f.audit()).find((row) => row.method === "question-result")?.params).toEqual({
      action: "accept",
      content: { colour: "blue" },
    });
    await session.close();
    await out.done;
  });
  it("rejects concurrent Turns, cancels only the correct Turn and continues afterward", async () => {
    const f = await fixture(),
      session = await open(f.adapter, f.root),
      out = outputs(session);
    await session.execute(start("wait-turn", "wait"));
    await expect
      .poll(async () => (await f.audit()).some((row) => row.method === "session/prompt"))
      .toBe(true);
    expect(await session.execute(start("collision", "not sent"))).toMatchObject({
      ok: false,
      error: { code: "sessionBusy" },
    });
    expect(
      await session.execute({ type: "turn.cancel", turnId: hostTurnIdSchema.parse("wrong") }),
    ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect(
      await session.execute({ type: "turn.cancel", turnId: hostTurnIdSchema.parse("wait-turn") }),
    ).toMatchObject({ ok: true });
    expect(await out.completed("wait-turn")).toMatchObject({
      event: { outcome: { status: "cancelled" } },
    });
    await session.execute(start("next", "continued"));
    expect(await out.completed("next")).toMatchObject({
      event: { outcome: { status: "succeeded" } },
    });
    await session.close();
    await out.done;
  });
  it("does not submit input when cancellation arrives during native Session creation", async () => {
    const f = await fixture("slow-new"),
      session = await open(f.adapter, f.root),
      out = outputs(session);
    await session.execute(start("early", "never send"));
    await session.execute({ type: "turn.cancel", turnId: hostTurnIdSchema.parse("early") });
    expect(await out.completed("early")).toMatchObject({
      event: { outcome: { status: "cancelled" } },
    });
    expect((await f.audit()).some((row) => row.method === "session/prompt")).toBe(false);
    await session.close();
    await out.done;
  });
  it("uses native config confirmations and replaces Thinking when a Model no longer supports it", async () => {
    const f = await fixture(),
      session = await open(f.adapter, f.root);
    expect(
      await session.execute({ type: "model.select", model: modelRef("provider/model-a") }),
    ).toMatchObject({ ok: true });
    expect(
      await session.execute({ type: "thinking.select", thinkingOptionId: thinkingRef("high") }),
    ).toMatchObject({ ok: true });
    expect(session.initialState.effectiveThinkingOptionId).toBe(thinkingRef("high"));
    expect(
      await session.execute({ type: "model.select", model: modelRef("provider/model-b") }),
    ).toMatchObject({ ok: true });
    expect(session.initialState.effectiveThinkingOptionId).toBeUndefined();
    expect(session.capabilities.configuration.selectThinkingOption).toBe(false);
    const refused = await open(f.next("refuse-config"), f.root);
    expect(
      await refused.execute({ type: "model.select", model: modelRef("provider/model-b") }),
    ).toMatchObject({ ok: false, error: { code: "protocolError" } });
    expect(refused.initialState.effectiveModel).toEqual(modelRef("provider/model-a"));
  });
  it("keeps running-Turn Model identity while accepting native next-configuration changes", async () => {
    const f = await fixture(),
      session = await open(f.adapter, f.root),
      out = outputs(session);
    await session.execute(start("active-config", "approve"));
    const requested = await out.wait((value) => value.kind === "interaction");
    if (requested.kind !== "interaction") throw new Error("No approval");
    expect(
      await session.execute({ type: "model.select", model: modelRef("provider/model-b") }),
    ).toMatchObject({ ok: true });
    expect(session.initialState.effectiveModel).toEqual(modelRef("provider/model-b"));
    await session.execute({
      type: "interaction.respond",
      interactionId: requested.interaction.interactionId,
      response: { type: "approval", actionId: "no" },
    });
    await out.completed("active-config");
    const snapshot = await session.readSnapshot();
    expect(snapshot).toMatchObject({
      ok: true,
      value: {
        turns: [{ model: modelRef("provider/model-a") }],
        state: { effectiveModel: modelRef("provider/model-b") },
      },
    });
    await session.close();
    await out.done;
  });
  it("rejects foreign workspaces and missing known history without replacement Sessions or prompts", async () => {
    const f = await fixture(),
      session = await open(f.adapter, f.root),
      out = outputs(session);
    await session.execute(start("saved", "hello"));
    await out.completed("saved");
    const ref = session.initialState.nativeRef;
    if (!ref) throw new Error("Native identity was not confirmed");
    await session.close();
    await out.done;
    expect(
      await f.next("foreign-cwd").open({ kind: "resume", cwd: f.root, nativeRef: ref }),
    ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    const bad = nativeTurnRefSchema.parse({
      harnessId: "trae-cli",
      nativeSessionId: ref.nativeSessionId,
      nativeTurnKey: "missing",
      formatVersion: 1,
    });
    expect(
      await f.next().open({ kind: "resume", cwd: f.root, nativeRef: ref, knownTurnRefs: [bad] }),
    ).toMatchObject({ ok: false, error: { code: "protocolError" } });
    expect((await f.audit()).filter((row) => row.method === "session/new")).toHaveLength(1);
    expect((await f.audit()).filter((row) => row.method === "session/prompt")).toHaveLength(1);
  });
  it("reports truncated native history instead of replacing a known snapshot with empty success", async () => {
    const f = await fixture(),
      session = await open(f.adapter, f.root),
      out = outputs(session);
    await session.execute(start("retained", "hello"));
    await out.completed("retained");
    const ref = session.initialState.nativeRef;
    if (!ref) throw new Error("Native identity was not confirmed");
    await session.close();
    await out.done;
    const current = await f.next().open({ kind: "resume", cwd: f.root, nativeRef: ref });
    if (!current.ok) throw new Error(current.error.message);
    const file = path.join(f.root, "sessions.json");
    const rows = JSON.parse(await readFile(file, "utf8"));
    rows[ref.nativeSessionId].events = [];
    await writeFile(file, JSON.stringify(rows));
    const before = await readFile(file, "utf8");
    expect(await current.value.readSnapshot()).toMatchObject({
      ok: false,
      error: { code: "protocolError" },
    });
    expect(await readFile(file, "utf8")).toBe(before);
    expect((await f.audit()).filter((row) => row.method === "session/prompt")).toHaveLength(1);
  });
  it("confirms permission changes by native readback and distinguishes missing installation", async () => {
    const f = await fixture(),
      session = await open(f.adapter, f.root);
    const { harnessPermissionModeIdSchema } = await import("@codexhost/shared-contracts");
    expect(
      await session.execute({ type: "model.select", model: modelRef("provider/model-a") }),
    ).toMatchObject({ ok: true });
    expect(
      await session.execute({
        type: "permissionMode.select",
        permissionModeId: harnessPermissionModeIdSchema.parse("bypass_permissions"),
      }),
    ).toMatchObject({ ok: true });
    expect(session.initialState.effectivePermissionModeId).toBe("bypass_permissions");
    const missing = new TraeCliAdapter({
      command: path.join(f.root, "not-installed.exe"),
      environment: f.environment,
    });
    f.track(missing);
    expect(await missing.inspect({ cwd: f.root })).toMatchObject({
      status: "notInstalled",
      error: { code: "notInstalled" },
    });
  });
  it("rejects unsupported execution policies, foreign identities and missing known history before sending input", async () => {
    const f = await fixture();
    expect(
      await f.adapter.open({
        kind: "create",
        cwd: f.root,
        executionPolicy: "unattended-full-access",
      }),
    ).toMatchObject({ ok: false, error: { code: "unsupported" } });
    const foreign = nativeSessionRefSchema.parse({
      harnessId: "pi",
      nativeSessionId: "foreign",
      formatVersion: 1,
      locator: { cwd: f.root },
    });
    expect(await f.adapter.open({ kind: "resume", cwd: f.root, nativeRef: foreign })).toMatchObject(
      { ok: false, error: { code: "invalidRequest" } },
    );
    expect(await f.audit()).toEqual([]);
  });
  it.each(["stall-init", "exit-prompt"])(
    "bounds failure and closes every owned CLI process: %s",
    async (scenario) => {
      const f = await fixture(scenario);
      if (scenario === "stall-init")
        expect(await f.adapter.inspect({ cwd: f.root })).toMatchObject({ status: "unavailable" });
      else {
        const session = await open(f.adapter, f.root),
          out = outputs(session);
        await session.execute(start("exit", "hello"));
        expect(await out.completed("exit")).toMatchObject({
          event: { outcome: { status: "failed" } },
        });
        await session.close();
        await out.done;
      }
      await f.adapter.close();
      await f.adapter.close();
      for (const pid of new Set((await f.audit()).map((row) => row.pid)))
        await expect
          .poll(() => {
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              return false;
            }
          })
          .toBe(false);
    },
  );
});
