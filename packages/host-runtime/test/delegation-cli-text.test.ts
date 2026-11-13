import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { runDelegationCli } from "../src/delegation-cli.js";
import { textDelegationOutput } from "../src/delegation-cli-text.js";
import type { DelegationCliCommand } from "../src/delegation-cli-help.js";
import type { DelegationThreadSnapshot } from "../src/delegation-types.js";

const body = '第一行 "引号"\n第二行\\路径\n\n  缩进\r\n尾行';
const snapshot: DelegationThreadSnapshot = {
  threadId: "child",
  harnessId: "pi",
  status: "completed",
  turn: { turnId: "turn-1", status: "completed" },
  progress: [],
  result: { availability: "available", text: body },
  nextCursor: null,
};

async function run(args: string[], response: unknown = snapshot, status = 200) {
  const output = new PassThrough();
  const diagnosticOutput = new PassThrough();
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(response), { status }));
  const code = await runDelegationCli({
    arguments: args,
    environment: {
      CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:4321",
      CODEXHOST_RUNTIME_TOKEN: "token",
    },
    output,
    diagnosticOutput,
    fetchImpl,
  });
  return {
    code,
    stdout: output.read()?.toString() ?? "",
    stderr: diagnosticOutput.read()?.toString() ?? "",
    fetchImpl,
  };
}

describe("text delegation CLI output", () => {
  it.each(["read", "wait"])("prints %s bodies verbatim with metadata", async (command) => {
    const result = await run(["thread", command, "child", "--format", "text"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      "thread: codex://threads/child   harness: pi   status: completed\n" +
        "turn: turn-1   status: completed\navailability: available\n---\n" +
        body +
        "\n",
    );
  });

  it("does not add a second trailing newline to the result", async () => {
    const result = await run(["thread", "read", "child", "--format=text"], {
      ...snapshot,
      result: { availability: "available", text: `${body}\n` },
    });
    expect(result.stdout.split("---\n")[1]).toBe(`${body}\n`);
  });

  it("prints role-labelled message paragraphs and pagination without escaping text", async () => {
    const result = await run(
      ["thread", "read", "child", "--view", "messages", "--format", "text"],
      {
        ...snapshot,
        messages: [
          { id: "m1", turnId: "t", role: "user", text: body },
          { id: "m2", turnId: "t", role: "agent", phase: "final", text: '回答\n"是"' },
        ],
        hasMore: false,
        nextCursor: "cursor-2",
      },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      "thread: codex://threads/child   harness: pi   status: completed\n" +
        "turn: turn-1   status: completed\nhasMore: false\nnextCursor: cursor-2\n---\n" +
        `role: user\n${body}\n\nrole: agent   phase: final\n回答\n"是"\n`,
    );
  });

  it("preserves remote links, timeout, live progress and unavailable-result errors", () => {
    expect(
      textDelegationOutput("thread wait", {
        ...snapshot,
        hostId: "remote host",
        status: "running",
        timedOut: true,
        progress: [{ id: "p", turnId: "t", text: "进行中\n第二步" }],
        result: { availability: "unavailable", message: '出错 "原因"' },
      }),
    ).toBe(
      "thread: thread://child?hostId=remote%20host   harness: pi   status: running\n" +
        "turn: turn-1   status: completed\nprogress: 进行中 第二步\ntimedOut: true\navailability: unavailable\n" +
        'error: 出错 "原因"\n---\n',
    );
  });

  it.each([undefined, "json", "compact"])(
    "keeps %s output byte-for-byte compatible",
    async (format) => {
      const result = await run([
        "thread",
        "read",
        "child",
        ...(format ? ["--format", format] : []),
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(
        JSON.stringify(
          format === "compact"
            ? {
                thread: "codex://threads/child",
                harnessId: "pi",
                status: "completed",
                result: snapshot.result,
              }
            : snapshot,
          null,
          2,
        ) + "\n",
      );
    },
  );

  it.each([
    [
      "delegate start",
      {
        deepLink: "codex://threads/child",
        harnessId: "pi",
        status: "running",
        cwd: "/项目",
        watch: { state: "notRegistered", reason: "无法登记" },
      },
      ["thread: codex://threads/child", "cwd: /项目", "watch.reason: 无法登记"],
    ],
    ["thread send", { threadId: "child", harnessId: "pi", status: "running" }, ["status: running"]],
    [
      "thread cancel",
      { threadId: "child", harnessId: "pi", cancelled: false },
      ["cancelRequested: false"],
    ],
    [
      "thread list",
      {
        threads: [
          {
            deepLink: "codex://threads/child",
            harnessId: "pi",
            status: "completed",
            title: '任务 "甲"',
            cwd: "/项目",
          },
        ],
        nextCursor: "next",
      },
      ['threads.0.title: 任务 "甲"', "threads.0.cwd: /项目", "nextCursor: next"],
    ],
    ["harness list", { harnesses: ["pi", "codex"] }, ["harnesses.0: pi", "harnesses.1: codex"]],
    [
      "thread watch",
      {
        threadId: "child",
        notifyThreadId: "parent",
        state: "watching",
        status: "running",
        timeoutMs: 1000,
      },
      ["notify: codex://threads/parent", "timeoutMs: 1000"],
    ],
  ] satisfies Array<[DelegationCliCommand, unknown, string[]]>)(
    "renders compact fields for %s",
    (command, response, expected) => {
      const text = textDelegationOutput(command, response);
      for (const field of expected) expect(text).toContain(field);
    },
  );

  it.each([
    ["host", "info"],
    ["project", "list"],
    ["thread", "file", "child", "--path", "report.txt"],
  ])("also uses text for %s %s routes", async (...args) => {
    const result = await run([...args, "--format", "text"], { value: '中文\n"真实换行"' });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('value: 中文\n"真实换行"\n');
  });

  it.each([
    ["events"],
    ["events", "--after", "1"],
    ["client", "add", "name"],
    ["thread", "unknown"],
  ])("rejects unsupported text commands before side effects: %s", async (...args) => {
    const result = await run([...args, "--format", "text"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: {
        code: "INVALID_ARGUMENT",
        message: expect.stringContaining("--format text is not supported"),
      },
    });
    expect(result.fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["json", "compact", "text"])(
    "adds watch metadata in %s without changing old fields",
    async (format) => {
      const watch = {
        threadId: "child",
        notifyThreadId: "parent",
        state: "undeliverable",
        outcome: "completed",
        turnId: "turn-1",
        reason: '失败 "原因"',
        registeredAt: "2026-01-01T00:00:00Z",
        taskName: '任务\n"中文"',
        threadStatus: "running",
        watchedForMs: 2500,
      };
      const response = { watches: [watch, { ...watch, threadId: "other" }] };
      const result = await run(["thread", "watches", "--format", format], response);
      expect(result.code).toBe(0);
      if (format === "text") {
        expect(result.stdout).toBe(
          ["child", "other"]
            .map(
              (threadId) =>
                `thread: codex://threads/${threadId}   notify: codex://threads/parent   state: undeliverable   outcome: completed   reason: 失败 "原因"   taskName: 任务 "中文"   threadStatus: running   watchedForMs: 2500\n`,
            )
            .join(""),
        );
      } else {
        const expected =
          format === "json"
            ? response
            : {
                watches: ["child", "other"].map((threadId) => ({
                  thread: `codex://threads/${threadId}`,
                  notify: "codex://threads/parent",
                  state: watch.state,
                  outcome: watch.outcome,
                  reason: watch.reason,
                  taskName: watch.taskName,
                  threadStatus: watch.threadStatus,
                  watchedForMs: watch.watchedForMs,
                })),
              };
        expect(result.stdout).toBe(`${JSON.stringify(expected, null, 2)}\n`);
      }
    },
  );

  it("keeps Runtime errors on stderr as JSON with exit code 1", async () => {
    const error = { error: { code: "THREAD_NOT_FOUND", message: '没有 "Thread"\n请检查' } };
    const result = await run(["thread", "read", "child", "--format", "text"], error, 400);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`${JSON.stringify(error, null, 2)}\n`);
  });
});
