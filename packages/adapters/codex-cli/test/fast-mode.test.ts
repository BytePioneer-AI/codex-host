import type { HarnessOutput, HarnessSession, OpenSessionInput } from "@codexhost/harness-adapter";
import {
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  hostTurnIdSchema,
  type HarnessModelRef,
} from "@codexhost/shared-contracts";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarnessAdapter } from "../src/plugin.ts";
import { codexFastModel, type CodexModel } from "../src/model-selection.ts";

const base: CodexModel = {
  id: "native-model",
  displayName: "Native Model",
  hidden: false,
  isDefault: true,
  supportedReasoningEfforts: [{ reasoningEffort: "high" }],
  defaultReasoningEffort: "high",
  serviceTiers: [{ id: "priority", name: "Fast", description: "Increased usage" }],
};
const plain = harnessModelRefSchema.parse({ id: base.id });
const fast = harnessModelRefSchema.parse(codexFastModel(base));
const legacy = { ...base };
delete legacy.serviceTiers;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture(initial: Record<string, unknown> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-fast-")));
  const home = join(root, ".codex");
  mkdirSync(home);
  const command = join(root, "codex");
  writeFileSync(
    command,
    `#!${process.execPath}\n${readFileSync(resolve("tests/fixtures/codex-auth-peer.cjs"), "utf8")}`,
  );
  chmodSync(command, 0o700);
  const scenario = (value: Record<string, unknown>) =>
    writeFileSync(join(home, "scenario.json"), JSON.stringify({ models: [base], ...value }));
  scenario(initial);
  const adapter = createHarnessAdapter({
    platform: process.platform,
    managedRemoteHost: false,
    launchCommand: command,
    environment: { HOME: root, CODEX_HOME: home },
  });
  cleanups.push(async () => {
    await adapter.close();
    rmSync(root, { recursive: true, force: true });
  });
  const records = () =>
    readFileSync(join(home, "rpc.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
  const open = async (
    input: Omit<Extract<OpenSessionInput, { kind: "create" }>, "cwd"> = { kind: "create" },
  ) => {
    const result = await adapter.open({ cwd: home, ...input });
    if (!result.ok) throw new Error(result.error.message);
    return track(result.value);
  };
  function track(session: HarnessSession) {
    const outputs: HarnessOutput[] = [];
    const consuming = (async () => {
      for await (const output of session.outputs) outputs.push(output);
    })();
    cleanups.push(async () => {
      await session.close();
      await consuming;
    });
    return { session, outputs };
  }
  return { adapter, home, records, scenario, open, track };
}

async function state(session: HarnessSession) {
  const result = await session.readSnapshot();
  if (!result.ok) throw new Error(result.error.message);
  return result.value.state;
}

async function select(session: HarnessSession, model: HarnessModelRef) {
  return session.execute({ type: "model.select", model });
}

async function turn(session: HarnessSession, outputs: HarnessOutput[], id: string) {
  expect(
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse(id),
      input: [{ type: "text", text: "hello" }],
    }),
  ).toMatchObject({ ok: true });
  await expect
    .poll(() =>
      outputs.some(
        (output) =>
          output.kind === "event" &&
          output.event.type === "turn.completed" &&
          output.event.turnId === id,
      ),
    )
    .toBe(true);
}

// The fixture is an executable Node script, like the existing native-process suite.
describe.skipIf(process.platform === "win32")("Codex native Fast service tier", () => {
  it("advertises only native priority tiers, without name heuristics or legacy guesses", async () => {
    const f = fixture({
      models: [
        base,
        { ...base, id: "standard", isDefault: false, serviceTiers: [] },
        {
          ...base,
          id: "flex",
          isDefault: false,
          serviceTiers: [{ id: "flex", name: "Fast", description: "" }],
        },
        { ...legacy, id: "legacy-gpt", isDefault: false, additionalSpeedTiers: ["fast"] },
      ],
    });
    const inspected = await f.adapter.inspect();
    if (inspected.status !== "ready") throw new Error("Inspection failed");
    expect(inspected.catalog.models.map((model) => model.fastModel)).toEqual([
      fast,
      undefined,
      undefined,
      undefined,
    ]);
    expect(inspected.catalog.defaultModel).toEqual(plain);
    expect(f.records().map((record) => record.method)).not.toContain("thread/start");
    f.scenario({ models: [{ ...base, defaultServiceTier: "priority" }] });
    const refreshed = await f.adapter.inspect({ refresh: true });
    expect(refreshed.status === "ready" && refreshed.catalog.defaultModel).toEqual(fast);
  });

  it("keeps ordinary selections working on app-servers without service-tier metadata", async () => {
    const f = fixture({ models: [legacy], omitServiceTier: true });
    const { session, outputs } = await f.open();
    expect(await select(session, plain)).toMatchObject({ ok: true });
    await turn(session, outputs, "legacy");
    expect(f.records().some((r) => r.method === "thread/settings/update")).toBe(false);
    expect(f.records().find((r) => r.method === "turn/start")?.params).not.toHaveProperty(
      "serviceTier",
    );
    expect(await select(session, fast)).toMatchObject({ ok: false });
  });

  for (const settingsEventFirst of [false, true]) {
    it(`creates and toggles Fast through native confirmation (event first: ${settingsEventFirst})`, async () => {
      const f = fixture({ settingsEventFirst });
      const { session, outputs } = await f.open({
        kind: "create",
        model: fast,
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      });
      expect(session.initialState.effectiveModel).toEqual(fast);
      expect(f.records().find((r) => r.method === "thread/start")?.params).toMatchObject({
        model: base.id,
        serviceTier: "priority",
      });
      await turn(session, outputs, "fast-on");
      f.scenario({
        settingsEventFirst,
        settingsWaitFile: "confirm",
        settingsBefore: { model: base.id, serviceTier: "priority", effort: "high" },
      });
      let settled = false;
      const pending = select(session, plain).then((result) => {
        settled = true;
        return result;
      });
      await expect
        .poll(() => f.records().filter((r) => r.method === "thread/settings/update").length)
        .toBe(1);
      expect(settled).toBe(false);
      expect((await state(session))?.effectiveModel).toEqual(fast);
      expect(
        outputs.some((o) => o.kind === "event" && o.event.type === "session.state.changed"),
      ).toBe(false);
      writeFileSync(join(f.home, "confirm"), "");
      expect(await pending).toMatchObject({ ok: true });
      expect(await state(session)).toMatchObject({
        effectiveModel: plain,
        effectiveThinkingOptionId: "high",
      });
      await turn(session, outputs, "fast-off");
      expect(f.records().find((r) => r.method === "thread/settings/update")?.params).toMatchObject({
        model: base.id,
        serviceTier: null,
        effort: "high",
      });
      expect(
        f
          .records()
          .filter((r) => r.method === "turn/start")
          .map((r) => ({ model: r.params.model, serviceTier: r.params.serviceTier })),
      ).toEqual([
        { model: base.id, serviceTier: "priority" },
        { model: base.id, serviceTier: "default" },
      ]);
      expect(await select(session, fast)).toMatchObject({ ok: true });
      expect((await state(session))?.effectiveModel).toEqual(fast);
      expect(f.records().filter((r) => r.method === "thread/start")).toHaveLength(1);
    });
  }

  it("switches during an active Turn and clears Fast when selecting another Model", async () => {
    const other = { ...base, id: "other-model", isDefault: false, serviceTiers: [] };
    const f = fixture({ models: [base, other], turnDelay: 200 });
    const { session, outputs } = await f.open({ kind: "create", model: fast });
    expect(
      await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("active"),
        input: [{ type: "text", text: "hello" }],
      }),
    ).toMatchObject({ ok: true });
    expect(await select(session, harnessModelRefSchema.parse({ id: other.id }))).toMatchObject({
      ok: true,
    });
    expect((await state(session))?.effectiveModel?.id).toBe(other.id);
    await expect
      .poll(() => outputs.some((o) => o.kind === "event" && o.event.type === "turn.completed"))
      .toBe(true);
    await turn(session, outputs, "other");
    expect(
      f
        .records()
        .filter((r) => r.method === "turn/start")
        .map((r) => [r.params.model, r.params.serviceTier]),
    ).toEqual([
      [base.id, "priority"],
      [other.id, "default"],
    ]);
  });

  it("preserves state on rejection and does not send opaque Fast refs to native model fields", async () => {
    const f = fixture({ settingsError: true });
    const { session, outputs } = await f.open({ kind: "create", model: plain });
    expect(await select(session, fast)).toMatchObject({
      ok: false,
      error: { message: "Native settings rejected" },
    });
    expect((await state(session))?.effectiveModel).toEqual(plain);
    expect(
      outputs.some((o) => o.kind === "event" && o.event.type === "session.state.changed"),
    ).toBe(false);
    expect(
      await select(session, harnessModelRefSchema.parse({ id: "codex-fast~forged" })),
    ).toMatchObject({ ok: false });
    expect(f.records().filter((r) => r.method === "thread/settings/update")).toHaveLength(1);
    await turn(session, outputs, "after-rejection");
    expect(f.records().find((r) => r.method === "turn/start")?.params).toMatchObject({
      model: base.id,
      serviceTier: "default",
    });
  });

  it("restores native Fast state and explicit on/off hints across cold resume", async () => {
    const f = fixture({ nativeServiceTier: "priority" });
    const { session } = await f.open();
    expect(session.initialState.effectiveModel).toEqual(fast);
    const nativeRef = session.initialState.nativeRef;
    if (!nativeRef) throw new Error("Missing native Session reference");
    await session.close();
    const resume = async (model?: HarnessModelRef) => {
      const result = await f.adapter.open({
        kind: "resume",
        cwd: f.home,
        nativeRef,
        ...(model ? { model } : {}),
      });
      if (!result.ok) throw new Error(result.error.message);
      return f.track(result.value).session;
    };
    const inherited = await resume();
    expect(inherited.initialState.effectiveModel).toEqual(fast);
    expect(await select(inherited, plain)).toMatchObject({ ok: true });
    await inherited.close();
    const off = await resume();
    expect(off.initialState.effectiveModel).toEqual(plain);
    await off.close();
    const on = await resume(fast);
    expect(on.initialState.effectiveModel).toEqual(fast);
    expect(on.initialState.nativeRef).toEqual(nativeRef);
    await on.close();
    const explicitOff = await resume(plain);
    expect(explicitOff.initialState.effectiveModel).toEqual(plain);
    expect(
      f
        .records()
        .filter((r) => r.method === "thread/resume")
        .map((r) => r.params.serviceTier),
    ).toEqual([undefined, undefined, "priority", null]);
  });

  it("refuses unavailable or unconfirmed Fast on open", async () => {
    const f = fixture({ models: [{ ...base, serviceTiers: [] }] });
    expect(await f.adapter.open({ kind: "create", cwd: f.home, model: fast })).toMatchObject({
      ok: false,
    });
    expect(f.records().some((r) => r.method === "thread/start")).toBe(false);
    f.scenario({ omitServiceTier: true });
    expect(await f.adapter.open({ kind: "create", cwd: f.home, model: fast })).toMatchObject({
      ok: false,
      error: { message: "Codex did not confirm the requested Fast service tier" },
    });
  });

  it.each([{ omitSettingsEvent: true }, { settingsResult: { serviceTier: "default" } }])(
    "faults and closes rather than guessing after unconfirmed settings: %j",
    async (scenario) => {
      const f = fixture(scenario);
      const { session, outputs } = await f.open({ kind: "create", model: plain });
      const original = globalThis.setTimeout;
      vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, delay, ...args) =>
        original(handler, delay === 15_000 ? 100 : delay, ...args),
      );
      expect(await select(session, fast)).toMatchObject({ ok: false });
      expect(outputs.some((o) => o.kind === "event" && o.event.type === "session.faulted")).toBe(
        true,
      );
      expect(
        outputs.some((o) => o.kind === "event" && o.event.type === "session.state.changed"),
      ).toBe(false);
      expect(await select(session, plain)).toMatchObject({
        ok: false,
        error: { code: "invalidState" },
      });
    },
  );
});
