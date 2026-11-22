import type { JsonObject } from "@codexhost/protocol-core";
import { afterEach, expect, it, vi } from "vitest";
import { confirmNativeThreadArchived } from "../src/native-thread-archive-confirm.js";

function setup() {
  const input = {
    threadId: "target",
    isNativeOwner: vi.fn(async () => true),
    initializeOfficial: vi.fn(async () => {}),
    currentGeneration: vi.fn((): number | null => 1),
    requestOfficial: vi.fn<(params: JsonObject) => Promise<JsonObject>>(async () => ({
      result: { data: [], nextCursor: null },
    })),
  };
  return input;
}

afterEach(() => vi.useRealTimers());

it("reads native archived pages directly and stops at a page-two match", async () => {
  const input = setup();
  input.requestOfficial
    .mockResolvedValueOnce({ result: { data: [{ id: "other" }], nextCursor: "page2" } })
    .mockResolvedValueOnce({ result: { data: [{ id: "target" }], nextCursor: "page3" } });
  expect(await confirmNativeThreadArchived(input)).toEqual({ confirmed: true });
  expect(input.requestOfficial.mock.calls).toEqual([
    [{ archived: true, limit: 100, cursor: null }],
    [{ archived: true, limit: 100, cursor: "page2" }],
  ]);
});

it("leaves an absent Thread unconfirmed", async () => {
  const input = setup();
  expect(await confirmNativeThreadArchived(input)).toEqual({ confirmed: false });
  expect(input.requestOfficial).toHaveBeenCalledTimes(1);
});

it.each([
  { error: { code: -32000, message: "official failure" } },
  { result: { data: "invalid" } },
  { result: { data: [{ id: "target" }], nextCursor: 17 } },
])("leaves errors and invalid pages unconfirmed: %j", async (response) => {
  const input = setup();
  input.requestOfficial.mockResolvedValue(response);
  expect(await confirmNativeThreadArchived(input)).toEqual({ confirmed: false });
  expect(input.requestOfficial).toHaveBeenCalledTimes(1);
});

it("observes rejected native reads", async () => {
  const input = setup();
  input.requestOfficial.mockRejectedValue(new Error("transport closed"));
  expect(await confirmNativeThreadArchived(input)).toEqual({ confirmed: false });
});

it("stops at a repeated cursor", async () => {
  const input = setup();
  input.requestOfficial.mockResolvedValue({ result: { data: [], nextCursor: "loop" } });
  expect(await confirmNativeThreadArchived(input)).toEqual({ confirmed: false });
  expect(input.requestOfficial).toHaveBeenCalledTimes(2);
});

it("stops at ten pages even when every cursor is new", async () => {
  const input = setup();
  let page = 0;
  input.requestOfficial.mockImplementation(async () => ({
    result: { data: [], nextCursor: `page-${++page}` },
  }));
  expect(await confirmNativeThreadArchived(input)).toEqual({ confirmed: false });
  expect(input.requestOfficial).toHaveBeenCalledTimes(10);
});

it("rejects external ownership without initializing or reading native Codex", async () => {
  const input = setup();
  input.isNativeOwner.mockResolvedValue(false);
  expect(await confirmNativeThreadArchived(input)).toEqual({ confirmed: false });
  expect(input.initializeOfficial).not.toHaveBeenCalled();
  expect(input.requestOfficial).not.toHaveBeenCalled();
});

it("does not confirm across native generations", async () => {
  const input = setup();
  input.requestOfficial.mockImplementation(async () => {
    input.currentGeneration.mockReturnValue(2);
    return { result: { data: [{ id: "target" }], nextCursor: null } };
  });
  expect(await confirmNativeThreadArchived(input)).toEqual({ confirmed: false });
  expect(input.requestOfficial).toHaveBeenCalledTimes(1);
});

it("does not read when the native generation is unavailable", async () => {
  const input = setup();
  input.currentGeneration.mockReturnValue(null);
  expect(await confirmNativeThreadArchived(input)).toEqual({ confirmed: false });
  expect(input.requestOfficial).not.toHaveBeenCalled();
});

it("enforces one total deadline across pages, including a stalled read and its late completion", async () => {
  vi.useFakeTimers();
  const input = setup();
  const first = Promise.withResolvers<JsonObject>();
  const second = Promise.withResolvers<JsonObject>();
  input.requestOfficial.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const result = confirmNativeThreadArchived(input);
  await vi.advanceTimersByTimeAsync(6_000);
  first.resolve({ result: { data: [], nextCursor: "second" } });
  await vi.advanceTimersByTimeAsync(0);
  expect(input.requestOfficial).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(3_999);
  let settled = false;
  void result.then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toEqual({ confirmed: false });
  expect(vi.getTimerCount()).toBe(0);
  second.resolve({ result: { data: [{ id: "target" }], nextCursor: "third" } });
  await vi.advanceTimersByTimeAsync(0);
  expect(input.requestOfficial).toHaveBeenCalledTimes(2);
});

it("bounds stalled owner resolution and does not initialize after late resolution", async () => {
  vi.useFakeTimers();
  const input = setup();
  const owner = Promise.withResolvers<boolean>();
  input.isNativeOwner.mockReturnValue(owner.promise);
  const result = confirmNativeThreadArchived(input);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await result).toEqual({ confirmed: false });
  owner.resolve(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(input.initializeOfficial).not.toHaveBeenCalled();
});

it("clears the deadline after early success and failure", async () => {
  vi.useFakeTimers();
  const input = setup();
  input.requestOfficial.mockResolvedValueOnce({ result: { data: [{ id: "target" }] } });
  expect(await confirmNativeThreadArchived(input)).toEqual({ confirmed: true });
  expect(vi.getTimerCount()).toBe(0);
  input.requestOfficial.mockRejectedValueOnce(new Error("read failed"));
  expect(await confirmNativeThreadArchived(input)).toEqual({ confirmed: false });
  expect(vi.getTimerCount()).toBe(0);
});
