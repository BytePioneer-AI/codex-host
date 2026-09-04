import { describe, expect, it } from "vitest";

import {
  DEEPSEEK_MODERN_SESSION_CWD_MAX_LENGTH,
  DEEPSEEK_MODERN_SESSION_ID_MAX_LENGTH,
  DEEPSEEK_MODERN_SESSION_LIST_MAX_LENGTH,
  DEEPSEEK_MODERN_SESSION_TITLE_MAX_LENGTH,
  DEEPSEEK_MODERN_SESSION_UPDATED_AT_MAX,
  deepSeekModernSessionCandidateSchema,
  deepSeekModernSessionImportParamsSchema,
  deepSeekModernSessionImportResultSchema,
  deepSeekModernSessionListParamsSchema,
  deepSeekModernSessionListResultSchema,
} from "@codexhost/shared-contracts";

const candidate = {
  nativeSessionId: "session-1",
  title: "Imported session",
  updatedAt: 1_777_777_777_777,
  cwd: "C:\\work\\project",
  running: false,
};

describe("DeepSeek Modern Session import contracts", () => {
  it("accepts only the fixed browser-safe request and result shapes", () => {
    expect(deepSeekModernSessionListParamsSchema.parse({})).toEqual({});
    expect(deepSeekModernSessionListResultSchema.parse({ candidates: [candidate] })).toEqual({
      candidates: [candidate],
    });
    expect(deepSeekModernSessionImportParamsSchema.parse({ nativeSessionId: "session-1" })).toEqual(
      { nativeSessionId: "session-1" },
    );
    expect(deepSeekModernSessionImportResultSchema.parse({ threadId: "thread-1" })).toEqual({
      threadId: "thread-1",
    });
  });

  it("rejects undeclared Native metadata, wire payloads, and credentials", () => {
    for (const [schema, value] of [
      [deepSeekModernSessionListParamsSchema, { cursor: "native-cursor" }],
      [deepSeekModernSessionListResultSchema, { items: [candidate] }],
      [deepSeekModernSessionCandidateSchema, { ...candidate, transcript: [] }],
      [deepSeekModernSessionCandidateSchema, { ...candidate, token: "secret" }],
      [deepSeekModernSessionImportParamsSchema, candidate],
      [
        deepSeekModernSessionImportResultSchema,
        { threadId: "thread-1", nativeSessionId: "secret" },
      ],
    ] as const) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });

  it("enforces finite candidate and field bounds", () => {
    for (const invalid of [
      { ...candidate, nativeSessionId: " " },
      { ...candidate, nativeSessionId: "session\0secret" },
      { ...candidate, nativeSessionId: "s".repeat(DEEPSEEK_MODERN_SESSION_ID_MAX_LENGTH + 1) },
      { ...candidate, title: " " },
      { ...candidate, title: "t".repeat(DEEPSEEK_MODERN_SESSION_TITLE_MAX_LENGTH + 1) },
      { ...candidate, cwd: " " },
      { ...candidate, cwd: "C:\\work\0secret" },
      { ...candidate, cwd: "c".repeat(DEEPSEEK_MODERN_SESSION_CWD_MAX_LENGTH + 1) },
      { ...candidate, updatedAt: -1 },
      { ...candidate, updatedAt: 1.5 },
      { ...candidate, updatedAt: DEEPSEEK_MODERN_SESSION_UPDATED_AT_MAX + 1 },
    ]) {
      expect(deepSeekModernSessionCandidateSchema.safeParse(invalid).success).toBe(false);
    }

    expect(
      deepSeekModernSessionListResultSchema.safeParse({
        candidates: Array.from(
          { length: DEEPSEEK_MODERN_SESSION_LIST_MAX_LENGTH + 1 },
          (_, index) => ({ ...candidate, nativeSessionId: `session-${index}` }),
        ),
      }).success,
    ).toBe(false);
    expect(deepSeekModernSessionCandidateSchema.parse({ ...candidate, title: null })).toMatchObject(
      {
        title: null,
      },
    );
  });

  it("accepts no display metadata from an import caller", () => {
    for (const key of [
      "cwd",
      "title",
      "updatedAt",
      "running",
      "model",
      "thinking",
      "permission",
      "preview",
    ]) {
      expect(
        deepSeekModernSessionImportParamsSchema.safeParse({
          nativeSessionId: "session-1",
          [key]: "untrusted",
        }).success,
      ).toBe(false);
    }
    expect(
      deepSeekModernSessionImportParamsSchema.safeParse({ nativeSessionId: " " }).success,
    ).toBe(false);
    expect(deepSeekModernSessionImportResultSchema.safeParse({ threadId: " " }).success).toBe(
      false,
    );
  });
});
