import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";

import type { InitializeResponse, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import {
  billingSourceRefSchema,
  hostTurnIdSchema,
  retainedPrewarmResultSchema,
  type BillingSourceRef,
  type RetainedPrewarmParams,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AntigravityAcpConfigOption,
  AntigravityAcpSessionOpenResult,
  AntigravityAcpTransportLike,
  AntigravityAcpTransportOptions,
  AntigravityOpenAcpSessionInput,
  AntigravityPromptResult,
  AntigravitySessionEventHandler,
} from "../src/acp-types.js";
import { AntigravityAdapter, type AntigravityAdapterOptions } from "../src/antigravity-adapter.js";
import { nativeBrainDirPath } from "../src/fork.js";

const GEMINI = "Gemini Models";
const CLAUDE = "Claude and GPT models";
const gemini = "gemini-3.8-flash";
const claude = "claude-sonnet-5-5";
const nativeAccount = { provider: "google", subject: "111111111111111111111" };
const otherNativeAccount = { provider: "google", subject: "222222222222222222222" };
const endTurn = { stopReason: "end_turn" };

function config({ bakedIn = false }: { bakedIn?: boolean } = {}): AntigravityAcpConfigOption[] {
  const models = bakedIn
    ? [`${gemini}-low`, claude, `${claude}-low`, `${claude}-high`]
    : [gemini, claude];
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      currentValue: models[0] ?? gemini,
      options: models.map((value) => ({ value, name: value })),
    },
    ...(bakedIn
      ? []
      : [
          {
            id: "thought_level",
            name: "Thinking",
            currentValue: "high",
            options: [
              { value: "low", name: "Low" },
              { value: "high", name: "High" },
            ],
          },
        ]),
  ];
}

class FakeTransport implements AntigravityAcpTransportLike {
  sessionId: string | null = null;
  isClosed = false;
  get skipPermissions() {
    return this.options.skipPermissions === true;
  }
  config = config();
  openedCatalog: AntigravityAcpSessionOpenResult["models"];
  onOpen?: () => Promise<void>;
  overrideSessionId?: string;
  handler: AntigravitySessionEventHandler | null = null;
  prompt = vi.fn<AntigravityAcpTransportLike["prompt"]>(async () => endTurn);
  steer = vi.fn<AntigravityAcpTransportLike["steer"]>(async () => {
    throw new Error("Retained prewarm must not steer");
  });
  initialize = vi.fn(async (): Promise<InitializeResponse> => ({ protocolVersion: 1 }));
  openSession = vi.fn(async (input: AntigravityOpenAcpSessionInput) => {
    await this.onOpen?.();
    this.sessionId = this.overrideSessionId ?? input.sessionId ?? randomUUID();
    return {
      opened: {
        sessionId: this.sessionId,
        ...(this.openedCatalog ? { models: this.openedCatalog } : {}),
        configOptions: this.config,
      },
    };
  });
  setMode = vi.fn(async () => {});
  setConfigOption = vi.fn(async (id: string, value: string) => {
    this.config = this.config.map((option) =>
      option.id === id ? { ...option, currentValue: value } : option,
    );
    return this.config;
  });
  setSessionEventHandler(handler: AntigravitySessionEventHandler | null) {
    this.handler = handler;
  }
  setSessionInteractionHandler =
    vi.fn<AntigravityAcpTransportLike["setSessionInteractionHandler"]>();
  cancel = vi.fn(async () => {});
  closeSession = vi.fn(async () => {});
  close = vi.fn(async () => {
    this.isClosed = true;
  });
  constructor(readonly options: AntigravityAcpTransportOptions) {}
}

const directories: string[] = [];
const adapters: AntigravityAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
  // /usage resolves when the report arrives; the fake child can still hold its cwd on Windows.
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 40 })),
  );
});

async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "agy-retained-"));
  directories.push(home);
  const storage = path.join(home, "host", "retained-antigravity");
  const windows = process.platform === "win32";
  const command = path.join(home, windows ? "agy.cmd" : "agy");
  const script = path.join(home, "usage.mjs");
  const wire = path.join(home, "usage.jsonl");
  await writeFile(
    command,
    windows
      ? `@"${process.execPath}" "${script}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
    { mode: 0o755 },
  );
  await writeFile(
    script,
    `
    import { readFileSync } from "node:fs";
    if (process.argv.slice(2).join(" ") !== "--print=/usage --output-format stream-json") process.exit(42);
    process.stdout.write(readFileSync(${JSON.stringify(wire)}, "utf8"));
  `,
  );
  const useAccount = (account: unknown, scopes: string[] = [GEMINI, CLAUDE]) =>
    writeFile(
      wire,
      `${JSON.stringify({
        event: "command_result",
        command: {
          name: "usage",
          data: {
            account,
            groups: scopes.map((name) => ({
              name,
              buckets: [{ window: "5h", remaining_fraction: 0.8 }],
            })),
          },
        },
      })}\n`,
    );
  await useAccount(nativeAccount);
  const transports: FakeTransport[] = [];
  function start(
    configure?: (transport: FakeTransport) => void,
    options: AntigravityAdapterOptions = {},
  ) {
    const adapter = new AntigravityAdapter({
      ...options,
      command,
      retainedPrewarmDirectory: storage,
      environment: { ...process.env, HOME: home, USERPROFILE: home, ...options.environment },
      createTransport(input) {
        const transport = new FakeTransport(input);
        configure?.(transport);
        transports.push(transport);
        return transport;
      },
    });
    adapters.push(adapter);
    return adapter;
  }
  async function log(id: string | null, step: number, model: string) {
    assert(id);
    const file = path.join(
      nativeBrainDirPath(id, home),
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(
      file,
      `${JSON.stringify({ type: "PLANNER_RESPONSE", status: "DONE", step_index: step, model })}\n`,
    );
    return file;
  }
  function rows() {
    const db = new DatabaseSync(path.join(storage, "sessions.sqlite"), { readOnly: true });
    try {
      return db
        .prepare(
          `SELECT source_id, scope_id, native_session_id, state, observed_models
        FROM retained_sessions ORDER BY scope_id, source_id`,
        )
        .all();
    } finally {
      db.close();
    }
  }
  return { home, script, wire, useAccount, start, transports, log, rows };
}

async function sourceOf(adapter: AntigravityAdapter): Promise<BillingSourceRef> {
  return billingSourceRefSchema.parse((await adapter.inspectAccount())?.billingSourceRef);
}

async function run(adapter: AntigravityAdapter, input: RetainedPrewarmParams) {
  const result = await adapter.runRetainedPrewarm(input);
  if (!result.ok) throw new Error(result.error.message);
  return retainedPrewarmResultSchema.parse(result.value);
}

describe("Antigravity retained quota prewarm", () => {
  it("locks Gemini and Claude to low in separate durable Sessions and closes only transports", async () => {
    const f = await fixture();
    const files: string[] = [];
    const select = (model: string, bakedIn: boolean) =>
      f.start((transport) => {
        transport.config = config({ bakedIn });
        transport.prompt.mockImplementation(async () => {
          const row = f.rows().find((row) => row.native_session_id === transport.sessionId);
          expect(row?.state).toBe("running");
          files.push(await f.log(transport.sessionId, 1, `${model}-low`));
          return endTurn;
        });
      });
    const g = select(gemini, false);
    const c = select(claude, true);
    const billingSourceRef = await sourceOf(g);
    expect(await c.inspectAccount()).toMatchObject({
      billingSourceRef,
      retainedPrewarmScopes: [GEMINI, CLAUDE],
    });
    const gr = await run(g, { billingSourceRef, scopeId: GEMINI });
    const cr = await run(c, { billingSourceRef, scopeId: CLAUDE });
    expect(gr).toMatchObject({
      status: "succeeded",
      model: gemini,
      thinkingOptionId: "low",
      modelVerification: "matched",
    });
    expect(cr).toMatchObject({
      status: "succeeded",
      scopeId: CLAUDE,
      model: claude,
      thinkingOptionId: "low",
      modelVerification: "matched",
    });
    expect(gr.nativeSessionRef).not.toEqual(cr.nativeSessionRef);
    expect(f.transports[0]?.setConfigOption.mock.calls).toEqual([
      ["model", gemini],
      ["thought_level", "low"],
    ]);
    expect(f.transports[1]?.setConfigOption.mock.calls).toEqual([["model", `${claude}-low`]]);
    expect(f.transports[0]?.options.cwd).not.toBe(f.transports[1]?.options.cwd);
    for (const transport of f.transports) {
      expect(transport.skipPermissions).toBe(false);
      expect(transport.setMode).toHaveBeenCalledExactlyOnceWith("default");
      expect(transport.openSession).toHaveBeenCalledExactlyOnceWith({
        kind: "create",
        cwd: transport.options.cwd,
      });
      expect(transport.prompt).toHaveBeenCalledExactlyOnceWith(
        [
          {
            type: "text",
            text: "[codexhost-quota-prewarm]\nReply only with OK. Do not use tools or make any changes.",
          },
        ],
        expect.any(Object),
      );
      expect(transport.close).toHaveBeenCalledTimes(1);
      expect(transport.closeSession).not.toHaveBeenCalled();
    }
    expect(f.rows().map((row) => row.observed_models)).toEqual([
      JSON.stringify([`${claude}-low`]),
      JSON.stringify([`${gemini}-low`]),
    ]);
    for (const file of files) expect(await readFile(file, "utf8")).toContain("PLANNER_RESPONSE");
  });

  it("resumes an anonymous Profile after restart even when scope casing or the optional login signal changes", async () => {
    const f = await fixture();
    await f.useAccount(undefined);
    const first = f.start((transport) => {
      transport.prompt.mockImplementation(async () => {
        await f.log(transport.sessionId, 9, claude);
        return endTurn;
      });
    });
    const billingSourceRef = await sourceOf(first);
    const initial = await run(first, { billingSourceRef, scopeId: CLAUDE });
    expect(initial).toMatchObject({ status: "succeeded", accountVerification: "unverified" });
    expect(initial).not.toHaveProperty("accountChanged");
    await first.close();
    await f.useAccount(nativeAccount, ["Claude and GPT Models"]);
    const next = f.start((transport) => {
      transport.onOpen = () => f.useAccount(nativeAccount, ["CLAUDE AND GPT MODELS"]);
    });
    const resumed = await run(next, { billingSourceRef, scopeId: CLAUDE });
    expect(resumed).toMatchObject({
      status: "succeeded",
      scopeId: CLAUDE,
      nativeSessionRef: initial.nativeSessionRef,
      modelVerification: "unavailable",
      accountVerification: "verified",
      accountChanged: false,
    });
    expect(f.transports[1]?.openSession).toHaveBeenCalledExactlyOnceWith({
      kind: "resume",
      sessionId: initial.nativeSessionRef?.nativeSessionId,
      cwd: f.transports[0]?.options.cwd,
    });
    expect(f.transports[1]?.prompt).toHaveBeenCalledTimes(1);
    expect(f.rows()).toHaveLength(1);
  });

  it.each([
    [
      "wrong catalog",
      (transport: FakeTransport) => {
        transport.openedCatalog = {
          availableModels: [{ modelId: "gemini-3-flash", name: "Gemini" }],
        };
      },
    ],
    [
      "no exact model",
      (transport: FakeTransport) => {
        assert(transport.config[0]);
        transport.config[0].options = [{ value: "gemini-3.8-flash-high", name: "High" }];
      },
    ],
    [
      "no low option",
      (transport: FakeTransport) => {
        assert(transport.config[1]);
        transport.config[1].options = [{ value: "high", name: "High" }];
      },
    ],
    [
      "wrong confirmation",
      (transport: FakeTransport) => {
        transport.setConfigOption.mockImplementation(async () =>
          transport.config.map((option) =>
            option.id === "model" ? { ...option, currentValue: claude } : option,
          ),
        );
      },
    ],
  ])("rejects %s before prompt and never replays the failed target", async (_reason, configure) => {
    const f = await fixture();
    const first = f.start(configure);
    const input = { billingSourceRef: await sourceOf(first), scopeId: GEMINI };
    const failed = await run(first, input);
    expect(failed).toMatchObject({
      status: "failed",
      modelVerification: "not-run",
      nativeSessionRef: expect.any(Object),
    });
    expect(f.transports[0]?.prompt).not.toHaveBeenCalled();
    expect(f.transports[0]?.close).toHaveBeenCalledTimes(1);
    expect(await run(f.start(), input)).toMatchObject({
      status: "blocked",
      nativeSessionRef: failed.nativeSessionRef,
    });
    expect(f.transports).toHaveLength(1);
  });

  it("advertises both scopes for a quota-only Profile without exposing its path or login metadata", async () => {
    const f = await fixture();
    const first = f.start();
    const billingSourceRef = await sourceOf(first);
    expect(billingSourceRef.id).toMatch(/^[a-f0-9]{64}$/u);
    expect(billingSourceRef.id).not.toContain(nativeAccount.subject);
    expect(await first.runRetainedPrewarm({ billingSourceRef, scopeId: "Unknown" })).toMatchObject({
      ok: false,
      error: { code: "invalidRequest" },
    });
    await f.useAccount(nativeAccount, [GEMINI, GEMINI.toLowerCase(), CLAUDE]);
    expect(await first.inspectAccount()).toMatchObject({ retainedPrewarmScopes: [CLAUDE] });
    expect(await run(first, { billingSourceRef, scopeId: GEMINI })).toMatchObject({
      status: "blocked",
    });
    for (const account of [
      undefined,
      { provider: "google", email: "example@example.test", token: "redacted" },
      { ...nativeAccount, subject: 12345 },
    ]) {
      await f.useAccount(account);
      const snapshot = await first.inspectAccount();
      expect(snapshot).toMatchObject({ billingSourceRef, retainedPrewarmScopes: [GEMINI, CLAUDE] });
      expect(snapshot).not.toHaveProperty("loginIdentity");
      expect(JSON.stringify(snapshot)).not.toContain(f.home);
    }
    expect(f.transports).toHaveLength(0);
  });

  it.each(["closed", "close rejected"] as const)(
    "does not send under a stale schedule and only releases its claim once %s",
    async (close) => {
      const f = await fixture();
      const a = f.start((transport) => {
        transport.onOpen = () => f.useAccount(otherNativeAccount);
        if (close === "close rejected")
          transport.close.mockRejectedValueOnce(new Error("native close failed"));
      });
      const billingSourceRef = await sourceOf(a);
      const stale = await run(a, { billingSourceRef, scopeId: GEMINI });
      expect(stale).toMatchObject({ status: "blocked", accountChanged: true });
      expect(f.transports[0]?.prompt).not.toHaveBeenCalled();
      const b = f.start();
      const current = await sourceOf(b);
      if (close === "close rejected") {
        expect(stale).toMatchObject({
          error: "Antigravity retained prewarm transport did not close",
          nativeSessionRef: expect.any(Object),
        });
        expect(await run(b, { billingSourceRef: current, scopeId: GEMINI })).toMatchObject({
          status: "blocked",
          nativeSessionRef: stale.nativeSessionRef,
        });
        expect(f.transports).toHaveLength(1);
        return;
      }
      expect(await run(b, { billingSourceRef: current, scopeId: GEMINI })).toMatchObject({
        status: "succeeded",
        nativeSessionRef: stale.nativeSessionRef,
        billingSourceRef: current,
      });
      expect(f.transports[1]?.openSession).toHaveBeenCalledExactlyOnceWith({
        kind: "resume",
        sessionId: stale.nativeSessionRef?.nativeSessionId,
        cwd: f.transports[0]?.options.cwd,
      });
    },
  );

  it("does not dispatch when the same account loses the requested native scope", async () => {
    const f = await fixture();
    const a = f.start((transport) => {
      transport.onOpen = () => f.useAccount(nativeAccount, [CLAUDE]);
    });
    const billingSourceRef = await sourceOf(a);
    expect(await run(a, { billingSourceRef, scopeId: GEMINI })).toMatchObject({
      status: "failed",
      error: expect.stringContaining("scope is no longer advertised"),
    });
    expect(f.transports[0]?.prompt).not.toHaveBeenCalled();
  });

  it("reuses one Session across logins without sharing request attribution", async () => {
    const f = await fixture();
    const select = () =>
      f.start((transport) => {
        transport.prompt.mockImplementation(async () => {
          await f.log(transport.sessionId, 1, gemini);
          return endTurn;
        });
      });
    const a = select();
    const aInput = { billingSourceRef: await sourceOf(a), scopeId: GEMINI };
    const aResult = await run(a, aInput);
    expect(aResult.status).toBe("succeeded");
    await a.close();

    await f.useAccount(otherNativeAccount);
    const b = select();
    const bInput = { billingSourceRef: await sourceOf(b), scopeId: GEMINI };
    expect(bInput.billingSourceRef).not.toEqual(aInput.billingSourceRef);
    expect(await run(b, aInput)).toMatchObject({
      status: "blocked",
      accountChanged: true,
    });
    expect(f.transports).toHaveLength(1);
    const bResult = await run(b, bInput);
    expect(bResult).toMatchObject({
      status: "succeeded",
      billingSourceRef: bInput.billingSourceRef,
      accountChanged: true,
      nativeSessionRef: aResult.nativeSessionRef,
    });
    expect(f.transports[1]?.openSession).toHaveBeenCalledExactlyOnceWith({
      kind: "resume",
      sessionId: aResult.nativeSessionRef?.nativeSessionId,
      cwd: f.transports[0]?.options.cwd,
    });
    await b.close();

    const restarted = select();
    expect(await sourceOf(restarted)).toEqual(bInput.billingSourceRef);
    expect(await run(restarted, bInput)).toMatchObject({
      status: "succeeded",
      accountChanged: false,
      nativeSessionRef: bResult.nativeSessionRef,
    });
    expect(f.transports[2]?.openSession).toHaveBeenCalledExactlyOnceWith({
      kind: "resume",
      sessionId: bResult.nativeSessionRef?.nativeSessionId,
      cwd: f.transports[1]?.options.cwd,
    });
    await f.useAccount(undefined);
    const anonymousRef = await sourceOf(restarted);
    expect(anonymousRef).toEqual(aInput.billingSourceRef);
    const anonymous = await run(restarted, { billingSourceRef: anonymousRef, scopeId: GEMINI });
    expect(anonymous).toMatchObject({
      status: "succeeded",
      accountVerification: "unverified",
      nativeSessionRef: aResult.nativeSessionRef,
    });
    expect(anonymous).not.toHaveProperty("accountChanged");
    expect(f.transports[3]?.openSession).toHaveBeenCalledExactlyOnceWith({
      kind: "resume",
      sessionId: aResult.nativeSessionRef?.nativeSessionId,
      cwd: f.transports[0]?.options.cwd,
    });
    await f.useAccount(nativeAccount);
    expect(await sourceOf(restarted)).toEqual(aInput.billingSourceRef);
    expect(await run(restarted, aInput)).toMatchObject({
      status: "succeeded",
      billingSourceRef: aInput.billingSourceRef,
      accountChanged: true,
      nativeSessionRef: aResult.nativeSessionRef,
    });
    expect(f.transports[4]?.openSession).toHaveBeenCalledExactlyOnceWith({
      kind: "resume",
      sessionId: aResult.nativeSessionRef?.nativeSessionId,
      cwd: f.transports[0]?.options.cwd,
    });
    expect(f.rows()).toEqual([
      expect.objectContaining({
        source_id: aInput.billingSourceRef.id,
        native_session_id: aResult.nativeSessionRef?.nativeSessionId,
        state: "succeeded",
      }),
    ]);
  });

  it("stops after the native CLI refuses to resume under the new login without creating a replacement", async () => {
    const f = await fixture();
    const a = f.start();
    const original = await run(a, { billingSourceRef: await sourceOf(a), scopeId: GEMINI });
    await a.close();
    await f.useAccount(otherNativeAccount);
    const b = f.start((transport) => {
      transport.onOpen = async () => {
        throw new Error("Native ACP rejected resume for this login");
      };
    });
    const billingSourceRef = await sourceOf(b);
    const input = { billingSourceRef, scopeId: GEMINI };
    expect(await run(b, input)).toMatchObject({
      status: "failed",
      error: "Native ACP rejected resume for this login",
      accountChanged: true,
      billingSourceRef,
      nativeSessionRef: original.nativeSessionRef,
    });
    expect(f.transports[1]?.openSession).toHaveBeenCalledExactlyOnceWith({
      kind: "resume",
      sessionId: original.nativeSessionRef?.nativeSessionId,
      cwd: f.transports[0]?.options.cwd,
    });
    expect(f.transports[1]?.prompt).not.toHaveBeenCalled();
    expect(await run(f.start(), input)).toMatchObject({
      status: "blocked",
      nativeSessionRef: original.nativeSessionRef,
    });
    expect(f.transports).toHaveLength(2);
    expect(f.rows()).toHaveLength(1);
  });

  it("keeps two Profiles with the same native login separate and rejects a stale Profile target", async () => {
    const f = await fixture();
    const first = f.start();
    const firstRef = await sourceOf(first);
    const initial = await run(first, { billingSourceRef: firstRef, scopeId: GEMINI });
    const secondHome = await mkdtemp(path.join(os.tmpdir(), "agy-other-profile-"));
    directories.push(secondHome);
    const second = f.start(undefined, {
      environment: { HOME: secondHome, USERPROFILE: secondHome },
    });
    const secondRef = await sourceOf(second);
    expect(secondRef).not.toEqual(firstRef);
    expect(await run(second, { billingSourceRef: firstRef, scopeId: GEMINI })).toMatchObject({
      status: "blocked",
      nativeSessionRef: null,
    });
    expect(f.transports).toHaveLength(1);
    const next = await run(second, { billingSourceRef: secondRef, scopeId: GEMINI });
    expect(next.status).toBe("succeeded");
    expect(next.nativeSessionRef).not.toEqual(initial.nativeSessionRef);
    expect(f.transports[1]?.openSession).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "create" }),
    );
    expect(f.rows()).toHaveLength(2);
  });

  it("fetches the new Profile's quota even within the previous Profile's cooldown", async () => {
    const f = await fixture();
    const alias = path.join(f.home, "profile");
    const other = path.join(f.home, "other");
    const kind = process.platform === "win32" ? "junction" : "dir";
    await mkdir(other);
    await symlink(f.home, alias, kind);
    const adapter = f.start(undefined, {
      environment: { HOME: alias, USERPROFILE: alias },
    });
    expect(await adapter.refreshCredits()).toMatchObject({ scope: { id: GEMINI } });
    await rename(alias, `${alias}-old`);
    await symlink(other, alias, kind);
    await f.useAccount(otherNativeAccount, [CLAUDE]);
    expect(await adapter.refreshCredits()).toMatchObject({ scope: { id: CLAUDE } });
  });

  it("does not use an old Profile's in-flight quota after the Profile moves", async () => {
    const f = await fixture();
    const alias = path.join(f.home, "profile");
    const other = path.join(f.home, "other");
    const read = path.join(f.home, "quota-read");
    const release = path.join(f.home, "quota-release");
    const kind = process.platform === "win32" ? "junction" : "dir";
    await mkdir(other);
    await symlink(f.home, alias, kind);
    await writeFile(
      f.script,
      `
      import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
      const quota = readFileSync(${JSON.stringify(f.wire)}, "utf8");
      if (!existsSync(${JSON.stringify(read)})) {
        const { promise, resolve } = Promise.withResolvers();
        const watcher = watch(${JSON.stringify(f.home)}, () => {
          if (!existsSync(${JSON.stringify(release)})) return;
          watcher.close();
          resolve();
        });
        writeFileSync(${JSON.stringify(read)}, "");
        await promise;
      }
      process.stdout.write(quota);
      `,
      "utf8",
    );
    const adapter = f.start(undefined, {
      environment: { HOME: alias, USERPROFILE: alias },
      inspectTimeoutMs: 3000,
    });
    const old = adapter.inspectAccount();
    try {
      await vi.waitFor(() => readFile(read), { timeout: 2000 });
      await rename(alias, `${alias}-old`);
      await symlink(other, alias, kind);
      await f.useAccount(otherNativeAccount, [CLAUDE]);
      expect(await adapter.refreshCredits()).toMatchObject({ scope: { id: CLAUDE } });
      expect(await adapter.inspectAccount()).toMatchObject({
        billingSourceRef: expect.any(Object),
        retainedPrewarmScopes: [CLAUDE],
      });
    } finally {
      await writeFile(release, "", "utf8");
      await expect(old).resolves.toBeNull();
    }
    expect((await adapter.refreshCredits())?.scope?.id).toBe(CLAUDE);
  }, 10_000);

  it.each(["initialize", "usage", "initialize with unconfirmed close"] as const)(
    "recovers a pre-prompt %s failure only when native closure is confirmed",
    async (failure) => {
      const f = await fixture();
      const adapter = f.start((transport) => {
        if (failure === "usage") {
          transport.onOpen = () => writeFile(f.wire, "", "utf8");
        } else {
          transport.initialize.mockRejectedValueOnce(new Error("initialize failed"));
          if (failure === "initialize with unconfirmed close")
            transport.close.mockRejectedValueOnce(new Error("close failed"));
        }
      });
      const input = { billingSourceRef: await sourceOf(adapter), scopeId: GEMINI };
      const interrupted = await run(adapter, input);
      expect(interrupted.status).toBe("failed");
      expect(f.transports[0]?.prompt).not.toHaveBeenCalled();
      expect(f.transports[0]?.close).toHaveBeenCalledTimes(1);
      await f.useAccount(nativeAccount);
      const retried = await run(f.start(), input);
      if (failure === "initialize with unconfirmed close") {
        expect(retried).toMatchObject({
          status: "blocked",
          error: "Antigravity retained prewarm transport did not close",
        });
        expect(f.transports).toHaveLength(1);
      } else {
        expect(retried.status).toBe("succeeded");
        if (failure === "usage")
          expect(retried.nativeSessionRef).toEqual(interrupted.nativeSessionRef);
        expect(f.transports[1]?.prompt).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("does not open a native Session if the Profile moves during ACP initialization", async () => {
    const f = await fixture();
    const alias = path.join(f.home, "profile");
    const other = path.join(f.home, "other");
    const kind = process.platform === "win32" ? "junction" : "dir";
    await mkdir(other);
    await symlink(f.home, alias, kind);
    const adapter = f.start(
      (transport) => {
        transport.initialize.mockImplementation(async () => {
          await rename(alias, `${alias}-old`);
          await symlink(other, alias, kind);
          return { protocolVersion: 1 };
        });
      },
      { environment: { HOME: alias, USERPROFILE: alias } },
    );
    const input = { billingSourceRef: await sourceOf(adapter), scopeId: GEMINI };
    expect(await run(adapter, input)).toMatchObject({
      status: "failed",
      nativeSessionRef: null,
      error: "The requested Antigravity Profile is no longer active",
    });
    expect(f.transports[0]?.openSession).not.toHaveBeenCalled();
    expect(await run(adapter, input)).toMatchObject({ status: "blocked" });
    expect(f.transports).toHaveLength(1);
    await rename(alias, `${alias}-other`);
    await rename(`${alias}-old`, alias);
    const restored = f.start(undefined, { environment: { HOME: alias, USERPROFILE: alias } });
    expect(await run(restored, input)).toMatchObject({ status: "succeeded" });
  });

  it("treats a Profile directory alias as the same retained identity", async () => {
    const f = await fixture();
    await f.useAccount(undefined);
    const first = f.start();
    const input = { billingSourceRef: await sourceOf(first), scopeId: GEMINI };
    const initial = await run(first, input);
    await first.close();
    const alias = path.join(f.home, "alias");
    await symlink(f.home, alias, process.platform === "win32" ? "junction" : "dir");
    const second = f.start(undefined, { environment: { HOME: alias, USERPROFILE: alias } });
    expect(await sourceOf(second)).toEqual(input.billingSourceRef);
    expect(await run(second, input)).toMatchObject({
      status: "succeeded",
      nativeSessionRef: initial.nativeSessionRef,
    });
    expect(f.rows()).toHaveLength(1);
  });

  it("cancels permission requests and leaves the retained target failed", async () => {
    const f = await fixture();
    const denied = Promise.withResolvers<RequestPermissionResponse>();
    const a = f.start((transport) => {
      transport.prompt.mockImplementation(async (_parts, handler) => {
        assert(transport.sessionId);
        const response = await handler.onPermission({
          sessionId: transport.sessionId,
          toolCall: { toolCallId: "test-tool" },
          options: [],
        });
        denied.resolve(response);
        return endTurn;
      });
    });
    const input = { billingSourceRef: await sourceOf(a), scopeId: GEMINI };
    expect(await run(a, input)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("attempted a tool or interaction"),
    });
    expect(await denied.promise).toEqual({ outcome: { outcome: "cancelled" } });
    expect(f.transports[0]?.closeSession).not.toHaveBeenCalled();
    expect(await run(f.start(), input)).toMatchObject({ status: "blocked" });
    expect(f.transports).toHaveLength(1);
  });

  it("waits for retained prewarm cleanup even when an ordinary Session close fails", async () => {
    const f = await fixture();
    const prompting = Promise.withResolvers<undefined>();
    const prompt = Promise.withResolvers<AntigravityPromptResult>();
    const release = Promise.withResolvers<undefined>();
    const adapter = f.start((transport) => {
      if (f.transports.length === 0) return;
      transport.prompt.mockImplementation(() => {
        prompting.resolve(undefined);
        return prompt.promise;
      });
      transport.close.mockReturnValueOnce(release.promise);
    });
    const opened = await adapter.open({ kind: "create", cwd: f.home });
    assert(opened.ok);
    await opened.value.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("ordinary"),
      input: [{ type: "text", text: "hello" }],
    });
    await vi.waitFor(() => expect(f.transports[0]?.prompt).toHaveBeenCalled());
    const ordinary = f.transports[0];
    assert(ordinary);
    ordinary.close.mockRejectedValueOnce(new Error("ordinary close failed"));
    const input = { billingSourceRef: await sourceOf(adapter), scopeId: GEMINI };
    const pending = run(adapter, input);
    await prompting.promise;
    const closed = adapter.close().catch((error: unknown) => ({ error, rows: f.rows() }));
    await setImmediate();
    release.resolve(undefined);
    expect(await closed).toMatchObject({
      error: new Error("ordinary close failed"),
      rows: [{ state: "failed" }],
    });
    expect(await pending).toMatchObject({ status: "failed" });
  });

  it("atomically blocks a second adapter during create and retains an unresolved create across restarts", async () => {
    const f = await fixture();
    const creating = Promise.withResolvers<undefined>();
    const lostResponse = Promise.withResolvers<undefined>();
    const a = f.start((transport) => {
      transport.onOpen = () => {
        creating.resolve(undefined);
        return lostResponse.promise;
      };
    });
    const b = f.start();
    const input = { billingSourceRef: await sourceOf(a), scopeId: GEMINI };
    const pending = run(a, input);
    await creating.promise;
    expect(f.rows()[0]).toMatchObject({ state: "creating", native_session_id: null });
    expect(await run(b, input)).toMatchObject({
      status: "blocked",
      nativeSessionRef: null,
    });
    await a.close();
    expect(await pending).toMatchObject({ status: "failed", nativeSessionRef: null });
    expect(f.rows()[0]).toMatchObject({ state: "unresolved", native_session_id: null });
    expect(await run(f.start(), input)).toMatchObject({
      status: "blocked",
      nativeSessionRef: null,
    });
    expect(f.transports).toHaveLength(1);
    expect(f.transports[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("claims a running prompt exclusively, bounds native execution, and never replays a timeout", async () => {
    const f = await fixture();
    const dispatched = Promise.withResolvers<undefined>();
    const hanging = Promise.withResolvers<AntigravityPromptResult>();
    const first = f.start(
      (transport) => {
        transport.prompt.mockImplementation(() => {
          dispatched.resolve(undefined);
          return hanging.promise;
        });
      },
      { commandTimeoutMs: 3000 },
    );
    const input = { billingSourceRef: await sourceOf(first), scopeId: GEMINI };
    const pending = run(first, input);
    await dispatched.promise;
    const concurrent = await run(f.start(), input);
    expect(concurrent).toMatchObject({ status: "blocked", nativeSessionRef: expect.any(Object) });
    const failed = await pending;
    expect(failed).toMatchObject({
      status: "failed",
      error: expect.stringContaining("timed out"),
      nativeSessionRef: concurrent.nativeSessionRef,
    });
    expect(f.transports[0]?.close).toHaveBeenCalledTimes(1);
    expect(await run(f.start(), input)).toMatchObject({
      status: "blocked",
      nativeSessionRef: failed.nativeSessionRef,
    });
    expect(f.transports).toHaveLength(1);
  }, 10_000);

  it("fails on a native model mismatch after switching accounts even on end_turn and never prompts again", async () => {
    const f = await fixture();
    const original = f.start();
    const originalInput = { billingSourceRef: await sourceOf(original), scopeId: GEMINI };
    const initial = await run(original, originalInput);
    expect(initial.status).toBe("succeeded");
    await original.close();
    await f.useAccount(otherNativeAccount);
    const a = f.start((transport) => {
      transport.prompt.mockImplementation(async () => {
        await f.log(transport.sessionId, 1, gemini);
        await f.log(transport.sessionId, 2, "gemini-4-carbon-low");
        return endTurn;
      });
    });
    const current = await sourceOf(a);
    const input = { billingSourceRef: current, scopeId: GEMINI };
    const failed = await run(a, input);
    expect(failed).toMatchObject({
      status: "failed",
      modelVerification: "mismatch",
      accountChanged: true,
      nativeSessionRef: initial.nativeSessionRef,
    });
    expect(f.rows()[0]).toMatchObject({
      state: "failed",
      observed_models: JSON.stringify([gemini, "gemini-4-carbon-low"]),
    });
    expect(await run(f.start(), input)).toMatchObject({
      status: "blocked",
      modelVerification: "mismatch",
      nativeSessionRef: failed.nativeSessionRef,
    });
    expect(f.transports).toHaveLength(2);
  });

  it("rejects a different native ID from resume without replacing the owned reference", async () => {
    const f = await fixture();
    const first = f.start((transport) => {
      transport.prompt.mockImplementation(async () => {
        await f.log(transport.sessionId, 1, gemini);
        return endTurn;
      });
    });
    const input = { billingSourceRef: await sourceOf(first), scopeId: GEMINI };
    const initial = await run(first, input);
    const second = f.start((transport) => {
      transport.overrideSessionId = randomUUID();
    });
    expect(await run(second, input)).toMatchObject({
      status: "failed",
      nativeSessionRef: initial.nativeSessionRef,
    });
    expect(f.transports[1]?.prompt).not.toHaveBeenCalled();
  });
});
