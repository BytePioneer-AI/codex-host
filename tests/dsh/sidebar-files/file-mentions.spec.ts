import { describe, expect, it, vi } from "vitest";
import type { TranslateNS } from "@deepseek-ai/dsh-client-locale/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import { fileMentionSource } from "@deepseek-ai/dsh-client-ui-sidebar-files/src/client/file-mentions.ts";
import { en } from "@deepseek-ai/dsh-client-ui-sidebar-files/src/client/locales.ts";

const session = { sessionId: "draft-files" as SessionId };
const t = ((key: keyof typeof en) => en[key]) as TranslateNS<"sidebarFiles">;
const request = (query: string, signal = new AbortController().signal) => ({
  query,
  signal,
  position: "inline" as const,
  drilled: false,
});

describe("workspace file mentions", () => {
  it("filters one directory, omits unrepresentable names, and preserves quoted paths", async () => {
    const list = vi.fn(async () => ({
      ok: true as const,
      value: [
        { path: "my docs/READ", kind: "directory" as const },
        { path: "my docs/read me.md", kind: "file" as const },
        { path: 'my docs/read"bad', kind: "file" as const },
      ],
    }));
    const source = fileMentionSource({ fileReferences: { list } }, () => true, t);
    expect(source.aliases).toEqual(["#"]);
    expect(source.order).toBeGreaterThan(20);
    const req = request("my docs/read");
    const candidates = await source.candidates(session, { ...req, quoted: true });
    expect(list).toHaveBeenCalledWith(session.sessionId, "my docs/read", req.signal);
    expect(candidates.map((entry) => entry.name)).toEqual(["my docs/READ", "my docs/read me.md"]);
    const pick = (index: number, action: "pick" | "drill", trigger: "@" | "#" = "@") =>
      source.onPick({
        candidate: candidates[index]!,
        trigger,
        session,
        action,
        position: "inline",
        via: "menu",
        span: { start: 5, end: 20, draftRev: 1 },
      });
    expect(pick(0, "drill")).toEqual({ text: '@"my docs/READ/', continue: true });
    expect(pick(0, "drill", "#")).toEqual({ text: '#"my docs/READ/', continue: true });
    expect(pick(0, "pick")).toEqual({ text: '@"my docs/READ/" ' });
    expect(pick(1, "pick")).toEqual({ text: '@"my docs/read me.md" ' });
  });

  it("does not query unbound workspaces or accept an aborted listing", async () => {
    const list = vi.fn(async () => ({
      ok: true as const,
      value: [],
    }));
    const source = fileMentionSource({ fileReferences: { list } }, () => false, t);
    expect((await source.candidates(session, request("")))[0]?.disabledReason).toBe(en.noWorkspace);
    expect(list).not.toHaveBeenCalled();
    const bound = fileMentionSource({ fileReferences: { list } }, () => true, t);
    const abort = new AbortController();
    const pending = bound.candidates(session, request("", abort.signal));
    abort.abort();
    await expect(pending).rejects.toThrow();
  });

  it("passes bare queries to recursive search and surfaces no matches", async () => {
    const list = vi.fn(async () => ({
      ok: true as const,
      value: [],
    }));
    const source = fileMentionSource({ fileReferences: { list } }, () => true, t);
    const rows = await source.candidates(session, request("absent"));
    expect(list).toHaveBeenCalledWith(session.sessionId, "absent", expect.any(AbortSignal));
    expect(rows.map((row) => row.disabledReason)).toEqual([en["mention.noMatches"]]);
  });

  it("keeps listing failures visible and unselectable", async () => {
    const list = vi.fn(async () => ({
      ok: false as const,
      error: new RemoteError("workspace-file/not-found", "Directory removed", { path: "gone/" }),
    }));
    const source = fileMentionSource({ fileReferences: { list } }, () => true, t);
    const rows = await source.candidates(session, request("gone/"));
    expect(rows[0]?.disabledReason).toBe(en["error.unavailable"]);
    expect(rows[0]?.value).toBeUndefined();
  });
});
