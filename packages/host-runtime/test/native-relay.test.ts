import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { OfficialRuntimeScope } from "../src/codex-runtime/official-runtime-scope.js";
import { startClientChannelServer } from "../src/client-channel-server.js";
import { sharedNativeBackend, nativeRelaySession } from "../src/native-relay.js";
import { createFixture, stopFixture, JsonLineCollector } from "./app-server-host-fixture.js";

it("keeps native server requests and their replies on the shared execution owner", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-relay-"));
  const fixture = createFixture();
  await fixture.ready;
  const stdin = new PassThrough(),
    stdout = new PassThrough();
  const exit = Promise.withResolvers<{ code: number; signal: null }>();
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
        close: () => stdout.end(),
      }),
      stop: async () => {
        exit.resolve({ code: 0, signal: null });
      },
    }),
  });
  const frames = new JsonLineCollector(stdin);
  stdin.on("data", () => {
    if (frames.messages.at(-1)?.method === "initialize")
      stdout.write(
        JSON.stringify({ id: frames.messages.at(-1)?.id, result: { userAgent: "shared" } }) + "\n",
      );
  });
  const server = await startClientChannelServer({
    environment: { CODEXHOST_DATA_DIR: root },
    owner: "service",
    target: fixture.host,
    nativeSession: (streams) => nativeRelaySession(scope, streams),
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
  } finally {
    await remote.stop();
    await server.close();
    await stopFixture(fixture);
    await rm(root, { recursive: true, force: true });
    await scope.close();
  }
});
