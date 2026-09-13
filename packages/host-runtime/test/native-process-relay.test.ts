import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { NativeProcessRelay } from "../src/native-process-relay.js";

it("distinguishes a failed helper spawn from an unconfirmed running process tree", async () => {
  const read = vi.fn(async (): Promise<Buffer | null> => null);
  const relay = new NativeProcessRelay({
    launcher: path.join(tmpdir(), `${randomUUID()}.missing`),
    program: process.execPath,
    arguments: [],
    cwd: tmpdir(),
    environment: process.env,
    receipt: { directory: tmpdir(), name: "unused.json", tag: randomUUID() },
    files: { read },
  });
  relay.stdout.resume();
  relay.stderr.resume();
  await expect(relay.start()).rejects.toThrow("Native process relay");
  expect(relay.processId).toBeUndefined();
  const exit = await relay.stop();
  expect(exit.error?.message).not.toContain(tmpdir());
  expect(read).not.toHaveBeenCalled();
});
