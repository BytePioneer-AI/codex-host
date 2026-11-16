import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runDelegationCli } from "../src/delegation-cli.js";
import { MAX_CLI_TEXT_INPUT_BYTES } from "../src/delegation-cli-text-input.js";
import {
  DELEGATION_RUNTIME_ENDPOINT_ENV,
  DELEGATION_RUNTIME_TOKEN_ENV,
  DELEGATION_THREAD_ID_ENV,
  NATIVE_CODEX_THREAD_ID_ENV,
} from "../src/delegation-types.js";

const environment = {
  [DELEGATION_RUNTIME_ENDPOINT_ENV]: "http://127.0.0.1:4321",
  [DELEGATION_RUNTIME_TOKEN_ENV]: "token",
};
const text = "中文 \"double\" 'single' `backticks` $HOME ${value} $(echo nope) \\n\n  indented\n\n";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function invoke(args: string[], stdin?: Readable & { isTTY?: boolean }, env = environment) {
  const output = new PassThrough();
  const diagnosticOutput = new PassThrough();
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true })));
  const code = await runDelegationCli({
    arguments: args,
    environment: env,
    output,
    diagnosticOutput,
    fetchImpl,
    ...(stdin ? { stdin } : {}),
  });
  return {
    code,
    fetchImpl,
    output: output.read()?.toString() ?? "",
    error: diagnosticOutput.read()?.toString() ?? "",
  };
}

const commands = [
  { prefix: ["delegate", "start", "--harness", "pi"], option: "--task", field: "task" },
  { prefix: ["thread", "send", "target"], option: "--message", field: "message" },
];

describe("delegation file and stdin input", () => {
  it.each(commands)(
    "preserves heredoc-style UTF-8 text for $option from stdin and files",
    async ({ prefix, option, field }) => {
      const directory = await mkdtemp(path.join(tmpdir(), "delegation-input-"));
      directories.push(directory);
      const file = path.join(directory, "text.txt");
      await writeFile(file, text, "utf8");
      for (const source of ["-", file]) {
        const result = await invoke(
          [...prefix, `${option}-file`, source],
          Readable.from([Buffer.from(text)]),
        );
        expect(result.code, result.error).toBe(0);
        const request = JSON.parse(String(result.fetchImpl.mock.calls[0]?.[1]?.body));
        expect(request[field]).toBe(text.slice(0, -1));
      }
    },
  );

  it.each(commands)(
    "rejects mutually exclusive $option even with an empty inline value",
    async ({ prefix, option }) => {
      const result = await invoke(
        [...prefix, option, "", `${option}-file`, "-"],
        Readable.from([text]),
      );
      expect(result.code).toBe(1);
      expect(JSON.parse(result.error).error).toMatchObject({
        code: "INVALID_ARGUMENT",
        message: expect.stringContaining("mutually exclusive"),
      });
      expect(result.fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each(commands)(
    "rejects empty, oversized, missing, and unreadable $option-file inputs",
    async ({ prefix, option }) => {
      const directory = await mkdtemp(path.join(tmpdir(), "delegation-input-"));
      directories.push(directory);
      for (const [source, stdin, expected] of [
        ["-", Readable.from([]), "must not be empty"],
        ["-", Readable.from([" \r\n"]), "must not be empty"],
        ["-", Readable.from([Buffer.alloc(MAX_CLI_TEXT_INPUT_BYTES + 1, 97)]), "exceeds"],
        [path.join(directory, "missing"), undefined, "Cannot read"],
        [directory, undefined, "Cannot read"],
      ] as const) {
        const result = await invoke([...prefix, `${option}-file`, source], stdin);
        expect(result.code).toBe(1);
        expect(JSON.parse(result.error).error).toMatchObject({
          code: "INVALID_ARGUMENT",
          message: expect.stringContaining(expected),
        });
        expect(result.fetchImpl).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects a terminal without reading it or waiting", async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const read = vi.spyOn(stdin, "read");
    const result = await invoke(["thread", "send", "target", "--message-file", "-"], stdin);
    expect(result.code).toBe(1);
    expect(result.error).toContain("heredoc");
    expect(read).not.toHaveBeenCalled();
    stdin.destroy();
  });

  it.each(["\n", "\r\n"])(
    "removes exactly one final newline (%j) and accepts the byte limit",
    async (newline) => {
      const content = "a".repeat(MAX_CLI_TEXT_INPUT_BYTES - Buffer.byteLength(newline)) + newline;
      const result = await invoke(
        ["thread", "send", "target", "--message-file", "-"],
        Readable.from([content]),
      );
      expect(result.code).toBe(0);
      expect(JSON.parse(String(result.fetchImpl.mock.calls[0]?.[1]?.body)).message).toBe(
        content.slice(0, -newline.length),
      );
    },
  );

  it.each(commands)(
    "leaves inline $option text unchanged, including final newlines",
    async ({ prefix, option, field }) => {
      const result = await invoke([...prefix, option, text]);
      expect(result.code).toBe(0);
      expect(JSON.parse(String(result.fetchImpl.mock.calls[0]?.[1]?.body))[field]).toBe(text);
    },
  );
});

describe("send CLI options", () => {
  it.each([DELEGATION_THREAD_ID_ENV, NATIVE_CODEX_THREAD_ID_ENV])(
    "passes interrupt and resolved watch parent from %s",
    async (name) => {
      const result = await invoke(
        ["thread", "send", "target", "--interrupt", "--message", "continue", "--watch", "true"],
        undefined,
        { ...environment, [name]: "parent" },
      );
      expect(result.code, result.error).toBe(0);
      expect(JSON.parse(String(result.fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
        threadId: "target",
        message: "continue",
        interrupt: true,
        notifyThreadId: "parent",
        watchTimeoutMs: 1740000,
      });
    },
  );

  it("accepts the bare interrupt flag before the Thread identifier", async () => {
    const result = await invoke([
      "thread",
      "send",
      "--interrupt",
      "target",
      "--message",
      "continue",
    ]);
    expect(result.code, result.error).toBe(0);
  });

  it.each([
    ["--watch", "yes"],
    ["--interrupt=maybe"],
    ["--watch-timeout-ms", "1"],
    ["--watch", "true", "--watch-timeout-ms", "0"],
  ])("rejects invalid send options %j", async (...options) => {
    const result = await invoke(["thread", "send", "target", "--message", "continue", ...options]);
    expect(result.code).toBe(1);
    expect(result.error).toContain("INVALID_ARGUMENT");
    expect(result.fetchImpl).not.toHaveBeenCalled();
  });
});
