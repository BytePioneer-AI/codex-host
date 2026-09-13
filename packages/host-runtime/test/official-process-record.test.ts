import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { OfficialProcessRecord } from "../src/codex-runtime/official-process-record.js";
import type { OwnedOfficialBackend } from "../src/codex-runtime/official-runtime-owner.js";
import type { OfficialAppServerExit } from "../src/official-app-server-connection.js";
import { MemoryCredentialFiles } from "./fixtures/memory-credential-files.js";

function fixture() {
  const files = new MemoryCredentialFiles();
  const identity = vi.fn<(pid: number) => Promise<string | null>>(async () => "birth-one");
  const assertOwnership = vi.fn(() => {});
  const record = new OfficialProcessRecord({
    files,
    sharedCodexHome: "/home",
    identity,
    assertOwnership,
  });
  const key = "/home/.codexhost-process.json";
  const exit = Promise.withResolvers<OfficialAppServerExit>();
  const native: OwnedOfficialBackend = {
    processId: 42,
    closed: exit.promise,
    start: vi.fn(async () => {}),
    connect: vi.fn(async () => {
      throw new Error("unused");
    }),
    stop: vi.fn(async () => {
      exit.resolve({ code: 0, signal: null });
    }),
  };
  let tag = "";
  let receiptKey = "";
  const backend = record.wrap((receipt) => {
    tag = receipt.tag;
    receiptKey = `${receipt.directory}/${receipt.name}`;
    return native;
  });
  const proveExit = () =>
    files.contents.set(
      receiptKey,
      Buffer.from(JSON.stringify({ version: 1, tag, pid: 42, treeExited: true })),
    );
  return { files, identity, assertOwnership, record, key, native, backend, exit, proveExit };
}

describe("shared-home process witness", () => {
  it("records birth identity before work and clears only after confirmed exit", async () => {
    const f = fixture();
    await f.backend.start();
    expect(JSON.parse(f.files.contents.get(f.key)?.toString() ?? "null")).toMatchObject({
      phase: "running",
      pid: 42,
      identity: "birth-one",
    });
    await expect(f.record.reconcile()).rejects.toThrow("still running");
    await f.backend.stop();
    expect(f.files.contents.has(f.key)).toBe(false);
  });
  it("rechecks the lease after the spawn intent acknowledgement before creating a process", async () => {
    const f = fixture();
    f.files.beforeReplace = () => {
      f.assertOwnership.mockImplementation(() => {
        throw new Error("lease lost");
      });
    };
    await expect(f.backend.start()).rejects.toThrow("lease lost");
    expect(f.native.start).not.toHaveBeenCalled();
    expect(f.files.contents.has(f.key)).toBe(true);
    f.exit.resolve({ code: 0, signal: null });
  });

  it("refuses an abandoned spawn gap without inventing proof of exit", async () => {
    const f = fixture();
    f.files.contents.set(
      f.key,
      Buffer.from(JSON.stringify({ version: 1, nonce: randomUUID(), phase: "starting" })),
    );
    await expect(f.backend.start()).rejects.toThrow("unconfirmed");
    expect(f.native.start).not.toHaveBeenCalled();
    expect(f.files.contents.has(f.key)).toBe(true);
  });
  it.each([null, "different-birth"])(
    "requires a tree receipt as well as supervisor absence or PID reuse (%s)",
    async (current) => {
      const f = fixture();
      await f.backend.start();
      f.identity.mockResolvedValue(current);
      await expect(f.record.reconcile()).rejects.toThrow("tree exit is unconfirmed");
      f.proveExit();
      await f.record.reconcile();
      expect(f.files.contents.has(f.key)).toBe(false);
    },
  );
  it("accepts confirmed Windows supervisor exit as Job tree-exit proof", async () => {
    const f = fixture();
    await f.backend.start();
    f.identity.mockResolvedValue(null);
    const windowsRecord = new OfficialProcessRecord({
      files: f.files,
      sharedCodexHome: "/home",
      identity: f.identity,
      assertOwnership: () => {},
      supervisorExitClosesProcessTree: true,
    });
    await windowsRecord.reconcile();
    expect(f.files.contents.has(f.key)).toBe(false);
  });
  it("keeps the witness when observation fails or stop is unconfirmed", async () => {
    const f = fixture();
    await f.backend.start();
    f.identity.mockRejectedValue(new Error("unknown"));
    await expect(f.record.reconcile()).rejects.toThrow("unknown");
    vi.mocked(f.native.stop).mockRejectedValue(new Error("timeout"));
    await expect(f.backend.stop()).rejects.toThrow("timeout");
    expect(f.files.contents.has(f.key)).toBe(true);
  });
  it("does not clear a different owner's record", async () => {
    const f = fixture();
    await f.backend.start();
    const replacement = Buffer.from(
      JSON.stringify({ version: 1, nonce: randomUUID(), phase: "starting" }),
    );
    f.files.contents.set(f.key, replacement);
    await expect(f.backend.stop()).rejects.toThrow("ownership changed");
    expect(f.files.contents.get(f.key)).toEqual(replacement);
  });
  it("reports both backend and witness failures during start", async () => {
    const f = fixture();
    let replacements = 0;
    f.files.beforeReplace = () => {
      replacements++;
      if (replacements === 2) throw new Error("witness write failed");
    };
    vi.mocked(f.native.start).mockRejectedValue(new Error("backend start failed"));
    await expect(f.backend.start()).rejects.toThrow("Official process start failed");
    await f.backend.stop();
  });

  it("still records a process created by a failing start", async () => {
    const f = fixture();
    vi.mocked(f.native.start).mockRejectedValue(new Error("started but failed"));
    await expect(f.backend.start()).rejects.toThrow("started but failed");
    await expect(f.record.reconcile()).rejects.toThrow("still running");
    await f.backend.stop();
    expect(f.files.contents.has(f.key)).toBe(false);
  });
});
