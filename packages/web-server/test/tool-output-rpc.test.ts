import assert from "node:assert/strict";
import { defined } from "./support/defined.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { webToolOutputPreviews, type WebToolOutputReference } from "@codexhost/shared-contracts";
import { ChSessions } from "../src/ch-sessions.ts";
import { DataDir } from "../src/store.ts";
import { Workspaces } from "../src/workspaces.ts";
import {
  EventHub,
  RpcError,
  RpcRegistry,
  StreamRegistry,
  type StreamHandler,
  type StreamSink,
} from "../src/transport.ts";
import { FakeChChannel } from "./support/ch-channel.ts";

class Streams extends StreamRegistry {
  endpoints = new Map<string, StreamHandler>();
  override register(name: string, handler: StreamHandler) {
    super.register(name, handler);
    this.endpoints.set(name, handler);
  }
}
it("authorizes projected output reads, previews relay follow/page, and preserves the local view", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tool-output-rpc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = new FakeChChannel();
  const row = host.add("tools", dir);
  host.add("other", dir);
  defined(row.turns[0]).items.push({
    id: "command",
    type: "commandExecution",
    status: "completed",
    command: "diagnose",
    cwd: dir,
    aggregatedOutput: "OUTPUT".repeat(30_000),
    exitCode: 0,
  });
  const original = host.request.bind(host);
  let denied = false;
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    // Native Codex is a supported owner now. Access revocation must be an
    // authoritative Host refusal, not merely a native ownership label.
    if (denied && method === "codexhost/thread/inspect")
      throw new RpcError("host/rejected", "Thread access revoked");
    return original<T>(method, params);
  };
  const sessions = new ChSessions(host, new Workspaces(new DataDir(dir), dir), new EventHub(dir));
  t.after(() => sessions.close());
  const rpc = new RpcRegistry(),
    streams = new Streams();
  sessions.register(rpc, streams);
  const follow = async (relay: boolean) => {
    const frames: unknown[] = [],
      closes: Array<() => void> = [];
    const sink: StreamSink = {
      id: "test",
      relay,
      closed: false,
      push: (frame) => frames.push(structuredClone(frame)),
      onClose: (fn) => closes.push(fn),
      end: () => closes.forEach((fn) => fn()),
      fail: (code) => {
        throw new Error(code);
      },
    };
    await defined(streams.endpoints.get("session/follow"))(
      { request: { address: { sessionId: row.id }, assistantStream: true } },
      sink,
    );
    sink.end();
    return frames[0] as {
      epoch: string;
      cursor: number;
      records: Array<{
        event: {
          type: string;
          seq: number;
          data: { meta?: unknown; message: { content: Array<{ text: string }> } };
        };
      }>;
    };
  };
  const local = await follow(false),
    remote = await follow(true);
  const tool = defined(remote.records.find((r) => r.event.type === "tool/result"));
  const ref = defined(webToolOutputPreviews(tool.event.data.meta)[0]).reference;
  const localText = defined(
    defined(local.records.find((r) => r.event.type === "tool/result")).event.data.message
      .content[0],
  ).text;
  assert.match(localText, /characters truncated/);
  const call = (reference: WebToolOutputReference) =>
    rpc.dispatch("session/toolOutput", { args: { request: reference } });
  const full = await call(ref);
  assert.ok(full.ok);
  assert.equal((full.value as { text: string }).text, localText);
  assert.equal(
    defined(
      defined((await follow(false)).records.find((r) => r.event.type === "tool/result")).event.data
        .message.content[0],
    ).text,
    localText,
  );
  const pageRequest = {
    args: { request: { address: { sessionId: row.id }, throughSeq: local.cursor } },
  };
  const localPage = await rpc.dispatch("session/page", pageRequest);
  const relayPage = await rpc.dispatch("session/page", pageRequest, undefined, undefined, true);
  assert.ok(localPage.ok && relayPage.ok);
  assert.ok(JSON.stringify(localPage.value).length > JSON.stringify(relayPage.value).length * 2);
  for (const reference of [
    { ...ref, version: "old" },
    { ...ref, sessionId: "other" },
    { ...ref, part: 99 },
  ]) {
    const result = await call(reference);
    assert.ok(!result.ok);
    assert.equal(result.error.code, "session/tool-output-stale");
  }
  denied = true;
  const inaccessible = await call(ref);
  assert.ok(!inaccessible.ok);
  assert.equal(inaccessible.error.code, "host/rejected");
});
