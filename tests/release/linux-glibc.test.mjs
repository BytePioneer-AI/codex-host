import { describe, expect, it } from "vitest";

import {
  LINUX_GLIBC_BASELINE,
  LINUX_GLIBC_BASELINE_IMAGE,
  LINUX_NATIVE_EXECUTABLES,
  glibcVersionsFromObjdump,
  linuxGlibcCargoArguments,
  stripLinuxDebugInfo,
  verifyLinuxGlibcBaseline,
  verifyLinuxGlibcLoad,
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

  it("accepts every packaged native executable at the 2.28 baseline", () => {
    expect(
      verifyLinuxGlibcBaseline({
        packageRoot: "/package",
        inspect: () => "0000 w DF *UND* 0000 (GLIBC_2.28) statx\n",
      }),
    ).toEqual(LINUX_NATIVE_EXECUTABLES.map((relative) => ({ relative, maximum: "2.28" })));
    expect(LINUX_GLIBC_BASELINE).toBe("2.28");
  });

  it("rejects a native executable that imports a newer glibc symbol", () => {
    let inspection = 0;
    expect(() =>
      verifyLinuxGlibcBaseline({
        packageRoot: "/package",
        inspect: () =>
          inspection++ === 0
            ? "0000 DF *UND* 0000 (GLIBC_2.34) __libc_start_main\n"
            : "0000 DF *UND* 0000 (GLIBC_2.28) statx\n",
      }),
    ).toThrow("bin/codexhost requires GLIBC_2.34, exceeding the GLIBC_2.28 release baseline");
  });

  it("links through cargo-zigbuild at the baseline without a full strip", () => {
    expect(linuxGlibcCargoArguments("aarch64-unknown-linux-gnu")).toEqual([
      "zigbuild",
      "--config",
      'profile.release.strip="none"',
      "--target",
      "aarch64-unknown-linux-gnu.2.28",
    ]);
  });

  it("strips only debug information from every packaged native executable", () => {
    const stripped = [];
    stripLinuxDebugInfo({ packageRoot: "/package", strip: (binary) => stripped.push(binary) });
    expect(stripped).toEqual([
      "/package/bin/codexhost",
      "/package/libexec/codexhost-shim",
      "/package/libexec/codexhost-updater",
    ]);
  });

  it("resolves every packaged native executable with the baseline image loader", () => {
    const traced = [];
    verifyLinuxGlibcLoad({
      packageRoot: "/package",
      trace: (binaries) => {
        traced.push(...binaries);
        return "/package/bin/codexhost:\n\tlibc.so.6 => /lib64/libc.so.6 (0x00007f0000000000)\n";
      },
    });
    expect(traced).toEqual(LINUX_NATIVE_EXECUTABLES.map((relative) => `/package/${relative}`));
    expect(LINUX_GLIBC_BASELINE_IMAGE).toMatch(/^almalinux:8@sha256:[a-f0-9]{64}$/u);
  });

  it("rejects an executable whose glibc version or library is missing on the baseline image", () => {
    expect(() =>
      verifyLinuxGlibcLoad({
        packageRoot: "/package",
        trace: () =>
          [
            "/package/libexec/codexhost-shim:",
            "/package/libexec/codexhost-shim: /lib64/libc.so.6: version `GLIBC_2.34' not found (required by /package/libexec/codexhost-shim)",
            "\tlibc.so.6 => /lib64/libc.so.6 (0x00007f0000000000)",
            "\tlibgcc_s.so.1 => not found",
          ].join("\n"),
      }),
    ).toThrow(
      /GLIBC_2\.34' not found \(required by \/package\/libexec\/codexhost-shim\)\nlibgcc_s\.so\.1 => not found$/u,
    );
  });
});
