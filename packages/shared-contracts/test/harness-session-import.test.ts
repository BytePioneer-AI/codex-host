import { describe, expect, it } from "vitest";

import {
  HARNESS_SESSION_IMPORT_CWD_MAX_LENGTH,
  HARNESS_SESSION_IMPORT_ID_MAX_LENGTH,
  HARNESS_SESSION_IMPORT_TITLE_MAX_LENGTH,
  HARNESS_SESSION_IMPORT_UPDATED_AT_MAX,
  harnessSessionImportCandidateSchema,
} from "@codexhost/shared-contracts";

const candidate = {
  nativeSessionId: "native-session",
  title: "Existing session",
  updatedAt: 1_777_777_777_777,
  cwd: "C:\\work\\project",
  running: false,
};

describe("Harness Session import candidate contract", () => {
  it("accepts only bounded browser-safe Native Session metadata", () => {
    expect(harnessSessionImportCandidateSchema.parse(candidate)).toEqual(candidate);
    for (const invalid of [
      { ...candidate, nativeSessionId: " " },
      { ...candidate, nativeSessionId: "s".repeat(HARNESS_SESSION_IMPORT_ID_MAX_LENGTH + 1) },
      { ...candidate, title: "t".repeat(HARNESS_SESSION_IMPORT_TITLE_MAX_LENGTH + 1) },
      { ...candidate, cwd: "c".repeat(HARNESS_SESSION_IMPORT_CWD_MAX_LENGTH + 1) },
      { ...candidate, updatedAt: HARNESS_SESSION_IMPORT_UPDATED_AT_MAX + 1 },
      { ...candidate, transcript: [] },
    ]) {
      expect(harnessSessionImportCandidateSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
