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
import { emptyFailureRecourse, failureLine } from "../src/client/failure-line.ts";
import { en, zh, type SidebarDocumentPreviewKey } from "../src/client/locales.ts";
import { markdownImageUrl } from "../src/client/markdown/path-images.ts";

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

describe("OfficePreviewCache host-scope isolation", () => {
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

  it("skips Hub generation for remote peers, isolates identical paths across hosts, and evicts per-host independently", async () => {
    const localSession = "local-thread" as SessionId;
    const peerASession = makeRemoteSessionId("remote-peer:peer-a", "t1");
    const peerBSession = makeRemoteSessionId("remote-peer:peer-b", "t1");
    const sharedPath = "/workspace/report.docx";

    let hubGeneration = "hub-gen-1" as OfficeToPdfGeneration;
    let peerAGeneration = "peer-a-gen-1" as OfficeToPdfGeneration;
    const generationSpy = vi.fn(async () => ({ ok: true as const, value: hubGeneration }));

    const renderSpy = vi.fn(async (file: { sessionId: SessionId; path: string }) => {
      const label =
        file.sessionId === localSession
          ? `local:${hubGeneration}`
          : file.sessionId === peerASession
            ? `peerA:${peerAGeneration}`
            : "peerB:gen-1";
      const generation =
        file.sessionId === localSession
          ? hubGeneration
          : file.sessionId === peerASession
            ? peerAGeneration
            : ("peer-b-gen-1" as OfficeToPdfGeneration);
      const data = new TextEncoder().encode(label);
      const value: OfficeFileBytes = {
        absolutePath: sharedPath,
        version: "v1",
        offset: 0,
        eof: true,
        bytes: data.byteLength,
        data,
        missingFonts: [],
        generation,
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

    // 1. Remote Peer A renders without querying Hub generation
    const firstPeerA = await cache.read({ sessionId: peerASession, path: sharedPath }, signal);
    expect(firstPeerA.ok).toBe(true);
    expect(generationSpy).toHaveBeenCalledTimes(0);
    expect(renderSpy).toHaveBeenCalledTimes(1);
    if (firstPeerA.ok) {
      expect(new TextDecoder().decode(firstPeerA.value.data)).toBe("peerA:peer-a-gen-1");
    }

    // 2. Second read for Peer A hits cache without calling Hub generation or re-converting
    const cachedPeerA = await cache.read({ sessionId: peerASession, path: sharedPath }, signal);
    expect(cachedPeerA.ok).toBe(true);
    expect(generationSpy).toHaveBeenCalledTimes(0);
    expect(renderSpy).toHaveBeenCalledTimes(1);

    // 3. Peer B with the exact same path and version does NOT collide with Peer A
    const firstPeerB = await cache.read({ sessionId: peerBSession, path: sharedPath }, signal);
    expect(firstPeerB.ok).toBe(true);
    expect(renderSpy).toHaveBeenCalledTimes(2);
    if (firstPeerB.ok) {
      expect(new TextDecoder().decode(firstPeerB.value.data)).toBe("peerB:gen-1");
    }

    // 4. Local session queries Hub generation and renders independently
    const firstLocal = await cache.read({ sessionId: localSession, path: sharedPath }, signal);
    expect(firstLocal.ok).toBe(true);
    expect(generationSpy).toHaveBeenCalledTimes(1);
    expect(renderSpy).toHaveBeenCalledTimes(3);
    if (firstLocal.ok) {
      expect(new TextDecoder().decode(firstLocal.value.data)).toBe("local:hub-gen-1");
    }

    // 5. Hub generation changes -> invalidates local cache ONLY, leaving Peer A & Peer B cached
    hubGeneration = "hub-gen-2" as OfficeToPdfGeneration;
    const secondLocal = await cache.read({ sessionId: localSession, path: sharedPath }, signal);
    expect(secondLocal.ok).toBe(true);
    expect(renderSpy).toHaveBeenCalledTimes(4);
    if (secondLocal.ok) {
      expect(new TextDecoder().decode(secondLocal.value.data)).toBe("local:hub-gen-2");
    }

    const stillCachedPeerA = await cache.read(
      { sessionId: peerASession, path: sharedPath },
      signal,
    );
    expect(stillCachedPeerA.ok).toBe(true);
    expect(renderSpy).toHaveBeenCalledTimes(4);

    await cache.dispose();
  });
});

describe("Remote workspace file preview failure messages and Markdown image routing", () => {
  it("formats clear Chinese and English messages for unsupported/offline/outside-workspace remote errors", () => {
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
