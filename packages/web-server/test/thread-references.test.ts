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
    { id: "draft", blank: true, projectionValues: { threadReference: { hostId: "local" } } },
    { id: "remote", blank: false, projectionValues: { threadReference: { hostId: "remote" } } },
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

it("rejects remote, ambiguous, malformed and unrelated message destinations", () => {
  for (const href of [
    "target",
    "thread://target",
    "thread://target?hostId=remote-explicit",
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
