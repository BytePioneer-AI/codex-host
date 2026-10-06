import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MOBILE_CODEX_PATHS,
  supportsMobileCodex,
  packageMobileCodex,
} from "../../scripts/release/mobile-codex.mjs";
import { expectedPayloadPaths } from "../../scripts/release/prepare-payload.mjs";
import { expectedNpmPackagePaths } from "../../scripts/release/prepare-npm.mjs";
import { releaseTarget } from "../../scripts/release/targets.mjs";
import { sha256File } from "../../scripts/release/node-runtime.mjs";

afterEach(() => vi.unstubAllEnvs());
describe("mobile Codex distribution", () => {
  it("requires an explicit packaging opt-in", () => {
    const target = releaseTarget("macos-arm64");
    expect(packageMobileCodex(target, {})).toBe(false);
    expect(packageMobileCodex(target, { CODEXHOST_BUILD_MOBILE_CODEX: "1" })).toBe(true);
    expect(
      packageMobileCodex(releaseTarget("linux-arm64"), { CODEXHOST_BUILD_MOBILE_CODEX: "1" }),
    ).toBe(false);
  });
  it("ships binary, license, source provenance and patch in both supported formats", () => {
    vi.stubEnv("CODEXHOST_BUILD_MOBILE_CODEX", "1");
    const target = releaseTarget("macos-arm64");
    for (const entry of MOBILE_CODEX_PATHS) {
      expect(expectedPayloadPaths(target)).toContain(entry);
      expect(expectedNpmPackagePaths(target)).toContain(entry);
    }
    expect(supportsMobileCodex(releaseTarget("macos-x64"))).toBe(false);
    expect(expectedPayloadPaths(releaseTarget("windows-x64"))).not.toContain(MOBILE_CODEX_PATHS[0]);
  });
  it("pins the exact patch alongside the upstream source", async () => {
    const root = path.resolve("tools/mobile-remote/patches");
    const source = JSON.parse(await readFile(path.join(root, "source.json"), "utf8"));
    expect(await sha256File(path.join(root, "codex-0.160.0-remote-host.patch"))).toBe(
      source.patchSha256,
    );
    expect(source.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(source.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
