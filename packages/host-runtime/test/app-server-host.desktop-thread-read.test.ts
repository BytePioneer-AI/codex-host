import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import {
  DELEGATION_READ_METHOD,
  DESKTOP_THREAD_READ_METHOD,
  DESKTOP_THREAD_READ_REPLY_METHOD,
} from "@codexhost/shared-contracts";
import type { JsonObject } from "@codexhost/protocol-core";
import { DelegationControlRegistry } from "../src/delegation-control-registry.js";
import { startDelegationControlServer } from "../src/delegation-control-server.js";
import { runDelegationCli } from "../src/delegation-cli.js";
import {
  createFixture,
  startPiThread,
  completePiTurn,
  stopFixture,
  readJsonLine,
  writeRequest,
  requestId,
} from "./app-server-host-fixture.js";

it.each([
  ["codex", 1],
  ["pi", 1],
  ["codex", 2],
  ["pi", 2],
] as const)(
  "falls back from CLI local-not-loaded to %s history with %i registered connections",
  async (harnessId, connectionCount) => {
    const registry = new DelegationControlRegistry();
    const remotes = Array.from({ length: connectionCount }, () =>
      createFixture({ onDelegationApi: (api) => registry.register(api) }),
    );
    const remote = remotes[0];
    if (!remote) throw new Error("Remote fixture is missing");
    const desktop = createFixture();
    const server = await startDelegationControlServer({ api: registry, token: "fixture" });
    try {
      await Promise.all([...remotes.map((session) => session.ready), desktop.ready]);
      const target = harnessId === "pi" ? await startPiThread(desktop) : "native-target";
      if (harnessId === "pi") await completePiTurn(desktop, target, 2);
      const output = new PassThrough();
      const diagnostics = new PassThrough();
      const reading = runDelegationCli({
        arguments: [
          "thread",
          "read",
          `thread://${target}?hostId=local`,
          "--view",
          "messages",
          "--limit",
          "2",
          "--format",
          "compact",
        ],
        environment: {
          CODEXHOST_RUNTIME_ENDPOINT: server.endpoint,
          CODEXHOST_RUNTIME_TOKEN: "fixture",
        },
        output,
        diagnosticOutput: diagnostics,
      });
      for (const session of remotes) {
        const nativeRead = await readJsonLine(session.official.stdin);
        expect(nativeRead).toMatchObject({ method: "thread/read", params: { threadId: target } });
        writeRequest(session.official.stdout, {
          id: nativeRead.id ?? null,
          error: { code: -32603, message: `thread not loaded: ${target}` },
        });
      }
      const callback = await remote.collector.waitFor(
        (message) => message.method === DESKTOP_THREAD_READ_METHOD,
      );
      const params = callback.params as JsonObject;
      expect(params.input).toEqual({ threadId: target, view: "messages", limit: 2 });
      // Desktop relays only the fixed local read, not another CLI request (no fallback loop).
      writeRequest(desktop.desktopInput, {
        id: 10,
        method: DELEGATION_READ_METHOD,
        params: params.input ?? null,
      });
      if (harnessId === "codex") {
        const localRead = await readJsonLine(desktop.official.stdin);
        expect(localRead).toMatchObject({
          method: "thread/read",
          params: { threadId: target, includeTurns: true },
        });
        writeRequest(desktop.official.stdout, {
          id: localRead.id ?? null,
          result: {
            thread: {
              id: target,
              turns: [
                {
                  id: "turn",
                  status: "completed",
                  items: [{ id: "answer", type: "agentMessage", text: "answer 2" }],
                },
              ],
            },
          },
        });
      }
      const snapshot = await desktop.collector.waitFor((message) => requestId(message, 10));
      expect(snapshot).not.toHaveProperty("error");
      writeRequest(remote.desktopInput, {
        id: 20,
        method: DESKTOP_THREAD_READ_REPLY_METHOD,
        params: { requestId: params.requestId ?? null, result: snapshot.result ?? null },
      });
      expect(await reading, diagnostics.read()?.toString()).toBe(0);
      expect(JSON.parse(String(output.read()))).toMatchObject({
        thread: `thread://${target}?hostId=local`,
        readSource: "connected-desktop",
        harnessId,
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "agent", text: "answer 2" }),
        ]),
      });
      expect(await remote.collector.waitFor((message) => requestId(message, 20))).toMatchObject({
        result: null,
      });
    } finally {
      await server.close();
      registry.close();
      await Promise.all(remotes.map((session) => stopFixture(session)));
      await stopFixture(desktop);
    }
  },
);

it("preserves native read errors on the fixed Desktop read RPC", async () => {
  const f = createFixture();
  try {
    await f.ready;
    writeRequest(f.desktopInput, {
      id: 1,
      method: DELEGATION_READ_METHOD,
      params: { threadId: "missing", view: "result" },
    });
    const read = await readJsonLine(f.official.stdin);
    writeRequest(f.official.stdout, {
      id: read.id ?? null,
      error: { code: -32603, message: "thread not loaded: missing" },
    });
    await expect(f.collector.waitFor((message) => requestId(message, 1))).resolves.toMatchObject({
      error: { message: "Official Thread read failed: thread not loaded: missing" },
    });
    expect(
      f.collector.messages.some((message) => message.method === DESKTOP_THREAD_READ_METHOD),
    ).toBe(false);
  } finally {
    await stopFixture(f);
  }
});
