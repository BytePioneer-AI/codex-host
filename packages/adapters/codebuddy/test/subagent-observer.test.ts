import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeSessionRefSchema } from "@codexhost/shared-contracts";
import { CodeBuddyChildObserver } from "../src/subagent-history.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cb-observer-"));
  roots.push(root);
  const cwd = path.join(root, "work"),
    other = path.join(root, "other"),
    config = path.join(root, "config"),
    project = path.join(config, "projects", "fixture"),
    children = path.join(project, "parent", "subagents");
  await Promise.all([fs.mkdir(cwd), fs.mkdir(other), fs.mkdir(children, { recursive: true })]);
  const parent = nativeSessionRefSchema.parse({
    harnessId: "codebuddy",
    nativeSessionId: "parent",
    formatVersion: 1,
  });
  const parentFile = path.join(project, "parent.jsonl"),
    childFile = path.join(children, "agent-child.jsonl"),
    parentRow = {
      id: "parent-user",
      type: "message",
      role: "user",
      content: "delegate",
      cwd,
      sessionId: "parent",
    },
    childRow = {
      id: "child-user",
      type: "message",
      role: "user",
      content: "read files",
      cwd,
      sessionId: "native-child",
      providerData: { conversationRequestId: "request-1" },
    };
  await fs.writeFile(parentFile, JSON.stringify(parentRow));
  await fs.writeFile(childFile, JSON.stringify(childRow));
  return {
    cwd,
    other,
    children,
    parent,
    parentFile,
    parentRow,
    childFile,
    childRow,
    environment: { CODEBUDDY_CONFIG_DIR: config },
  };
}

describe("CodeBuddy child observer cache", () => {
  it("avoids full reads on an unchanged poll and invalidates on append and replacement", async () => {
    const value = await fixture();
    const observer = new CodeBuddyChildObserver(value.parent, value.cwd, value.environment);
    try {
      expect(await observer.locate("request-1")).toBe("agent-child");
      await observer.read("agent-child", "running");
      const warmReads = vi.mocked(fs.readFile).mock.calls.length;
      expect(warmReads).toBe(2);

      expect(await observer.locate("request-1")).toBe("agent-child");
      await observer.read("agent-child", "running");
      expect(vi.mocked(fs.readFile)).toHaveBeenCalledTimes(warmReads);

      await fs.appendFile(
        value.parentFile,
        `\n${JSON.stringify({ ...value.parentRow, id: "parent-assistant", role: "assistant" })}`,
      );
      await observer.read("agent-child", "running");
      expect(vi.mocked(fs.readFile)).toHaveBeenCalledTimes(warmReads + 1);

      const parentReplacement = `${value.parentFile}.replacement`;
      await fs.writeFile(
        parentReplacement,
        JSON.stringify({ ...value.parentRow, id: "parent-new" }),
      );
      await fs.rename(parentReplacement, value.parentFile);
      await observer.read("agent-child", "running");
      expect(vi.mocked(fs.readFile)).toHaveBeenCalledTimes(warmReads + 2);

      await fs.appendFile(
        value.childFile,
        `\n${JSON.stringify({ ...value.childRow, id: "assistant", parentId: "child-user", role: "assistant" })}`,
      );
      await observer.read("agent-child", "running");
      expect(vi.mocked(fs.readFile)).toHaveBeenCalledTimes(warmReads + 3);

      const replacement = `${value.childFile}.replacement`;
      await fs.writeFile(replacement, JSON.stringify({ ...value.childRow, id: "replacement" }));
      await fs.rename(replacement, value.childFile);
      await observer.read("agent-child", "running");
      expect(vi.mocked(fs.readFile)).toHaveBeenCalledTimes(warmReads + 4);
    } finally {
      observer.close();
    }
  });

  it("does not cache child bytes under a version observed after a same-size replacement", async () => {
    const value = await fixture();
    const observer = new CodeBuddyChildObserver(value.parent, value.cwd, value.environment);
    const readFile = vi.mocked(fs.readFile),
      original = readFile.getMockImplementation();
    if (!original) throw new Error("Missing readFile implementation");
    let mutated = false;
    readFile.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (!mutated && path.basename(String(args[0])) === "agent-child.jsonl") {
        mutated = true;
        const replacement = `${value.childFile}.during-read`;
        await fs.writeFile(
          replacement,
          JSON.stringify({ ...value.childRow, content: "after data" }),
        );
        await fs.rename(replacement, value.childFile);
      }
      return result;
    });
    try {
      expect((await observer.read("agent-child", "running")).turns[0]?.input[0]?.text).toBe(
        "read files",
      );
      expect(mutated).toBe(true);
      expect(JSON.parse(String(await original(value.childFile, "utf8"))).content).toBe(
        "after data",
      );
      expect((await observer.read("agent-child", "running")).turns[0]?.input[0]?.text).toBe(
        "after data",
      );
    } finally {
      readFile.mockImplementation(original);
      observer.close();
    }
  });

  it("does not cache parent bytes under a version observed after a same-size replacement", async () => {
    const value = await fixture();
    const observer = new CodeBuddyChildObserver(value.parent, value.cwd, value.environment);
    const readFile = vi.mocked(fs.readFile),
      original = readFile.getMockImplementation();
    if (!original) throw new Error("Missing readFile implementation");
    let mutated = false;
    readFile.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (!mutated && String(args[0]) === value.parentFile) {
        mutated = true;
        const replacement = `${value.parentFile}.during-read`;
        await fs.writeFile(
          replacement,
          JSON.stringify({ ...value.parentRow, sessionId: "otherx" }),
        );
        await fs.rename(replacement, value.parentFile);
      }
      return result;
    });
    try {
      await observer.read("agent-child", "running");
      await expect(observer.read("agent-child", "running")).rejects.toThrow(
        "different Session identity",
      );
    } finally {
      readFile.mockImplementation(original);
      observer.close();
    }
  });

  it("rechecks existing children for ambiguous correlation after warming a request", async () => {
    const value = await fixture();
    const otherFile = path.join(value.children, "agent-other.jsonl"),
      otherRow = {
        ...value.childRow,
        id: "other-user",
        sessionId: "other-native-child",
        providerData: { conversationRequestId: "request-2" },
      };
    await fs.writeFile(otherFile, JSON.stringify(otherRow));
    const observer = new CodeBuddyChildObserver(value.parent, value.cwd, value.environment);
    try {
      expect(await observer.locate("request-1")).toBe("agent-child");
      await fs.writeFile(
        otherFile,
        JSON.stringify({
          ...otherRow,
          providerData: { conversationRequestId: "request-1" },
        }),
      );
      await expect(observer.locate("request-1")).rejects.toThrow(
        "Ambiguous native Subagent correlation",
      );
    } finally {
      observer.close();
    }
  });

  it("revalidates cached children after mixed identity, cwd, and path redirection changes", async () => {
    const value = await fixture();
    const observer = new CodeBuddyChildObserver(value.parent, value.cwd, value.environment);
    try {
      expect(await observer.locate("request-1")).toBe("agent-child");
      await observer.read("agent-child", "running");

      await fs.writeFile(
        value.parentFile,
        JSON.stringify({ ...value.parentRow, sessionId: "other" }),
      );
      await expect(observer.read("agent-child", "running")).rejects.toThrow(
        "different Session identity",
      );
      await fs.writeFile(value.parentFile, JSON.stringify(value.parentRow));
      await observer.read("agent-child", "running");

      await fs.writeFile(
        value.childFile,
        [value.childRow, { ...value.childRow, id: "mixed", sessionId: "other-child" }]
          .map((row) => JSON.stringify(row))
          .join("\n"),
      );
      await expect(observer.read("agent-child", "running")).rejects.toThrow(
        "identity is missing or mixed",
      );

      await fs.writeFile(value.childFile, JSON.stringify({ ...value.childRow, cwd: value.other }));
      await expect(observer.read("agent-child", "running")).rejects.toThrow("workspace differs");

      await fs.writeFile(value.childFile, JSON.stringify(value.childRow));
      await observer.read("agent-child", "running");
      const outside = path.join(value.other, "agent-child.jsonl");
      await fs.writeFile(outside, JSON.stringify(value.childRow));
      await fs.rm(value.childFile);
      await fs.symlink(outside, value.childFile);
      await expect(observer.read("agent-child", "running")).rejects.toThrow(
        "Redirected Subagent transcript",
      );

      await fs.rm(value.children, { recursive: true });
      await fs.symlink(
        value.other,
        value.children,
        process.platform === "win32" ? "junction" : "dir",
      );
      await expect(observer.read("agent-child", "running")).rejects.toThrow(
        "Redirected CodeBuddy Subagent directory",
      );
    } finally {
      observer.close();
    }
  });

  it("invalidates truncated files and enforces the size limit before reading", async () => {
    const value = await fixture();
    const observer = new CodeBuddyChildObserver(value.parent, value.cwd, value.environment);
    try {
      await observer.read("agent-child", "running");
      const warmReads = vi.mocked(fs.readFile).mock.calls.length;
      await fs.truncate(value.childFile, 0);
      await expect(observer.read("agent-child", "running")).rejects.toThrow(
        "identity is missing or mixed",
      );
      expect(vi.mocked(fs.readFile).mock.calls.length).toBeGreaterThan(warmReads);

      await fs.truncate(value.childFile, 8_000_001);
      const beforeLimit = vi.mocked(fs.readFile).mock.calls.length;
      await expect(observer.read("agent-child", "running")).rejects.toThrow("exceeds 8 MB");
      expect(vi.mocked(fs.readFile)).toHaveBeenCalledTimes(beforeLimit);
    } finally {
      observer.close();
    }
  });
});
