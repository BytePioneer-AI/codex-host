import assert from "node:assert/strict";
import { it } from "node:test";
import {
  THREAD_LINK_PATTERN,
  localThreadId,
  parseThreadReferenceDrag,
  threadReferenceInsert,
  threadReferenceOf,
  threadReferenceUri,
} from "@deepseek-ai/dsh-client-ui-conversation/thread-reference";
import { remoteSessionId } from "../src/remote-sessions.ts";

const shared = (id: string, title = "Same title") => {
  const reference = threadReferenceOf({
    id,
    title,
    blank: false,
    projectionValues: { threadReference: { hostId: "local" } },
  });
  assert.ok(reference);
  return reference;
};

it("keeps canonical identity and local source independent of display title", () => {
  const a = shared("canonical-a"),
    b = shared("canonical-b");
  assert.equal(a.title, b.title);
  assert.equal(threadReferenceUri(a), "thread://canonical-a?hostId=local");
  assert.notEqual(threadReferenceInsert(a).ref, threadReferenceInsert(b).ref);
  assert.equal(
    threadReferenceInsert(a).clipboardText,
    "[@Same title](thread://canonical-a?hostId=local)",
  );
  assert.equal(shared("abcdefgh-123", " \n ").title, "abcdefgh");
});

it("escapes Markdown, HTML-looking titles, newlines, and opaque ID delimiters", () => {
  const ref = shared("id)[]/?#", "a](evil)\\\n<b> *_`title`");
  const insert = threadReferenceInsert(ref);
  assert.equal(insert.label, "a](evil)\\ <b> *_`title`");
  assert.equal(
    insert.clipboardText,
    "[@a\\]\\(evil\\)\\\\ \\<b\\> \\*\\_\\`title\\`](thread://id%29%5B%5D%2F%3F%23?hostId=local)",
  );
  assert.deepEqual(parseThreadReferenceDrag(JSON.stringify(ref)), ref);
  assert.equal(parseThreadReferenceDrag("not json"), undefined);
  assert.equal(parseThreadReferenceDrag(JSON.stringify({ ...ref, hostId: "remote" })), undefined);
});

it("does not infer shared ownership from a Harness, UUID, or uncreated draft", () => {
  for (const session of [
    { id: "isolated-codex", blank: false, projectionValues: {} },
    { id: "official-thread", blank: false },
    { id: "remote", blank: false, projectionValues: { threadReference: { hostId: "remote" } } },
    { id: "draft", blank: true, projectionValues: { threadReference: { hostId: "local" } } },
  ])
    assert.equal(threadReferenceOf(session), undefined);
});

it("parses explicit local Thread links without normalizing their identity", () => {
  for (const id of ["canonical-target", "UPPER-Case", "会话/带?#括号()"])
    for (const href of [
      `codex://threads/${encodeURIComponent(id)}`,
      `thread://${encodeURIComponent(id)}?hostId=local`,
    ])
      assert.equal(localThreadId(href), id);
});

it("finds bare Thread URLs without swallowing prose punctuation or embedded schemes", () => {
  const text =
    "任务 1：codex://threads/target-A，任务 2：(thread://target-B?hostId=local). " +
    "codex://threads/encoded%2Did; prefixcodex://threads/ignored " +
    "https://example.com/codex://threads/ignored codex://threads/target-A?";
  const matches = () => [...text.matchAll(THREAD_LINK_PATTERN)].map(([href]) => href);
  assert.deepEqual(matches(), [
    "codex://threads/target-A",
    "thread://target-B?hostId=local",
    "codex://threads/encoded%2Did",
    "codex://threads/target-A?",
  ]);
  assert.deepEqual(matches().map(localThreadId), ["target-A", "target-B", "encoded-id", undefined]);
  assert.equal(THREAD_LINK_PATTERN.lastIndex, 0);
});

it("rejects ambiguous, malformed and unrelated message destinations", () => {
  for (const href of [
    "target",
    "thread://target",
    "thread://target?hostId=durable",
    "thread://target?hostId=local&hostId=other",
    "thread://target?hostId=local&extra=true",
    "thread://target?hostId=local#fragment",
    "thread://target/path?hostId=local",
    "codex://threads/target?hostId=remote-explicit",
    "codex://threads/target/extra",
    "codex://threads/target#fragment",
    "codex://other/target",
    "codex://threads/",
    "codex://threads/%ZZ",
    "codex://threads/%00",
    "codex://threads/%0a",
    "codex://threads/target\n",
    " thread://target?hostId=local",
    "https://example.com",
    "mailto:someone@example.com",
    "javascript:alert(1)",
    "data:text/html,hello",
  ])
    assert.equal(localThreadId(href), undefined, href);
});

it("round trips native remote references without using the encoded Web ID as a native ID", () => {
  for (const [hostId, threadId] of [
    ["remote-control:机器", "线程/one"],
    ["remote-peer:11111111-2222-4333-8444-555555555555", "peer-thread-1"],
    ["remote-peer:peer-中文", "线程/peer?#()"],
  ] as const) {
    const reference = threadReferenceOf({
      id: "web-remote:opaque",
      blank: false,
      title: "Peer Title",
      projectionValues: { threadReference: { hostId, threadId } },
    });
    assert.ok(reference, hostId);
    assert.equal(reference.threadId, threadId);
    assert.equal(reference.hostId, hostId);
    const expectedSessionId = remoteSessionId(hostId, threadId);
    assert.equal(localThreadId(threadReferenceUri(reference)), expectedSessionId);
    assert.deepEqual(parseThreadReferenceDrag(JSON.stringify(reference)), reference);
  }
  for (const invalidHostId of [
    "remote-peer",
    "remote-peer:",
    "remote-control:",
    "remote-ssh:",
    "remote-other:id",
    "remote",
    "durable",
  ]) {
    assert.equal(
      threadReferenceOf({
        id: "web-remote:opaque",
        blank: false,
        projectionValues: { threadReference: { hostId: invalidHostId, threadId: "t-1" } },
      }),
      undefined,
      invalidHostId,
    );
    assert.equal(
      localThreadId(`thread://t-1?hostId=${encodeURIComponent(invalidHostId)}`),
      undefined,
      invalidHostId,
    );
    assert.equal(
      parseThreadReferenceDrag(
        JSON.stringify({ hostId: invalidHostId, threadId: "t-1", title: "Bad" }),
      ),
      undefined,
      invalidHostId,
    );
  }
});
