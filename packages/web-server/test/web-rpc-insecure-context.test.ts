import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { resolve } from "node:path";
import { it } from "node:test";
import { createContext, runInContext } from "node:vm";
import { build } from "esbuild";
import { defined } from "./support/defined.ts";

for (const scenario of [
  {
    file: "ui-codexhost/src/client/api.ts",
    expression: 'module.exports.harnessCommandApi.inspect("session")',
    method: "codexhost/threadCommands",
    args: { request: { sessionId: "session" } },
  },
  {
    file: "ui-model-selection/src/client/preferences-api.ts",
    expression:
      'module.exports.preferenceCall("patch", { operation: { kind: "favorite", harnessId: "pi", modelId: "model", enabled: true } })',
    method: "codexhost/preferences/patch",
    args: {
      operation: { kind: "favorite", harnessId: "pi", modelId: "model", enabled: true },
    },
  },
]) {
  it(`${scenario.method} works without the secure-context randomUUID API`, async () => {
    const output = await build({
      entryPoints: [
        resolve(import.meta.dirname, "../../../apps/web-ui/packages/client", scenario.file),
      ],
      bundle: true,
      platform: "browser",
      format: "cjs",
      write: false,
    });
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const context = createContext({
      module: { exports: {} },
      crypto: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) },
      fetch: async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return { ok: true, json: async () => ({ result: { ok: true, value: "received" } }) };
      },
    });
    runInContext(defined(output.outputFiles[0]).text, context);
    for (let i = 0; i < 2; i++)
      assert.equal(await runInContext(scenario.expression, context), "received");
    assert.equal(requests.length, 2);
    const ids = new Set<string>();
    for (const { url, init } of requests) {
      assert.equal(url, `api/${scenario.method}`);
      assert.equal(init.method, "POST");
      assert.equal(init.credentials, "same-origin");
      assert.equal((init.headers as Record<string, string>)["content-type"], "application/json");
      const body = JSON.parse(String(init.body)) as {
        type: string;
        rpcId: string;
        method: string;
        payload: { args: unknown };
      };
      assert.equal(body.type, "client-request");
      assert.equal(body.method, scenario.method);
      assert.deepEqual(body.payload.args, scenario.args);
      assert.match(
        body.rpcId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      ids.add(body.rpcId);
    }
    assert.equal(ids.size, 2, "each request gets a distinct UUID");
  });
}
