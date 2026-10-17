import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { startMixedSharedHost } from "./support/shared-mixed-host.ts";
import { startServer } from "./support/server.ts";
import { MixedChHost, writeWebCodexPlugin } from "./support/web-codex.ts";

it(
  "the production Web entry routes isolated Codex through the shared owner and external Threads through CH",
  { timeout: 20_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "mixed-http-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const plugins = writeWebCodexPlugin(root);
    const host = new MixedChHost();
    host.add("shared", root, "GUI external Thread");
    host.add("official", root, "GUI native Codex").modelProvider = "openai";
    const shared = await startMixedSharedHost(t, root, plugins, host);
    const url = await startServer(
      t,
      resolve(import.meta.dirname, ".."),
      ["--import", "tsx", "src/main.ts"],
      shared.args,
    );
    async function dispatch(method: string, args: Record<string, unknown> = {}) {
      const response = await fetch(new URL(`/api/${method}`, url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "client-request",
          rpcId: "mixed-http",
          method,
          payload: { args },
        }),
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        result:
          { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };
      };
      return body.result;
    }
    async function call<T>(method: string, request?: Record<string, unknown>): Promise<T> {
      const result = await dispatch(method, request ? { request } : {});
      assert.ok(result.ok, result.ok ? undefined : result.error.message);
      return result.value as T;
    }
    const catalog = await call<{ groups: Array<{ id: string }> }>("session/modelCatalog");
    assert.deepEqual(catalog.groups.map((group) => group.id).sort(), ["codex", "fake"]);
    const list = await call<{ items: Array<{ sessionId: string }> }>("session/list");
    assert.deepEqual(
      list.items.map((item) => item.sessionId),
      ["shared"],
    );
    const { sessionId } = await call<{ sessionId: string }>("session/create", { cwd: root });
    await call("session/selectModel", { sessionId, provider: "codex", model: "codex-model" });
    await call("session/prompt", {
      sessionId,
      requestId: "web-codex",
      content: [{ type: "text", text: "Codex-owned HTTP request" }],
      mode: "queue",
    });
    const deadline = Date.now() + 3_000;
    let history = "";
    do {
      history = JSON.stringify(
        await call("session/page", {
          address: { kind: "session", sessionId },
          throughSeq: Number.MAX_SAFE_INTEGER,
        }),
      );
      if (history.includes("echo: Codex-owned HTTP request")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    assert.match(history, /echo: Codex-owned HTTP request/u);
    assert.equal(
      host.requests.some(({ method }) =>
        ["thread/start", "turn/start", "thread/resume"].includes(method),
      ),
      false,
    );
    const upload = new URL("/api/session/uploadFileBinary", url);
    upload.searchParams.set("sessionId", sessionId);
    upload.searchParams.set("name", "not-supported.txt");
    const uploaded = await fetch(upload, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: "payload",
    });
    assert.equal(((await uploaded.json()) as { ok: boolean }).ok, false);
    await call("session/prompt", {
      sessionId: "shared",
      requestId: "shared-turn",
      content: [{ type: "text", text: "Shared HTTP request" }],
      mode: "queue",
    });
    assert.equal(host.requests.filter(({ method }) => method === "turn/start").length, 1);
    assert.equal(
      host.requests.find(({ method }) => method === "turn/start")?.params.threadId,
      "shared",
    );
    const refused = await dispatch("session/prompt", {
      request: { sessionId: "official", content: [{ type: "text", text: "Must not execute" }] },
    });
    assert.equal(refused.ok, false);
    assert.equal(host.requests.filter(({ method }) => method === "turn/start").length, 1);
    const merged = await call<{ items: Array<{ sessionId: string }> }>("session/list");
    assert.deepEqual(
      merged.items.map((item) => item.sessionId).sort(),
      [sessionId, "shared"].sort(),
    );
  },
);
