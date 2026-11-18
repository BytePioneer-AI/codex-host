import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { GrokAdapter } from "../src/grok-adapter.js";

// The executable fixture uses a POSIX shebang, which Windows cannot launch directly.
describe.skipIf(process.platform === "win32")("Grok Model catalog inspection over ACP", () => {
  it.each(["updated", "unsupported", "malformed", "authentication error"])(
    "reads the post-initialization catalog: %s",
    async (mode) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "grok-acp-models-"));
      const command = path.join(root, "fixture.mjs");
      const calls = path.join(root, "calls.jsonl");
      await writeFile(
        command,
        `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const send = (value) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
const model = (modelId) => ({modelId, name: modelId, _meta: {reasoningEffort:'high',reasoningEfforts:[{id:'high',label:'High'}]}});
const initial = {currentModelId:'grok-4.6',availableModels:[model('grok-4.6'),model('grok-4.5')]};
const updated = {currentModelId:'grok-4.7-build-fast',availableModels:['grok-4.7','grok-4.7-build-fast','grok-4.6','grok-4.5'].map(model)};
let authenticated = false;
createInterface({input:process.stdin}).on('line', line => {
 const request = JSON.parse(line);
 appendFileSync(${JSON.stringify(calls)}, JSON.stringify(request.method)+'\\n');
 if(request.method==='initialize') send({id:request.id,result:{protocolVersion:1,agentCapabilities:{sessionCapabilities:{list:{}}},_meta:{modelState:initial},authMethods:[]}});
 else if(request.method==='session/list') {
  authenticated = true;
  send({id:request.id,result:{sessions:[]}});
 } else if(request.method==='_x.ai/models/list') {
  if(${JSON.stringify(mode)}==='unsupported') send({id:request.id,error:{code:-32601,message:'Method not found'}});
  else if(${JSON.stringify(mode)}==='authentication error') send({id:request.id,error:{code:-32000,message:'Authentication required'}});
  else send({id:request.id,result:{result:${JSON.stringify(mode)}==='malformed'?{availableModels:[]}:authenticated?updated:initial}});
 } else send({id:request.id,error:{code:-32601,message:'Unexpected method'}});
});
`,
        { mode: 0o755 },
      );
      const adapter = new GrokAdapter({
        command,
        environment: { HOME: root, GROK_HOME: root },
        commandTimeoutMs: 2000,
        closeTimeoutMs: 100,
      });
      try {
        const result = await adapter.inspect({ cwd: root });
        if (mode === "malformed" || mode === "authentication error") {
          expect(result).toMatchObject({
            status: "error",
            error: { code: mode === "malformed" ? "protocolError" : "authenticationRequired" },
          });
        } else {
          expect(result.status).toBe("ready");
          if (result.status !== "ready") throw new Error("Expected a native Model catalog");
          expect(result.catalog.models.map(({ ref }) => ref.id)).toEqual(
            mode === "updated"
              ? ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"]
              : ["grok-4.6", "grok-4.5"],
          );
          expect(result.catalog.defaultModel?.id).toBe(
            mode === "updated" ? "grok-4.7-build-fast" : "grok-4.6",
          );
          expect(result.catalog.defaultThinkingOptionId).toBe("high");
        }
        expect(
          (await readFile(calls, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ).toEqual(["initialize", "session/list", "_x.ai/models/list"]);
      } finally {
        await adapter.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
