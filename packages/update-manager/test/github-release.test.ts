import { describe, expect, it, vi } from "vitest";

import {
  CODEXHOST_LATEST_RELEASE_URL,
  compareSemanticVersions,
  expectedInstallerAssetName,
  fetchLatestGitHubRelease,
  parseLatestGitHubRelease,
  selectInstallerReleaseArtifact,
} from "@codexhost/update-manager";

function release(overrides: Record<string, unknown> = {}) {
  return {
    tag_name: "v1.2.3",
    html_url: "https://github.com/BytePioneer-AI/codex-host/releases/tag/v1.2.3",
    draft: false,
    prerelease: false,
    body: "## Changes\n\n- Safer updates",
    assets: [
      {
        name: "codexhost-1.2.3-windows-x64.exe",
        size: 42,
        digest: `sha256:${"ab".repeat(32)}`,
        browser_download_url:
          "https://github.com/BytePioneer-AI/codex-host/releases/download/v1.2.3/codexhost-1.2.3-windows-x64.exe",
        uploader: { login: "github-actions" },
      },
    ],
    author: { login: "github-actions" },
    ...overrides,
  };
}

describe("GitHub Release update discovery", () => {
  it("parses the public latest response and selects one exact target asset", () => {
    const parsed = parseLatestGitHubRelease(release());
    expect(parsed.version).toBe("1.2.3");
    expect(parsed.releaseNotes).toBe("## Changes\n\n- Safer updates");
    expect(selectInstallerReleaseArtifact(parsed, "windows-x64")).toEqual({
      name: "codexhost-1.2.3-windows-x64.exe",
      source: {
        url: "https://github.com/BytePioneer-AI/codex-host/releases/download/v1.2.3/codexhost-1.2.3-windows-x64.exe",
        sha256: "ab".repeat(32),
        size: 42,
      },
    });
    expect(expectedInstallerAssetName("1.2.3", "macos-arm64")).toBe(
      "codexhost-1.2.3-macos-arm64.dmg",
    );
  });

  it("rejects prereleases, mismatched notes, duplicate assets, and unverified selection", () => {
    expect(() => parseLatestGitHubRelease(release({ prerelease: true }))).toThrow("invalid");
    expect(() =>
      parseLatestGitHubRelease(
        release({
          html_url: "https://github.com/BytePioneer-AI/codex-host/releases/tag/v9.9.9",
        }),
      ),
    ).toThrow("does not match");
    const parsedWithoutDigest = parseLatestGitHubRelease(
      release({
        assets: [
          {
            name: "codexhost-1.2.3-windows-x64.exe",
            size: 42,
            browser_download_url:
              "https://github.com/BytePioneer-AI/codex-host/releases/download/v1.2.3/codexhost-1.2.3-windows-x64.exe",
          },
        ],
      }),
    );
    expect(parsedWithoutDigest.assets[0]?.digest).toBeNull();
    expect(() => selectInstallerReleaseArtifact(parsedWithoutDigest, "windows-x64")).toThrow(
      "no valid SHA-256",
    );
    const parsed = parseLatestGitHubRelease(release());
    expect(() =>
      selectInstallerReleaseArtifact(
        { ...parsed, assets: [...parsed.assets, ...parsed.assets] },
        "windows-x64",
      ),
    ).toThrow("exactly one");
    expect(() =>
      selectInstallerReleaseArtifact(
        { ...parsed, assets: parsed.assets.map((asset) => ({ ...asset, digest: null })) },
        "windows-x64",
      ),
    ).toThrow("no valid SHA-256");
  });

  it("uses stable SemVer precedence", () => {
    expect(compareSemanticVersions("1.2.3-test.2", "1.2.3")).toBeLessThan(0);
    expect(compareSemanticVersions("1.2.4", "1.2.3")).toBeGreaterThan(0);
    expect(compareSemanticVersions("1.2.3+one", "1.2.3+two")).toBe(0);
  });

  it("requests only the fixed GitHub latest endpoint", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(release()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(fetchLatestGitHubRelease({ fetch: fetchImpl })).resolves.toMatchObject({
      version: "1.2.3",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      CODEXHOST_LATEST_RELEASE_URL,
      expect.objectContaining({ redirect: "error" }),
    );
  });
});
