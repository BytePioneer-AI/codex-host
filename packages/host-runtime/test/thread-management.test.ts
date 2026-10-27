import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { THREAD_MANAGE_METHOD, type ThreadManagementOperation } from "@codexhost/shared-contracts";
import { ThreadBridge } from "../src/thread-bridge.js";
import { ThreadSendReceipts } from "../src/thread-send-receipts.js";
import { runDelegationCli } from "../src/delegation-cli.js";
import { OfficialRuntimeScope } from "../src/codex-runtime/official-runtime-scope.js";
import type { DelegationControlRegistration } from "../src/delegation-types.js";
import {
  createFixture,
  stopFixture,
  writeRequest,
  requestId,
  readJsonLine,
  requiredMessageId,
} from "./app-server-host-fixture.js";

const machineId = randomUUID();
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function receipts() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thread-management-"));
  directories.push(directory);
  return new ThreadSendReceipts(directory);
}

it("recovers the same created Thread after restart and rejects changed payloads", async () => {
  const store = await receipts();
  const input = {
    expectedMachineId: machineId,
    requestId: randomUUID(),
    action: { operation: "create", cwd: "/work", harnessId: "codex" } as const,
  };
  const create = vi.fn(async () => ({ operation: "create" as const, threadId: "created" }));
  expect(await store.manage(input, create)).toEqual({
    result: { operation: "create", threadId: "created" },
  });
  expect(await new ThreadSendReceipts(store.directory).manage(input, create)).toHaveProperty(
    "result.threadId",
    "created",
  );
  expect(
    await store.manage({ ...input, action: { ...input.action, cwd: "/different" } }, create),
  ).toHaveProperty("error.code", "INVALID_ARGUMENT");
  expect(create).toHaveBeenCalledOnce();
});

it("does not repeat a create whose reply was lost", async () => {
  const store = await receipts();
  const input = {
    expectedMachineId: machineId,
    requestId: randomUUID(),
    action: { operation: "create", cwd: "/work", harnessId: "codex" } as const,
  };
  const create = vi.fn(async () => {
    throw new Error("connection lost");
  });
  expect(await store.manage(input, create)).toHaveProperty("error.code", "OUTCOME_UNKNOWN");
  expect(await new ThreadSendReceipts(store.directory).manage(input, create)).toHaveProperty(
    "error.code",
    "OUTCOME_UNKNOWN",
  );
  expect(create).toHaveBeenCalledOnce();
});

it("reads an empty native Thread and sends its first Turn without resuming a missing rollout", async () => {
  let api: DelegationControlRegistration | undefined;
  const fixture = createFixture({
    onDelegationApi: (registration) => {
      api = registration;
      return undefined;
    },
  });
  try {
    await fixture.ready;
    if (!api) throw new Error("Missing registration");
    for (const operation of ["read", "send"] as const) {
      const result =
        operation === "read"
          ? api.read({ threadId: "fresh", view: "messages" })
          : api.send({ threadId: "fresh", message: "first task" });
      const read = await readJsonLine(fixture.official.stdin);
      expect(read).toMatchObject({ method: "thread/read", params: { includeTurns: true } });
      writeRequest(fixture.official.stdout, {
        id: requiredMessageId(read),
        error: {
          code: -32600,
          message:
            "thread fresh is not materialized yet; includeTurns is unavailable before first user message",
        },
      });
      const metadata = await readJsonLine(fixture.official.stdin);
      expect(metadata).toMatchObject({ method: "thread/read", params: { includeTurns: false } });
      writeRequest(fixture.official.stdout, {
        id: requiredMessageId(metadata),
        result: { thread: { id: "fresh", status: { type: "idle" }, turns: [] } },
      });
      if (operation === "send") {
        const start = await readJsonLine(fixture.official.stdin);
        expect(start).toMatchObject({
          method: "turn/start",
          params: { threadId: "fresh", input: [{ type: "text", text: "first task" }] },
        });
        writeRequest(fixture.official.stdout, {
          id: requiredMessageId(start),
          result: { turn: { id: "first-turn" } },
        });
        await expect(result).resolves.toHaveProperty("turnId", "first-turn");
      } else await expect(result).resolves.toHaveProperty("messages", []);
    }
  } finally {
    await stopFixture(fixture);
  }
});

it.each([false, true])(
  "validates target identity and native lifecycle operations (shared owner: %s)",
  async (externalOnly) => {
    const closed = Promise.withResolvers<{ code: number; signal: null }>();
    const scope = externalOnly
      ? new OfficialRuntimeScope({
          permanentHome: "/synthetic/home",
          diagnosticOutput: new PassThrough(),
          createBackend: () => ({
            closed: closed.promise,
            start: async () => {},
            connect: async () => ({
              stdin: fixture.official.stdin,
              stdout: fixture.official.stdout,
              stderr: fixture.official.stderr,
              closed: closed.promise,
              close: () => {},
            }),
            stop: async () => {
              closed.resolve({ code: 0, signal: null });
            },
          }),
        })
      : undefined;
    const fixture = createFixture({
      externalOnly,
      ...(scope ? { officialRuntimeScope: scope } : {}),
      threadBridge: new ThreadBridge(machineId, await receipts()),
    });
    try {
      await fixture.ready;
      await scope?.start();
      const create = {
        requestId: randomUUID(),
        expectedMachineId: machineId,
        action: { operation: "create", cwd: "/work", harnessId: "codex" },
      };
      writeRequest(fixture.desktopInput, {
        id: 90,
        method: THREAD_MANAGE_METHOD,
        params: { ...create, expectedMachineId: randomUUID() },
      });
      expect(await fixture.collector.waitFor((m) => requestId(m, 90))).toHaveProperty(
        "result.error.code",
        "INVALID_ARGUMENT",
      );
      expect(fixture.official.stdin.readableLength).toBe(0);
      writeRequest(fixture.desktopInput, { id: 91, method: THREAD_MANAGE_METHOD, params: create });
      if (externalOnly) {
        const initialize = await readJsonLine(fixture.official.stdin);
        expect(initialize.method).toBe("initialize");
        writeRequest(fixture.official.stdout, { id: requiredMessageId(initialize), result: {} });
        expect((await readJsonLine(fixture.official.stdin)).method).toBe("initialized");
      }
      const start = await readJsonLine(fixture.official.stdin);
      expect(start).toMatchObject({
        method: "thread/start",
        params: { cwd: "/work", ephemeral: false, historyMode: "legacy" },
      });
      expect(start.params).not.toHaveProperty("sandbox");
      expect(start.params).not.toHaveProperty("approvalPolicy");
      writeRequest(fixture.official.stdout, {
        id: requiredMessageId(start),
        result: { thread: { id: "new-thread", status: { type: "idle" } } },
      });
      expect(await fixture.collector.waitFor((m) => requestId(m, 91))).toHaveProperty(
        "result.result.threadId",
        "new-thread",
      );
      writeRequest(fixture.desktopInput, { id: 92, method: THREAD_MANAGE_METHOD, params: create });
      expect(await fixture.collector.waitFor((m) => requestId(m, 92))).toHaveProperty(
        "result.result.threadId",
        "new-thread",
      );
      expect(fixture.official.stdin.readableLength).toBe(0);
      const operations: [ThreadManagementOperation, string][] = [
        [{ operation: "rename", threadId: "new-thread", name: "named" }, "thread/name/set"],
        [{ operation: "archive", threadId: "new-thread" }, "thread/archive"],
        [{ operation: "unarchive", threadId: "new-thread" }, "thread/unarchive"],
        [{ operation: "delete", threadId: "new-thread" }, "thread/delete"],
      ];
      let nextId = 100;
      for (const [action, method] of operations) {
        const id = ++nextId;
        writeRequest(fixture.desktopInput, {
          id,
          method: THREAD_MANAGE_METHOD,
          params: { action, requestId: randomUUID(), expectedMachineId: machineId },
        });
        const request = await readJsonLine(fixture.official.stdin);
        expect(request).toMatchObject({ method, params: { threadId: "new-thread" } });
        writeRequest(fixture.official.stdout, { id: requiredMessageId(request), result: {} });
        expect(await fixture.collector.waitFor((m) => requestId(m, id))).toHaveProperty(
          "result.result.operation",
          action.operation,
        );
      }
    } finally {
      await stopFixture(fixture);
      await scope?.close();
    }
  },
);

it.each([
  ["delete", `thread://t?machineId=${machineId}`],
  ["delete", `thread://t?machineId=${machineId}`, "--confirm", "false"],
  ["create", "--on", "thread://t?hostId=local", "--cwd", "/work"],
  ["create", "--machine", "invalid", "--cwd", "/work"],
  ["rename", `thread://t?machineId=${machineId}`, "--name", ""],
])("rejects invalid lifecycle command before dispatch: %s", async (...args) => {
  const fetchImpl = vi.fn<typeof fetch>();
  expect(
    await runDelegationCli({
      arguments: ["thread", ...args],
      fetchImpl,
      output: new PassThrough(),
      diagnosticOutput: new PassThrough(),
    }),
  ).toBe(1);
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("uses the machine in --on for create and returns request ID when the reply is lost", async () => {
  const output = new PassThrough();
  const diagnosticOutput = new PassThrough();
  const id = randomUUID();
  const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("connection lost"));
  expect(
    await runDelegationCli({
      arguments: [
        "thread",
        "create",
        "--on",
        `thread://existing?hostId=local&machineId=${machineId}`,
        "--cwd",
        "/target/work",
        "--request-id",
        id,
      ],
      environment: {
        CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:1",
        CODEXHOST_RUNTIME_TOKEN: "test",
      },
      fetchImpl,
      output,
      diagnosticOutput,
    }),
  ).toBe(1);
  expect(JSON.parse(String(diagnosticOutput.read()))).toMatchObject({
    error: { code: "OUTCOME_UNKNOWN", details: { requestId: id, machineId } },
  });
  const call = fetchImpl.mock.calls[0];
  if (!call) throw new Error("Missing Runtime request");
  const [url, init] = call;
  expect(String(url)).toBe("http://127.0.0.1:1/v1/thread/manage");
  expect(JSON.parse(String(init?.body))).toEqual({
    machineId,
    hostId: "local",
    requestId: id,
    action: { operation: "create", cwd: "/target/work", harnessId: "codex" },
  });
});

it("creates and manages external Threads through their existing ownership handlers", async () => {
  const fixture = createFixture({ threadBridge: new ThreadBridge(machineId, await receipts()) });
  let nextId = 200;
  const manage = async (action: ThreadManagementOperation) => {
    const id = ++nextId;
    writeRequest(fixture.desktopInput, {
      id,
      method: THREAD_MANAGE_METHOD,
      params: { action, requestId: randomUUID(), expectedMachineId: machineId },
    });
    return fixture.collector.waitFor((m) => requestId(m, id));
  };
  try {
    await fixture.ready;
    const created = await manage({ operation: "create", cwd: "/work", harnessId: "pi" });
    const result = created.result as { result: { threadId: string } };
    expect(result.result.threadId).toBeTruthy();
    const threadId = result.result.threadId;
    expect(await manage({ operation: "rename", threadId, name: "external name" })).toHaveProperty(
      "result.result.operation",
      "rename",
    );
    expect(await manage({ operation: "archive", threadId })).toHaveProperty(
      "result.result.operation",
      "archive",
    );
    expect(await manage({ operation: "unarchive", threadId })).toHaveProperty(
      "result.result.operation",
      "unarchive",
    );
    expect(await manage({ operation: "delete", threadId })).toHaveProperty(
      "result.result.operation",
      "delete",
    );
    expect(fixture.official.stdin.readableLength).toBe(0);
  } finally {
    await stopFixture(fixture);
  }
});
