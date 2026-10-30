import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { runDelegationCli } from "../src/delegation-cli.js";
import {
  DELEGATION_RUNTIME_ENDPOINT_ENV,
  DELEGATION_RUNTIME_TOKEN_ENV,
} from "../src/delegation-types.js";

const environment = {
  [DELEGATION_RUNTIME_ENDPOINT_ENV]: "http://127.0.0.1:4321",
  [DELEGATION_RUNTIME_TOKEN_ENV]: "token",
};

function outputText(stream: PassThrough): string {
  return stream.read()?.toString() ?? "";
}

async function sentBody(arguments_: string[]): Promise<Record<string, unknown>> {
  const fetchImpl = vi.fn(
    async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  ) as unknown as typeof fetch;
  const diagnosticOutput = new PassThrough();
  const exitCode = await runDelegationCli({
    arguments: arguments_,
    environment,
    output: new PassThrough(),
    diagnosticOutput,
    fetchImpl,
  });
  if (exitCode !== 0) throw new Error(outputText(diagnosticOutput));
  return JSON.parse(String(vi.mocked(fetchImpl).mock.calls[0]?.[1]?.body)) as Record<
    string,
    unknown
  >;
}

async function rejection(arguments_: string[]): Promise<{ code: string; message: string }> {
  const fetchImpl = vi.fn() as unknown as typeof fetch;
  const diagnosticOutput = new PassThrough();
  await expect(
    runDelegationCli({ arguments: arguments_, environment, diagnosticOutput, fetchImpl }),
  ).resolves.toBe(1);
  expect(fetchImpl).not.toHaveBeenCalled();
  return (JSON.parse(outputText(diagnosticOutput)) as { error: { code: string; message: string } })
    .error;
}

describe("delegation CLI option values", () => {
  it("takes free-text values verbatim even when they start with --", async () => {
    await expect(
      sentBody([
        "delegate",
        "start",
        "--harness",
        "pi",
        "--task",
        "--- front matter",
        "--task-name",
        "--help",
      ]),
    ).resolves.toMatchObject({ task: "--- front matter", taskName: "--help" });
    await expect(sentBody(["thread", "send", "abc", "--message", "--help me"])).resolves.toEqual({
      threadId: "abc",
      message: "--help me",
    });
  });

  it("forwards an empty --task-name for Runtime validation", async () => {
    await expect(
      sentBody(["delegate", "start", "--harness", "pi", "--task", "work", "--task-name", ""]),
    ).resolves.toMatchObject({ task: "work", taskName: "" });
  });

  it("accepts the --name=value form for every option", async () => {
    await expect(
      sentBody([
        "delegate",
        "start",
        "--harness=pi",
        "--task=--flag=x",
        "--task-name=",
        "--cwd=/synthetic",
        "--watch=true",
        "--watch-timeout-ms=5",
      ]),
    ).resolves.toMatchObject({
      harnessId: "pi",
      task: "--flag=x",
      taskName: "",
      cwd: path.resolve("/synthetic"),
      watchTimeoutMs: 5,
    });
    await expect(
      sentBody(["thread", "read", "abc", "--view=messages", "--limit=3", "--format=json"]),
    ).resolves.toMatchObject({ threadId: "abc", view: "messages", limit: 3 });
  });

  it.each([
    [["delegate", "start", "--harness", "pi", "--task"], "--task requires a value"],
    [["thread", "send", "abc", "--message"], "--message requires a value"],
    [["delegate", "start", "--harness", "--task", "work"], "--harness requires a value"],
    [["harness", "inspect", "pi", "--cwd", ""], "--cwd requires a value"],
    [["harness", "inspect", "pi", "--cwd="], "--cwd requires a value"],
    [
      ["thread", "send", "abc", "--message=a", "--message", "b"],
      "--message may only be provided once",
    ],
  ])("rejects %j", async (arguments_, message) => {
    await expect(rejection(arguments_)).resolves.toEqual({ code: "INVALID_ARGUMENT", message });
  });

  it("still shows help after an inline option value", async () => {
    const output = new PassThrough();
    await expect(
      runDelegationCli({ arguments: ["thread", "send", "abc", "--message=x", "--help"], output }),
    ).resolves.toBe(0);
    expect(outputText(output)).toContain("codexhost thread send");
  });

  it("resolves a relative --cwd against the caller process cwd", async () => {
    await expect(
      sentBody(["delegate", "start", "--harness", "pi", "--task", "work", "--cwd", "./sub"]),
    ).resolves.toMatchObject({ cwd: path.resolve(process.cwd(), "sub") });
    await expect(sentBody(["harness", "inspect", "pi", "--cwd", "."])).resolves.toMatchObject({
      cwd: process.cwd(),
    });
    await expect(sentBody(["thread", "list", "--cwd", "../other"])).resolves.toMatchObject({
      cwd: path.resolve(process.cwd(), "../other"),
    });
  });

  it("rejects a malformed host ID encoding in a Thread reference", async () => {
    await expect(rejection(["thread", "read", "thread://abc?hostId=%E0%A4"])).resolves.toEqual({
      code: "INVALID_ARGUMENT",
      message: "Thread reference is invalid",
    });
  });

  it.each(["1e2", "0x10", " 7", "7 ", "+7", "7.0", "-1", "0"])(
    "rejects non-decimal limit %j",
    async (limit) => {
      await expect(
        rejection(["thread", "read", "abc", "--view", "messages", "--limit", limit]),
      ).resolves.toEqual({
        code: "INVALID_ARGUMENT",
        message: "--limit must be a positive integer no greater than 100",
      });
    },
  );

  it("rejects non-decimal timeouts", async () => {
    await expect(rejection(["thread", "wait", "abc", "--timeout-ms", "1e3"])).resolves.toEqual({
      code: "INVALID_ARGUMENT",
      message: "--timeout-ms must be a positive integer",
    });
  });
});
