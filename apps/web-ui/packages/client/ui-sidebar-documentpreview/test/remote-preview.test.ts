import { describe, expect, it, vi } from "vitest";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { OfficeToPdfGeneration } from "@deepseek-ai/dsh-office-to-pdf/types";
import type { RemoteFailure } from "@deepseek-ai/dsh-api-remotes/client";
import {
  OfficePreviewCache,
  decodeRemoteHostScope,
  officeScopeForSession,
  type OfficeFileBytes,
} from "../src/client/office/cache.ts";
import {
  emptyFailureRecourse,
  failureLine,
  remoteWorkspacePreviewBlockKey,
} from "../src/client/failure-line.ts";
import { en, zh, type SidebarDocumentPreviewKey } from "../src/client/locales.ts";
import { markdownImageUrl } from "../src/client/markdown/path-images.ts";
import {
  fileMentionAccess,
  fileMentionSource,
  type FileMentionSessionRow,
} from "../../ui-sidebar-files/src/client/file-mentions.ts";

function makeRemoteSessionId(hostId: string, threadId: string): SessionId {
  const encoded = Buffer.from(JSON.stringify([hostId, threadId])).toString("base64url");
  return `web-remote:${encoded}` as SessionId;
}

function makeTranslator(dict: Record<SidebarDocumentPreviewKey, string>) {
  return (key: SidebarDocumentPreviewKey, params?: Record<string, string | number>) => {
    let text = dict[key];
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace(`{${k}}`, String(v));
      }
    }
    return text;
  };
}

describe("OfficePreviewCache host-scope isolation & stale generation protection", () => {
  it("decodes remote host scopes and separates local from per-peer remote sessions", () => {
    const peerA = makeRemoteSessionId("remote-peer:peer-a", "thread-1");
    const peerB = makeRemoteSessionId("remote-peer:peer-b", "thread-1");
    expect(decodeRemoteHostScope("local-thread")).toBeUndefined();
    expect(decodeRemoteHostScope(peerA)).toBe("remote-peer:peer-a");
    expect(officeScopeForSession("local-thread")).toEqual({
      scopeKey: "local",
      useHostGeneration: true,
    });
    expect(officeScopeForSession(peerA)).toEqual({
      scopeKey: "remote:remote-peer:peer-a",
      useHostGeneration: false,
    });
    expect(officeScopeForSession(peerB)).toEqual({
      scopeKey: "remote:remote-peer:peer-b",
      useHostGeneration: false,
    });
  });

  it("refreshes when Peer generation changes with unchanged file version, prevents late-arrival pollution, and keeps local cache isolated", async () => {
    const localSession = "local-thread" as SessionId;
    const peerASession = makeRemoteSessionId("remote-peer:peer-a", "t1");
    const sharedPath = "/workspace/report.docx";

    let hubGeneration = "hub-gen-1" as OfficeToPdfGeneration;
    let peerAGeneration = "peer-a-gen-1" as OfficeToPdfGeneration;
    const generationSpy = vi.fn(async () => ({ ok: true as const, value: hubGeneration }));

    let releaseSlowPeerRender!: () => void;
    let slowRenderMode = false;

    const renderSpy = vi.fn(async (file: { sessionId: SessionId; path: string }) => {
      const capturedGeneration = file.sessionId === localSession ? hubGeneration : peerAGeneration;
      if (file.sessionId === peerASession && slowRenderMode) {
        slowRenderMode = false;
        await new Promise<void>((resolve) => {
          releaseSlowPeerRender = resolve;
        });
      }
      const label =
        file.sessionId === localSession
          ? `local:${capturedGeneration}`
          : `peerA:${capturedGeneration}`;
      const data = new TextEncoder().encode(label);
      const value: OfficeFileBytes = {
        absolutePath: sharedPath,
        version: "v1",
        offset: 0,
        eof: true,
        bytes: data.byteLength,
        data,
        missingFonts: [],
        generation: capturedGeneration,
      };
      return { ok: true as const, value };
    });

    const cache = new OfficePreviewCache(
      async () => ({ ok: true as const, value: { absolutePath: sharedPath, version: "v1" } }),
      renderSpy,
      10,
      1024 * 1024,
      4,
      8,
      generationSpy,
      () => new Error("busy"),
      (file) => officeScopeForSession(file.sessionId),
    );

    const signal = new AbortController().signal;

    // 1. Concurrent remote reads deduplicate into one in-flight conversion without querying Hub generation
    slowRenderMode = true;
    const p1 = cache.read({ sessionId: peerASession, path: sharedPath }, signal);
    const p2 = cache.read({ sessionId: peerASession, path: sharedPath }, signal);
    await new Promise((r) => setTimeout(r, 10));
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(generationSpy).toHaveBeenCalledTimes(0);

    // Peer restarts/replaces fonts while file version stays "v1"
    peerAGeneration = "peer-a-gen-2" as OfficeToPdfGeneration;
    releaseSlowPeerRender();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok) expect(new TextDecoder().decode(r1.value.data)).toBe("peerA:peer-a-gen-1");

    // 2. Next open after Peer generation changed MUST NOT return stale gen-1 PDF
    const freshPeerA = await cache.read({ sessionId: peerASession, path: sharedPath }, signal);
    expect(freshPeerA.ok).toBe(true);
    expect(generationSpy).toHaveBeenCalledTimes(0);
    expect(renderSpy).toHaveBeenCalledTimes(2);
    if (freshPeerA.ok) {
      expect(new TextDecoder().decode(freshPeerA.value.data)).toBe("peerA:peer-a-gen-2");
    }

    // 3. Local session caches properly and is never polluted by remote renders
    const firstLocal = await cache.read({ sessionId: localSession, path: sharedPath }, signal);
    const cachedLocal = await cache.read({ sessionId: localSession, path: sharedPath }, signal);
    expect(firstLocal.ok && cachedLocal.ok).toBe(true);
    expect(generationSpy).toHaveBeenCalledTimes(2);
    expect(renderSpy).toHaveBeenCalledTimes(3);
    if (cachedLocal.ok) {
      expect(new TextDecoder().decode(cachedLocal.value.data)).toBe("local:hub-gen-1");
    }

    // 4. Hub generation bump invalidates local cache cleanly
    hubGeneration = "hub-gen-2" as OfficeToPdfGeneration;
    const secondLocal = await cache.read({ sessionId: localSession, path: sharedPath }, signal);
    expect(secondLocal.ok).toBe(true);
    expect(renderSpy).toHaveBeenCalledTimes(4);
    if (secondLocal.ok) {
      expect(new TextDecoder().decode(secondLocal.value.data)).toBe("local:hub-gen-2");
    }

    await cache.dispose();
  });
});

describe("Remote workspace file preview failure messages, capability gating, mentions, and Markdown image routing", () => {
  it("formats clear Chinese and English messages and blocks incapable remote hosts upfront", () => {
    const tZh = makeTranslator(zh);
    const tEn = makeTranslator(en);

    const upgradeErr = {
      code: "remote/workspace-files-unsupported",
      message: "upgrade",
      details: { reason: "upgrade-required" },
    } as unknown as RemoteFailure;
    expect(failureLine(tZh, upgradeErr)).toContain("升级");
    expect(failureLine(tEn, upgradeErr)).toContain("Upgrade codexhost");
    expect(emptyFailureRecourse(upgradeErr)).toBe("none");

    const draftErr = {
      code: "remote/workspace-files-unsupported",
      message: "draft",
      details: { reason: "unsubmitted-draft" },
    } as unknown as RemoteFailure;
    expect(failureLine(tZh, draftErr)).toContain("第一条消息");
    expect(failureLine(tEn, draftErr)).toContain("first message");

    const offlineErr = {
      code: "remote/offline",
      message: "offline",
      details: {},
    } as unknown as RemoteFailure;
    expect(failureLine(tZh, offlineErr)).toContain("离线");
    expect(failureLine(tEn, offlineErr)).toContain("offline");
    expect(emptyFailureRecourse(offlineErr)).toBe("retry");

    const outsideErr = {
      code: "workspace-file/outside-workspace",
      message: "outside",
      details: { path: "../secret" },
    } as unknown as RemoteFailure;
    expect(failureLine(tZh, outsideErr)).toContain("工作区之外");
    expect(failureLine(tEn, outsideErr)).toContain("outside the workspace");
    expect(emptyFailureRecourse(outsideErr)).toBe("none");

    // Upfront remoteHost.workspaceFiles capability gating
    const peerSession = makeRemoteSessionId("remote-peer:p1", "t1");
    expect(
      remoteWorkspacePreviewBlockKey(peerSession, {
        hostId: "remote-peer:p1",
        state: "connected",
        workspaceFiles: true,
      }),
    ).toBeUndefined();
    expect(
      remoteWorkspacePreviewBlockKey(peerSession, {
        hostId: "remote-peer:p1",
        state: "connected",
        workspaceFiles: false,
      }),
    ).toBe("error.remoteUpgradeRequired");
    expect(
      remoteWorkspacePreviewBlockKey("web-remote:draft-1", {
        hostId: "remote-peer:p1",
        state: "connected",
        workspaceFiles: false,
      }),
    ).toBe("error.remoteDraftUnsubmitted");
    expect(
      remoteWorkspacePreviewBlockKey(peerSession, {
        hostId: "remote-ssh:box",
        state: "connected",
        workspaceFiles: false,
      }),
    ).toBe("error.remoteUnsupported");
    expect(
      remoteWorkspacePreviewBlockKey(peerSession, {
        hostId: "remote-peer:p1",
        state: "disconnected",
        workspaceFiles: false,
      }),
    ).toBe("error.remoteOffline");
    expect(remoteWorkspacePreviewBlockKey("local-1", null)).toBeUndefined();
  });

  it("enables @ file mentions for committed online remote peers with workspaceFiles even when cwd is empty, and disables unsupported/draft/offline remotes", async () => {
    const peerSession = makeRemoteSessionId("remote-peer:p1", "t1");
    const rows: Record<string, FileMentionSessionRow> = {
      [peerSession]: {
        cwd: "",
        blank: false,
        projectionValues: {
          remoteHost: { hostId: "remote-peer:p1", state: "connected", workspaceFiles: true },
        },
      },
      "web-remote:draft-1": {
        cwd: "",
        blank: true,
        projectionValues: {
          remoteHost: { hostId: "remote-peer:p1", state: "connected", workspaceFiles: false },
        },
      },
      [makeRemoteSessionId("remote-peer:offline", "t1")]: {
        cwd: "",
        blank: false,
        projectionValues: {
          remoteHost: {
            hostId: "remote-peer:offline",
            state: "disconnected",
            workspaceFiles: false,
          },
        },
      },
      [makeRemoteSessionId("remote-peer:legacy", "t1")]: {
        cwd: "",
        blank: false,
        projectionValues: {
          remoteHost: { hostId: "remote-peer:legacy", state: "connected", workspaceFiles: false },
        },
      },
      [makeRemoteSessionId("remote-ssh:box", "t1")]: {
        cwd: "",
        blank: false,
        projectionValues: {
          remoteHost: { hostId: "remote-ssh:box", state: "connected", workspaceFiles: false },
        },
      },
      "remote-control:box-1": {
        cwd: "",
        blank: false,
        projectionValues: {
          remoteHost: { hostId: "remote-control:box-1", state: "connected", workspaceFiles: false },
        },
      },
      "local-with-cwd": { cwd: "/repo", blank: false },
      "local-no-cwd": { cwd: "", blank: false },
    };

    expect(fileMentionAccess(peerSession as never, rows[peerSession])).toBe("enabled");
    expect(fileMentionAccess("local-with-cwd" as never, rows["local-with-cwd"])).toBe("enabled");
    expect(fileMentionAccess("local-no-cwd" as never, rows["local-no-cwd"])).toBe("no-workspace");

    const listSpy = vi.fn(async () => ({
      ok: true as const,
      value: [{ path: "src/app.ts", kind: "file" as const }],
    }));
    const accessFor = (id: string) => fileMentionAccess(id as never, rows[id]);
    const source = fileMentionSource(
      { fileReferences: { list: listSpy } },
      (id) => accessFor(id) === "enabled",
      ((k: string) => k) as never,
      (id) => accessFor(id) === "disabled",
    );

    // Enabled remote Peer session queries fileReferences.list even though cwd is ""
    const enabledCandidates = await source.candidates(
      { sessionId: peerSession } as never,
      { query: "app", quoted: false, signal: new AbortController().signal } as never,
    );
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(enabledCandidates.map((c) => c.value)).toEqual(["@src/app.ts"]);

    // Draft, offline, legacy, SSH, and remote-control remain disabled without calling fileReferences.list
    listSpy.mockClear();
    for (const disabledId of [
      "web-remote:draft-1",
      makeRemoteSessionId("remote-peer:offline", "t1"),
      makeRemoteSessionId("remote-peer:legacy", "t1"),
      makeRemoteSessionId("remote-ssh:box", "t1"),
      "remote-control:box-1",
    ]) {
      expect(accessFor(disabledId)).toBe("disabled");
      const candidates = await source.candidates(
        { sessionId: disabledId } as never,
        { query: "README", quoted: false, signal: new AbortController().signal } as never,
      );
      expect(candidates).toEqual([]);
    }
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("routes Markdown images for remote sessions to /api/remote-peer/file instead of Hub local /api/file", () => {
    const remoteSession = makeRemoteSessionId("remote-peer:peer-1", "t1");
    const remoteUrl = markdownImageUrl(
      "http://localhost:4400/",
      "/remote/work/docs/README.md",
      "./img/pic.png",
      remoteSession,
    );
    expect(remoteUrl).toBeDefined();
    const parsed = new URL(remoteUrl ?? "");
    expect(parsed.pathname).toBe("/api/remote-peer/file");
    expect(parsed.searchParams.get("sessionId")).toBe(remoteSession);
    expect(parsed.searchParams.get("path")).toBe("/remote/work/docs/./img/pic.png");

    const localUrl = markdownImageUrl(
      "http://localhost:4400/",
      "/local/work/docs/README.md",
      "./img/pic.png",
      "local-1",
    );
    expect(localUrl).toContain("/api/file?");
  });
});
