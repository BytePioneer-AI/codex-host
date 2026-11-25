import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";
import { GrokAcpTransport, type GrokTransportEvent } from "../src/acp-transport.js";

// The executable fixture uses a POSIX shebang, which Windows cannot launch directly.
describe.skipIf(process.platform === "win32")("Grok live ACP usage wire", () => {
  it("receives underscore-prefixed native response and tool-input notifications", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-acp-usage-"));
    const command = path.join(root, "fixture.mjs");
    await writeFile(
      command,
      `#!${process.execPath}
import { createInterface } from 'node:readline';
const send = (value) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
createInterface({input:process.stdin}).on('line', line => {
 const request = JSON.parse(line);
 if(request.method==='initialize') send({id:request.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});
 else if(request.method==='session/new') send({id:request.id,result:{sessionId:'fixture'}});
 else if(request.method==='_x.ai/session/usage' && request.params.sessionId==='fixture') send({id:request.id,result:{usage:{costUsdTicks:100000000}}});
 else if(request.method==='session/set_model') send({id:request.id,result:{_meta:{model:request.params._meta?.contextWindow===500000?{Ok:request.params.modelId}:{Err:'contextWindow must be in _meta'}}}});
 else if(request.method==='session/prompt') {
  const update = (sessionId, value) => send({method:'_x.ai/session_notification',params:{sessionId,update:value}});
  update('foreign', {sessionUpdate:'response_completed',usage:{output_tokens:999}});
  update('fixture', {sessionUpdate:'tool_call_delta_chunk',tool_index:0,arguments_delta:'{"command":'});
  update('fixture', {sessionUpdate:'response_completed',message_id:'request-one',usage:{input_tokens:80,output_tokens:20,cache_read_input_tokens:20,cache_creation_input_tokens:0,reasoning_tokens:5}});
  send({id:request.id,result:{stopReason:'end_turn'}});
 }
});
`,
      { mode: 0o755 },
    );
    const transport = new GrokAcpTransport({
      cwd: root,
      command,
      environment: { HOME: root, GROK_HOME: root },
      commandTimeoutMs: 3000,
      closeTimeoutMs: 100,
    });
    try {
      await transport.open({
        kind: "create",
        permissionModeId: harnessPermissionModeIdSchema.parse("ask"),
      });
      expect(await transport.getUsage()).toEqual({ costUsdTicks: 100000000 });
      await transport.setModel("grok-4.7", "high", 500000);
      const events: GrokTransportEvent[] = [];
      await transport.runTurn(
        "fixture",
        (event) => events.push(event),
        async () => ({ outcome: { outcome: "cancelled" } }),
      );
      expect(events).toEqual([
        { type: "tool.input.delta", text: '{"command":' },
        {
          type: "response.completed",
          messageId: "request-one",
          usage: {
            input_tokens: 80,
            output_tokens: 20,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 0,
            reasoning_tokens: 5,
          },
        },
      ]);
    } finally {
      await transport.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
