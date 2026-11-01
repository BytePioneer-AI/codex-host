import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { OpenCodeClient } from "@opencode/client";
import { harnessSessionImportCandidateSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenCodeAdapter as V1Adapter } from "../src/opencode-adapter.js";
import { V2Adapter } from "../src/v2/adapter.js";
import { V2Connection } from "../src/v2/connection.js";
import { listV2SessionCandidates, resolveV2SessionCandidate } from "../src/v2/session-import.js";
import { detectOpenCode } from "../src/version.js";
import { OpenCodeAdapter } from "../src/versioned-adapter.js";

vi.mock("../src/version.js", () => ({ detectOpenCode: vi.fn() }));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(detectOpenCode).mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "codexhost-opencode-import-")));
  roots.push(root);
  const cwd = path.join(root, "project");
  await mkdir(cwd);
  return cwd;
}

function info(id: string, directory: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    projectID: "p",
    title: `Title ${id}`,
    time: { created: 1_000, updated: 2_000 },
    location: { directory },
    ...overrides,
  };
}

/** Serves fixed pages and records the cursors the importer asked for. */
function client(pages: unknown[][], active: Record<string, unknown> = {}) {
  const cursors: (string | undefined)[] = [];
  const list = vi.fn((input: { cursor?: string } = {}) => {
    cursors.push(input.cursor);
    const index = input.cursor ? Number(input.cursor) : 0;
    return Promise.resolve({
      data: pages[index] ?? [],
      cursor: { next: index + 1 < pages.length ? String(index + 1) : null },
    });
  });
  return {
    cursors,
    list,
    client: {
      session: { list, active: () => Promise.resolve(active) },
    } as unknown as OpenCodeClient,
  };
}

describe("OpenCode v2 Session import discovery", () => {
  it("lists top-level Sessions of every page with browser-safe metadata", async () => {
    const cwd = await project();
    const fake = client(
      [
        [
          info("ses_a", cwd, { title: " Native\ttitle " }),
          info("ses_child", cwd, { parentID: "ses_a" }),
          info("ses_archived", cwd, { time: { created: 1, updated: 2, archived: 3 } }),
        ],
        [
          info("ses_b", cwd, { title: undefined, fork: { sessionID: "ses_a" } }),
          info("ses_gone", path.join(cwd, "missing")),
          info("ses_relative", "relative"),
          info("ses_running", cwd),
        ],
      ],
      { ses_running: { type: "running" } },
    );

    const listed = await listV2SessionCandidates(fake.client);
    expect(listed).toEqual([
      { nativeSessionId: "ses_a", title: "Native title", updatedAt: 2_000, cwd, running: null },
      // A Fork is an ordinary resumable Session; a missing title stays null.
      { nativeSessionId: "ses_b", title: null, updatedAt: 2_000, cwd, running: null },
      {
        nativeSessionId: "ses_running",
        title: "Title ses_running",
        updatedAt: 2_000,
        cwd,
        running: true,
      },
    ]);
    expect(fake.cursors).toEqual([undefined, "1"]);
    expect(harnessSessionImportCandidateSchema.array().safeParse(listed).success).toBe(true);
  });

  it("stops on a repeating cursor instead of reading forever", async () => {
    const cwd = await project();
    const list = vi.fn(() =>
      Promise.resolve({ data: [info("ses_a", cwd)], cursor: { next: "same" } }),
    );
    const looping = {
      session: { list, active: () => Promise.resolve({}) },
    } as unknown as OpenCodeClient;
    expect(await listV2SessionCandidates(looping)).toHaveLength(1);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("resolves the selected Session from the native listing with a v2 resume reference", async () => {
    const cwd = await project();
    const fake = client([
      [info("ses_a", cwd)],
      [info("ses_b", cwd), info("ses_child", cwd, { parentID: "x" })],
    ]);
    expect(await resolveV2SessionCandidate(fake.client, "ses_b")).toEqual({
      candidate: {
        nativeSessionId: "ses_b",
        title: "Title ses_b",
        updatedAt: 2_000,
        cwd,
        running: null,
      },
      nativeRef: {
        harnessId: "opencode",
        nativeSessionId: "ses_b",
        formatVersion: 1,
        // Earlier unattended access is not attested by native history and is never assumed.
        locator: { protocol: 2, directory: cwd, executionPolicy: "default" },
      },
    });
    expect(await resolveV2SessionCandidate(fake.client, "ses_child")).toBeNull();
    expect(await resolveV2SessionCandidate(fake.client, "ses_missing")).toBeNull();
  });
});

describe("OpenCode Session import through the Adapter", () => {
  it("reads through a private server, closes it, and maps failures to bounded results", async () => {
    const cwd = await project();
    const fake = client([[info("ses_a", cwd)]]);
    const connect = vi.spyOn(V2Connection.prototype, "client").mockResolvedValue(fake.client);
    const disconnect = vi.spyOn(V2Connection.prototype, "close").mockResolvedValue();
    const adapter = new V2Adapter({});

    expect(await adapter.sessionImport.listCandidates()).toMatchObject({
      ok: true,
      value: [{ nativeSessionId: "ses_a" }],
    });
    expect(await adapter.sessionImport.resolveCandidate("ses_a")).toMatchObject({
      ok: true,
      value: { nativeRef: { nativeSessionId: "ses_a" } },
    });
    expect(await adapter.sessionImport.resolveCandidate("ses_missing")).toMatchObject({
      ok: false,
      error: { code: "sessionNotFound" },
    });
    expect(disconnect).toHaveBeenCalledTimes(3);

    connect.mockRejectedValueOnce(new Error("spawn /secret/path ENOENT"));
    const failed = await adapter.sessionImport.listCandidates();
    expect(failed).toMatchObject({ ok: false, error: { code: "unavailable", retryable: true } });
    expect(JSON.stringify(failed)).not.toContain("/secret/path");
    expect(disconnect).toHaveBeenCalledTimes(4);

    await adapter.close();
    expect(await adapter.sessionImport.listCandidates()).toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    expect(connect).toHaveBeenCalledTimes(4);
  });

  it("routes by the selected CLI: v2 imports, v1 reports unsupported", async () => {
    const cwd = await project();
    const fake = client([[info("ses_a", cwd)]]);
    vi.spyOn(V2Connection.prototype, "client").mockResolvedValue(fake.client);
    vi.spyOn(V2Connection.prototype, "close").mockResolvedValue();
    const closeV1 = vi.spyOn(V1Adapter.prototype, "close").mockResolvedValue();
    vi.mocked(detectOpenCode)
      .mockResolvedValueOnce({ major: 2, executable: "/test/v2" })
      .mockResolvedValueOnce({ major: 1, executable: "/test/v1" })
      .mockRejectedValueOnce(new Error("no CLI"));
    const adapter = new OpenCodeAdapter();

    expect(await adapter.sessionImport.listCandidates()).toMatchObject({
      ok: true,
      value: [{ nativeSessionId: "ses_a" }],
    });
    // v1 only lists per project; there is nothing to import across projects from.
    expect(await adapter.sessionImport.resolveCandidate?.("ses_a")).toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
    expect(closeV1).toHaveBeenCalledTimes(1);
    expect(await adapter.sessionImport.listCandidates()).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });

    await adapter.close();
    expect(await adapter.sessionImport.listCandidates()).toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    expect(detectOpenCode).toHaveBeenCalledTimes(3);
  });
});
