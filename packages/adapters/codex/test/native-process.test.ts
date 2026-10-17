/** A real synthetic stdio peer verifies launch/routing without using a model or Desktop. */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { it } from "vitest";

import { createHarnessAdapter } from "../src/plugin.ts";

it.skipIf(process.platform === "win32")(
  "sends every native operation only to the isolated home with Desktop routing removed",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "web-codex-process-")));
    const command = join(root, "fake-codex");
    const home = join(root, "web-codex-home");
    const log = join(root, "rpc.jsonl");
    writeFileSync(
      command,
      `#!${process.execPath}
const { appendFileSync, existsSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { createInterface } = require('node:readline');
if (process.argv.includes('--version')) process.exit(0);
const record = method => appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method, env: process.env }) + '\\n');
const file = join(process.env.CODEX_HOME, 'thread.json');
createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  record(request.method);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === 'model/list') result = {data:[{id:'test-model',displayName:'Test',description:'',hidden:false,isDefault:true,supportedReasoningEfforts:[],defaultReasoningEffort:'medium'}]};
  if (request.method === 'thread/start') writeFileSync(file, 'isolated-thread');
  if (request.method === 'thread/start' || request.method === 'thread/resume') {
    if (request.method === 'thread/resume' && (request.params.threadId !== 'isolated-thread' || !existsSync(file))) {
      process.stdout.write(JSON.stringify({id: request.id,error:{code:-32000,message:'Thread is not in this home'}}) + '\\n');
      return;
    }
    result = {thread:{id:'isolated-thread'},model:'test-model',reasoningEffort:null};
  }
  if (request.method === 'thread/list') result = {data:existsSync(file) ? [{id:'isolated-thread',name:'Isolated',preview:'',cwd:${JSON.stringify(root)},updatedAt:1,ephemeral:false,parentThreadId:null}] : []};
  if (request.method === 'thread/read') result = {thread:{turns:[]}};
  process.stdout.write(JSON.stringify({id: request.id,result}) + '\\n');
});
`,
    );
    chmodSync(command, 0o700);
    const adapter = createHarnessAdapter({
      environment: {
        HOME: root,
        CODEXHOST_CODEX_COMMAND: command,
        CODEXHOST_CODEX_HOME: home,
        CODEX_HOME: join(root, "gui-home"),
        CODEXHOST_HOST_RUNTIME_PATH: "/do-not-execute-desktop-host",
        CODEX_CLI_PATH: "/do-not-execute-desktop-shim",
        CODEX_THREAD_ID: "gui-thread",
        NODE_OPTIONS: "--import=/do-not-execute-hook",
      },
    });
    try {
      assert.equal((await adapter.inspect()).status, "ready");
      assert.deepEqual(await adapter.sessionImport.listCandidates(), { ok: true, value: [] });
      const created = await adapter.open({ kind: "create", cwd: root });
      assert.equal(created.ok, true);
      if (!created.ok) return;
      const nativeRef = created.value.initialState.nativeRef;
      assert.deepEqual(nativeRef, {
        harnessId: "codex",
        nativeSessionId: "isolated-thread",
        locator: { codexHome: home },
      });
      await created.value.close();
      const resumed = await adapter.open({ kind: "resume", cwd: root, nativeRef });
      assert.equal(resumed.ok, true);
      if (resumed.ok) await resumed.value.close();
      const foreign = await adapter.open({
        kind: "resume",
        cwd: root,
        nativeRef: {
          harnessId: "codex",
          nativeSessionId: "gui-thread",
          locator: { codexHome: home },
        },
      });
      assert.equal(foreign.ok, false);
      assert.equal((await adapter.readHistory(nativeRef)).ok, true);
      const imported = await adapter.sessionImport.resolveCandidate("isolated-thread");
      assert.equal(imported.ok, true);
      if (imported.ok) {
        assert.deepEqual(imported.value.nativeRef, nativeRef);
        assert.equal((await adapter.readHistory(imported.value.nativeRef)).ok, true);
      }
      const other = createHarnessAdapter({
        environment: {
          HOME: root,
          CODEXHOST_CODEX_COMMAND: command,
          CODEXHOST_CODEX_HOME: join(root, "other-web-home"),
        },
      });
      try {
        const before = readFileSync(log, "utf8");
        for (const result of [
          await other.open({ kind: "resume", cwd: root, nativeRef }),
          await other.readHistory(nativeRef),
        ]) {
          assert.equal(result.ok, false);
          if (!result.ok) assert.equal(result.error.code, "sessionScopeMismatch");
        }
        assert.equal(readFileSync(log, "utf8"), before);
      } finally {
        await other.close();
      }
      const candidates = await adapter.sessionImport.listCandidates();
      assert.equal(candidates.ok, true);
      if (candidates.ok)
        assert.deepEqual(
          candidates.value.map((item) => item.nativeSessionId),
          ["isolated-thread"],
        );
    } finally {
      await adapter.close();
      const records = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method: string; env: NodeJS.ProcessEnv });
      assert.equal(records.filter((record) => record.method === "thread/start").length, 1);
      assert.equal(records.filter((record) => record.method === "thread/resume").length, 2);
      for (const { env } of records) {
        assert.equal(env.CODEX_HOME, home);
        assert.equal(
          Object.keys(env).some((key) => key.startsWith("CODEXHOST_")),
          false,
        );
        assert.equal(env.CODEX_CLI_PATH, undefined);
        assert.equal(env.CODEX_THREAD_ID, undefined);
        assert.equal(env.NODE_OPTIONS, undefined);
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);
