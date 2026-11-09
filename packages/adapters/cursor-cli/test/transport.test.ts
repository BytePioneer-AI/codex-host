import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CursorTransport, type CursorCallbacks } from "../src/transport.js";

const state = vi.hoisted(() => ({ scenario: "normal", arguments: [] as string[][] }));
vi.mock("../src/command.js", () => ({
  cursorInvocation: (_environment: unknown, _command: unknown, args: string[]) => {
    state.arguments.push(args);
    return {
      command: process.execPath,
      arguments: [
        path.resolve("packages/adapters/cursor-cli/test/fixtures/acp.mjs"),
        state.scenario,
      ],
      windowsVerbatimArguments: false,
    };
  },
}));
const transports: CursorTransport[] = [];
const configRoots: string[] = [];
function isolatedEnvironment(
  approvalMode?: string,
): NodeJS.ProcessEnv & { CURSOR_CONFIG_DIR: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "codexhost-cursor-force-"));
  configRoots.push(root);
  if (approvalMode !== undefined) {
    mkdirSync(root, { recursive: true });
    writeFileSync(
      path.join(root, "cli-config.json"),
      JSON.stringify({ version: 1, approvalMode }),
      "utf8",
    );
  }
  return { ...process.env, CURSOR_CONFIG_DIR: root };
}
function transport(
  timeoutMs = 2_000,
  loadModelCatalog = true,
  executionPolicy?: "unattended-full-access",
  environment: NodeJS.ProcessEnv = isolatedEnvironment(),
  cwd = process.cwd(),
) {
  const result = new CursorTransport({
    cwd,
    environment,
    timeoutMs,
    loadModelCatalog,
    ...(executionPolicy ? { executionPolicy } : {}),
  });
  transports.push(result);
  return result;
}
afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
  for (const root of configRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  state.scenario = "normal";
  state.arguments = [];
});
const callbacks: CursorCallbacks = {
  update: () => {},
  permission: async () => ({ outcome: { outcome: "selected", optionId: "deny" } }),
  extension: async () => ({ outcome: { outcome: "cancelled" } }),
};
describe("Cursor ACP process boundary", () => {
  it("uses real stdio framing for handshake, native permission and terminal response", async () => {
    const native = transport();
    await native.open();
    const permission = vi.fn(callbacks.permission);
    expect(await native.prompt("synthetic", { ...callbacks, permission })).toEqual({
      stopReason: "end_turn",
    });
    expect(permission).toHaveBeenCalledTimes(1);
    await native.close();
    await native.close();
    await expect(native.prompt("closed", callbacks)).rejects.toThrow();
  });
  it("settles prompt when the owned process exits", async () => {
    state.scenario = "exit";
    const native = transport();
    await native.open();
    await expect(native.prompt("synthetic", callbacks)).rejects.toThrow();
  });
  it("bounds and closes a CLI that never initializes", async () => {
    state.scenario = "hang-startup";
    const native = transport(200);
    await expect(native.open()).rejects.toThrow(/timed out|closed/u);
    await expect(native.open()).rejects.toThrow("reopened");
  });
  it("poisons a timed-out configuration so a late response cannot affect another turn", async () => {
    state.scenario = "hang-config";
    const native = transport(1_000);
    await native.open();
    await expect(native.configure("mode", "plan")).rejects.toThrow(/timed out|closed/u);
    await expect(native.prompt("must not run", callbacks)).rejects.toThrow();
  });
});

it("reads history without waiting for a model catalog that never responds", async () => {
  state.scenario = "hang-models";
  const replay = transport(500, false);
  expect(await replay.open("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).toMatchObject({
    configOptions: [],
  });
});

it("authenticates ahead of session adoption without creating or loading a session", async () => {
  state.scenario = "prepare-once";
  const native = transport();
  await Promise.all([native.prepare(), native.prepare()]);
  expect(native.sessionId).toBe("");
  expect(await native.open()).toMatchObject({ sessionId: expect.any(String) });
  await expect(native.open()).rejects.toThrow("reopened");
});

it("reuses a matching model catalog while keeping freshly loaded configuration", async () => {
  state.scenario = "cached-models";
  const cached = [{ value: "model", name: "Model", configOptions: [] }];
  const native = new CursorTransport(
    { cwd: process.cwd(), environment: process.env, timeoutMs: 500 },
    cached,
  );
  transports.push(native);
  const info = await native.open();
  expect(info.nativeModels).toEqual(cached);
  expect(info.nativeModels).not.toBe(cached);
  expect(info.configOptions).toMatchObject([{ id: "model", currentValue: "model" }]);
});

it("refreshes a cached catalog when the native session advertises different models", async () => {
  state.scenario = "changed-models";
  const native = new CursorTransport({ cwd: process.cwd(), environment: process.env }, [
    { value: "removed", name: "Removed", configOptions: [] },
  ]);
  transports.push(native);
  expect((await native.open()).nativeModels).toBeUndefined();
});

it("closes a process while authentication is pending without leaving a reusable transport", async () => {
  state.scenario = "hang-auth";
  const native = transport();
  const preparing = native.prepare();
  const failed = expect(preparing).rejects.toThrow(/closed|exited/u);
  await native.close();
  await failed;
  await expect(native.open()).rejects.toThrow("reopened");
});

it("requests native Run Everything for unattended full access and for unrestricted CLI config", async () => {
  const unattended = transport(2_000, true, "unattended-full-access", isolatedEnvironment());
  await unattended.open();
  expect(state.arguments).toEqual([["--force", "acp"]]);

  const ordinary = transport(2_000, true, undefined, isolatedEnvironment());
  await ordinary.open();
  expect(state.arguments).toEqual([["--force", "acp"], ["acp"]]);

  const allowlist = transport(2_000, true, undefined, isolatedEnvironment("allowlist"));
  await allowlist.open();
  expect(state.arguments.at(-1)).toEqual(["acp"]);

  const brokenEnvironment = isolatedEnvironment();
  writeFileSync(path.join(brokenEnvironment.CURSOR_CONFIG_DIR, "cli-config.json"), "{");
  const broken = transport(2_000, true, undefined, brokenEnvironment);
  await broken.open();
  expect(state.arguments.at(-1)).toEqual(["acp"]);

  const unrestricted = transport(2_000, true, undefined, isolatedEnvironment("unrestricted"));
  await unrestricted.open();
  expect(state.arguments.at(-1)).toEqual(["--force", "acp"]);

  // Interactive unrestricted still uses Host approval UI if native approvals arrive;
  // only unattended-full-access refuses them. Spawn --force must not change that policy.
  const unattendedWithUnrestricted = transport(
    2_000,
    true,
    "unattended-full-access",
    isolatedEnvironment("unrestricted"),
  );
  await unattendedWithUnrestricted.open();
  expect(state.arguments.at(-1)).toEqual(["--force", "acp"]);
});

it.each(["CURSOR_CONFIG_DIR", "XDG_CONFIG_HOME"] as const)(
  "reads relative %s from the child cwd, not the Host cwd",
  async (variable) => {
    const root = mkdtempSync(path.join(process.cwd(), ".cursor-config-test-"));
    configRoots.push(root);
    const cwd = path.join(root, "workspace");
    mkdirSync(cwd);
    const relative = path.relative(process.cwd(), root);
    const suffix = variable === "XDG_CONFIG_HOME" ? ["cursor"] : [];
    const hostConfig = path.join(root, ...suffix, "cli-config.json");
    const childConfig = path.resolve(cwd, relative, ...suffix, "cli-config.json");
    mkdirSync(path.dirname(hostConfig), { recursive: true });
    mkdirSync(path.dirname(childConfig), { recursive: true });
    const environment = Object.freeze({
      ...process.env,
      CURSOR_CONFIG_DIR: undefined,
      XDG_CONFIG_HOME: undefined,
      [variable]: relative,
    });
    for (const mode of ["allowlist", "unrestricted"]) {
      writeFileSync(
        hostConfig,
        JSON.stringify({ approvalMode: mode === "allowlist" ? "unrestricted" : "allowlist" }),
      );
      writeFileSync(childConfig, JSON.stringify({ approvalMode: mode }));
      const native = transport(2_000, true, undefined, environment, cwd);
      await native.open();
      expect(state.arguments.at(-1)).toEqual(
        mode === "unrestricted" ? ["--force", "acp"] : ["acp"],
      );
      expect(native.options.executionPolicy).toBeUndefined();
      const permission = vi.fn(callbacks.permission);
      await native.prompt("synthetic", { ...callbacks, permission });
      expect(permission).toHaveBeenCalledTimes(1);
    }
    const unattended = transport(2_000, true, "unattended-full-access", environment, cwd);
    writeFileSync(childConfig, JSON.stringify({ approvalMode: "allowlist" }));
    await unattended.open();
    expect(state.arguments.at(-1)).toEqual(["--force", "acp"]);
    expect(unattended.options.executionPolicy).toBe("unattended-full-access");
  },
);
