import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { GrokAcpTransport } from "../src/acp-transport.js";
import {
  GROK_CLOCK_ELICIT_FIXTURE,
  GROK_MCP_ELICIT_METHOD,
  grokMcpElicitAccept,
  grokMcpElicitCancel,
} from "../src/grok-elicitation.js";

const permissionModeId = harnessPermissionModeIdSchema.parse("ask");

async function withFixture(
  script: string,
  run: (transport: GrokAcpTransport, capture: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-acp-elicit-"));
  const command = path.join(root, "fixture.mjs");
  const capture = path.join(root, "captured.jsonl");
  await writeFile(command, script.replaceAll("__CAPTURE__", JSON.stringify(capture)), {
    mode: 0o755,
  });
  const transport = new GrokAcpTransport({
    cwd: root,
    command,
    environment: { HOME: root, GROK_HOME: root },
    commandTimeoutMs: 4000,
    closeTimeoutMs: 200,
  });
  try {
    await run(transport, capture);
  } finally {
    await transport.close();
    await rm(root, { recursive: true, force: true });
  }
}

const clockParams = {
  ...GROK_CLOCK_ELICIT_FIXTURE,
  sessionId: "created",
};

describe.skipIf(process.platform === "win32")("Grok ACP MCP elicitation wire", () => {
  it("keeps empty clientCapabilities and replies to _x.ai/mcp/elicit with a flat outcome", async () => {
    await withFixture(
      `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const capture = __CAPTURE__;
const send = (value) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
let promptId;
createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  appendFileSync(capture, line + '\\n');
  if (request.method === 'initialize') {
    send({id:request.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]}});
  } else if (request.method === 'session/new') {
    send({id:request.id,result:{sessionId:'created'}});
  } else if (request.method === 'session/prompt') {
    promptId = request.id;
    send({id:'elicit-1', method:'${GROK_MCP_ELICIT_METHOD}', params:${JSON.stringify(clockParams)}});
  } else if (request.id === 'elicit-1') {
    send({id:promptId,result:{stopReason:'end_turn'}});
  }
});
`,
      async (transport, capture) => {
        await transport.open({ kind: "create", permissionModeId });
        const response = await transport.runTurn(
          "open clock",
          () => undefined,
          async () => ({ outcome: { outcome: "cancelled" } }),
          async () => grokMcpElicitAccept(),
        );
        expect(response).toEqual({ stopReason: "end_turn" });
        const lines = (await readFile(capture, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        const initialize = lines.find((line) => line.method === "initialize");
        expect((initialize?.params as { clientCapabilities?: unknown }).clientCapabilities).toEqual(
          {},
        );
        const elicitReply = lines.find((line) => line.id === "elicit-1");
        expect(elicitReply).toMatchObject({
          id: "elicit-1",
          result: grokMcpElicitAccept(),
        });
        expect(elicitReply && "error" in elicitReply).toBe(false);
      },
    );
  });

  it("cancels elicitation with no active prompt and rejects an unknown extension method", async () => {
    await withFixture(
      `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const capture = __CAPTURE__;
const send = (value) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  appendFileSync(capture, line + '\\n');
  if (request.method === 'initialize') {
    send({id:request.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]}});
  } else if (request.method === 'session/new') {
    send({id:request.id,result:{sessionId:'created'}});
    send({id:'elicit-idle', method:'${GROK_MCP_ELICIT_METHOD}', params:${JSON.stringify(clockParams)}});
    send({id:'unknown-ext', method:'elicitation/create', params:{}});
  }
});
`,
      async (transport, capture) => {
        await transport.open({ kind: "create", permissionModeId });
        await new Promise((resolve) => setTimeout(resolve, 150));
        const lines = (await readFile(capture, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(lines.find((line) => line.id === "elicit-idle")).toMatchObject({
          result: grokMcpElicitCancel(),
        });
        const unknown = lines.find((line) => line.id === "unknown-ext") as {
          error?: { code?: number };
        };
        expect(unknown?.error?.code).toBe(-32601);
      },
    );
  });
});
