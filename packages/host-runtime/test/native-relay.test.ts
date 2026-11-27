import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { OfficialRuntimeScope } from "../src/codex-runtime/official-runtime-scope.js";
import { startClientChannelServer } from "../src/client-channel-server.js";
import { sharedNativeBackend, nativeRelaySession } from "../src/native-relay.js";
import { createRemoteOfficialAppServerConnection } from "../src/remote-official-connection.js";
import { createFixture, stopFixture, JsonLineCollector } from "./app-server-host-fixture.js";

function nativeFixture() {
  const stdin = new PassThrough(),
    stdout = new PassThrough();
  const exit = Promise.withResolvers<{ code: number; signal: null }>();
  const close = vi.fn(() => {
    stdout.end();
  });
  const scope = new OfficialRuntimeScope({
    permanentHome: "/test",
    diagnosticOutput: new PassThrough(),
    createBackend: () => ({
      closed: exit.promise,
      start: async () => {},
      connect: async () => ({
        stdin,
        stdout,
        stderr: new PassThrough(),
        closed: new Promise(() => {}),
        close,
      }),
      stop: async () => {
        exit.resolve({ code: 0, signal: null });
      },
    }),
  });
  const frames = new JsonLineCollector(stdin);
  return { scope, stdin, stdout, frames, close };
}

function localRelay() {
  const backend = nativeFixture();
  const input = new PassThrough(),
    output = new PassThrough();
  const relay = nativeRelaySession(backend.scope, {
    input,
    output,
    diagnosticOutput: new PassThrough(),
  });
  const replies = new JsonLineCollector(output);
  const running = relay.run();
  input.write('{"id":1,"method":"initialize","params":{}}\n');
  return { ...backend, input, output, replies, relay, running };
}

it("releases the client when the viewer leaves during initialization", async () => {
  const f = localRelay();
  try {
    await f.frames.waitFor((v) => v.method === "initialize");
    f.relay.disconnect();
    f.relay.close();
    await expect(f.running).resolves.toBe(0);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.scope.owner.running).toBe(true);
  } finally {
    f.relay.close();
    await f.scope.close();
  }
});

it("keeps the native owner available when the viewer's output fails", async () => {
  const f = localRelay();
  try {
    const init = await f.frames.waitFor((v) => v.method === "initialize");
    f.stdout.write(JSON.stringify({ id: init.id, result: {} }) + "\n");
    await f.replies.waitFor((v) => v.id === 1);
    vi.spyOn(f.output, "write").mockImplementationOnce(() => {
      throw new Error("Viewer closed");
    });
    f.stdout.write('{"method":"thread/closed","params":{"threadId":"test"}}\n');
    await expect(f.running).resolves.toBe(0);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.scope.gate.phase).toBe("ready");
  } finally {
    f.relay.close();
    await f.scope.close();
  }
});

it("continues the relay after a retired reply and returns request errors to their caller", async () => {
  const f = localRelay();
  try {
    const init = await f.frames.waitFor((v) => v.method === "initialize");
    f.stdout.write(JSON.stringify({ id: init.id, result: {} }) + "\n");
    await f.replies.waitFor((v) => v.id === 1);
    f.stdout.write('{"id":7,"method":"item/permissions/requestApproval","params":{}}\n');
    const prompt = await f.replies.waitFor((v) => v.method === "item/permissions/requestApproval");
    f.stdout.write('{"method":"serverRequest/resolved","params":{"requestId":7}}\n');
    await f.replies.waitFor((v) => v.method === "serverRequest/resolved");
    f.input.write(JSON.stringify({ id: prompt.id, result: {} }) + "\n");
    f.input.write('{"id":2,"method":"initialize","params":{}}\n');
    expect(await f.replies.waitFor((v) => v.id === 2)).toMatchObject({ error: { code: -32001 } });
    f.input.write('{"id":3,"method":"thread/list","params":{}}\n');
    await f.frames.waitFor((v) => v.id === 3);
    expect(f.frames.messages.some((v) => v.id === 7)).toBe(false);
  } finally {
    f.relay.close();
    await f.running;
    await f.scope.close();
  }
});

it("keeps native server requests and their replies on the shared execution owner", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-relay-"));
  const fixture = createFixture();
  await fixture.ready;
  const { stdin, stdout, scope, frames } = nativeFixture();
  stdin.on("data", () => {
    if (frames.messages.at(-1)?.method === "initialize")
      stdout.write(
        JSON.stringify({ id: frames.messages.at(-1)?.id, result: { userAgent: "shared" } }) + "\n",
      );
  });
  let stopping = false;
  const server = await startClientChannelServer({
    environment: { CODEXHOST_DATA_DIR: root },
    owner: "service",
    target: fixture.host,
    nativeSession: (streams) => nativeRelaySession(scope, streams),
    shutdown: {
      runningTasks: () => 0,
      stop: () => {
        stopping = true;
      },
      isStopping: () => stopping,
    },
  });
  const remote = sharedNativeBackend(root);
  try {
    await remote.start();
    const connection = await remote.connect();
    const input = connection.stdin;
    const replies = new JsonLineCollector(connection.stdout);
    input.write('{"id":8,"method":"initialize","params":{}}\n');
    await expect
      .poll(() => replies.messages)
      .toContainEqual({ id: 8, result: { userAgent: "shared" } });
    stdout.write(
      '{"id":42,"method":"item/permissions/requestApproval","params":{"threadId":"same"}}\n',
    );
    await expect.poll(() => replies.messages.length).toBe(2);
    input.write(
      JSON.stringify({ id: replies.messages[1]?.id, result: { decision: "decline" } }) + "\n",
    );
    await expect
      .poll(() => frames.messages)
      .toContainEqual({ id: 42, result: { decision: "decline" } });
    connection.close();
    await connection.closed;
    await remote.stop();
    expect(scope.owner.running).toBe(true);
    stopping = true;
    const endpoint = `ws://127.0.0.1:${server.descriptor.port}`;
    const options = { capabilityToken: server.descriptor.token };
    await expect(
      createRemoteOfficialAppServerConnection(endpoint + "/v1/native", options),
    ).rejects.toThrow("HTTP 503");
    await expect(
      createRemoteOfficialAppServerConnection(endpoint + "/missing", options),
    ).rejects.toThrow("HTTP 404");
  } finally {
    await remote.stop();
    await server.close();
    await stopFixture(fixture);
    await rm(root, { recursive: true, force: true });
    await scope.close();
  }
});
