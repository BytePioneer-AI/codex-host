import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MappingStore } from "../src/index.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
if (!originalPlatform) throw new Error("Missing process.platform descriptor");
const ownerPid = 6484;
const recordedStart = "2026-10-26T00:37:41.132Z";
const reusedStart = "2026-10-26T00:52:50.0000000Z";
const nodePath = "C:\\codexhost\\node.exe";

describe("Windows Mapping Store lock identity (simulated OS replies)", () => {
  let directory: string;
  let store: MappingStore;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-windows-lock-"));
    store = new MappingStore({ directory, instanceId: "new-owner" });
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.mocked(execFileSync).mockReset();
  });

  afterEach(async () => {
    Object.defineProperty(process, "platform", originalPlatform);
    vi.restoreAllMocks();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function writeLock(overrides: Record<string, unknown> = {}): Promise<string> {
    const content = JSON.stringify({
      pid: ownerPid === process.pid ? ownerPid + 1 : ownerPid,
      instanceId: "previous-owner",
      startedAt: recordedStart,
      executablePath: nodePath,
      processStartedAt: recordedStart,
      ...overrides,
    });
    await writeFile(path.join(directory, "store.lock"), content);
    return content;
  }

  function reply(executablePath: string | null, startedAt: string | null): void {
    vi.mocked(execFileSync).mockReturnValue(
      JSON.stringify({ Path: executablePath, StartTime: startedAt }),
    );
  }

  async function expectPreserved(content: string): Promise<void> {
    await expect(store.initialize()).rejects.toMatchObject({ code: "STORE_LOCKED" });
    expect(await readFile(path.join(directory, "store.lock"), "utf8")).toBe(content);
  }

  async function expectRecovered(): Promise<void> {
    await store.initialize();
    expect(JSON.parse(await readFile(path.join(directory, "store.lock"), "utf8"))).toMatchObject({
      pid: process.pid,
      instanceId: "new-owner",
    });
    // Identity probes must never terminate the unrelated process.
    for (const [, signal] of vi.mocked(process.kill).mock.calls) expect(signal).toBe(0);
  }

  it("recovers a reused system PID using CIM creation time when Get-Process cannot read identity", async () => {
    await writeLock();
    vi.mocked(execFileSync).mockImplementation((_file, args) => {
      const query = args?.at(-1) ?? "";
      return JSON.stringify({
        Path: null,
        StartTime: query.includes("Get-CimInstance") ? reusedStart : null,
      });
    });
    await expectRecovered();
    expect(execFileSync).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-NoProfile", "-NonInteractive", "-Command"]),
      expect.objectContaining({ timeout: 5_000, windowsHide: true }),
    );
  });

  it("does not query process metadata without contention", async () => {
    await store.initialize();
    expect(execFileSync).not.toHaveBeenCalled();
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("preserves a live owner when only its creation time is readable", async () => {
    reply(null, recordedStart);
    await expectPreserved(await writeLock());
  });

  it("keeps the existing five-second start-time tolerance", async () => {
    reply(null, "2026-10-26T00:37:45.1320000Z");
    await expectPreserved(await writeLock());
  });

  it("recovers a reused PID even when the executable path is unchanged", async () => {
    reply(nodePath, reusedStart);
    await writeLock();
    await expectRecovered();
  });

  it("preserves a live owner with equivalent Windows path spelling", async () => {
    reply("c:/CODEXHOST/node.exe", recordedStart);
    await expectPreserved(await writeLock());
  });

  it("recovers a known different executable even without a creation time", async () => {
    reply("C:\\Windows\\System32\\svchost.exe", null);
    await writeLock();
    await expectRecovered();
  });

  it.each([undefined, "invalid"])(
    "preserves a lock with unavailable path and recorded start time %s",
    async (processStartedAt) => {
      reply(null, reusedStart);
      await expectPreserved(await writeLock({ processStartedAt }));
    },
  );

  it("preserves a legacy lock when only the new process creation time is known", async () => {
    reply(null, reusedStart);
    await expectPreserved(
      await writeLock({ executablePath: undefined, processStartedAt: undefined }),
    );
  });

  it.each(["", "not json", '{"StartTime":"invalid"}'])(
    "preserves the lock for unavailable or malformed metadata %j",
    async (output) => {
      vi.mocked(execFileSync).mockReturnValue(output);
      await expectPreserved(await writeLock());
    },
  );

  it("preserves the lock when the metadata query times out", async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw Object.assign(new Error("Cannot query process"), { code: "ETIMEDOUT" });
    });
    await expectPreserved(await writeLock());
  });

  it("still checks CIM identity when the PID existence probe is denied", async () => {
    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error("Access denied"), { code: "EPERM" });
    });
    reply(null, reusedStart);
    await writeLock();
    await expectRecovered();
  });

  it("recovers a dead owner's lock without querying CIM", async () => {
    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    });
    await writeLock();
    await expectRecovered();
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
