import { createServer } from "node:http";
import { mkdtemp, rm, realpath, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  hostTurnIdSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
} from "@codexhost/shared-contracts";
import type { HarnessOutput, HarnessSession } from "@codexhost/harness-adapter";
import { ZcodeAdapter } from "../src/adapter.js";
import { writePersonalProviderFixture } from "../../../../tests/fixtures/zcode-provider.js";

const runtime = process.env.CODEXHOST_TEST_ZCODE_RUNTIME;
describe.skipIf(!runtime)("ZCode native services with isolated local Provider", () => {
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
                  file_path: path.join(root, "fixture-created.txt"),
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
          usage: { input_tokens: 5, output_tokens: 4 },
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
        usage: { input_tokens: 5, output_tokens: 0 },
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
      runtimeDirectory: required(runtime),
      timeoutMs: 15_000,
      environment: {
        PATH: process.env.PATH,
        ZCODE_DATA_BASE_DIR: root,
        ZCODE_CREDENTIAL_SECRET: "fixture-only",
        NODE_ENV: "production",
        ZCODE_SESSION_DB_PATH: path.join(root, "native.sqlite"),
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
