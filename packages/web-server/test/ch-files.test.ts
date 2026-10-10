import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { ChSessions } from "../src/ch-sessions.ts";
import { WebFiles } from "../src/web-files.ts";
import { WebImages } from "../src/web-images.ts";
import { DataDir } from "../src/store.ts";
import { Workspaces } from "../src/workspaces.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import { FakeChHost } from "./support/ch-host.ts";

for (const unknown of [false, true])
  it(`file receipts survive ${unknown ? "outcome-unknown" : "rejected first"} sends and canonical draft binding`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "ch-file-receipts-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const data = new DataDir(root),
      files = new WebFiles(data),
      host = new FakeChHost();
    const native = host.request.bind(host);
    let attempts = 0,
      reject = true;
    host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (method === "turn/start") {
        attempts++;
        if (reject && !unknown) throw new Error("Native refusal");
        const result = await native<T>(method, params);
        if (reject) throw new Error("Outcome unknown");
        return result;
      }
      return native<T>(method, params);
    };
    const sessions = new ChSessions(
      host,
      new Workspaces(data, root, true),
      new EventHub(root),
      new WebImages(data),
      files,
    );
    t.after(() => sessions.close());
    const rpc = new RpcRegistry();
    sessions.register(rpc, new StreamRegistry());
    const created = await rpc.dispatch("session/create", { args: { request: { cwd: root } } });
    assert.ok(created.ok);
    const id = (created.value as { sessionId: string }).sessionId;
    const staged = await rpc.dispatch("fileUploads/upload", {
      args: {
        agentId: id,
        request: { name: "notes.md", data: Buffer.from("Keep these bytes").toString("base64") },
      },
    });
    assert.ok(staged.ok);
    const receiptId = (staged.value as { receiptId: string }).receiptId;
    assert.equal(
      host.requests.some((r) => r.method === "thread/start"),
      false,
    );
    const args = { args: { request: { sessionId: id, content: [{ type: "file", receiptId }] } } };
    const first = await rpc.dispatch("session/prompt", args);
    assert.equal(first.ok, false);
    const canonical = [...host.threads.keys()][0];
    assert.ok(canonical);
    const [file] = await files.resolve(canonical, [receiptId]);
    assert.ok(file);
    assert.equal(readFileSync(file.path, "utf8"), "Keep these bytes");
    assert.equal(attempts, 1, "no automatic resubmission");
    assert.equal(host.requests.filter((r) => r.method === "thread/start").length, 1);
    if (!unknown) {
      reject = false;
      assert.equal((await rpc.dispatch("session/prompt", args)).ok, true);
      assert.equal(attempts, 2);
      assert.equal(host.requests.filter((r) => r.method === "thread/start").length, 1);
      await assert.rejects(files.resolve(canonical, [receiptId]), /not uploaded/u);
    }
  });
