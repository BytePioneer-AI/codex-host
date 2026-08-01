import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { PiRpcClient } from "./rpc-client.mjs";

const fakePi = path.resolve(import.meta.dirname, "fixtures/fake-pi.mjs");

function client(scenario, options = {}) {
  return new PiRpcClient({
    configuredCommand: [process.execPath, fakePi],
    env: { ...process.env, CODEXHOST_FAKE_PI_SCENARIO: scenario },
    commandTimeoutMs: 1_000,
    pendingCloseMs: 10,
    closeGraceMs: 100,
    forceGraceMs: 2_000,
    ...options,
  });
}

async function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

describe("Gate C Pi RPC client", () => {
  it("correlates concurrent responses and preserves unknown event order", async () => {
    const rpc = client("interleaved");
    await rpc.start();
    const [first, second] = await Promise.all([
      rpc.send({ type: "echo", value: 1 }),
      rpc.send({ type: "echo", value: 2 }),
    ]);
    expect(first.data.echoed).toBe(1);
    expect(second.data.echoed).toBe(2);
    expect(await waitUntil(() => rpc.events.length === 6)).toBe(true);
    expect(rpc.events.map(({ type }) => type)).toEqual([
      "unknown_future_event",
      "agent_start",
      "agent_settled",
      "unknown_future_event",
      "agent_start",
      "agent_settled",
    ]);
    await rpc.close();
  });

  it("fails pending requests on malformed stdout", async () => {
    const rpc = client("malformed");
    await rpc.start();
    await expect(rpc.send({ type: "echo" })).rejects.toMatchObject({ code: "MALFORMED_FRAME" });
    await expect(rpc.send({ type: "echo" })).rejects.toMatchObject({ code: "MALFORMED_FRAME" });
    await rpc.close();
  });

  it("fails pending requests when a frame exceeds the configured byte limit", async () => {
    const rpc = client("oversized-frame", { maxFrameBytes: 64 });
    await rpc.start();
    await expect(rpc.send({ type: "echo" })).rejects.toMatchObject({
      code: "FRAME_TOO_LARGE",
    });
    await rpc.close();
  });

  it("rejects unknown response ids instead of hanging", async () => {
    const rpc = client("unknown-response");
    await rpc.start();
    await expect(rpc.send({ type: "echo" })).rejects.toMatchObject({ code: "UNKNOWN_RESPONSE" });
    await rpc.close();
  });

  it("rejects duplicate response ids as a protocol fault", async () => {
    const rpc = client("duplicate-response");
    await rpc.start();
    await rpc.send({ type: "echo" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(rpc.send({ type: "echo" })).rejects.toMatchObject({
      code: "DUPLICATE_RESPONSE",
    });
    await rpc.close();
  });

  it("preserves UTF-8 when a frame is emitted one byte at a time", async () => {
    const rpc = client("chunked-utf8");
    await rpc.start();
    const response = await rpc.send({ type: "echo" });
    expect(response.data).toBe("A-utf8-漢字-B");
    await rpc.close();
  });

  it("fails all pending requests with the same process exit fact", async () => {
    const rpc = client("crash");
    await rpc.start();
    const results = await Promise.allSettled([
      rpc.send({ type: "one" }),
      rpc.send({ type: "two" }),
    ]);
    expect(results.every(({ status }) => status === "rejected")).toBe(true);
    expect(results.map(({ reason }) => reason.code)).toEqual(["PROCESS_EXIT", "PROCESS_EXIT"]);
    expect(results.map(({ reason }) => reason.details.code)).toEqual([23, 23]);
    await rpc.close();
  });

  it("fails pending requests when protocol stdout reaches EOF", async () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 999_999_999;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => true;
    child.stdin.once("data", () => child.stdout.end());
    child.stdin.once("finish", () => {
      child.exitCode = 0;
      child.emit("exit", 0, null);
    });
    const rpc = client("normal", {
      spawnProcess: () => {
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
    });
    await rpc.start();
    await expect(rpc.send({ type: "echo" })).rejects.toMatchObject({ code: "PROTOCOL_EOF" });
    await rpc.close();
  });

  it("bounds stderr diagnostics", async () => {
    const rpc = client("stderr", { stderrLimitBytes: 12 });
    await rpc.start();
    await rpc.send({ type: "echo" });
    expect(Buffer.byteLength(rpc.stderr)).toBeLessThanOrEqual(12);
    await rpc.close();
  });

  it("times out commands and force-closes a process that refuses EOF", async () => {
    const rpc = client("refuse-close", { commandTimeoutMs: 50 });
    await rpc.start();
    await expect(rpc.send({ type: "echo" })).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    await expect(rpc.close()).resolves.toMatchObject({});
    expect(rpc.state).toBe("closed");
  });

  it("honors stdin backpressure without blocking bounded shutdown", async () => {
    const rpc = client("backpressure", { commandTimeoutMs: 50 });
    await rpc.start();
    await expect(
      rpc.send({ type: "echo", value: "x".repeat(2 * 1024 * 1024) }),
    ).rejects.toMatchObject({
      code: "REQUEST_TIMEOUT",
    });
    await rpc.close();
  });

  it("force-closes a tracked descendant with the RPC process tree", async () => {
    const rpc = client("spawn-child-refuse-close");
    await rpc.start();
    const response = await rpc.send({ type: "echo" });
    const childPid = response.data.childPid;
    expect(await processExists(childPid)).toBe(true);
    await rpc.close();
    expect(await waitUntil(async () => !(await processExists(childPid)))).toBe(true);
  });
});
