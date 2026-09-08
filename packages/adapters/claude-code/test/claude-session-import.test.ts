import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { harnessIdSchema } from "@codexhost/shared-contracts";

import { ClaudeCodeAdapter } from "../src/claude-code-adapter.js";
import { ClaudeSessionImportIndex } from "../src/claude-session-import.js";
import type { ClaudeAdapterDependencies, ClaudeSessionMetadata } from "../src/transport.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; cwd: string }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "codexhost-claude-import-")));
  roots.push(root);
  const cwd = path.join(root, "project");
  await mkdir(cwd);
  return { root, cwd };
}

function metadata(cwd: string, overrides: Partial<ClaudeSessionMetadata> = {}) {
  return {
    sessionId: "claude-native-session",
    summary: "Native summary",
    lastModified: 1_767_225_600_123,
    cwd,
    ...overrides,
  } satisfies ClaudeSessionMetadata;
}

describe("Claude native Session import discovery", () => {
  it("maps SDK metadata to a resumable source without reading Transcript content", async () => {
    const { cwd } = await fixture();
    const listSessions = vi.fn(async () => [
      metadata(cwd, {
        customTitle: "  Custom\0 title  ",
        firstPrompt: "private prompt",
      }),
    ]);
    const getSessionInfo = vi.fn(async () => metadata(cwd));
    const index = new ClaudeSessionImportIndex({
      listSessions,
      getSessionInfo,
      isRunning: () => false,
      readSessionMessages: async () => [],
    });

    await expect(index.list(new AbortController().signal)).resolves.toEqual([
      {
        candidate: {
          nativeSessionId: "claude-native-session",
          cwd,
          title: "Custom title",
          updatedAt: 1_767_225_600_123,
          running: null,
        },
        nativeRef: {
          harnessId: "claude-code",
          nativeSessionId: "claude-native-session",
          formatVersion: 1,
        },
      },
    ]);
    expect(listSessions).toHaveBeenCalledOnce();
    expect(getSessionInfo).not.toHaveBeenCalled();
  });

  it("skips metadata that cannot safely resume and rejects ambiguous identities", async () => {
    const { root, cwd } = await fixture();
    const index = new ClaudeSessionImportIndex({
      listSessions: async () => [
        metadata(cwd),
        metadata(cwd),
        metadata("relative/path", { sessionId: "relative" }),
        metadata(path.join(root, "missing"), { sessionId: "missing" }),
        metadata(cwd, { sessionId: "bad-time", lastModified: Number.NaN }),
      ],
      getSessionInfo: async () => undefined,
      isRunning: () => false,
      readSessionMessages: async () => [],
    });
    await expect(index.list(new AbortController().signal)).rejects.toThrow("ambiguous");
  });

  it("freshly resolves the selected ID and reports sessions opened by this Adapter as running", async () => {
    const { cwd } = await fixture();
    const native = metadata(cwd);
    const getSessionInfo = vi.fn(async () => native);
    const listSessions = vi.fn(async () => [native]);
    const adapter = new ClaudeCodeAdapter({}, {
      randomUUID: () => "new-session",
      getSessionInfo,
      listSessions,
      readSessionMessages: async () => [],
    } as unknown as ClaudeAdapterDependencies);

    await expect(adapter.sessionImport.listCandidates()).resolves.toMatchObject({
      ok: true,
      value: [{ nativeSessionId: "claude-native-session", running: null }],
    });
    const opened = await adapter.open({
      kind: "resume",
      cwd,
      nativeRef: {
        harnessId: harnessIdSchema.parse("claude-code"),
        nativeSessionId: "claude-native-session",
        formatVersion: 1,
      },
    });
    expect(opened.ok).toBe(true);
    await expect(adapter.sessionImport.listCandidates()).resolves.toMatchObject({
      ok: true,
      value: [{ nativeSessionId: "claude-native-session", running: true }],
    });
    await expect(
      adapter.sessionImport.resolveCandidate("claude-native-session"),
    ).resolves.toMatchObject({
      ok: true,
      value: { nativeRef: { nativeSessionId: "claude-native-session" } },
    });
    expect(getSessionInfo).toHaveBeenCalledWith({ sessionId: "claude-native-session" });
    if (opened.ok) await opened.value.close();
    await adapter.close();
  });

  it("does not resolve missing or mismatched metadata and honors cancellation", async () => {
    const { cwd } = await fixture();
    const getSessionInfo = vi
      .fn<({ sessionId }: { sessionId: string }) => Promise<ClaudeSessionMetadata | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(metadata(cwd, { sessionId: "another-session" }));
    const index = new ClaudeSessionImportIndex({
      listSessions: async () => [],
      getSessionInfo,
      isRunning: () => false,
      readSessionMessages: async () => [],
    });
    const signal = new AbortController().signal;
    await expect(index.resolve("missing", signal)).resolves.toBeNull();
    await expect(index.resolve("requested", signal)).resolves.toBeNull();

    const controller = new AbortController();
    controller.abort();
    await expect(index.list(controller.signal)).rejects.toThrow();
  });

  it("resolves the selected Session to its latest existing Transcript cwd", async () => {
    const { root, cwd } = await fixture();
    const latestCwd = path.join(cwd, "repository");
    await mkdir(latestCwd);
    const readSessionMessages = vi.fn(async () => [
      { type: "user", cwd },
      { type: "assistant", cwd: path.join(root, "missing") },
      { type: "user", cwd: latestCwd },
    ]);
    const index = new ClaudeSessionImportIndex({
      listSessions: async () => [metadata(cwd)],
      getSessionInfo: async () => metadata(cwd),
      isRunning: () => false,
      readSessionMessages,
    });

    await expect(index.list(new AbortController().signal)).resolves.toMatchObject([
      { candidate: { cwd } },
    ]);
    await expect(
      index.resolve("claude-native-session", new AbortController().signal),
    ).resolves.toMatchObject({ candidate: { cwd: latestCwd } });
    expect(readSessionMessages).toHaveBeenCalledWith({
      cwd,
      sessionId: "claude-native-session",
    });
  });
});
