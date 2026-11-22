import assert from "node:assert/strict";
import { it } from "node:test";
import {
  SidebarBrowserInputBatcher,
  type SidebarBrowserInput,
} from "../src/sidebar-browser-input-batcher.ts";

const wheel = (deltaY: number, x = 10, y = 20, deltaX = 0) =>
  ({ type: "wheel", x, y, deltaX, deltaY }) as const;
const mouse = (action: "down" | "move" | "up", x: number) =>
  ({ type: "mouse", action, x, y: 20, button: "left", clickCount: 1 }) as const;

function pendingInput() {
  const batcher = new SidebarBrowserInputBatcher<number, number>();
  const pending: (() => SidebarBrowserInput)[] = [];
  return {
    enqueue(message: SidebarBrowserInput, viewer = 1, page = 1) {
      const take = batcher.enqueue(viewer, page, message);
      if (take) pending.push(take);
    },
    next() {
      return pending.shift()?.();
    },
    drain() {
      return pending.splice(0).map((take) => take());
    },
    seal() {
      batcher.seal();
    },
  };
}

it("takes the first wheel immediately and keeps one waiting sum without touching it", () => {
  const input = pendingInput();
  const first = wheel(24);
  input.enqueue(first);
  assert.equal(input.next(), first);

  input.enqueue(wheel(12, 10, 20, 2));
  for (let i = 0; i < 50; i++) input.enqueue(wheel(2, 10, 20, 1));
  assert.deepEqual(input.drain(), [wheel(112, 10, 20, 52)]);
  assert.equal(first.deltaY, 24);
});

it("keeps changed coordinates, direction, viewer and page in separate ordered batches", () => {
  const input = pendingInput();
  const messages = [wheel(1), wheel(2, 11), wheel(3, 11, 21)];
  for (const message of messages) input.enqueue(message);
  input.enqueue(wheel(-4, 11, 21));
  input.enqueue(wheel(-5, 11, 21, 1));
  input.enqueue(wheel(-6, 11, 21, -1));
  input.enqueue(wheel(-7, 11, 21, -1), 2);
  input.enqueue(wheel(-8, 11, 21, -1), 2, 2);
  input.enqueue(wheel(-9, 11, 21, -1), 2, 2);
  assert.deepEqual(input.drain(), [
    ...messages,
    wheel(-9, 11, 21, 1),
    wheel(-6, 11, 21, -1),
    wheel(-7, 11, 21, -1),
    wheel(-17, 11, 21, -2),
  ]);
});

it("flushes wheel batches before click, drag, key and text without moves jumping ahead", () => {
  const input = pendingInput();
  const key = { type: "key", action: "down", key: "Shift", code: "ShiftLeft" } as const;
  const text = { type: "text", text: "hello" } as const;
  for (const message of [
    wheel(1),
    wheel(2),
    mouse("down", 10),
    mouse("move", 11),
    mouse("move", 12),
    wheel(4),
    wheel(5),
    mouse("move", 13),
    mouse("up", 13),
    wheel(6),
    wheel(7),
    key,
    wheel(8),
    text,
    wheel(9),
    wheel(10),
  ])
    input.enqueue(message);

  assert.deepEqual(input.drain(), [
    wheel(3),
    mouse("down", 10),
    mouse("move", 12),
    wheel(9),
    mouse("move", 13),
    mouse("up", 13),
    wheel(13),
    key,
    wheel(8),
    text,
    wheel(19),
  ]);
});

it("can seal a batch at an external ordering boundary such as releasing held input", () => {
  const input = pendingInput();
  input.enqueue(wheel(1));
  input.enqueue(wheel(2));
  input.seal();
  input.enqueue(wheel(4));
  assert.deepEqual(input.next(), wheel(3));
  input.enqueue(wheel(8));
  assert.deepEqual(input.drain(), [wheel(12)]);
});
