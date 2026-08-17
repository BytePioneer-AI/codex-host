import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { locateGrokNativeSession } from "../src/acp-transport.js";
import {
  GROK_SESSION_FORK_METHOD,
  buildGrokForkParams,
  isGrokMethodNotFound,
  parseGrokForkResponse,
} from "../src/grok-fork.js";

describe("Grok Fork ACP envelope", () => {
  it("uses the underscore-prefixed wire method and camelCase params", () => {
    expect(GROK_SESSION_FORK_METHOD).toBe("_x.ai/session/fork");
    expect(
      buildGrokForkParams({
        sourceSessionId: "parent",
        sourceCwd: "/src",
        newCwd: "/src",
        targetPromptIndex: 0,
        sessionKind: "fork",
      }),
    ).toEqual({
      sourceSessionId: "parent",
      sourceCwd: "/src",
      newCwd: "/src",
      targetPromptIndex: 0,
      sessionKind: "fork",
    });
  });

  it("omits optional fields and still sends targetPromptIndex 0", () => {
    expect(
      buildGrokForkParams({
        sourceSessionId: "parent",
        sourceCwd: "/src",
        newCwd: "/dst",
        targetPromptIndex: 0,
      }),
    ).toEqual({
      sourceSessionId: "parent",
      sourceCwd: "/src",
      newCwd: "/dst",
      targetPromptIndex: 0,
    });
  });

  it("parses a top-level response and a result-wrapped response", () => {
    expect(
      parseGrokForkResponse({
        newSessionId: "child",
        parentSessionId: "parent",
        chatMessagesCopied: 2,
      }),
    ).toMatchObject({ newSessionId: "child", parentSessionId: "parent" });
    expect(parseGrokForkResponse({ result: { newSessionId: "child" } })).toEqual({
      newSessionId: "child",
    });
  });

  it("rejects a missing Session identity, an error payload, and Method Not Found", () => {
    expect(parseGrokForkResponse({})).toBeNull();
    expect(parseGrokForkResponse({ result: {} })).toBeNull();
    expect(parseGrokForkResponse({ newSessionId: "child", error: "nope" })).toBeNull();
    expect(isGrokMethodNotFound({ code: -32601, message: "Method not found" })).toBe(true);
    expect(isGrokMethodNotFound(new Error("Grok ACP Method Not Found: _x.ai/session/fork"))).toBe(
      true,
    );
    expect(isGrokMethodNotFound(new Error("native timeout"))).toBe(false);
  });

  it("includes Worktree fields only when they are set", () => {
    expect(
      buildGrokForkParams({
        sourceSessionId: "parent",
        sourceCwd: "/src",
        newCwd: "/worktree",
        targetPromptIndex: 1,
        sessionKind: "worktree",
        sourceWorkspaceDir: "/src",
      }),
    ).toEqual({
      sourceSessionId: "parent",
      sourceCwd: "/src",
      newCwd: "/worktree",
      targetPromptIndex: 1,
      sessionKind: "worktree",
      sourceWorkspaceDir: "/src",
    });
  });

  it("locates a Native Session cwd and original workspace from summary.json", async () => {
    const grokHome = await mkdtemp(path.join(os.tmpdir(), "codexhost-grok-locate-"));
    const sessionId = "01a0locate-0000-7000-8000-000000000001";
    const cwd = "/source/project";
    await mkdir(path.join(grokHome, "sessions", encodeURIComponent(cwd), sessionId), {
      recursive: true,
    });
    await writeFile(
      path.join(grokHome, "sessions", encodeURIComponent(cwd), sessionId, "summary.json"),
      JSON.stringify({
        info: { id: sessionId, cwd },
        source_workspace_dir: "/original/workspace",
      }),
    );
    await writeFile(path.join(grokHome, "sessions", "session_search.sqlite"), "not-a-directory");
    await expect(
      locateGrokNativeSession({ environment: { GROK_HOME: grokHome } }, sessionId),
    ).resolves.toEqual({
      cwd: path.resolve(cwd),
      sourceWorkspaceDir: path.resolve("/original/workspace"),
    });
  });
});
