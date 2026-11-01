import { describe, expect, it, vi } from "vitest";

import {
  CODEXHOST_LATEST_RELEASE_URL,
  compareSemanticVersions,
  expectedInstallerAssetName,
  fetchLatestGitHubRelease,
  fetchLatestGitHubReleaseWithGitHubCli,
  parseLatestGitHubRelease,
  selectInstallerReleaseArtifact,
  type GitHubCliRunner,
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

  it("uses the authenticated GitHub CLI without exposing its token", async () => {
    const run = vi.fn(async () => JSON.stringify(release()));
    await expect(
      fetchLatestGitHubReleaseWithGitHubCli({
        environment: { PATH: "/usr/bin:/bin" },
        executableCandidates: ["/opt/homebrew/bin/gh"],
        run,
      }),
    ).resolves.toMatchObject({ version: "1.2.3" });
    expect(run).toHaveBeenCalledWith(
      "/opt/homebrew/bin/gh",
      [
        "api",
        "--hostname",
        "github.com",
        "--method",
        "GET",
        "--header",
        "Accept: application/vnd.github+json",
        "--header",
        "X-GitHub-Api-Version: 2022-11-28",
        "repos/BytePioneer-AI/codex-host/releases/latest",
      ],
      { environment: { PATH: "/usr/bin:/bin" } },
    );
  });

  it("falls back cleanly when GitHub CLI is unavailable", async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error("not installed"), { code: "ENOENT" });
    });
    await expect(
      fetchLatestGitHubReleaseWithGitHubCli({
        executableCandidates: ["gh", "/opt/homebrew/bin/gh"],
        run,
      }),
    ).resolves.toBeNull();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("finds Homebrew gh with the minimal macOS GUI PATH", async () => {
    const run = vi.fn(async (executable: string) => {
      if (executable === "gh") throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return JSON.stringify(release());
    });
    await expect(
      fetchLatestGitHubReleaseWithGitHubCli({
        environment: { PATH: "/usr/bin:/bin" },
        platform: "darwin",
        run,
      }),
    ).resolves.toMatchObject({ version: "1.2.3" });
    expect(run.mock.calls.map(([executable]) => executable)).toEqual([
      "gh",
      "/opt/homebrew/bin/gh",
    ]);
  });

  it.each(["win32", "linux"] as const)("discovers native gh on %s", async (platform) => {
    const expected =
      platform === "win32" ? "C:\\Program Files\\GitHub CLI\\gh.exe" : "/usr/local/bin/gh";
    const run = vi.fn(async (executable: string) => {
      if (executable !== expected) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return JSON.stringify(release());
    });
    await expect(
      fetchLatestGitHubReleaseWithGitHubCli({
        environment: { ProgramFiles: "C:\\Program Files" },
        platform,
        run,
      }),
    ).resolves.toMatchObject({ version: "1.2.3" });
    expect(run.mock.calls.at(-1)?.[0]).toBe(expected);
  });

  it("does not substitute another installation for an explicit gh command", async () => {
    const run = vi.fn<GitHubCliRunner>(async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    await expect(
      fetchLatestGitHubReleaseWithGitHubCli({
        environment: { CODEXHOST_GH_COMMAND: "/custom/gh" },
        run,
      }),
    ).resolves.toBeNull();
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toBe("/custom/gh");
  });

  it("does not repeat CLI failures or expose their diagnostics", async () => {
    const run = vi.fn(async () => {
      throw new Error("private CLI diagnostic");
    });
    await expect(
      fetchLatestGitHubReleaseWithGitHubCli({
        executableCandidates: ["gh", "/opt/homebrew/bin/gh"],
        run,
      }),
    ).resolves.toBeNull();
    expect(run).toHaveBeenCalledOnce();
  });

  it.each([
    "not JSON",
    JSON.stringify(release({ prerelease: true })),
    JSON.stringify(release({ html_url: "https://example.com/release" })),
  ])("rejects invalid CLI release output", async (output) => {
    const run = vi.fn(async () => output);
    await expect(fetchLatestGitHubReleaseWithGitHubCli({ run })).resolves.toBeNull();
    expect(run).toHaveBeenCalledOnce();
  });

  it("does not start gh after cancellation", async () => {
    const run = vi.fn();
    await expect(
      fetchLatestGitHubReleaseWithGitHubCli({ signal: AbortSignal.abort(), run }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(run).not.toHaveBeenCalled();
  });

  it("propagates cancellation without exposing subprocess stderr", async () => {
    const controller = new AbortController();
    const run = vi.fn(async () => {
      controller.abort();
      throw new Error("sensitive subprocess stderr");
    });
    await expect(
      fetchLatestGitHubReleaseWithGitHubCli({ signal: controller.signal, run }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(run).toHaveBeenCalledOnce();
  });
});
