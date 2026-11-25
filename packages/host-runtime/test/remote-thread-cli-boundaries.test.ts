import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { runDelegationCli } from "../src/delegation-cli.js";
import { compactDelegationOutput } from "../src/delegation-cli-output.js";

const cliEnv = {
  CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:1234",
  CODEXHOST_RUNTIME_TOKEN: "fixture",
  CODEXHOST_THREAD_ID: "caller-thread-1",
};

it.each([
  ["read", "thread://t?hostId=mac", "--host", "other"],
  ["read", "thread://t?hostId=mac&hostId=other"],
  ["read", "thread://t?hostId=%ZZ"],
  ["send", "thread://t?hostId=mac", "--message", "hello"],
  ["send", "thread://t?hostId=remote-ssh-discovered%3Amac", "--message", "hello"],
  ["send", "thread://t?hostId=remote-peer%3Apeer-b", "--message", "hello", "--watch", "true"],
  ["wait", "t", "--host", "mac"],
  ["wait", "thread://t?hostId=remote-control%3Adesktop"],
  ["cancel", "thread://t?hostId=remote-ssh-discovered%3Amac"],
  ["watch", "thread://t?hostId=remote-peer%3Apeer-b"],
  ["watch", "t", "--host", "remote-peer:peer-b"],
  ["list", "--host", "remote-ssh-discovered:mac"],
])("does not dispatch invalid or unsupported remote arguments: %s %s", async (...args) => {
  const fetchImpl = vi.fn<typeof fetch>();
  expect(
    await runDelegationCli({
      arguments: ["thread", ...args],
      environment: cliEnv,
      output: new PassThrough(),
      diagnosticOutput: new PassThrough(),
      fetchImpl,
    }),
  ).toBe(1);
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("rejects remote --watch on delegate start and non-peer remote hosts without dispatching", async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  for (const args of [
    [
      "delegate",
      "start",
      "--host",
      "remote-peer:peer-b",
      "--harness",
      "pi",
      "--task",
      "hi",
      "--watch",
      "true",
    ],
    ["delegate", "start", "--host", "remote-ssh-discovered:mac", "--harness", "pi", "--task", "hi"],
    ["harness", "list", "--host", "remote-ssh-discovered:mac"],
    ["harness", "inspect", "pi", "--host", "remote-ssh-discovered:mac"],
  ]) {
    expect(
      await runDelegationCli({
        arguments: args,
        environment: cliEnv,
        output: new PassThrough(),
        diagnosticOutput: new PassThrough(),
        fetchImpl,
      }),
    ).toBe(1);
  }
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("dispatches remote-peer operations without local worktree/cwd rewriting and forwards callerThreadId", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    calls.push({
      path: new URL(String(url)).pathname,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ ok: true }));
  });

  expect(
    await runDelegationCli({
      arguments: ["host", "list"],
      environment: cliEnv,
      output: new PassThrough(),
      diagnosticOutput: new PassThrough(),
      fetchImpl,
    }),
  ).toBe(0);
  expect(calls.at(-1)).toEqual({ path: "/v1/host/list", body: {} });

  // Remote delegate start must not run local git worktree or resolve --cwd against A's process.cwd().
  expect(
    await runDelegationCli({
      arguments: [
        "delegate",
        "start",
        "--host",
        "remote-peer:peer-b",
        "--harness",
        "pi",
        "--task",
        "build",
        "--cwd",
        "/remote/b/repo",
        "--worktree",
        "feat-on-b",
        "--base",
        "main",
      ],
      environment: cliEnv,
      output: new PassThrough(),
      diagnosticOutput: new PassThrough(),
      fetchImpl,
    }),
  ).toBe(0);
  expect(calls.at(-1)).toEqual({
    path: "/v1/delegate/start",
    body: {
      harnessId: "pi",
      task: "build",
      hostId: "remote-peer:peer-b",
      cwd: "/remote/b/repo",
      parentThreadId: "caller-thread-1",
      callerThreadId: "caller-thread-1",
      worktree: "feat-on-b",
      base: "main",
    },
  });

  // Remote thread list must not default --cwd to A's local process.cwd().
  expect(
    await runDelegationCli({
      arguments: ["thread", "list", "--host", "remote-peer:peer-b"],
      environment: cliEnv,
      output: new PassThrough(),
      diagnosticOutput: new PassThrough(),
      fetchImpl,
    }),
  ).toBe(0);
  expect(calls.at(-1)?.body).not.toHaveProperty("cwd");
  expect(calls.at(-1)?.body).toMatchObject({
    hostId: "remote-peer:peer-b",
    callerThreadId: "caller-thread-1",
  });

  // Remote thread send/wait/cancel accept thread://<id>?hostId=...
  expect(
    await runDelegationCli({
      arguments: [
        "thread",
        "send",
        "thread://t-b?hostId=remote-peer%3Apeer-b",
        "--message",
        "go",
        "--steer",
        "true",
      ],
      environment: cliEnv,
      output: new PassThrough(),
      diagnosticOutput: new PassThrough(),
      fetchImpl,
    }),
  ).toBe(0);
  expect(calls.at(-1)).toEqual({
    path: "/v1/thread/send",
    body: {
      threadId: "t-b",
      hostId: "remote-peer:peer-b",
      callerThreadId: "caller-thread-1",
      message: "go",
      steer: true,
    },
  });

  expect(
    await runDelegationCli({
      arguments: ["thread", "wait", "t-b", "--host", "remote-peer:peer-b", "--timeout-ms", "1500"],
      environment: cliEnv,
      output: new PassThrough(),
      diagnosticOutput: new PassThrough(),
      fetchImpl,
    }),
  ).toBe(0);
  expect(calls.at(-1)).toEqual({
    path: "/v1/thread/wait",
    body: {
      threadId: "t-b",
      hostId: "remote-peer:peer-b",
      callerThreadId: "caller-thread-1",
      view: "result",
      timeoutMs: 1500,
    },
  });
});

it("preserves remote Host links in compact outputs across commands", () => {
  expect(
    compactDelegationOutput("thread read", {
      threadId: "t",
      hostId: "remote-ssh-discovered:mac",
      harnessId: "codex",
      status: "completed",
      turn: null,
      progress: [],
      result: { availability: "available", text: "done" },
    }),
  ).toMatchObject({ thread: "thread://t?hostId=remote-ssh-discovered%3Amac" });

  const expected = "thread://t-b?hostId=remote-peer%3Apeer-b";
  expect(
    compactDelegationOutput("thread send", {
      threadId: "t-b",
      hostId: "remote-peer:peer-b",
      turnId: "turn-1",
      harnessId: "pi",
      status: "running",
      next: { read: "r", wait: "w" },
    }),
  ).toMatchObject({ thread: expected });
  expect(
    compactDelegationOutput("thread cancel", {
      threadId: "t-b",
      hostId: "remote-peer:peer-b",
      turnId: "turn-1",
      harnessId: "pi",
      cancelled: true,
    }),
  ).toMatchObject({ thread: expected, cancelRequested: true });
  expect(
    compactDelegationOutput("thread answer", {
      threadId: "t-b",
      hostId: "remote-peer:peer-b",
      interactionId: "q-1",
      turnId: "turn-1",
      harnessId: "pi",
      status: "running",
      next: { read: "r", wait: "w" },
    }),
  ).toMatchObject({ thread: expected });
});
