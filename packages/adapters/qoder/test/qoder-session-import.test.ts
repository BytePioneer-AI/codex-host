import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { harnessSessionImportCandidateSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QoderAdapter } from "../src/qoder-adapter.js";
import type { SDKSessionInfo } from "../src/qoder-sdk-types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "codexhost-qoder-import-")));
  roots.push(root);
  const cwd = path.join(root, "project");
  await mkdir(cwd);
  return cwd;
}

function info(sessionId: string, cwd: string | undefined, overrides: Partial<SDKSessionInfo> = {}) {
  return {
    sessionId,
    summary: `Summary ${sessionId}`,
    lastModified: 2_000,
    ...(cwd === undefined ? {} : { cwd }),
    ...overrides,
  } satisfies SDKSessionInfo;
}

describe("Qoder native Session import discovery", () => {
  it("lists the SDK's Sessions with browser-safe metadata", async () => {
    const cwd = await project();
    const listSessions = vi.fn(() =>
      Promise.resolve([
        info("s-summary", cwd, { firstPrompt: "First prompt", lastModified: 3_000.7 }),
        info("s-custom", cwd, { customTitle: " Custom\ttitle " }),
        info("s-prompt", cwd, { summary: "", firstPrompt: "Only\n prompt" }),
        info("s-untitled", cwd, { summary: "" }),
        // Not resumable in a project: no directory, a relative one, or one that is gone.
        info("s-no-cwd", undefined),
        info("s-relative", "relative"),
        info("s-gone", path.join(cwd, "missing")),
        // A repeated identity keeps its first, most recent entry.
        info("s-summary", cwd, { summary: "Older duplicate", lastModified: 1 }),
      ]),
    );
    const adapter = new QoderAdapter({
      listSessions,
      getSessionInfo: () => Promise.resolve(undefined),
    });

    const listed = await adapter.sessionImport.listCandidates();
    if (!listed.ok) throw new Error(listed.error.message);
    expect(listed.value).toEqual([
      {
        nativeSessionId: "s-summary",
        title: "Summary s-summary",
        updatedAt: 3_000,
        cwd,
        running: null,
      },
      { nativeSessionId: "s-custom", title: "Custom title", updatedAt: 2_000, cwd, running: null },
      { nativeSessionId: "s-prompt", title: "Only prompt", updatedAt: 2_000, cwd, running: null },
      { nativeSessionId: "s-untitled", title: null, updatedAt: 2_000, cwd, running: null },
    ]);
    expect(harnessSessionImportCandidateSchema.array().safeParse(listed.value).success).toBe(true);
    await adapter.close();
  });

  it("re-reads the selected Session and uses the distribution's own identity", async () => {
    const cwd = await project();
    const sessions = new Map([["s-a", info("s-a", cwd)]]);
    const getSessionInfo = vi.fn((sessionId: string) => Promise.resolve(sessions.get(sessionId)));
    const adapter = new QoderAdapter({
      variant: "cn",
      listSessions: () => Promise.resolve([...sessions.values()]),
      getSessionInfo,
    });

    expect(await adapter.sessionImport.resolveCandidate("s-a")).toEqual({
      ok: true,
      value: {
        candidate: {
          nativeSessionId: "s-a",
          title: "Summary s-a",
          updatedAt: 2_000,
          cwd,
          running: null,
        },
        nativeRef: { harnessId: "qoder-cn", nativeSessionId: "s-a", formatVersion: 1 },
      },
    });
    // Looked up across all projects, not only the current directory.
    expect(getSessionInfo).toHaveBeenLastCalledWith("s-a");

    sessions.set("s-a", info("s-a", path.join(cwd, "missing")));
    expect(await adapter.sessionImport.resolveCandidate("s-a")).toMatchObject({
      ok: false,
      error: { code: "sessionNotFound", message: "Qoder CN Session is no longer importable" },
    });
    sessions.delete("s-a");
    expect(await adapter.sessionImport.resolveCandidate("s-a")).toMatchObject({
      ok: false,
      error: { code: "sessionNotFound" },
    });
    // An SDK that answers with another Session is not trusted.
    getSessionInfo.mockResolvedValueOnce(info("s-other", cwd));
    expect(await adapter.sessionImport.resolveCandidate("s-a")).toMatchObject({
      ok: false,
      error: { code: "sessionNotFound" },
    });
    await adapter.close();
  });

  it("maps SDK failures to a bounded result and stops after Adapter close", async () => {
    const listSessions = vi
      .fn<() => Promise<SDKSessionInfo[]>>()
      .mockRejectedValueOnce(new Error("EACCES /secret/path"))
      .mockResolvedValue([]);
    const adapter = new QoderAdapter({
      listSessions,
      getSessionInfo: () => Promise.resolve(undefined),
    });

    const failed = await adapter.sessionImport.listCandidates();
    expect(failed).toMatchObject({ ok: false, error: { code: "unavailable", retryable: true } });
    expect(JSON.stringify(failed)).not.toContain("/secret/path");
    expect(await adapter.sessionImport.listCandidates()).toEqual({ ok: true, value: [] });

    await adapter.close();
    expect(await adapter.sessionImport.listCandidates()).toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    expect(listSessions).toHaveBeenCalledTimes(2);
  });
});
