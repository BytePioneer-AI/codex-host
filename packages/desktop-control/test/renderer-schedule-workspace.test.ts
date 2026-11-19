import { describe, expect, it, vi } from "vitest";
import { encodeHarnessPluginRoute, harnessIdSchema } from "@codexhost/shared-contracts";
import {
  createNativeScheduleWorkspaceThread,
  readNativeScheduleWorkspaces,
  isNativeProjectThreadCreator,
  type NativeProjectThreadCreator,
} from "../src/renderer-schedule-workspace.js";
import type { RendererHostRouting } from "../src/renderer-host-routing.js";

const model = encodeHarnessPluginRoute({ harnessId: harnessIdSchema.parse("pi") });
const workspace = { id: "project-a", label: "Project A", cwd: "/workspace" };
const project = (group = {}) => ({
  source: "codex",
  group: {
    projectId: workspace.id,
    label: workspace.label,
    path: workspace.cwd,
    rootPaths: [workspace.cwd],
    projectKind: "local",
    ...group,
  },
});
const result = {
  status: "created",
  conversationId: "new-thread",
  firstTurn: { status: "not-requested" },
};
function fixture() {
  const conversation = {
    cwd: workspace.cwd,
    latestCollaborationMode: { settings: { model } },
    turns: [] as unknown[],
  };
  const manager = {
    getConversation: vi.fn(() => conversation),
    archiveConversation: vi.fn(async () => {}),
  };
  let current: unknown = manager;
  const routing = {
    forHost: () => ({ manager: current, policy: { scopedCreation: true } }),
  } as unknown as RendererHostRouting;
  const scope = { get() {} };
  const registry = { scope, addManager() {}, getForHostId: () => manager };
  const main = {
    querySelectorAll: () => [],
    __reactFiber$fixture: { memoizedState: { memoizedState: registry } },
  };
  const catalog = new Map<string, unknown>([["a", project()]]);
  const row = {
    querySelectorAll: () => [],
    __reactFiber$fixture: { memoizedProps: { projectByKey: catalog } },
  };
  const root = { querySelectorAll: (selector: string) => (selector === "main" ? [main] : [row]) };
  const create = vi.fn<NativeProjectThreadCreator>(async (input) => {
    input.onSettled(result);
    return { kind: "creation", result };
  });
  const controller = new AbortController();
  const start = () =>
    createNativeScheduleWorkspaceThread(
      root,
      routing,
      create,
      { workspace, model, title: "Task" },
      controller.signal,
    );
  return {
    root,
    catalog,
    manager,
    scope,
    create,
    controller,
    start,
    conversation,
    replaceConnection: () => {
      current = {};
    },
  };
}

describe("native workspace task preparation", () => {
  it("uses the native project-aware empty-chat API without task CRUD or changing the Model", async () => {
    const f = fixture();
    const thread = await f.start();
    expect(thread.threadId).toBe("new-thread");
    expect(f.create).toHaveBeenCalledWith({
      scope: f.scope,
      target: { type: "project", projectId: workspace.id, environment: { type: "local" } },
      model,
      title: "Task",
      prompt: "",
      startWithoutFirstTurn: true,
      onSettled: expect.any(Function),
    });
    thread.retain();
    f.controller.abort();
    await Promise.resolve();
    expect(f.manager.archiveConversation).not.toHaveBeenCalled();
  });
  it("archives an unsubmitted empty chat once on cancellation, including a late settlement", async () => {
    const f = fixture();
    const ready = Promise.withResolvers<unknown>();
    f.create.mockImplementation(() => ready.promise);
    const pending = f.start();
    f.controller.abort();
    f.create.mock.calls[0]?.[0].onSettled(result);
    ready.resolve({ kind: "creation", result });
    await expect(pending).rejects.toThrow();
    await Promise.resolve();
    expect(f.manager.archiveConversation).toHaveBeenCalledTimes(1);
    expect(f.manager.archiveConversation).toHaveBeenCalledWith("new-thread", {
      useAppServerPins: false,
      source: "automation_history",
    });
    expect(f.manager.archiveConversation.mock.contexts[0]).toBe(f.manager);
  });
  it("does not archive a chat the user has started using", async () => {
    const f = fixture();
    await f.start();
    f.conversation.turns.push({ id: "user-turn" });
    f.controller.abort();
    await Promise.resolve();
    expect(f.manager.archiveConversation).not.toHaveBeenCalled();
  });
  it("rejects a removed project before calling native creation", async () => {
    const f = fixture();
    f.catalog.clear();
    await expect(f.start()).rejects.toThrow("workspace is no longer available");
    expect(f.create).not.toHaveBeenCalled();
  });
  it("rejects a changed connection, actual cwd or Model instead of linking the wrong chat", async () => {
    for (const change of ["connection", "cwd", "model"] as const) {
      const f = fixture();
      f.create.mockImplementation(async () => {
        if (change === "connection") f.replaceConnection();
        else if (change === "cwd") f.conversation.cwd = "/wrong";
        else f.conversation.latestCollaborationMode.settings.model = "gpt-native";
        return { kind: "creation", result };
      });
      await expect(f.start()).rejects.toThrow();
      f.controller.abort();
    }
  });
  it("does not retry an unknown native outcome and still cleans up a late confirmed chat", async () => {
    const f = fixture();
    f.create.mockResolvedValue({ kind: "creation", result: { status: "outcome-unknown" } });
    await expect(f.start()).rejects.toThrow("not confirmed");
    expect(f.create).toHaveBeenCalledTimes(1);
    f.controller.abort();
    f.create.mock.calls[0]?.[0].onSettled(result);
    await Promise.resolve();
    expect(f.manager.archiveConversation).toHaveBeenCalledTimes(1);
  });
});

describe("native workspace catalog", () => {
  it("includes collapsed local projects, excludes remote/cloud entries and deduplicates IDs", () => {
    const f = fixture();
    f.catalog.set("duplicate", project());
    f.catalog.set("remote", project({ projectId: "remote", projectKind: "remote" }));
    f.catalog.set("cloud", { ...project({ projectId: "cloud" }), source: "chatgpt" });
    expect(readNativeScheduleWorkspaces(f.root)).toEqual([workspace]);
  });
  it("rejects ambiguous paths, relative paths and paths outside the native project roots", () => {
    const f = fixture();
    f.catalog.set("ambiguous", project({ path: "/other", rootPaths: ["/other"] }));
    expect(readNativeScheduleWorkspaces(f.root)).toEqual([]);
    for (const group of [{ path: "relative", rootPaths: ["relative"] }, { path: "/other" }]) {
      f.catalog.clear();
      f.catalog.set("invalid", project(group));
      expect(readNativeScheduleWorkspaces(f.root)).toEqual([]);
    }
  });
  it("preserves Chinese, Windows and UNC paths", () => {
    const f = fixture();
    for (const path of ["/work/项目 A", "C:\\work\\项目", "\\\\server\\share\\project"]) {
      f.catalog.set("a", project({ path, rootPaths: [path] }));
      expect(readNativeScheduleWorkspaces(f.root)[0]?.cwd).toBe(path);
    }
  });
  it("does not discover generic functions as the native project creator", () => {
    expect(isNativeProjectThreadCreator(async () => {})).toBe(false);
    expect(isNativeProjectThreadCreator({ createThread() {} })).toBe(false);
  });
});
