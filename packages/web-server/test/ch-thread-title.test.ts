import assert from "node:assert/strict";
import { it } from "node:test";
import { threadListTitle } from "../src/ch-thread-title.ts";

it("prefers the stored name, then the first prompt, then the project and id", () => {
  assert.equal(
    threadListTitle({ id: "t1", name: " 手动名 ", preview: "hi", cwd: "/a/web" }),
    "手动名",
  );
  assert.equal(
    threadListTitle({ id: "t1", name: null, preview: "首条消息", cwd: "/a/web" }),
    "首条消息",
  );
  assert.equal(threadListTitle({ id: "t1", name: "  ", preview: " ", cwd: "/a/web" }), "web");
  assert.equal(threadListTitle({ id: "t1", name: null, preview: undefined, cwd: "" }), "t1");
  assert.equal(threadListTitle({ id: "t1" }), "t1");
});

it("skips empty names and trims the first prompt", () => {
  for (const name of [undefined, null, "", " \t\n "]) {
    assert.equal(threadListTitle({ id: "t1", name, preview: " hello \n" }), "hello");
  }
});

it("bounds only the prompt fallback, normalizes whitespace and keeps Unicode intact", () => {
  assert.equal(threadListTitle({ id: "t1", preview: " First\n\t prompt " }), "First prompt");
  const text = "题😀".repeat(40);
  assert.equal(threadListTitle({ id: "t1", preview: text }), text);
  assert.equal(threadListTitle({ id: "t1", preview: text + "尾" }), text + "…");
  assert.equal(threadListTitle({ id: "t1", name: text + "标题", preview: "hi" }), text + "标题");
});

it("falls back to id for missing, root or whitespace-only directory names", () => {
  for (const cwd of [undefined, null, "", "/", "///", "   ", "/a/   /"]) {
    assert.equal(threadListTitle({ id: "t1", name: "", preview: " \n", cwd }), "t1");
  }
  assert.equal(threadListTitle({ id: "t1", cwd: "/a/web/" }), "web");
  assert.equal(threadListTitle({ id: "t1", cwd: "/a/ web /" }), " web ");
});

it("handles Windows drive and UNC paths independently of the server platform", () => {
  for (const cwd of [
    "C:\\Users\\alice\\web",
    "C:\\Users\\alice\\web\\",
    "C:/Users/alice/web/",
    "\\\\server\\share\\web\\",
  ]) {
    assert.equal(threadListTitle({ id: "t1", cwd }), "web");
  }
  assert.equal(threadListTitle({ id: "t1", cwd: "C:\\" }), "t1");
  assert.equal(threadListTitle({ id: "t1", cwd: "C:\\a\\   \\" }), "t1");
});

it(
  "preserves literal backslashes in POSIX directory names",
  { skip: process.platform === "win32" },
  () => {
    assert.equal(threadListTitle({ id: "t1", cwd: "/a/web\\notes" }), "web\\notes");
  },
);
