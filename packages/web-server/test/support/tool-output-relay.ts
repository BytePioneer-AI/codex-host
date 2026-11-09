/** Real relay/TLS ingress with an isolated fake CH source, shared by output integration checks. */
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { TestContext } from "node:test";
import type { WebAccessState } from "@codexhost/shared-contracts";
import { relayIdentity } from "../../src/remote-relay/identity.ts";
import { FakeChChannel, startFakeChChannel } from "./ch-channel.ts";
import { startFakeChDebugger } from "./ch-host.ts";
import { startServer } from "./server.ts";
import { acmeServer } from "./acme-server.ts";
import { certPath, keyPath, relayData, startRelay, delay } from "./relay.ts";

export async function toolOutputRelay(t: TestContext) {
  const ca = await acmeServer(t, ({ reply }) => {
    reply(503, { detail: "isolated CA" });
    return true;
  });
  const relay = await startRelay(t);
  const data = relayData(t);
  const host = new FakeChChannel();
  const row = host.add("large-tool", data.root, "Large tool output");
  const output = Array.from(
    { length: 10_000 },
    (_, i) => `Diagnostic line ${i}: ${Math.imul(i + 19, 2654435761) >>> 0}\n`,
  ).join("");
  row.turns = [
    {
      id: "tool-turn",
      status: "completed",
      items: [
        { id: "u", type: "userMessage", content: [{ type: "text", text: "Inspect diagnostics" }] },
        {
          id: "command",
          type: "commandExecution",
          command: "inspect-diagnostics",
          cwd: data.root,
          status: "completed",
          aggregatedOutput: output,
          exitCode: 0,
        },
        { id: "a", type: "agentMessage", text: "Diagnostics ready", phase: "final_answer" },
      ],
    },
  ];
  host.add("other-thread", data.root, "Other thread");
  const debug = await startFakeChDebugger(host);
  t.after(() => debug.close());
  const channel = await startFakeChChannel(host, data.root);
  t.after(() => channel.close());
  const endpoint = `remote-relay/endpoints/${encodeURIComponent(`localhost:${relay.port}`)}`;
  mkdirSync(data.path(endpoint), { recursive: true });
  copyFileSync(certPath, data.path(endpoint, "certificate.pem"));
  copyFileSync(keyPath, data.path("remote-relay/certificate-key.pem"));
  data.writeJson("service.json", { relayHost: `localhost:${relay.port}`, relayEnabled: true });
  const local = new URL(
    await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      ["--data", data.root, "--ch-cdp", debug.endpoint, "--ch-control-directory", data.root],
      {
        authenticated: true,
        environment: {
          NODE_EXTRA_CA_CERTS: certPath,
          HTTPS_PROXY: "",
          https_proxy: "",
          CODEXHOST_RELAY_ACME_DIRECTORY: ca.directory,
        },
      },
    ),
  );
  const localToken = local.searchParams.get("token") as string;
  const access = async (): Promise<WebAccessState> => {
    const response = await fetch(new URL("/api/codexhost/accessTokenGet", local), {
      method: "POST",
      headers: { authorization: `Bearer ${localToken}` },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "access",
        method: "codexhost/accessTokenGet",
        payload: { args: {} },
      }),
    });
    return (await response.json()).result.value;
  };
  let state = await access();
  for (let i = 0; state.relay?.state.status === "connecting" && i < 100; i++) {
    await delay(20);
    state = await access();
  }
  assert.equal(state.relay?.state.status, "connected");
  const hostname = `${relayIdentity(data).id}.relay.test`;
  return {
    host,
    row,
    output,
    data,
    relay,
    local,
    localToken,
    secret: state.secret,
    hostname,
    origin: `https://${hostname}`,
  };
}
