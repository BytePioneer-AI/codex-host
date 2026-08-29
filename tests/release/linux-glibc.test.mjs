import { describe, expect, it } from "vitest";

import {
  LINUX_GLIBC_BASELINE,
  LINUX_NATIVE_EXECUTABLES,
  glibcVersionsFromObjdump,
  verifyLinuxGlibcBaseline,
} from "../../scripts/release/linux-glibc.mjs";

describe("Linux glibc release baseline", () => {
  it("extracts and sorts symbol versions numerically", () => {
    expect(
      glibcVersionsFromObjdump(`
0000 DF *UND* 0000 (GLIBC_2.9) old_symbol
0000 DF *UND* 0000 (GLIBC_2.35) current_symbol
0000 DF *UND* 0000 (GLIBC_2.17) clock_gettime
0000 DF *UND* 0000 (GLIBC_2.35) current_symbol
`),
    ).toEqual(["2.9", "2.17", "2.35"]);
  });

  it("accepts every packaged native executable at the 2.35 baseline", () => {
    expect(
      verifyLinuxGlibcBaseline({
        packageRoot: "/package",
        inspect: () => "0000 DF *UND* 0000 (GLIBC_2.34) pthread_create\n",
      }),
    ).toEqual(LINUX_NATIVE_EXECUTABLES.map((relative) => ({ relative, maximum: "2.34" })));
    expect(LINUX_GLIBC_BASELINE).toBe("2.35");
  });

  it("rejects a native executable that imports a newer glibc symbol", () => {
    expect(() =>
      verifyLinuxGlibcBaseline({
        packageRoot: "/package",
        inspect: (binary) =>
          binary.endsWith("bin/codexhost")
            ? "0000 w DF *UND* 0000 (GLIBC_2.39) pidfd_spawnp\n"
            : "0000 DF *UND* 0000 (GLIBC_2.35) stat\n",
      }),
    ).toThrow("bin/codexhost requires GLIBC_2.39, exceeding the GLIBC_2.35 release baseline");
  });
});
