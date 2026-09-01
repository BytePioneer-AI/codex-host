import type { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  codebuddyProjectSlug,
  codebuddyTranscriptPath,
  parseCodeBuddyTranscript,
  readCodeBuddyTranscript,
  snapshotFromTranscriptTurns,
} from "../src/history.js";

function entry(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

const TRANSCRIPT = [
  entry({
    id: "u-1",
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "list the files" }],
  }),
  entry({ id: "r-1", type: "reasoning", content: [{ type: "text", text: "thinking" }] }),
  entry({
    type: "function_call",
    callId: "call-1",
    name: "Bash",
    arguments: JSON.stringify({ command: "ls -la" }),
  }),
  entry({
    type: "function_call_result",
    callId: "call-1",
    status: "success",
    output: [{ type: "text", text: "a.txt\nb.txt" }],
  }),
  entry({
    type: "function_call",
    callId: "call-2",
    name: "read_file",
    arguments: JSON.stringify({ path: "a.txt" }),
  }),
  entry({
    type: "function_call_result",
    callId: "call-2",
    status: "failed",
    output: [{ type: "text", text: "boom" }],
  }),
  entry({
    id: "u-2",
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "thanks" }],
  }),
].join("\n");

describe("parseCodeBuddyTranscript", () => {
  it("groups entries into turns keyed by user message ids", () => {
    const turns = parseCodeBuddyTranscript(TRANSCRIPT);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.nativeTurnKey).toBe("u-1");
    expect(turns[0]?.input).toEqual([{ type: "text", text: "list the files" }]);
    expect(turns[1]?.nativeTurnKey).toBe("u-2");
  });

  it("projects shell tools as commandExecution and others as toolExecution", () => {
    const items = parseCodeBuddyTranscript(TRANSCRIPT)[0]?.items ?? [];
    expect(items[0]).toMatchObject({
      item: { type: "reasoning", text: "thinking" },
      outcome: { status: "succeeded" },
    });
    expect(items[1]).toMatchObject({
      item: { type: "commandExecution", command: "ls -la", output: "a.txt\nb.txt" },
    });
    expect(items[2]).toMatchObject({
      item: { type: "toolExecution", toolName: "read_file", arguments: { path: "a.txt" } },
      outcome: { status: "failed" },
    });
  });

  it("ignores malformed lines and entries before the first user message", () => {
    const turns = parseCodeBuddyTranscript(
      [
        "{broken",
        entry({ type: "reasoning", content: [{ type: "text", text: "orphan" }] }),
        "",
      ].join("\n"),
    );
    expect(turns).toEqual([]);
  });

  it("falls back to synthetic turn keys when the user message has no id", () => {
    const turns = parseCodeBuddyTranscript(
      entry({ type: "message", role: "user", content: [{ type: "text", text: "hi" }] }),
    );
    expect(turns[0]?.nativeTurnKey).toBe("codebuddy-turn-1");
  });
});

describe("snapshotFromTranscriptTurns", () => {
  it("attaches stable Native Turn Refs to every turn", () => {
    const turns = parseCodeBuddyTranscript(TRANSCRIPT);
    const snapshot = snapshotFromTranscriptTurns(turns, {
      harnessId: "codebuddy",
      nativeSessionId: "s-1",
    } as Parameters<typeof snapshotFromTranscriptTurns>[1]);
    expect(snapshot.turns[0]?.nativeTurnRef).toEqual({
      harnessId: "codebuddy",
      nativeSessionId: "s-1",
      nativeTurnKey: "u-1",
      formatVersion: 1,
    });
  });
});

describe("codebuddyProjectSlug", () => {
  it("strips leading separators and replaces path separators", () => {
    expect(codebuddyProjectSlug("/Users/demo/WorkBuddy")).toBe("Users-demo-WorkBuddy");
    expect(codebuddyProjectSlug("C:\\repo\\app")).toBe("C--repo-app");
  });
});

describe("codebuddyTranscriptPath", () => {
  it("resolves ~/.codebuddy/projects/<slug>/<session>.jsonl", () => {
    expect(codebuddyTranscriptPath("/home/demo", "/work/app", "s-1")).toBe(
      "/home/demo/.codebuddy/projects/work-app/s-1.jsonl",
    );
  });
});

describe("readCodeBuddyTranscript", () => {
  it("reads the primary path first", () => {
    const content = readCodeBuddyTranscript("/work/app", "s-1", {
      homeDirectory: "/home/demo",
      readFile: ((path: string) => {
        expect(path).toBe("/home/demo/.codebuddy/projects/work-app/s-1.jsonl");
        return "primary";
      }) as typeof readFileSync,
      readDirectory: (() => {
        throw new Error("should not scan");
      }) as unknown as typeof readdirSync,
    });
    expect(content).toBe("primary");
  });

  it("scans project slugs as a fallback when the primary path is missing", () => {
    const content = readCodeBuddyTranscript("/work/app", "s-1", {
      homeDirectory: "/home/demo",
      readFile: ((path: string) => {
        if (path === "/home/demo/.codebuddy/projects/work-app/s-1.jsonl") {
          throw new Error("ENOENT");
        }
        if (path === "/home/demo/.codebuddy/projects/private-tmp-work-app/s-1.jsonl") {
          return "fallback";
        }
        throw new Error("ENOENT");
      }) as typeof readFileSync,
      readDirectory: (() => [
        "work-app",
        "private-tmp-work-app",
      ]) as unknown as unknown as typeof readdirSync,
    });
    expect(content).toBe("fallback");
  });

  it("returns null when nothing can be read", () => {
    const content = readCodeBuddyTranscript("/work/app", "s-1", {
      homeDirectory: "/home/demo",
      readFile: (() => {
        throw new Error("ENOENT");
      }) as typeof readFileSync,
      readDirectory: (() => {
        throw new Error("ENOENT");
      }) as unknown as typeof readdirSync,
    });
    expect(content).toBeNull();
  });
});
