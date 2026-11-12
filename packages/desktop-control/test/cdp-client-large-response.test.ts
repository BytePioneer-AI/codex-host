import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { expect, it } from "vitest";
import { CdpClient } from "../src/cdp-client.js";
import { remoteConnectionsExpression } from "../src/remote-connections-control.js";
import type { RemoteSessionOperation } from "@codexhost/shared-contracts";

it("receives a fragmented multi-megabyte history response and keeps the CDP connection usable", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });
  await once(server, "listening");
  const history = "history-历史-".repeat(600_000);
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(String(data)) as { id: number; method: string };
      if (request.method !== "Runtime.evaluate") {
        socket.send(JSON.stringify({ id: request.id, result: { accepted: true } }));
        return;
      }
      const reply = Buffer.from(
        JSON.stringify({
          id: request.id,
          result: { result: { type: "object", value: { history } } },
        }),
      );
      // CDP can fragment a large response, including across a UTF-8 code point.
      for (let offset = 0; offset < reply.length; offset += 1_048_576) {
        socket.send(reply.subarray(offset, offset + 1_048_576), {
          binary: false,
          fin: offset + 1_048_576 >= reply.length,
        });
        if (offset === 0) socket.ping();
      }
    });
  });
  let client: CdpClient | undefined;
  try {
    const address = server.address() as AddressInfo;
    client = await CdpClient.connect(`ws://127.0.0.1:${address.port}/devtools/page/history`, {
      commandTimeoutMs: 10_000,
    });
    expect((await client.evaluate<{ history: string }>("history")).history).toBe(history);
    await expect(client.command("Runtime.enable")).resolves.toEqual({ accepted: true });
  } finally {
    client?.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 15_000);

it.skipIf(!process.env.CODEXHOST_TEST_CDP_BROWSER)(
  "receives a large real Chromium CDP result",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codexhost-cdp-history-"));
    const executablePath = process.env.CODEXHOST_TEST_CDP_BROWSER;
    const browser = await chromium.launchPersistentContext(directory, {
      ...(executablePath ? { executablePath } : {}),
      headless: true,
      args: ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"],
    });
    let client: CdpClient | undefined;
    try {
      const port = (await readFile(path.join(directory, "DevToolsActivePort"), "utf8")).split(
        "\n",
      )[0];
      await browser.pages()[0]?.goto(`http://127.0.0.1:${port}/json/version`);
      const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
        type: string;
        webSocketDebuggerUrl: string;
      }>;
      const target = targets.find((candidate) => candidate.type === "page");
      if (!target) throw new Error("Missing isolated Chromium page");
      client = await CdpClient.connect(target.webSocketDebuggerUrl);
      const value = await client.evaluate<string>("'history-\\u5386\\u53f2-'.repeat(600000)");
      expect(value.length).toBe("history-历史-".length * 600_000);
      await expect(client.evaluate("6*7")).resolves.toBe(42);
      await client.evaluate(`(()=>{
        window.fixtureSends=[];
        const manager={
          getConversation:()=>({requests:[]}),
          async sendRequest(method,params){
            if(method==='thread/resume'&&params.excludeTurns!==true)
              throw Error('Native resume must not transfer unbounded history');
            if(method==='thread/read') return {thread:{id:params.threadId,turns:[{
              id:'history',items:[{type:'agentMessage',text:params.threadId==='oversized'
                ? 'x'.repeat(17*1024*1024)
                : window.fixtureSends.length?'history-\\u5386\\u53f2-'.repeat(600000):'small'}]
            }]}};
            if(method==='turn/start'){window.fixtureSends.push(params.threadId);return {accepted:true}}
            return {};
          }
        };
        const route={manager};
        window.__codexhostHostRoutingV1={knownHostIds:()=>['remote-ssh-discovered:fixture'],forHost:()=>route};
        return true;
      })()`);
      const activeClient = client;
      const call = (operation: RemoteSessionOperation) =>
        activeClient.evaluate<{
          result?: { epoch: string; result: { thread: { id: string } } };
          error?: { code: number };
        }>(remoteConnectionsExpression({ action: "session", operation }));
      for (const threadId of ["a", "b", "c", "a"]) {
        const snapshot = await call({
          kind: "read",
          hostId: "remote-ssh-discovered:fixture",
          threadId,
        });
        expect(snapshot.error).toBeUndefined();
        expect(snapshot.result?.result.thread.id).toBe(threadId);
        if (!snapshot.result) throw new Error("Missing fixture snapshot");
        const sent = await call({
          kind: "prompt",
          hostId: "remote-ssh-discovered:fixture",
          threadId,
          epoch: snapshot.result.epoch,
          text: "isolated regression",
        });
        expect(sent.error).toBeUndefined();
      }
      expect(
        (
          await call({
            kind: "read",
            hostId: "remote-ssh-discovered:fixture",
            threadId: "oversized",
          })
        ).error?.code,
      ).toBe(-32094);
      const recovered = await call({
        kind: "read",
        hostId: "remote-ssh-discovered:fixture",
        threadId: "b",
      });
      if (!recovered.result) throw new Error("Unrelated fixture Thread became unavailable");
      expect(
        (
          await call({
            kind: "prompt",
            hostId: "remote-ssh-discovered:fixture",
            threadId: "b",
            epoch: recovered.result.epoch,
            text: "after oversized history",
          })
        ).error,
      ).toBeUndefined();
      expect(await client.evaluate("window.fixtureSends")).toEqual(["a", "b", "c", "a", "b"]);
    } finally {
      client?.close();
      await browser.close();
      if (!path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep))
        throw new Error("Unexpected test directory");
      await rm(directory, { recursive: true, force: true });
    }
  },
  20_000,
);
