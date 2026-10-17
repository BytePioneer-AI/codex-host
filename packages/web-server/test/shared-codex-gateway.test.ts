/** Real Web HTTP/mux -> authenticated owner channel -> Codex Adapter -> synthetic native stdio. */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { WebSocket } from "ws";
import { HarnessPreferencesStore } from "@codexhost/harness-plugin-files";
import {
  ClientChannelEvents,
  SharedWebCodexOwner,
  startClientChannelServer,
} from "@codexhost/host-runtime";
import { startServer } from "./support/server.ts";

async function until(test: () => boolean, description: string) {
  const deadline = Date.now() + 8000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function rpc<T>(
  url: string,
  method: string,
  request: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(new URL(`api/${method}`, url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "client-request",
      rpcId: "test",
      method,
      payload: { args: { request } },
    }),
  });
  const value = (await response.json()) as {
    result: { ok: boolean; value: T; error?: { code: string; message: string } };
  };
  assert.ok(value.result.ok, `${method}: ${JSON.stringify(value.result.error)}`);
  return value.result.value;
}
async function mux(url: string, endpoint: string, request: Record<string, unknown>) {
  const socket = new WebSocket(new URL("api/remote.mux", url.replace("http:", "ws:")));
  const frames: Array<Record<string, unknown>> = [];
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.on("message", (data) => frames.push(JSON.parse(String(data))));
  socket.send(
    JSON.stringify({ type: "open", streamId: "test", endpoint, payload: { args: { request } } }),
  );
  return { socket, frames };
}

it(
  "shares isolated Codex across two real gateways and keeps native work alive after one stops",
  { timeout: 30000 },
  async (t) => {
    if (process.platform === "win32") return t.skip("Synthetic CLI uses a POSIX shebang");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "shared-codex-web-")));
    const home = join(root, "isolated-home"),
      command = join(root, "native-agent"),
      log = join(root, "native-rpc.jsonl");
    writeFileSync(
      command,
      `#!${process.execPath}
const {appendFileSync, writeFileSync, existsSync} = require('node:fs');
const {join} = require('node:path');
const {createInterface} = require('node:readline');
if(process.argv.includes('--version')) process.exit(0);
const file=join(process.env.CODEX_HOME,'thread.json');
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const record=method=>appendFileSync(${JSON.stringify(log)},JSON.stringify({method,pid:process.pid,home:process.env.CODEX_HOME})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line); record(request.method); if(request.id===undefined) return;
 let result={};
 if(request.method==='model/list') result={data:[{id:'test-model',displayName:'Test',description:'',hidden:false,isDefault:true,supportedReasoningEfforts:[],defaultReasoningEffort:'medium'}]};
 if(request.method==='thread/start') writeFileSync(file,'isolated-thread');
 if(request.method==='thread/start'||request.method==='thread/resume') result={thread:{id:'isolated-thread'},model:'test-model',reasoningEffort:null};
 if(request.method==='thread/list') result={data:existsSync(file)?[{id:'isolated-thread',name:'Isolated',preview:'',cwd:${JSON.stringify(root)},updatedAt:1,ephemeral:false,parentThreadId:null}]:[]};
 if(request.method==='thread/read') result={thread:{turns:[]}};
 if(request.method==='turn/start') {
   result={turn:{id:'native-turn'}};
   send({id:request.id,result});
   setTimeout(()=>send({method:'turn/started',params:{threadId:'isolated-thread',turn:{id:'native-turn'}}}),20);
   setTimeout(()=>send({method:'item/completed',params:{threadId:'isolated-thread',turnId:'native-turn',item:{id:'answer',type:'agentMessage',text:'Survived gateway shutdown'}}}),650);
   setTimeout(()=>send({method:'turn/completed',params:{threadId:'isolated-thread',turn:{id:'native-turn',status:'completed',error:null}}}),700);
   return;
 }
 send({id:request.id,result});
});
`,
    );
    chmodSync(command, 0o700);
    const environment = {
      HOME: root,
      CODEX_HOME: join(root, "gui-home"),
      CODEXHOST_DATA_DIR: root,
    };
    const events = new ClientChannelEvents();
    const preferences = new HarnessPreferencesStore(root);
    const prefs = async (method: string, params: Record<string, unknown>) =>
      method.endsWith("/get")
        ? preferences.get(params.scope as never)
        : preferences.patch(params as never);
    const owner = new SharedWebCodexOwner(
      environment,
      events,
      async (id) => id === "gui-official",
      prefs,
    );
    const externalRequests: string[] = [];
    const target = {
      clientEvents: events,
      webCodex: owner,
      async handleClientRequest(method: string, params: unknown) {
        externalRequests.push(method);
        if (method.startsWith("codexhost/harness/preferences/"))
          return { result: await prefs(method, params as Record<string, unknown>) };
        if (method === "thread/list") return { result: { data: [], nextCursor: null } };
        if (method === "codexhost/harness/plugins/list") return { result: { plugins: [] } };
        if (method === "codexhost/workspace/read")
          return { result: { projects: [], assignments: {}, projectless: [], pinned: [] } };
        if (method.endsWith("display-settings/get")) return { result: { entries: null } };
        if (method.endsWith("display-settings/capabilities")) return { result: { events: true } };
        return { error: { code: -32601, message: "Unavailable in external fixture" } };
      },
      async clientSnapshot() {
        throw new Error("Official snapshot must not be requested");
      },
      async respondClient() {
        throw new Error("Official response must not be requested");
      },
    };
    const channel = await startClientChannelServer({ target, environment, owner: "service" });
    t.after(async () => {
      await channel.close();
      await owner.close();
      await preferences.close();
      rmSync(root, { recursive: true, force: true });
    });
    const args = [
      "--session-source",
      "codexhost",
      "--ch-data",
      root,
      "--ch-control-directory",
      join(root, "client-hosts"),
      "--harness",
      "codex",
      "--codex-home",
      home,
      "--codex-command",
      command,
    ];
    let firstChild: ChildProcess | undefined;
    const first = await startServer(
      t,
      resolve("packages/web-server"),
      ["--import", "tsx", "src/main.ts"],
      args,
      {
        onSpawn: (child) => {
          firstChild = child;
        },
      },
    );
    const second = await startServer(
      t,
      resolve("packages/web-server"),
      ["--import", "tsx", "src/main.ts"],
      args,
    );
    const created = await rpc<{ sessionId: string }>(first, "session/create", { cwd: root });
    await rpc(first, "session/selectModel", {
      sessionId: created.sessionId,
      provider: "codex",
      model: "test-model",
    });
    await rpc(first, "session/prompt", {
      sessionId: created.sessionId,
      requestId: "one-submit",
      mode: "queue",
      content: [{ type: "text", text: "Continue through gateway shutdown" }],
    });
    await until(
      () => existsSync(log) && readFileSync(log, "utf8").includes('"turn/start"'),
      "native accepted Turn",
    );
    await until(
      () => existsSync(join(root, "web-codex/sessions/index.json")),
      "owner index persisted",
    );
    await rpc(second, "session/list");
    await rpc(second, "session/prompt", {
      sessionId: created.sessionId,
      requestId: "one-submit",
      mode: "queue",
      content: [{ type: "text", text: "Continue through gateway shutdown" }],
    });
    await assert.rejects(
      rpc(second, "session/prompt", {
        sessionId: created.sessionId,
        requestId: "one-submit",
        mode: "queue",
        content: [{ type: "text", text: "Changed duplicate" }],
      }),
      /request-conflict/,
    );
    assert.ok(firstChild);
    const gatewayProcess = firstChild;
    const stopped = new Promise<void>((resolve) => gatewayProcess.once("exit", () => resolve()));
    gatewayProcess.kill("SIGTERM");
    await stopped;
    const follow = await mux(second, "session/follow", {
      address: { kind: "session", sessionId: created.sessionId },
      assistantStream: true,
    });
    t.after(() => follow.socket.close());
    const journal = join(root, "web-codex/sessions", created.sessionId, "events.jsonl");
    await until(
      () => existsSync(journal) && readFileSync(journal, "utf8").includes('"turn/end"'),
      "owner finishes after gateway shutdown",
    );
    await until(
      () => JSON.stringify(follow.frames).includes("Survived gateway shutdown"),
      "browser follows owner output",
    );
    const listing = await rpc<{ items: Array<{ sessionId: string }> }>(second, "session/list");
    assert.ok(listing.items.some((item) => item.sessionId === created.sessionId));
    assert.equal(
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.includes('"turn/start"')).length,
      1,
    );
    for (const entry of readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)))
      assert.equal(entry.home, home);
    assert.equal(externalRequests.includes("thread/start"), false);
    const control = await mux(second, "session/control", {});
    t.after(() => control.socket.close());
    await until(
      () => JSON.stringify(control.frames).includes(created.sessionId),
      "control baseline contains isolated Session",
    );
    assert.ok(JSON.stringify(control.frames).includes("baseline"));
    const configured = await owner.configure({
      home,
      command,
      pluginRoots: [resolve("packages/adapters")],
    });
    for (const input of [
      { request: { sessionId: "gui-official", provider: "fake" } },
      { _request: { home: join(root, "gui-home") } },
      { provider: "fake" },
    ])
      await assert.rejects(
        owner.request({
          epoch: configured.cursor.epoch,
          address: { scope: configured.scope, sessionId: created.sessionId },
          operation: "selectModel",
          input,
        }),
      );
    await assert.rejects(
      owner.request({
        epoch: configured.cursor.epoch,
        address: { scope: configured.scope, sessionId: "gui-official" },
        operation: "permissionCatalog",
        input: {},
      }),
      /session-not-found/,
    );
  },
);
