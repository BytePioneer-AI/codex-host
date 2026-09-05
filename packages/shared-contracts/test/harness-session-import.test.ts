import { describe, expect, it } from "vitest";
import {
  HARNESS_SESSION_IMPORT_CWD_MAX_LENGTH,
  HARNESS_SESSION_IMPORT_ID_MAX_LENGTH,
  HARNESS_SESSION_IMPORT_TITLE_MAX_LENGTH,
  HARNESS_SESSION_IMPORT_UPDATED_AT_MAX,
  harnessSessionImportCandidateSchema,
  harnessSessionImportSourcesParamsSchema,
  harnessSessionImportSourcesResultSchema,
  harnessSessionListParamsSchema,
  harnessSessionListResultSchema,
  harnessSessionImportParamsSchema,
  harnessSessionImportResultSchema,
} from "@codexhost/shared-contracts";

const candidate = {
  nativeSessionId: "pi-native",
  title: null,
  cwd: "/project",
  updatedAt: 1,
  running: null,
};

describe("Generic Harness Session import contracts", () => {
  it("bounds individual pages and search inputs without limiting the total candidate count", () => {
    expect(
      harnessSessionListParamsSchema.parse({
        harnessId: "pi",
        query: " needle ",
        offset: 100,
        limit: 50,
      }),
    ).toEqual({ harnessId: "pi", query: "needle", offset: 100, limit: 50 });
    expect(
      harnessSessionListResultSchema.parse({ candidates: [candidate], total: 1_000_000 }),
    ).toEqual({ candidates: [candidate], total: 1_000_000 });
    for (const extra of [
      { offset: -1 },
      { offset: 0.5 },
      { offset: Infinity },
      { limit: 0 },
      { limit: 1_001 },
      { query: "a\0b" },
      { query: "a".repeat(4097) },
    ]) {
      expect(harnessSessionListParamsSchema.safeParse({ harnessId: "pi", ...extra }).success).toBe(
        false,
      );
    }
    expect(harnessSessionListResultSchema.safeParse({ candidates: [candidate] }).success).toBe(
      false,
    );
  });

  it("accepts only bounded browser-safe Native Session metadata", () => {
    const metadata = {
      nativeSessionId: "native-session",
      title: "Existing session",
      updatedAt: 1_777_777_777_777,
      cwd: "C:\\work\\project",
      running: false,
    };
    expect(harnessSessionImportCandidateSchema.parse(metadata)).toEqual(metadata);
    for (const invalid of [
      { ...metadata, nativeSessionId: " " },
      { ...metadata, nativeSessionId: "s".repeat(HARNESS_SESSION_IMPORT_ID_MAX_LENGTH + 1) },
      { ...metadata, title: "t".repeat(HARNESS_SESSION_IMPORT_TITLE_MAX_LENGTH + 1) },
      { ...metadata, cwd: "c".repeat(HARNESS_SESSION_IMPORT_CWD_MAX_LENGTH + 1) },
      { ...metadata, updatedAt: HARNESS_SESSION_IMPORT_UPDATED_AT_MAX + 1 },
      { ...metadata, transcript: [] },
    ])
      expect(harnessSessionImportCandidateSchema.safeParse(invalid).success).toBe(false);
  });

  it("supports unknown activity without inferring idle and uses explicit Harness-scoped requests", () => {
    expect(harnessSessionImportCandidateSchema.parse(candidate).running).toBeNull();
    expect(harnessSessionImportSourcesParamsSchema.parse({})).toEqual({});
    expect(
      harnessSessionImportSourcesResultSchema.parse({
        harnesses: [{ harnessId: "pi", name: "Pi" }],
      }),
    ).toEqual({ harnesses: [{ harnessId: "pi", name: "Pi" }] });
    expect(harnessSessionListParamsSchema.parse({ harnessId: "pi" })).toEqual({ harnessId: "pi" });
    expect(
      harnessSessionImportParamsSchema.parse({ harnessId: "pi", nativeSessionId: "pi-native" }),
    ).toEqual({ harnessId: "pi", nativeSessionId: "pi-native" });
    expect(harnessSessionImportResultSchema.parse({ threadId: "thread" })).toEqual({
      threadId: "thread",
    });
  });

  it("keeps native references, arbitrary actions and untrusted metadata out of the browser contract", () => {
    for (const field of ["locator", "nativeRef", "transcript", "token", "sessionFile"]) {
      expect(
        harnessSessionImportCandidateSchema.safeParse({ ...candidate, [field]: "secret" }).success,
      ).toBe(false);
    }
    for (const field of ["cwd", "locator", "title", "running", "environment", "command"]) {
      expect(
        harnessSessionImportParamsSchema.safeParse({
          harnessId: "pi",
          nativeSessionId: "pi-native",
          [field]: "untrusted",
        }).success,
      ).toBe(false);
    }
    for (const params of [{}, { harnessId: "../pi" }, { harnessId: "pi", cwd: "/project" }]) {
      expect(harnessSessionListParamsSchema.safeParse(params).success).toBe(false);
    }
    expect(harnessSessionImportSourcesParamsSchema.safeParse({ hostId: "remote" }).success).toBe(
      false,
    );
    expect(
      harnessSessionImportResultSchema.safeParse({ threadId: "thread", nativeRef: {} }).success,
    ).toBe(false);
  });
});
