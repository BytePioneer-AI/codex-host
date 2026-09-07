import type { SessionSummary } from "@deepseek-ai/dsh-host-apiproxy/api";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { describe, expect, it } from "vitest";

import { parseLegacySessionCandidates } from "../../src/legacy/session-list.js";

function item(overrides: Record<string, unknown> = {}): SessionSummary {
  return {
    sessionId: "session-1" as SessionId,
    updatedAt: 10,
    running: false,
    blank: false,
    cwd: "/workspace",
    ...overrides,
  } as SessionSummary;
}

describe("parseLegacySessionCandidates", () => {
  it("keeps resumable Legacy Sessions and reads the title projection", () => {
    expect(
      parseLegacySessionCandidates([
        item({
          projections: { asOfSeq: 5, values: { title: "Project session" } },
        }),
      ]),
    ).toEqual([
      {
        nativeSessionId: "session-1",
        title: "Project session",
        updatedAt: 10,
        cwd: "/workspace",
        running: false,
      },
    ]);
  });

  it("skips subagent, blank, relative, and malformed Sessions", () => {
    expect(
      parseLegacySessionCandidates([
        item({ sessionId: "sub", origin: "subagent" }),
        item({ sessionId: "blank", blank: true }),
        item({ sessionId: "relative", cwd: "relative/project" }),
        item({ sessionId: "missing-cwd", cwd: undefined }),
        item({ sessionId: "", cwd: "/workspace" }),
      ]),
    ).toEqual([]);
  });

  it("preserves the native running state and null title", () => {
    expect(
      parseLegacySessionCandidates([
        item({
          sessionId: "running-session",
          running: true,
          projections: { asOfSeq: 0, values: {} },
        }),
      ]),
    ).toEqual([
      {
        nativeSessionId: "running-session",
        title: null,
        updatedAt: 10,
        cwd: "/workspace",
        running: true,
      },
    ]);
  });
});
