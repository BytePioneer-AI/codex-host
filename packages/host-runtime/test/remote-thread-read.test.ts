import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { runDelegationCli } from "../src/delegation-cli.js";
import { formatThreadReference } from "@codexhost/shared-contracts";
import { randomUUID } from "node:crypto";

it("sends to the copied machine with a generated or explicitly reused request ID", async () => {
  const reference = { threadId: "t", hostId: "local", machineId: randomUUID() };
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    const input = JSON.parse(String(init?.body));
    return Response.json({
      ...input,
      turnId: "turn",
      harnessId: "codex",
      status: "running",
      next: { read: "read" },
    });
  });
  const environment = {
    CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:1234",
    CODEXHOST_RUNTIME_TOKEN: "test",
  };
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => {
    text += String(chunk);
  });
  expect(
    await runDelegationCli({
      arguments: [
        "thread",
        "send",
        formatThreadReference(reference),
        "--message",
        "continue",
        "--format",
        "compact",
      ],
      environment,
      fetchImpl,
      output,
    }),
  ).toBe(0);
  const sent = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
  expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/v1/thread/send-scoped");
  expect(sent).toMatchObject({ ...reference, message: "continue", requestId: expect.any(String) });
  expect(JSON.parse(text)).toMatchObject({
    thread: formatThreadReference(reference),
    requestId: sent.requestId,
  });
  expect(
    await runDelegationCli({
      arguments: [
        "thread",
        "send",
        formatThreadReference(reference),
        "--message",
        "continue",
        "--request-id",
        sent.requestId,
      ],
      environment,
      fetchImpl,
      output: new PassThrough(),
    }),
  ).toBe(0);
  expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual(sent);
});

it("returns the generated request ID when a send response is lost", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    throw new Error("connection closed");
  });
  const diagnosticOutput = new PassThrough();
  let text = "";
  diagnosticOutput.on("data", (chunk) => {
    text += String(chunk);
  });
  const reference = { threadId: "t", machineId: randomUUID() };
  expect(
    await runDelegationCli({
      arguments: ["thread", "send", formatThreadReference(reference), "--message", "continue"],
      environment: {
        CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:1234",
        CODEXHOST_RUNTIME_TOKEN: "test",
      },
      fetchImpl,
      diagnosticOutput,
      output: new PassThrough(),
    }),
  ).toBe(1);
  const sent = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
  expect(JSON.parse(text)).toMatchObject({
    error: { code: "OUTCOME_UNKNOWN", details: { requestId: sent.requestId, ...reference } },
  });
});

it("passes machine identity from a copied link and refuses that link for unsupported wait/cancel", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}"));
  const environment = {
    CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:1234",
    CODEXHOST_RUNTIME_TOKEN: "fixture",
  };
  const reference = {
    threadId: "t",
    hostId: "local",
    machineId: "12345678-1234-4123-8123-123456789abc",
  };
  const link = formatThreadReference(reference);
  expect(
    await runDelegationCli({
      arguments: ["thread", "read", link],
      environment,
      fetchImpl,
      output: new PassThrough(),
      diagnosticOutput: new PassThrough(),
    }),
  ).toBe(0);
  expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
    ...reference,
    view: "result",
  });
  expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/v1/thread/read-scoped");
  for (const arguments_ of [
    ["thread", "wait", link],
    ["thread", "cancel", link],
  ]) {
    expect(
      await runDelegationCli({
        arguments: arguments_,
        environment,
        fetchImpl,
        output: new PassThrough(),
        diagnosticOutput: new PassThrough(),
      }),
    ).toBe(1);
  }
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it("does not fall back when a legacy Runtime rejects scoped requests", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () =>
    Response.json(
      { error: { code: "INVALID_ARGUMENT", message: "Unknown Runtime control route" } },
      { status: 400 },
    ),
  );
  const link = formatThreadReference({
    threadId: "same-local-id",
    machineId: randomUUID(),
    hostId: "local",
  });
  for (const command of [
    ["thread", "read", link],
    ["thread", "send", link, "--message", "continue"],
  ]) {
    expect(
      await runDelegationCli({
        arguments: command,
        environment: {
          CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:1234",
          CODEXHOST_RUNTIME_TOKEN: "test",
        },
        fetchImpl,
        output: new PassThrough(),
        diagnosticOutput: new PassThrough(),
      }),
    ).toBe(1);
  }
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(fetchImpl.mock.calls.every(([url]) => String(url).endsWith("-scoped"))).toBe(true);
});

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
