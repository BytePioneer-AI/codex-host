import type { HarnessSession } from "@codexhost/harness-adapter";
import { hostTurnIdSchema, type HostTurnId } from "@codexhost/shared-contracts";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHarnessAdapter } from "../src/plugin.ts";
import { CodexAppServer } from "../src/rpc.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0)) await fn();
});
function fixture(scenario: object = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-local-auth-")));
  const home = join(root, ".codex");
  mkdirSync(home);
  const command = join(root, "codex");
  writeFileSync(
    command,
    `#!${process.execPath}\n${readFileSync(resolve("tests/fixtures/codex-auth-peer.cjs"), "utf8")}`,
  );
  chmodSync(command, 0o700);
  writeFileSync(join(home, "scenario.json"), JSON.stringify(scenario));
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
  return {
    adapter,
    home,
    command,
    scenario: (value: object) => writeFileSync(join(home, "scenario.json"), JSON.stringify(value)),
    methods: () =>
      readFileSync(join(home, "rpc.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).method) as string[],
  };
}
async function turn(session: HarnessSession, turnId: HostTurnId, text: string) {
  expect(
    await session.execute({ type: "turn.start", turnId, input: [{ type: "text", text }] }),
  ).toMatchObject({ ok: true });
  for await (const output of session.outputs) {
    if (output.kind === "event" && output.event.type === "turn.completed")
      return output.event.outcome;
  }
  throw Error("Missing native Turn completion");
}

it.skipIf(process.platform === "win32")(
  "uses local credentials without account preflight and returns native failure normally",
  async () => {
    const f = fixture({ requireAuth: true });
    expect((await f.adapter.inspect()).status).toBe("ready");
    expect(f.methods()).not.toContain("thread/start");
    const opened = await f.adapter.open({ kind: "create", cwd: f.home });
    if (!opened.ok) throw Error(opened.error.message);
    try {
      expect(
        await turn(opened.value, hostTurnIdSchema.parse("missing-auth"), "hello"),
      ).toMatchObject({
        status: "failed",
        error: { code: "nativeFailure", message: "Native model unauthorized" },
      });
    } finally {
      await opened.value.close();
    }
    writeFileSync(join(f.home, "authenticated.json"), "true");
    const retried = await f.adapter.open({ kind: "create", cwd: f.home });
    if (!retried.ok) throw Error(retried.error.message);
    try {
      expect(
        await turn(retried.value, hostTurnIdSchema.parse("local-auth"), "hello"),
      ).toMatchObject({ status: "succeeded" });
    } finally {
      await retried.value.close();
    }
    expect(f.methods().some((m) => m.startsWith("account/"))).toBe(false);
  },
);

const quotaScenario = {
  accountRead: {
    account: { type: "chatgpt", email: "codex@example.com", planType: "plus" },
    requiresOpenaiAuth: true,
  },
  rateLimits: {
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 40, windowDurationMins: 10_080 },
    },
  },
};

it.skipIf(process.platform === "win32")(
  "reads quota without a Thread, coalesces refreshes and limits background queries",
  async () => {
    const f = fixture(quotaScenario);
    expect(f.adapter.credits()).toBeNull();
    const [account, concurrent, credits] = await Promise.all([
      f.adapter.inspectAccount(),
      f.adapter.inspectAccount(),
      f.adapter.refreshCredits(),
    ]);
    expect(account).toMatchObject({
      email: "codex@example.com",
      plan: "plus",
      credits: { usedPercent: 25, periodType: "five_hour" },
    });
    expect(concurrent).toEqual(account);
    expect(credits).toEqual(account?.credits);
    expect(f.adapter.credits()).toEqual(credits);
    await f.adapter.refreshCredits();
    expect(f.methods()).toEqual([
      "initialize",
      "initialized",
      "account/read",
      "account/rateLimits/read",
    ]);

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 60_001);
    expect(f.adapter.credits()).toBeNull();
    expect(await f.adapter.refreshCredits()).toEqual(credits);
    expect(f.methods().filter((method) => method === "account/rateLimits/read")).toHaveLength(2);
  },
);

it.skipIf(process.platform === "win32")(
  "clears previous quota after logout, API-key login, provider changes or read failure",
  async () => {
    const f = fixture(quotaScenario);
    for (const scenario of [
      {},
      { accountRead: { account: { type: "apiKey" }, requiresOpenaiAuth: true } },
      { accountRead: { ...quotaScenario.accountRead, requiresOpenaiAuth: false } },
      { ...quotaScenario, rateLimits: { rateLimits: null } },
      { ...quotaScenario, quotaError: true },
    ]) {
      f.scenario(quotaScenario);
      expect(await f.adapter.inspectAccount()).not.toBeNull();
      f.scenario(scenario);
      expect(await f.adapter.inspectAccount()).toBeNull();
      expect(f.adapter.credits()).toBeNull();
    }
    const other = fixture();
    expect(await other.adapter.inspectAccount()).toBeNull();
    expect(other.adapter.credits()).toBeNull();
  },
);

it.skipIf(process.platform === "win32")(
  "closes an in-flight quota process and keeps the cache empty after close",
  async () => {
    const f = fixture({ ...quotaScenario, quotaWaitFile: "never" });
    const pending = f.adapter.inspectAccount();
    await expect.poll(() => f.methods().includes("account/rateLimits/read")).toBe(true);
    await f.adapter.close();
    expect(await pending).toBeNull();
    expect(f.adapter.credits()).toBeNull();
    expect(await f.adapter.refreshCredits()).toBeNull();
    expect(await f.adapter.inspectAccount()).toBeNull();
    expect(f.methods().filter((method) => method === "initialize")).toHaveLength(1);
  },
);

it.skipIf(process.platform === "win32")(
  "coalesces model inspections by workspace and closes native processes",
  async () => {
    const f = fixture({ modelWaitFile: "release" });
    const pending = f.adapter.inspect({ cwd: f.home });
    const concurrent = f.adapter.inspect({ cwd: f.home });
    await expect.poll(() => f.methods().filter((m) => m === "model/list").length).toBe(1);
    writeFileSync(join(f.home, "release"), "yes");
    expect((await Promise.all([pending, concurrent])).map((v) => v.status)).toEqual([
      "ready",
      "ready",
    ]);
    expect(f.methods().some((m) => m.startsWith("account/"))).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "bounds model control requests and closes in-flight inspections",
  async () => {
    const f = fixture({ modelWaitFile: "never" });
    const server = new CodexAppServer({
      command: f.command,
      environment: { ...process.env, CODEX_HOME: f.home },
      requestTimeoutMs: 1000,
    });
    try {
      await server.initialize();
      await expect(server.request("model/list", {})).rejects.toThrow("timed out");
    } finally {
      await server.close();
    }
    const pending = f.adapter.inspect();
    await expect.poll(() => f.methods().filter((m) => m === "model/list").length).toBe(2);
    await f.adapter.close();
    expect((await pending).status).toBe("unavailable");
    expect((await f.adapter.inspect()).status).toBe("unavailable");
  },
);
