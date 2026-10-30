import { expect, it, vi } from "vitest";
import { REMOTE_THREAD_REPLY_MAX_BYTES } from "@codexhost/shared-contracts";
import { DesktopThreadReader } from "../src/desktop-thread-reader.js";

const snapshot = {
  threadId: "target",
  harnessId: "codex",
  status: "completed",
  turn: null,
  progress: [],
  result: { availability: "available", text: "answer" },
  nextCursor: null,
};
const input = { threadId: "target", view: "result" as const };

it("correlates replies and ignores unrelated and late replies", async () => {
  const notify = vi
    .fn<ConstructorParameters<typeof DesktopThreadReader>[0]>()
    .mockResolvedValue(undefined);
  const reader = new DesktopThreadReader(notify);
  const other = new DesktopThreadReader(async () => undefined);
  const pending = reader.read(input);
  const requestId = notify.mock.calls[0]?.[0].requestId;
  expect(requestId).toBeTypeOf("string");
  other.reply({ requestId, result: snapshot });
  reader.reply({ requestId: "unrelated", result: snapshot });
  reader.reply({ requestId, result: snapshot });
  reader.reply({ requestId, error: { code: "INTERNAL_ERROR", message: "late" } });
  await expect(pending).resolves.toEqual(snapshot);
  reader.close();
  other.close();
});

it.each([{}, { ...snapshot, threadId: "wrong" }])(
  "rejects an invalid snapshot %j",
  async (result) => {
    const reader: DesktopThreadReader = new DesktopThreadReader(async ({ requestId }) =>
      reader.reply({ requestId, result }),
    );
    await expect(reader.read(input)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    reader.close();
  },
);

it("bounds an old Desktop that never replies and releases pending reads on disconnect", async () => {
  vi.useFakeTimers();
  const reader = new DesktopThreadReader(async () => undefined);
  try {
    const timeout = expect(reader.read(input)).rejects.toMatchObject({
      code: "RUNTIME_UNREACHABLE",
    });
    await vi.advanceTimersByTimeAsync(35_000);
    await timeout;
    const disconnected = expect(reader.read(input)).rejects.toThrow("Desktop disconnected");
    reader.close();
    await disconnected;
    await expect(reader.read(input)).rejects.toThrow("Desktop disconnected");
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    reader.close();
    vi.useRealTimers();
  }
});

it("rejects oversized replies without truncating their contents", async () => {
  const reader: DesktopThreadReader = new DesktopThreadReader(async ({ requestId }) =>
    reader.reply({
      requestId,
      result: {
        ...snapshot,
        result: { availability: "available", text: "x".repeat(REMOTE_THREAD_REPLY_MAX_BYTES) },
      },
    }),
  );
  await expect(reader.read(input)).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  reader.close();
});

it("propagates send failure without leaving a pending timer", async () => {
  const reader = new DesktopThreadReader(async () => {
    throw new Error("write failed");
  });
  await expect(reader.read(input)).rejects.toMatchObject({ code: "RUNTIME_UNREACHABLE" });
  reader.close();
});
