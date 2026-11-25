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
import { PNG } from "./support/image.ts";

it("image receipts preserve CH queue paths and session-authorized transcript previews", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-image-receipt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = new DataDir(root),
    images = new WebImages(data),
    files = new WebFiles(data, images),
    host = new FakeChHost();
  host.add("thread", root);
  host.add("other", root);
  const sessions = new ChSessions(
    host,
    new Workspaces(data, root, true),
    new EventHub(root),
    images,
    files,
  );
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  sessions.register(rpc, new StreamRegistry());
  const uploaded = await sessions.uploadFile(
    "thread",
    (async function* () {
      yield Buffer.from(PNG, "base64");
    })(),
    "photo.png",
    "image/png",
  );
  const result = await rpc.dispatch("session/prompt", {
    args: {
      request: {
        sessionId: "thread",
        mode: "queue",
        content: [
          { type: "file", receiptId: uploaded.receiptId },
          { type: "text", text: "Look" },
        ],
      },
    },
  });
  assert.ok(result.ok);
  const sent = host.requests.find((request) => request.method === "turn/start");
  assert.ok(sent);
  const presentation = sent.params.presentationInput as Array<{ type: string; path?: string }>;
  assert.equal(presentation[0]?.type, "localImage");
  const path = presentation[0]?.path;
  assert.ok(path);
  assert.equal(path.startsWith(images.directory), true);
  assert.equal(images.idForPath(path), uploaded.file.attachmentId);
  const preview = await rpc.dispatch("session/attachment", {
    args: { request: { sessionId: "thread", attachmentId: uploaded.file.attachmentId } },
  });
  assert.ok(preview.ok);
  assert.equal((preview.value as { data: string }).data, PNG);
  const foreign = await rpc.dispatch("session/attachment", {
    args: { request: { sessionId: "other", attachmentId: uploaded.file.attachmentId } },
  });
  assert.equal(foreign.ok, false);
});

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
