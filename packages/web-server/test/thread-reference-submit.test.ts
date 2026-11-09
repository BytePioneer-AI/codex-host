/** Submission regression only: no Agent or real CLI is exercised by these fixtures. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { ChSessions } from "../src/ch-sessions.ts";
import { DataDir } from "../src/store.ts";
import { Workspaces } from "../src/workspaces.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import { FakeChHost } from "./support/ch-host.ts";

const texts = [
  "01900000-1234-5678-9000-000000000001",
  "codex://threads/canonical-target",
  "thread://canonical-target?hostId=local",
  "[@Same title](thread://canonical-target?hostId=local)",
  "thread://canonical-target?hostId=remote-explicit",
  "[remote](thread://canonical-target?hostId=remote-explicit)",
];

for (const text of texts)
  it(`forwards references as ordinary text without resolving or injecting: ${text}`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "thread-reference-send-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const host = new FakeChHost();
    host.add("destination", root);
    host.add("canonical-target", root);
    const native = host.request.bind(host);
    host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (method === "thread/queue/update") {
        host.requests.push({ method, params });
        return {} as T;
      }
      return native<T>(method, params);
    };
    const sessions = new ChSessions(
      host,
      new Workspaces(new DataDir(root), root),
      new EventHub(root),
    );
    t.after(() => sessions.close());
    const rpc = new RpcRegistry();
    sessions.register(rpc, new StreamRegistry());
    const content = [{ type: "text", text }];
    const sent = await rpc.dispatch("session/prompt", {
      args: {
        request: {
          sessionId: "destination",
          requestId: "reference-request",
          content,
          mode: "queue",
        },
      },
    });
    assert.ok(sent.ok);
    assert.deepEqual(host.requests.find((request) => request.method === "turn/start")?.params, {
      threadId: "destination",
      input: [{ ...content[0], text_elements: [] }],
      delivery: "queue",
      presentationInput: content,
      clientUserMessageId: "reference-request",
    });
    const edited = await rpc.dispatch("session/updateQueue", {
      args: {
        request: {
          sessionId: "destination",
          itemId: "queued",
          action: { kind: "edit", content },
        },
      },
    });
    assert.ok(edited.ok);
    assert.deepEqual(
      host.requests.find((request) => request.method === "thread/queue/update")?.params,
      {
        threadId: "destination",
        queuedSubmissionId: "queued",
        input: [{ ...content[0], text_elements: [] }],
        presentationInput: content,
      },
    );
    assert.equal(
      host.requests.some(
        (request) =>
          request.method === "thread/turns/list" && request.params.threadId === "canonical-target",
      ),
      false,
    );
    assert.equal(host.threads.get("canonical-target")?.turns.length, 1);
  });
