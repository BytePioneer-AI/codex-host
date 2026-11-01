import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { withUserShellEnvironment } from "../src/user-shell-environment.js";

const marker = "startup output\0CODEXHOST_USER_SHELL_ENV_V1\0";

describe("User shell environment", () => {
  it.skipIf(process.platform === "win32")(
    "keeps the event loop responsive while a shell starts",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "codexhost-shell-async-"));
      try {
        const shell = path.join(directory, "zsh");
        await writeFile(
          shell,
          "#!/bin/sh\n/bin/sleep 0.2\nprintf '\\0CODEXHOST_USER_SHELL_ENV_V1\\0FROM_SHELL=yes\\0'\n",
          { mode: 0o700 },
        );
        let settled = false;
        const pending = withUserShellEnvironment({ HOME: directory, SHELL: shell });
        void pending.then(() => {
          settled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(settled).toBe(false);
        expect(await pending).toMatchObject({ FROM_SHELL: "yes" });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("loads zsh initialization and only fills variables missing from the Host", async () => {
    const run = vi.fn(async () => ({
      status: 0,
      stdout: Buffer.from(
        `${marker}ANTHROPIC_AUTH_TOKEN=from-shell\0ANTHROPIC_BASE_URL=https://api.example.com\0PATH=/shell/bin\0CLAUDE_CONFIG_DIR=/shell/config\0`,
      ),
    }));

    const result = await withUserShellEnvironment(
      { HOME: "/Users/example", PATH: "/host/bin", SHELL: "/bin/zsh" },
      { platform: "darwin", run },
    );

    expect(run).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-ilc", expect.stringContaining("/usr/bin/env -0")],
      expect.objectContaining({ timeout: 3_000 }),
    );
    expect(result).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: "from-shell",
      ANTHROPIC_BASE_URL: "https://api.example.com",
      CLAUDE_CONFIG_DIR: "/shell/config",
      PATH: "/host/bin",
    });
  });

  it("falls back without changing the Host environment when shell loading fails", async () => {
    const environment = { HOME: "/Users/example", PATH: "/host/bin", SHELL: "/bin/zsh" };

    expect(
      await withUserShellEnvironment(environment, {
        platform: "darwin",
        run: async () => ({ status: 1, stdout: Buffer.alloc(0) }),
      }),
    ).toBe(environment);
  });

  it("does not invoke a POSIX shell on Windows", async () => {
    const run = vi.fn();
    const environment = { HOME: "C:\\Users\\example", PATH: "C:\\Windows" };

    expect(await withUserShellEnvironment(environment, { platform: "win32", run })).toBe(
      environment,
    );
    expect(run).not.toHaveBeenCalled();
  });
});
