import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadSendReceipts } from "../src/thread-send-receipts.js";
import { DelegationControlError, type ThreadSendResult } from "../src/delegation-types.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thread-receipts-"));
  directories.push(directory);
  return new ThreadSendReceipts(directory);
}
const params = () => ({
  threadId: "thread",
  message: "continue",
  requestId: randomUUID(),
  expectedMachineId: randomUUID(),
});
const result: ThreadSendResult = {
  threadId: "thread",
  turnId: "turn",
  harnessId: "codex",
  status: "running",
  next: { read: "read", wait: "wait" },
};

it("joins duplicate sends and returns a durable receipt after restart without another Turn", async () => {
  const receipts = await fixture();
  const input = params();
  const pending = Promise.withResolvers<ThreadSendResult>();
  const send = vi.fn(() => pending.promise);
  const first = receipts.execute(input, send);
  const duplicate = receipts.execute(input, send);
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  pending.resolve(result);
  expect(await first).toEqual({ result });
  expect(await duplicate).toEqual({ result });
  expect(await new ThreadSendReceipts(receipts.directory).execute(input, send)).toEqual({ result });
  expect(await receipts.execute({ ...input, message: "different" }, send)).toMatchObject({
    error: { code: "INVALID_ARGUMENT" },
  });
  expect(send).toHaveBeenCalledOnce();
});

it("never replays an incomplete or corrupted receipt after another Runtime opens the store", async () => {
  const receipts = await fixture();
  const input = params();
  const pending = Promise.withResolvers<ThreadSendResult>();
  const send = vi.fn(() => pending.promise);
  const first = receipts.execute(input, send);
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(await new ThreadSendReceipts(receipts.directory).execute(input, send)).toMatchObject({
    error: { code: "OUTCOME_UNKNOWN" },
  });
  pending.resolve(result);
  await first;
  await writeFile(path.join(receipts.directory, `${input.requestId}.json`), "{");
  expect(await receipts.execute(input, send)).toMatchObject({ error: { code: "OUTCOME_UNKNOWN" } });
  expect(send).toHaveBeenCalledOnce();
});

it.each(["THREAD_BUSY", "THREAD_NOT_FOUND", "INVALID_ARGUMENT"] as const)(
  "preserves definitive %s errors and deduplicates failed requests",
  async (code) => {
    const receipts = await fixture();
    const input = params();
    const send = vi.fn(async () => {
      throw new DelegationControlError(code, "rejected");
    });
    expect(await receipts.execute(input, send)).toEqual({ error: { code, message: "rejected" } });
    expect(await receipts.execute(input, send)).toEqual({ error: { code, message: "rejected" } });
    expect(send).toHaveBeenCalledOnce();
  },
);

it("records uncertain dispatch failures instead of automatically replaying", async () => {
  const receipts = await fixture();
  const input = params();
  const send = vi.fn(async () => {
    throw new Error("native response lost");
  });
  expect(await receipts.execute(input, send)).toMatchObject({ error: { code: "OUTCOME_UNKNOWN" } });
  expect(await receipts.execute(input, send)).toMatchObject({ error: { code: "OUTCOME_UNKNOWN" } });
  expect(send).toHaveBeenCalledOnce();
});

it("rejects a second request ID while the first send is starting", async () => {
  const receipts = await fixture();
  const input = params();
  const pending = Promise.withResolvers<ThreadSendResult>();
  const send = vi.fn(() => pending.promise);
  const first = receipts.execute(input, send);
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(await receipts.execute({ ...input, requestId: randomUUID() }, send)).toMatchObject({
    error: { code: "THREAD_BUSY" },
  });
  pending.resolve(result);
  await first;
  expect(send).toHaveBeenCalledOnce();
});

it("does not call the Harness if the durable reservation cannot be written", async () => {
  const receipts = await fixture();
  const filename = path.join(receipts.directory, "not-a-directory");
  await writeFile(filename, "file");
  const send = vi.fn(async () => result);
  await expect(new ThreadSendReceipts(filename).execute(params(), send)).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});
