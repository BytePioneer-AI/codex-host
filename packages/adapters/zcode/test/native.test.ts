import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdtemp, rm, realpath, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  hostTurnIdSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
} from "@codexhost/shared-contracts";
import type { HarnessOutput, HarnessSession } from "@codexhost/harness-adapter";
import { ZcodeAdapter } from "../src/adapter.js";
import { writePersonalProviderFixture } from "../../../../tests/fixtures/zcode-provider.js";

// Path to an installed ZCode.app. Every run uses an isolated HOME/ZCODE_DATA_BASE_DIR and a
// local Provider; it never reads the real ~/.zcode.
const app = process.env.CODEXHOST_TEST_ZCODE_APP;
describe.skipIf(!app)("ZCode installed CLI with isolated local Provider", () => {
  let root: string, adapter: ZcodeAdapter;
  const received: unknown[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const input = JSON.parse(body);
    received.push(input);
    const last = JSON.stringify(input.messages?.at(-1));
    const toolResult = last.includes("tool_result");
    if (last.includes("fixture-slow") && !toolResult) return;
    const blocks: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: object;
    }> =
      last.includes("fixture-bash") && !toolResult
        ? [
            {
              type: "tool_use",
              id: "fixture_approval",
              name: "Bash",
              input: {
                command: `printf approved > ${path.join(root, "approved.txt")}`,
                description: "Write isolated fixture marker",
              },
            },
          ]
        : last.includes("fixture-write") && !toolResult
          ? [
              {
                type: "tool_use",
                id: "fixture_write",
                name: "Write",
                input: {
                  file_path: path.join(
                    root,
                    last.includes("fixture-write-meter")
                      ? "meter-created.txt"
                      : "fixture-created.txt",
                  ),
                  content: "fixture content\n",
                },
              },
            ]
          : last.includes("fixture-question") && !toolResult
            ? [
                {
                  type: "tool_use",
                  id: "fixture_question",
                  name: "AskUserQuestion",
                  input: {
                    questions: [
                      {
                        question: "Choose a color",
                        header: "Color",
                        options: [
                          { label: "Blue", description: "Blue" },
                          { label: "Red", description: "Red" },
                        ],
                        multiSelect: false,
                      },
                    ],
                  },
                },
              ]
            : last.includes("fixture-environment") && !toolResult
              ? [
                  {
                    type: "tool_use",
                    id: "fixture_bash",
                    name: "Bash",
                    input: {
                      command: "printf '%s' \"$CODEXHOST_THREAD_ID\"",
                      description: "Read isolated fixture marker",
                    },
                  },
                ]
              : [{ type: "text", text: "LOCAL_FIXTURE_OK" }];
    const stop = required(blocks[0]).type === "tool_use" ? "tool_use" : "end_turn";
    if (!input.stream) {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "fixture",
          type: "message",
          role: "assistant",
          model: input.model,
          content: blocks,
          stop_reason: stop,
          stop_sequence: null,
          usage: {
            input_tokens: 5,
            output_tokens: 4,
            cache_read_input_tokens: 30,
            cache_creation_input_tokens: 10,
          },
        }),
      );
      return;
    }
    response.setHeader("content-type", "text/event-stream");
    const send = (type: string, data: object) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send("message_start", {
      message: {
        id: "fixture",
        type: "message",
        role: "assistant",
        model: input.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 5,
          output_tokens: 0,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 10,
        },
      },
    });
    blocks.forEach((block, index) => {
      send("content_block_start", {
        index,
        content_block:
          block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" },
      });
      send("content_block_delta", {
        index,
        delta:
          block.type === "tool_use"
            ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
            : { type: "text_delta", text: block.text },
      });
      send("content_block_stop", { index });
    });
    // Give the actual CLI observable generation time, independent of tool execution.
    await new Promise((resolve) => setTimeout(resolve, 25));
    send("message_delta", {
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: 4 },
    });
    send("message_stop", {});
    response.end();
  });
  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "codexhost-zcode-native-")));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No local Provider port");
    await writePersonalProviderFixture(root, `http://127.0.0.1:${address.port}`);
    adapter = new ZcodeAdapter({
      app: required(app),
      timeoutMs: 15_000,
      environment: {
        PATH: process.env.PATH,
        HOME: root,
        ZCODE_DATA_BASE_DIR: root,
        ZCODE_CREDENTIAL_SECRET: "fixture-only",
      },
    });
  });
  afterAll(async () => {
    await adapter?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (root) await rm(root, { recursive: true, force: true });
  });
  it("inspects without prompting and resumes an independent conversation", async () => {
    const inspected = await adapter.inspect({ cwd: root });
    expect(inspected.status).toBe("ready");
    expect(received).toHaveLength(0);
    // The catalog comes from a deferred draft that must not be persisted.
    const database = new DatabaseSync(path.join(root, ".zcode/cli/db/db.sqlite"), {
      readOnly: true,
    });
    expect(database.prepare("select count(*) as count from session").get()).toEqual({ count: 0 });
    database.close();
    const opened = await adapter.open({ kind: "create", cwd: root });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const session = opened.value;
    const output = observe(session);
    expect((await session.readSnapshot()).ok).toBe(true);
    const ref = required(session.initialState.nativeRef);
    const start = await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("native-first"),
      input: [{ type: "text", text: "Reply with the fixture response." }],
    });
    expect(start).toEqual({ ok: true, value: { turnId: "native-first" } });
    await output.untilTerminal("native-first");
    const completed = output.values.find(
      (value) => value.kind === "event" && value.event.type === "turn.completed",
    );
    expect(completed).toMatchObject({
      kind: "event",
      event: { nativeTurnRef: { harnessId: "zcode" } },
    });
    const snapshot = await session.readSnapshot();
    if (!snapshot.ok) throw new Error(JSON.stringify(snapshot.error));
    expect(completed).toMatchObject({
      event: { nativeTurnRef: snapshot.value.turns[0]?.nativeTurnRef },
    });
    expect(JSON.stringify(snapshot.value)).toContain("LOCAL_FIXTURE_OK");
    expect(snapshot.value.turns).toHaveLength(1);
    await session.close();
    const resumed = await adapter.open({ kind: "resume", cwd: root, nativeRef: ref });
    if (!resumed.ok) throw new Error(JSON.stringify(resumed.error));
    expect(resumed.value.initialState.nativeRef).toEqual(ref);
    const next = observe(resumed.value);
    expect(
      (
        await resumed.value.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("native-second"),
          input: [{ type: "text", text: "One more fixture response." }],
        })
      ).ok,
    ).toBe(true);
    await next.untilTerminal("native-second");
    const history = await resumed.value.readSnapshot();
    expect(history.ok && history.value.turns.length).toBe(2);
    if (!history.ok) throw new Error(history.error.message);
    expect(
      next.values.find((value) => value.kind === "event" && value.event.type === "turn.completed"),
    ).toMatchObject({ event: { nativeTurnRef: history.value.turns[1]?.nativeTurnRef } });
    await resumed.value.close();
  }, 45_000);
  it("meters native requests before Turn completion and replays the same usage on resume", async () => {
    const opened = await adapter.open({
      kind: "create",
      cwd: root,
      executionPolicy: "unattended-full-access",
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value,
      output = observe(session);
    const ref = required(session.initialState.nativeRef);
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("native-meter"),
      input: [{ type: "text", text: "fixture-write-meter" }],
    });
    await output.untilTerminal("native-meter");
    const requests = output.values.flatMap((value) =>
      value.kind === "event" && value.event.type === "usage.request" ? [value.event.request] : [],
    );
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request).toMatchObject({
        model: "fixture-model",
        inputTokens: 45,
        outputTokens: 4,
        cachedInputTokens: 30,
        cacheWriteInputTokens: 10,
      });
      expect(request.historical).toBeUndefined();
      expect(request.startedAtMs).toBeTypeOf("number");
      expect(required(request.completedAtMs)).toBeGreaterThan(required(request.startedAtMs));
    }
    const firstRequest = output.values.findIndex(
      (v) => v.kind === "event" && v.event.type === "usage.request",
    );
    const terminal = output.values.findIndex(
      (v) => v.kind === "event" && v.event.type === "turn.completed",
    );
    expect(firstRequest).toBeGreaterThanOrEqual(0);
    expect(terminal).toBeGreaterThan(firstRequest);
    expect(new Set(requests.map((request) => request.requestId)).size).toBe(2);
    expect(
      output.values.some(
        (v) => v.kind === "event" && v.event.type === "usage.history" && !v.event.complete,
      ),
    ).toBe(false);
    await session.close();
    const resumed = await adapter.open({ kind: "resume", cwd: root, nativeRef: ref });
    if (!resumed.ok) throw new Error(resumed.error.message);
    const replay = observe(resumed.value);
    await vi.waitFor(() =>
      expect(
        replay.values.some((v) => v.kind === "event" && v.event.type === "usage.history"),
      ).toBe(true),
    );
    const historical = replay.values.flatMap((v) =>
      v.kind === "event" && v.event.type === "usage.request" ? [v.event.request] : [],
    );
    expect(historical).toHaveLength(requests.length);
    for (const request of requests) {
      const facts = { ...request };
      delete facts.startedAtMs;
      delete facts.completedAtMs;
      expect(historical).toContainEqual({ ...facts, reasoningOutputTokens: 0, historical: true });
    }
    await resumed.value.close();
  }, 45_000);
  it("preserves per-Thread tool environment across concurrent workspaces", async () => {
    const paths = [path.join(root, "one"), path.join(root, "two")];
    await Promise.all(paths.map((p) => mkdir(p)));
    const opened = await Promise.all(
      paths.map((cwd, i) =>
        adapter.open({
          kind: "create",
          cwd,
          executionPolicy: "unattended-full-access",
          environment: { CODEXHOST_THREAD_ID: `fixture-thread-${i}` },
        }),
      ),
    );
    await Promise.all(
      opened.map(async (result, i) => {
        if (!result.ok) throw new Error(JSON.stringify(result.error));
        const session = result.value,
          output = observe(session),
          id = `native-env-${i}`;
        expect(
          (
            await session.execute({
              type: "turn.start",
              turnId: hostTurnIdSchema.parse(id),
              input: [{ type: "text", text: "fixture-environment" }],
            })
          ).ok,
        ).toBe(true);
        await output.untilTerminal(id);
        expect(JSON.stringify(output.values)).toContain(`fixture-thread-${i}`);
        expect(JSON.stringify(output.values)).not.toContain(`fixture-thread-${1 - i}`);
        await session.close();
      }),
    );
  }, 45_000);
  it("cancels a running turn and continues the same Session", async () => {
    const opened = await adapter.open({ kind: "create", cwd: root });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const session = opened.value,
      output = observe(session);
    expect(
      (
        await session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("native-cancel"),
          input: [{ type: "text", text: "fixture-slow" }],
        })
      ).ok,
    ).toBe(true);
    expect(
      await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("native-busy"),
        input: [{ type: "text", text: "must not run" }],
      }),
    ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    expect(
      (
        await session.execute({
          type: "turn.cancel",
          turnId: hostTurnIdSchema.parse("native-cancel"),
        })
      ).ok,
    ).toBe(true);
    await output.untilTerminal("native-cancel", "cancelled");
    expect(
      (
        await session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("native-after-cancel"),
          input: [{ type: "text", text: "Continue with a fixture answer." }],
        })
      ).ok,
    ).toBe(true);
    await output.untilTerminal("native-after-cancel");
    expect(
      output.values.filter(
        (v) =>
          v.kind === "event" &&
          v.event.type === "turn.completed" &&
          v.event.turnId === "native-cancel",
      ),
    ).toHaveLength(1);
    await session.close();
  }, 45_000);
  it("projects and resolves native user questions", async () => {
    const opened = await adapter.open({ kind: "create", cwd: root });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const session = opened.value,
      output = observe(session);
    expect(
      (
        await session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("native-question"),
          input: [{ type: "text", text: "fixture-question" }],
        })
      ).ok,
    ).toBe(true);
    await expect
      .poll(() => output.values.find((v) => v.kind === "interaction"), { timeout: 10_000 })
      .toBeTruthy();
    const value = output.values.find((v) => v.kind === "interaction");
    if (value?.kind !== "interaction" || value.interaction.type !== "question")
      throw new Error("No native question");
    const question = required(value.interaction.questions[0]);
    const answer = question.type === "choice" ? required(question.options[0]).value : "Blue";
    expect(
      (
        await session.execute({
          type: "interaction.respond",
          interactionId: value.interaction.interactionId,
          response: { type: "question", answers: { [question.id]: [answer] } },
        })
      ).ok,
    ).toBe(true);
    await output.untilTerminal("native-question");
    await session.close();
  }, 45_000);
  it("retains native file changes in live output and history", async () => {
    const opened = await adapter.open({
      kind: "create",
      cwd: root,
      executionPolicy: "unattended-full-access",
    });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const session = opened.value,
      output = observe(session);
    expect(
      (
        await session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("native-write"),
          input: [{ type: "text", text: "fixture-write" }],
        })
      ).ok,
    ).toBe(true);
    await output.untilTerminal("native-write");
    const snapshot = await session.readSnapshot();
    if (!snapshot.ok) throw new Error(JSON.stringify(snapshot.error));
    expect(
      snapshot.value.turns.flatMap((t) => t.items).some((i) => i.item.type === "fileChange"),
    ).toBe(true);
    await session.close();
  }, 45_000);
  it("confirms model, thinking and permission changes and handles native approval", async () => {
    const opened = await adapter.open({
      kind: "create",
      cwd: root,
      permissionModeId: harnessPermissionModeIdSchema.parse("build"),
    });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const session = opened.value,
      output = observe(session);
    const inspection = await adapter.inspect({ cwd: root });
    if (inspection.status !== "ready") throw new Error("Catalog not ready");
    const reasoning = required(
      inspection.catalog.models.find((m) => m.label.endsWith("fixture-reasoning")),
    );
    const selected = await session.execute({ type: "model.select", model: reasoning.ref });
    if (!selected.ok) throw new Error(JSON.stringify(selected.error));
    expect(
      (
        await session.execute({
          type: "thinking.select",
          thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
        })
      ).ok,
    ).toBe(true);
    const configured = await session.readSnapshot();
    expect(configured.ok && configured.value.state?.effectiveThinkingOptionId).toBe("high");
    expect(
      (
        await session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("native-approval"),
          input: [{ type: "text", text: "fixture-bash" }],
        })
      ).ok,
    ).toBe(true);
    await expect
      .poll(() => output.values.find((v) => v.kind === "interaction"), { timeout: 10_000 })
      .toBeTruthy();
    const value = output.values.find((v) => v.kind === "interaction");
    if (value?.kind !== "interaction" || value.interaction.type !== "approval")
      throw new Error("No native approval");
    expect(
      (
        await session.execute({
          type: "interaction.respond",
          interactionId: value.interaction.interactionId,
          response: { type: "approval", actionId: "not-a-native-action" },
        })
      ).ok,
    ).toBe(false);
    const action = required(value.interaction.actions.find((a) => a.effect === "allowOnce"));
    expect(
      (
        await session.execute({
          type: "interaction.respond",
          interactionId: value.interaction.interactionId,
          response: { type: "approval", actionId: action.id },
        })
      ).ok,
    ).toBe(true);
    await output.untilTerminal("native-approval");
    expect(
      (
        await session.execute({
          type: "permissionMode.select",
          permissionModeId: harnessPermissionModeIdSchema.parse("yolo"),
        })
      ).ok,
    ).toBe(true);
    await session.close();
  }, 45_000);
});

describe.skipIf(!app)("ZCode Start Plan with synthetic credentials and a local Provider", () => {
  const jwt = "synthetic-start-plan-jwt";
  const requests: IncomingHttpHeaders[] = [];
  const receivedInputs: Array<{ model?: string; [key: string]: unknown }> = [];
  let root: string, adapter: ZcodeAdapter;
  const balanceResponse: unknown = {
    code: 0,
    data: {
      plans: [
        {
          plan_id: "zcode-v3-start-plan-trust-0930",
          name: "Start Plan",
          status: "active",
        },
      ],
      balances: [
        {
          capabilities: ["model:glm-5.3-flash"],
        },
      ],
    },
  };
  const verify = vi.fn(async () => ({
    "X-Aliyun-Captcha-Verify-Param": "synthetic-proof",
    "X-Aliyun-Captcha-Verify-Region": "cn-shanghai",
  }));
  const prewarm = vi.fn();
  const closeVerifier = vi.fn(async () => {});
  const createVerifier = vi.fn(() => ({ verify, prewarm, close: closeVerifier }));
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    if (request.url?.startsWith("/api/v1/zcode-plan/billing/balance")) {
      const mid = request.headers["x-device-mid"];
      if (mid === "no-plan-device-mid") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ code: 0, data: { plans: [], balances: [] } }));
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(balanceResponse));
      return;
    }
    requests.push(request.headers);
    const input = JSON.parse(body);
    receivedInputs.push(input);
    const message = {
      id: "fixture",
      type: "message",
      role: "assistant",
      model: input.model,
      content: [{ type: "text", text: "START_PLAN_FIXTURE_OK" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 4 },
    };
    if (!input.stream) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(message));
      return;
    }
    response.setHeader("content-type", "text/event-stream");
    const send = (type: string, data: object) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send("message_start", { message: { ...message, content: [], stop_reason: null } });
    send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    send("content_block_delta", {
      index: 0,
      delta: { type: "text_delta", text: "START_PLAN_FIXTURE_OK" },
    });
    send("content_block_stop", { index: 0 });
    send("message_delta", {
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 4 },
    });
    send("message_stop", {});
    response.end();
  });
  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "codexhost-zcode-start-plan-")));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No local Provider port");
    // The installed Built-in layer with only the Start Plan endpoint moved to the local Provider.
    const builtin = JSON.parse(
      await readFile(
        path.join(required(app), "Contents/Resources/config/provider/zcode-builtin.json"),
        "utf8",
      ),
    );
    for (const rule of builtin.config.providerConfigRules.providerRules)
      if (rule.config.access?.mode === "start-plan")
        rule.config.api.baseUrl = `http://127.0.0.1:${address.port}`;
    const builtinFile = path.join(root, "zcode-builtin.json");
    await writeFile(builtinFile, JSON.stringify(builtin));
    const encrypt = (value: string) => {
      const iv = randomBytes(12);
      const key = createHash("sha256").update("fixture-only").digest();
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return `enc:v1:${[iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".")}`;
    };
    await mkdir(path.join(root, ".zcode/v2"), { recursive: true });
    await writeFile(
      path.join(root, ".zcode/v2/credentials.json"),
      JSON.stringify({ "oauth:active_provider": encrypt("zai"), zcodejwttoken: encrypt(jwt) }),
    );
    await writeFile(
      path.join(root, ".zcode/v2/telemetry-state.json"),
      JSON.stringify({ deviceMid: "fixture-native-mid" }),
    );
    adapter = new ZcodeAdapter({
      app: required(app),
      timeoutMs: 15_000,
      createVerifier,
      environment: {
        PATH: process.env.PATH,
        HOME: root,
        ZCODE_DATA_BASE_DIR: root,
        ZCODE_CREDENTIAL_SECRET: "fixture-only",
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinFile,
        ZCODE_BASE_URL: `http://127.0.0.1:${address.port}`,
      },
    });
  });
  afterAll(async () => {
    await adapter?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (root) await rm(root, { recursive: true, force: true });
  });
  it("lists Start Plan models and authenticates each request with JWT and verification", async () => {
    const inspected = await adapter.inspect({ cwd: root });
    if (inspected.status !== "ready") throw new Error(JSON.stringify(inspected));
    const model = required(
      inspected.catalog.models.find((m) => m.label === "Start Plan / GLM-5.3-Flash"),
    );
    expect(model.supportedThinkingOptionIds).toEqual(["low", "high", "max"]);
    expect(prewarm).not.toHaveBeenCalled();
    const opened = await adapter.open({ kind: "create", cwd: root, model: model.ref });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    expect(prewarm).toHaveBeenCalledOnce();
    const session = opened.value,
      output = observe(session);
    expect(session.initialState.effectiveModel).toEqual(model.ref);
    expect(session.initialState.effectiveThinkingOptionId).toBe("max");
    expect(
      (
        await session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("start-plan-first"),
          input: [{ type: "text", text: "Reply with the fixture response." }],
        })
      ).ok,
    ).toBe(true);
    await output.untilTerminal("start-plan-first");
    const snapshot = await session.readSnapshot();
    expect(JSON.stringify(snapshot)).toContain("START_PLAN_FIXTURE_OK");
    expect(requests.length).toBeGreaterThan(0);
    for (const headers of requests) {
      expect(`${headers.authorization ?? ""} ${headers["x-api-key"] ?? ""}`).toContain(jwt);
      expect(headers["x-aliyun-captcha-verify-param"]).toBe("synthetic-proof");
    }
    expect(verify).toHaveBeenCalledTimes(requests.length);
    expect(JSON.stringify(output.values)).not.toContain(jwt);
    await session.close();
  }, 45_000);
  it("lists only capability models for an entitled Start Plan account", async () => {
    const inspected = await adapter.inspect({ cwd: root });
    if (inspected.status !== "ready") throw new Error(JSON.stringify(inspected));
    const startPlanModels = inspected.catalog.models.filter((m) =>
      m.label.startsWith("Start Plan /"),
    );
    expect(startPlanModels.map((m) => m.label)).toEqual(["Start Plan / GLM-5.3-Flash"]);
  });

  it("shares one Host verifier across Sessions and closes it only with the Adapter", async () => {
    const [first, second] = await Promise.all([
      adapter.open({ kind: "create", cwd: root }),
      adapter.open({ kind: "create", cwd: root }),
    ]);
    if (!first?.ok || !second?.ok) throw new Error(JSON.stringify([first, second]));
    const output = observe(second.value);
    await first.value.close();
    const before = verify.mock.calls.length;
    expect(
      (
        await second.value.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("start-plan-shared"),
          input: [{ type: "text", text: "Reply with the fixture response." }],
        })
      ).ok,
    ).toBe(true);
    await output.untilTerminal("start-plan-shared");
    expect(verify.mock.calls.length).toBeGreaterThan(before);
    expect(createVerifier).toHaveBeenCalledOnce();
    expect(createVerifier).toHaveBeenCalledWith({ appVersion: expect.any(String) });
    expect(prewarm).toHaveBeenCalledOnce();
    expect(closeVerifier).not.toHaveBeenCalled();
    await adapter.close();
    expect(closeVerifier).toHaveBeenCalledOnce();
  }, 45_000);

  it("routes session created without model to custom provider when Start Plan is unentitled", async () => {
    const address = server.address() as { port: number };
    const noPlanRoot = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "codexhost-zcode-no-plan-")),
    );
    try {
      const encrypt = (value: string) => {
        const iv = randomBytes(12);
        const key = createHash("sha256").update("fixture-only").digest();
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
        return `enc:v1:${[iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".")}`;
      };
      await mkdir(path.join(noPlanRoot, ".zcode/v2"), { recursive: true });
      await writeFile(
        path.join(noPlanRoot, ".zcode/v2/credentials.json"),
        JSON.stringify({ "oauth:active_provider": encrypt("zai"), zcodejwttoken: encrypt(jwt) }),
      );
      await writeFile(
        path.join(noPlanRoot, ".zcode/v2/telemetry-state.json"),
        JSON.stringify({ deviceMid: "no-plan-device-mid" }),
      );
      await writeFile(
        path.join(noPlanRoot, ".zcode/v2/provider_config.json"),
        JSON.stringify({
          schemaVersion: 1,
          config: {
            providerConfigRules: {
              providerRules: [
                {
                  providerId: "personal-custom",
                  providerName: "Custom Provider",
                  enabled: true,
                  config: {
                    group: "standard-personal",
                    access: { type: "api-key", apiKey: "test-only" },
                    api: {
                      type: "anthropic-messages",
                      baseUrl: `http://127.0.0.1:${address.port}`,
                    },
                    personalModelIds: ["custom-model-alpha", "custom-model-beta"],
                  },
                },
              ],
            },
            modelConfigRules: {
              providerModelRules: [
                {
                  providerId: "personal-custom",
                  modelId: "custom-model-alpha",
                  config: { optionSpecs: { reasoningLevel: { values: ["disabled"], map: "{}" } } },
                },
                {
                  providerId: "personal-custom",
                  modelId: "custom-model-beta",
                  config: { optionSpecs: { reasoningLevel: { values: ["disabled"], map: "{}" } } },
                },
              ],
              manualProviderModelRules: [],
            },
          },
        }),
      );

      const noPlanAdapter = new ZcodeAdapter({
        app: required(app),
        timeoutMs: 15_000,
        createVerifier,
        environment: {
          PATH: process.env.PATH,
          HOME: noPlanRoot,
          ZCODE_DATA_BASE_DIR: noPlanRoot,
          ZCODE_CREDENTIAL_SECRET: "fixture-only",
          ZCODE_BASE_URL: `http://127.0.0.1:${address.port}`,
        },
      });

      try {
        const inspected = await noPlanAdapter.inspect({ cwd: noPlanRoot });
        if (inspected.status !== "ready") throw new Error(JSON.stringify(inspected));
        const startPlanModels = inspected.catalog.models.filter((m) =>
          m.label.startsWith("Start Plan /"),
        );
        expect(startPlanModels).toEqual([]);
        expect(inspected.catalog.models.map((m) => m.label)).toContain(
          "Custom Provider / custom-model-alpha",
        );

        const opened = await noPlanAdapter.open({ kind: "create", cwd: noPlanRoot });
        if (!opened.ok) throw new Error(JSON.stringify(opened.error));
        const session = opened.value;
        const output = observe(session);
        expect(
          (
            await session.execute({
              type: "turn.start",
              turnId: hostTurnIdSchema.parse("no-plan-turn"),
              input: [{ type: "text", text: "Reply without plan." }],
            })
          ).ok,
        ).toBe(true);
        await output.untilTerminal("no-plan-turn");
        expect(receivedInputs.at(-1)?.model).toBe("custom-model-alpha");
        await session.close();
      } finally {
        await noPlanAdapter.close();
      }
    } finally {
      await rm(noPlanRoot, { recursive: true, force: true });
    }
  }, 45_000);

  it("creates a session with a non-first model and uses it", async () => {
    const address = server.address() as { port: number };
    const customRoot = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "codexhost-zcode-non-first-")),
    );
    try {
      const encrypt = (value: string) => {
        const iv = randomBytes(12);
        const key = createHash("sha256").update("fixture-only").digest();
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
        return `enc:v1:${[iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".")}`;
      };
      await mkdir(path.join(customRoot, ".zcode/v2"), { recursive: true });
      await writeFile(
        path.join(customRoot, ".zcode/v2/credentials.json"),
        JSON.stringify({ "oauth:active_provider": encrypt("zai"), zcodejwttoken: encrypt(jwt) }),
      );
      await writeFile(
        path.join(customRoot, ".zcode/v2/telemetry-state.json"),
        JSON.stringify({ deviceMid: "no-plan-device-mid" }),
      );
      await writeFile(
        path.join(customRoot, ".zcode/v2/provider_config.json"),
        JSON.stringify({
          schemaVersion: 1,
          config: {
            providerConfigRules: {
              providerRules: [
                {
                  providerId: "personal-custom",
                  providerName: "Custom Provider",
                  enabled: true,
                  config: {
                    group: "standard-personal",
                    access: { type: "api-key", apiKey: "test-only" },
                    api: {
                      type: "anthropic-messages",
                      baseUrl: `http://127.0.0.1:${address.port}`,
                    },
                    personalModelIds: ["custom-model-alpha", "custom-model-beta"],
                  },
                },
              ],
            },
            modelConfigRules: {
              providerModelRules: [
                {
                  providerId: "personal-custom",
                  modelId: "custom-model-alpha",
                  config: { optionSpecs: { reasoningLevel: { values: ["disabled"], map: "{}" } } },
                },
                {
                  providerId: "personal-custom",
                  modelId: "custom-model-beta",
                  config: { optionSpecs: { reasoningLevel: { values: ["disabled"], map: "{}" } } },
                },
              ],
              manualProviderModelRules: [],
            },
          },
        }),
      );

      const customAdapter = new ZcodeAdapter({
        app: required(app),
        timeoutMs: 15_000,
        createVerifier,
        environment: {
          PATH: process.env.PATH,
          HOME: customRoot,
          ZCODE_DATA_BASE_DIR: customRoot,
          ZCODE_CREDENTIAL_SECRET: "fixture-only",
          ZCODE_BASE_URL: `http://127.0.0.1:${address.port}`,
        },
      });

      try {
        const inspected = await customAdapter.inspect({ cwd: customRoot });
        if (inspected.status !== "ready") throw new Error(JSON.stringify(inspected));
        const secondModel = required(
          inspected.catalog.models.find((m) => m.label === "Custom Provider / custom-model-beta"),
        );

        const opened = await customAdapter.open({
          kind: "create",
          cwd: customRoot,
          model: secondModel.ref,
        });
        if (!opened.ok) throw new Error(JSON.stringify(opened.error));
        const session = opened.value;
        const output = observe(session);
        expect(
          (
            await session.execute({
              type: "turn.start",
              turnId: hostTurnIdSchema.parse("non-first-turn"),
              input: [{ type: "text", text: "Reply with second model." }],
            })
          ).ok,
        ).toBe(true);
        await output.untilTerminal("non-first-turn");
        expect(receivedInputs.at(-1)?.model).toBe("custom-model-beta");
        await session.close();
      } finally {
        await customAdapter.close();
      }
    } finally {
      await rm(customRoot, { recursive: true, force: true });
    }
  }, 45_000);
});

function observe(session: HarnessSession) {
  const values: HarnessOutput[] = [];
  const waiters = new Set<() => void>();
  void (async () => {
    for await (const item of session.outputs) {
      values.push(item);
      for (const notify of waiters) notify();
    }
    for (const notify of waiters) notify();
  })();
  return {
    values,
    untilTerminal(id: string, outcome = "succeeded") {
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () =>
            finish(
              new Error(
                `No terminal for ${id}; events: ${values.map((o) => (o.kind === "event" ? o.event.type : o.kind)).join(",")}`,
              ),
            ),
          25_000,
        );
        const finish = (error?: Error) => {
          clearTimeout(timeout);
          waiters.delete(check);
          if (error) reject(error);
          else resolve();
        };
        const check = () => {
          const terminal = values.find(
            (item) =>
              item.kind === "event" &&
              item.event.type === "turn.completed" &&
              item.event.turnId === id,
          );
          if (terminal?.kind === "event" && terminal.event.type === "turn.completed") {
            finish(
              terminal.event.outcome.status === outcome
                ? undefined
                : new Error(JSON.stringify(terminal.event.outcome)),
            );
          }
        };
        waiters.add(check);
        check();
      });
    },
  };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
