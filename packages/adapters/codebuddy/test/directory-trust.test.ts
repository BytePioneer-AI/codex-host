import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodeBuddyAdapter } from "../src/codebuddy-adapter.js";
import { CodeBuddyError } from "../src/common.js";
import { configuration } from "../src/configuration.js";
import {
  assessCodeBuddyDirectoryTrust,
  assertCodeBuddyDirectoryTrusted,
  codeBuddyMissingModelErrorMessage,
} from "../src/directory-trust.js";

async function configRoot() {
  return mkdtemp(path.join(tmpdir(), "codebuddy-trust-"));
}

describe("CodeBuddy directory trust surfacing", () => {
  it("classifies trustAll, trustedDirectories, untrusted settings, and missing settings", async () => {
    const home = await configRoot();
    const project = path.join(home, "project");
    await mkdir(project);
    const config = path.join(home, "config");
    await mkdir(config);
    const settingsPath = path.join(config, "settings.json");
    const environment = { HOME: home, CODEBUDDY_CONFIG_DIR: config };

    await writeFile(settingsPath, JSON.stringify({ trustAll: true }), "utf8");
    expect(assessCodeBuddyDirectoryTrust(project, environment).status).toBe("trusted");

    await writeFile(
      settingsPath,
      JSON.stringify({ trustedDirectories: [project, "~/project"] }),
      "utf8",
    );
    expect(assessCodeBuddyDirectoryTrust(project, environment).status).toBe("trusted");

    await writeFile(settingsPath, JSON.stringify({ trustedDirectories: [] }), "utf8");
    expect(assessCodeBuddyDirectoryTrust(project, environment)).toMatchObject({
      status: "untrusted",
      settingsPath,
    });

    const missing = await configRoot();
    expect(
      assessCodeBuddyDirectoryTrust(project, {
        HOME: missing,
        CODEBUDDY_CONFIG_DIR: path.join(missing, "absent"),
      }).status,
    ).toBe("unknown");
  });

  it("fails fast with an actionable invalidRequest before starting ACP when cwd is untrusted", async () => {
    const home = await configRoot();
    const project = path.join(home, "project");
    await mkdir(project);
    const config = path.join(home, "config");
    await mkdir(config);
    await writeFile(
      path.join(config, "settings.json"),
      JSON.stringify({ trustedDirectories: [path.join(home, "other")] }),
      "utf8",
    );
    const environment = { HOME: home, CODEBUDDY_CONFIG_DIR: config };

    expect(() => assertCodeBuddyDirectoryTrusted(project, environment)).toThrow(CodeBuddyError);
    try {
      assertCodeBuddyDirectoryTrusted(project, environment);
    } catch (error) {
      expect(error).toMatchObject({
        code: "invalidRequest",
        message: expect.stringMatching(/trustedDirectories|trustAll|worktree setup/i),
      });
    }

    const adapter = new CodeBuddyAdapter({
      environment,
      clientFactory: () => {
        throw new Error("ACP client must not start for an untrusted cwd");
      },
    });
    try {
      await expect(adapter.open({ kind: "create", cwd: project })).resolves.toMatchObject({
        ok: false,
        error: {
          code: "invalidRequest",
          message: expect.stringMatching(/trustedDirectories|directory trust|worktree setup/i),
        },
      });
      await expect(adapter.inspect({ cwd: project })).resolves.toMatchObject({
        status: "unavailable",
        error: {
          code: "invalidRequest",
          message: expect.stringMatching(/trustedDirectories|directory trust|worktree setup/i),
        },
      });
    } finally {
      await adapter.close();
    }
  });

  it("turns a missing current Model into a trust error when settings leave cwd untrusted", async () => {
    const home = await configRoot();
    const project = path.join(home, "work");
    await mkdir(project);
    const config = path.join(home, "config");
    await mkdir(config);
    await writeFile(
      path.join(config, "settings.json"),
      JSON.stringify({ trustedDirectories: ["/not/this"] }),
      "utf8",
    );
    const environment = { CODEBUDDY_CONFIG_DIR: config, HOME: home };

    expect(() => configuration([], undefined, { cwd: project, environment })).toThrowError(
      /trustedDirectories|worktree setup/i,
    );
    try {
      configuration([], undefined, { cwd: project, environment });
    } catch (error) {
      expect(error).toMatchObject({ code: "invalidRequest" });
    }

    const unknownHome = await configRoot();
    const unknownProject = path.join(unknownHome, "work");
    await mkdir(unknownProject);
    const unknownEnv = {
      HOME: unknownHome,
      CODEBUDDY_CONFIG_DIR: path.join(unknownHome, "missing-config"),
    };
    expect(() =>
      configuration([], undefined, { cwd: unknownProject, environment: unknownEnv }),
    ).toThrowError(/ACP did not report a valid current Model/);
    expect(codeBuddyMissingModelErrorMessage(unknownProject, unknownEnv)).toMatch(
      /trustedDirectories/,
    );

    await writeFile(path.join(config, "settings.json"), JSON.stringify({ trustAll: true }), "utf8");
    expect(codeBuddyMissingModelErrorMessage(project, environment)).toBe(
      "ACP did not report a valid current Model",
    );
  });
});
