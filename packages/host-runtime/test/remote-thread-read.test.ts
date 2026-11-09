import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { runDelegationCli } from "../src/delegation-cli.js";

it("preserves the explicit Host in a Desktop thread reference", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}"));
  const code = await runDelegationCli({
    arguments: [
      "thread",
      "read",
      "thread://remote-thread?hostId=remote-ssh-discovered%3Amac",
      "--view",
      "messages",
    ],
    environment: {
      CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:1234",
      CODEXHOST_RUNTIME_TOKEN: "fixture",
    },
    output: new PassThrough(),
    diagnosticOutput: new PassThrough(),
    fetchImpl,
  });
  expect(code).toBe(0);
  expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
    threadId: "remote-thread",
    hostId: "remote-ssh-discovered:mac",
    view: "messages",
  });
});
