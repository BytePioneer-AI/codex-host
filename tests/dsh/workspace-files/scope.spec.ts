import { resolve } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import TypertRegistry from "@deepseek-ai/dsh-typert-registry";
import { describe, expect, it } from "vitest";
import WorkspaceFiles from "@deepseek-ai/dsh-api-workspace-files";

const CAPS = {
  maxBytes: 1024,
  maxFileBytes: 1024,
  maxLines: 100,
  maxEntries: 100,
};

describe("Workspace Files Session scope lookup", () => {
  it("uses the Host-recorded local Thread directory and leaves with its plugin", async () => {
    const liveId = SessionId("local-thread");
    const fallbackId = SessionId("local-without-cwd");
    const missingId = SessionId("draft-thread");
    const liveRoot = resolve("live-workspace");
    const fallbackRoot = resolve("fallback-workspace");
    const ctx = new Context();
    ctx.provide("fs", {} as never);
    ctx.provide("sandboxPolicy", { workspaceRoot: fallbackRoot } as never);
    // codexhost replaces DSH's session store with the Host-recorded working
    // directory of one local Thread; every other Thread resolves to nothing.
    ctx.provide("sessions", {
      get: (id: string) =>
        id === liveId
          ? { header: { cwd: liveRoot } }
          : id === fallbackId
            ? { header: {} }
            : undefined,
    } as never);
    const typert = await ctx.plugin(TypertRegistry);
    const workspaceFiles = await ctx.plugin(WorkspaceFiles, CAPS);

    try {
      expect(ctx.get("agents")).toBeUndefined();
      const lookup = ctx.typert.lookups.get("workspaceFileScope");
      expect(lookup).toMatchObject({
        parameter: "workspaceFileScope",
        wire: "workspaceFileScopeId",
        hostTypeSymbol: "@deepseek-ai/dsh-api-workspace-files#WorkspaceFileScope",
        wireTypeSymbol: "@deepseek-ai/dsh-session/types#SessionId",
      });
      if (lookup === undefined) throw new Error("workspaceFileScope lookup did not register");

      await expect(lookup.resolve(liveId)).resolves.toEqual({
        sessionId: liveId,
        workspaceRoot: liveRoot,
      });
      await expect(lookup.resolve(fallbackId)).resolves.toEqual({
        sessionId: fallbackId,
        workspaceRoot: fallbackRoot,
      });
      await expect(lookup.resolve(missingId)).resolves.toBeUndefined();

      await workspaceFiles.dispose();
      expect(ctx.typert.lookups.get("workspaceFileScope")).toBeUndefined();
    } finally {
      await workspaceFiles.dispose();
      await typert.dispose();
    }
  });
});
