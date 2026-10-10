import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { ChSessions } from "../src/ch-sessions.ts";
import { ChThreadHistory } from "../src/ch-thread-history.ts";
import { DataDir } from "../src/store.ts";
import { Workspaces } from "../src/workspaces.ts";
import { WebImages } from "../src/web-images.ts";
import { ChAttachments } from "../src/ch-attachments.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import { FakeChHost } from "./support/ch-host.ts";
import { FakeChChannel } from "./support/ch-channel.ts";
import { PNG } from "./support/image.ts";

it("shared image sends use paths, reject invalid drafts before native creation and authorize preview by native history", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-images-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new FakeChChannel();
  host.add("other", root);
  const data = new DataDir(root),
    images = new WebImages(data);
  const sessions = new ChSessions(
    host,
    new Workspaces(data, root, true),
    new EventHub(root),
    images,
  );
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  sessions.register(rpc, new StreamRegistry());
  const call = async <T>(method: string, request: unknown): Promise<T> => {
    const result = await rpc.dispatch(method, { args: { request } });
    assert.ok(result.ok, result.ok ? undefined : result.error.message);
    return result.value as T;
  };
  const draft = await call<{ sessionId: string }>("session/create", { cwd: root });
  const invalid = await rpc.dispatch("session/prompt", {
    args: {
      request: {
        sessionId: draft.sessionId,
        content: [{ type: "image", mediaType: "image/png", data: "bad" }],
      },
    },
  });
  assert.equal(invalid.ok, false);
  assert.equal(
    host.requests.some((r) => r.method === "thread/start"),
    false,
  );
  assert.deepEqual(readdirSync(images.directory), []);
  await call("session/prompt", {
    sessionId: draft.sessionId,
    requestId: "image-send",
    content: [
      { type: "image", mediaType: "image/png", data: PNG },
      { type: "text", text: "Inspect the image" },
    ],
  });
  const sent = host.requests.find((r) => r.method === "turn/start");
  assert.ok(sent);
  const input = sent.params.input as Array<{ type: string; text: string }>;
  assert.ok(input.every((part) => part.type === "text"));
  const path = /## image-1.png: (.+)\n/u.exec(input[0]?.text ?? "")?.[1];
  assert.ok(path);
  assert.deepEqual(readFileSync(path), Buffer.from(PNG, "base64"));
  assert.equal(JSON.stringify(sent.params).includes(PNG), false);
  const threadId = String(sent.params.threadId);
  const id = (
    new ChAttachments(images).project(threadId, input)[0] as {
      attachment: { attachmentId: string };
    }
  ).attachment.attachmentId;
  assert.notEqual(threadId, draft.sessionId);
  const read = await call<{ data: string }>("session/attachment", {
    sessionId: threadId,
    attachmentId: id,
  });
  assert.equal(read.data, PNG);
  const foreign = await rpc.dispatch("session/attachment", {
    args: { request: { sessionId: "other", attachmentId: id } },
  });
  assert.equal(foreign.ok, false, "a guessed image ID is not authority for another Thread");
  const rows = await call<{
    items: Array<{
      sessionId: string;
      projections: { values: { attachmentInput: { enabled: boolean; imagesOnly: boolean } } };
    }>;
  }>("session/list", {});
  assert.deepEqual(
    rows.items.find((row) => row.sessionId === threadId)?.projections.values.attachmentInput,
    { enabled: true, imagesOnly: true },
  );
});

it("cold history and older-page projection reconstruct image references without a Web Thread index", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-image-history-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = new DataDir(root),
    saved = new WebImages(data);
  const content = saved.prepare([{ type: "image", mediaType: "image/png", data: PNG }]);
  const host = new FakeChHost(),
    row = host.add("history", root);
  row.turns = Array.from({ length: 7 }, (_, i) => ({
    id: `turn-${i}`,
    status: "completed",
    items: [
      {
        id: `message-${i}`,
        type: "userMessage",
        content: i === 0 ? content : [{ type: "text", text: `Message ${i}` }],
      },
    ],
  }));
  const restored = new ChAttachments(new WebImages(data));
  const view = new ChThreadHistory(
    host,
    row,
    "fake",
    () => {},
    undefined,
    (parts) => restored.project(row.id, parts),
  );
  await view.refresh();
  await view.loadOlder();
  const image = restored.project(row.id, content)[0] as { attachment: { attachmentId: string } };
  assert.equal(restored.read(view, image.attachment.attachmentId).data, PNG);
  assert.deepEqual(
    readdirSync(root),
    ["attachments"],
    "only bytes persist here; canonical history remains in CH",
  );
});

it("retains saved bytes after an outcome-unknown native send", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-image-unknown-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new FakeChHost();
  host.add("thread", root);
  const native = host.request.bind(host);
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    const result = await native<T>(method, params);
    if (method === "turn/start") throw new Error("outcome unknown");
    return result;
  };
  const data = new DataDir(root),
    images = new WebImages(data),
    rpc = new RpcRegistry();
  const sessions = new ChSessions(host, new Workspaces(data, root), new EventHub(root), images);
  t.after(() => sessions.close());
  sessions.register(rpc, new StreamRegistry());
  const result = await rpc.dispatch("session/prompt", {
    args: {
      request: {
        sessionId: "thread",
        content: [{ type: "image", mediaType: "image/png", data: PNG }],
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(host.requests.filter((r) => r.method === "turn/start").length, 1);
  assert.equal(
    readdirSync(images.directory).length,
    1,
    "the native Turn can already reference these bytes",
  );
});
