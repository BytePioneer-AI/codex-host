import { readFileSync, readlinkSync } from "node:fs";
import type * as fs from "node:fs";
import type * as fsPromises from "node:fs/promises";
import { link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MappingStore } from "../src/index.js";
import { createLockFile, removeStaleLock } from "../src/lock-file.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    readlinkSync: vi.fn(actual.readlinkSync),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return { ...actual, link: vi.fn(actual.link) };
});

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
if (!originalPlatform) throw new Error("Missing process.platform descriptor");
const ownerPid = process.pid + 100;
const contenderPid = process.pid + 101;
const startTicks = "12345678901234567";

function procStat(ticks = startTicks, state = "S"): string {
  const fields = Array<string>(20).fill("0");
  fields[0] = state;
  fields[19] = ticks;
  return `${ownerPid} (worker (nested) name) ${fields.join(" ")}\n`;
}

function denied(): never {
  throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
}

describe("Linux Mapping Store lock identity (simulated procfs)", () => {
  let directory: string;
  let lock: string;
  let store: MappingStore;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-linux-lock-"));
    lock = path.join(directory, "store.lock");
    store = new MappingStore({ directory, instanceId: "new-owner" });
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === 99999999) throw Object.assign(new Error("No such process"), { code: "ESRCH" });
      return true;
    });
    vi.mocked(link).mockClear();
    vi.mocked(readFileSync).mockImplementation(() => procStat());
    vi.mocked(readlinkSync).mockImplementation(() => process.execPath);
  });

  afterEach(async () => {
    Object.defineProperty(process, "platform", originalPlatform);
    vi.restoreAllMocks();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function writeLock(overrides: Record<string, unknown> = {}): Promise<string> {
    const content = JSON.stringify({
      pid: ownerPid,
      instanceId: "previous-owner",
      executablePath: process.execPath,
      processStartedAt: new Date(0).toISOString(),
      processStartTicks: startTicks,
      ...overrides,
    });
    await writeFile(lock, content);
    return content;
  }

  async function expectPreserved(content: string): Promise<void> {
    await expect(store.initialize()).rejects.toMatchObject({ code: "STORE_LOCKED" });
    expect(await readFile(lock, "utf8")).toBe(content);
  }

  async function expectRecovered(): Promise<void> {
    await store.initialize();
    expect(JSON.parse(await readFile(lock, "utf8"))).toMatchObject({
      pid: process.pid,
      instanceId: "new-owner",
      processStartTicks: startTicks,
    });
  }

  it("writes raw start ticks without reading boot wall time", async () => {
    await expectRecovered();
    expect(readFileSync).toHaveBeenCalledWith(`/proc/${process.pid}/stat`, "utf8");
    expect(
      vi
        .mocked(readFileSync)
        .mock.calls.every(([file]) => String(file).endsWith("/stat") && file !== "/proc/stat"),
    ).toBe(true);
  });

  it.each(["claim", "publish"])("names generated %s links with raw ticks", async (kind) => {
    if (kind === "publish") {
      await createLockFile(lock, "stale");
    } else {
      const content = await writeLock();
      await removeStaleLock(lock, content);
    }
    expect(link).toHaveBeenCalledWith(
      kind === "publish"
        ? expect.stringContaining(`${lock}.publish-${process.pid}-ticks${startTicks}-`)
        : lock,
      kind === "claim"
        ? expect.stringContaining(`${lock}.claim-${process.pid}-ticks${startTicks}-`)
        : lock,
    );
  });

  it("preserves a live owner across clock jumps with spaces and parentheses in comm", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    await expectPreserved(await writeLock());
  });

  it.each([
    [startTicks, "/usr/bin/replaced-node (deleted)"],
    [startTicks, `${process.execPath} (deleted)`],
    [undefined, `${process.execPath} (deleted)`],
  ])("preserves a live owner with ticks %s and executable %s", async (ticks, executable) => {
    vi.mocked(readlinkSync).mockReturnValue(executable);
    await expectPreserved(await writeLock({ processStartTicks: ticks }));
  });

  it("recovers an owner that exits between the PID probe and reading procfs", async () => {
    let probes = 0;
    vi.mocked(process.kill).mockImplementation((pid) => {
      if (pid === ownerPid && ++probes > 1)
        throw Object.assign(new Error("No such process"), { code: "ESRCH" });
      return true;
    });
    vi.mocked(readFileSync).mockImplementation((file) => {
      if (file === `/proc/${ownerPid}/stat`)
        throw Object.assign(new Error("No such file"), { code: "ENOENT" });
      return procStat();
    });
    await writeLock();
    await expectRecovered();
    expect(probes).toBe(2);
  });

  it.each(["live", "EPERM"])(
    "preserves an owner without procfs when the second PID probe reports %s",
    async (result) => {
      let probes = 0;
      vi.mocked(process.kill).mockImplementation((pid) => {
        if (pid === ownerPid && ++probes > 1 && result === "EPERM")
          throw Object.assign(new Error("Permission denied"), { code: "EPERM" });
        return true;
      });
      vi.mocked(readFileSync).mockImplementation(() => {
        throw Object.assign(new Error("No such file"), { code: "ENOENT" });
      });
      vi.mocked(readlinkSync).mockImplementation(denied);
      await expectPreserved(await writeLock());
      expect(probes).toBe(2);
    },
  );

  it("recovers a reused PID with the same executable and different start ticks", async () => {
    await writeLock({ processStartTicks: "12345678901234568" });
    await expectRecovered();
  });

  it("recovers a reused PID belonging to another executable", async () => {
    await writeLock({ executablePath: "/usr/bin/unrelated", processStartTicks: undefined });
    await expectRecovered();
  });

  it.each([undefined, "invalid"])(
    "preserves an ISO-only live lock with ticks %s",
    async (ticks) => {
      await expectPreserved(await writeLock({ processStartTicks: ticks }));
    },
  );

  it("preserves an unidentified legacy owner even if its executable is not node", async () => {
    vi.mocked(readlinkSync).mockReturnValue("/opt/codexhost");
    await expectPreserved(
      await writeLock({ processStartTicks: undefined, executablePath: undefined }),
    );
  });

  it("recovers a zombie owner", async () => {
    vi.mocked(readFileSync).mockImplementation(() => procStat(startTicks, "Z"));
    await writeLock();
    await store.initialize();
    expect(JSON.parse(await readFile(lock, "utf8"))).toMatchObject({ instanceId: "new-owner" });
  });

  it.each(["denied", "truncated", "invalid ticks", "no comm"])(
    "preserves a live owner when procfs metadata is %s",
    async (kind) => {
      vi.mocked(readFileSync).mockImplementation(() => {
        if (kind === "denied") return denied();
        if (kind === "truncated") return "123 (worker) S 0";
        if (kind === "invalid ticks") return procStat("invalid");
        return "invalid";
      });
      vi.mocked(readlinkSync).mockImplementation(denied);
      await expectPreserved(await writeLock());
    },
  );

  it("preserves an ISO-only lock when exe access is denied", async () => {
    vi.mocked(readlinkSync).mockImplementation(denied);
    await expectPreserved(await writeLock({ processStartTicks: undefined }));
  });

  it.each(["claim", "publish"])("recovers a %s link whose PID was reused", async (kind) => {
    await writeLock({ pid: 99999999 });
    const abandoned = `${lock}.${kind}-${contenderPid}-ticks1-abandoned`;
    await link(lock, abandoned);
    await expectRecovered();
    await expect(readFile(abandoned)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["claim", "publish"])("preserves a live %s link across clock jumps", async (kind) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now() - 60_000);
    const content = await writeLock({ pid: 99999999 });
    const competing = `${lock}.${kind}-${contenderPid}-ticks${startTicks}-competing`;
    await link(lock, competing);
    await expectPreserved(content);
    expect(await readFile(competing, "utf8")).toBe(content);
  });

  it.each(["claim", "publish"])(
    "preserves a %s link when procfs access is denied",
    async (kind) => {
      const content = await writeLock({ pid: 99999999 });
      vi.mocked(readFileSync).mockImplementation(denied);
      const competing = `${lock}.${kind}-${contenderPid}-ticks1-competing`;
      await link(lock, competing);
      await expectPreserved(content);
      expect(await readFile(competing, "utf8")).toBe(content);
    },
  );

  it.each(["claim", "publish"])("preserves ISO and unrecognized %s links", async (kind) => {
    const content = await writeLock({ pid: 99999999 });
    for (const token of [String(Date.now()), "unknown", "ticksinvalid"]) {
      const competing = `${lock}.${kind}-${contenderPid}-${token}-competing`;
      await link(lock, competing);
      await expectPreserved(content);
      expect(await readFile(competing, "utf8")).toBe(content);
      await rm(competing);
    }
  });
});
