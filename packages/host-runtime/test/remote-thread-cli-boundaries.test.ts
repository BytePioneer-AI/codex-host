import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { runDelegationCli } from "../src/delegation-cli.js";
import { compactDelegationOutput } from "../src/delegation-cli-output.js";

it.each([
  ["read", "thread://t?hostId=mac", "--host", "other"],
  ["read", "thread://t?hostId=mac&hostId=other"],
  ["read", "thread://t?hostId=%ZZ"],
  ["send", "thread://t?hostId=mac", "--message", "hello"],
  ["wait", "t", "--host", "mac"],
])("does not dispatch invalid or unsupported remote arguments: %s %s", async (...args) => {
  const fetchImpl = vi.fn<typeof fetch>();
  expect(
    await runDelegationCli({
      arguments: ["thread", ...args],
      output: new PassThrough(),
      diagnosticOutput: new PassThrough(),
      fetchImpl,
    }),
  ).toBe(1);
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("preserves a remote Host in compact snapshot links", () => {
  expect(
    compactDelegationOutput("thread read", {
      threadId: "t",
      hostId: "remote-ssh-discovered:mac",
      harnessId: "codex",
      status: "completed",
      turn: null,
      progress: [],
      result: { availability: "available", text: "done" },
      nextCursor: null,
    }),
  ).toMatchObject({ thread: "thread://t?hostId=remote-ssh-discovered%3Amac" });
});
