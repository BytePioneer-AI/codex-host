import { describe, expect, it, vi } from "vitest";

import { withUserShellEnvironment } from "../src/user-shell-environment.js";

const marker = "startup output\0CODEXHOST_USER_SHELL_ENV_V1\0";

describe("User shell environment", () => {
  it("loads zsh initialization and only fills variables missing from the Host", () => {
    const run = vi.fn(() => ({
      status: 0,
      stdout: Buffer.from(
        `${marker}ANTHROPIC_AUTH_TOKEN=from-shell\0ANTHROPIC_BASE_URL=https://api.example.com\0PATH=/shell/bin\0CLAUDE_CONFIG_DIR=/shell/config\0`,
      ),
    }));

    const result = withUserShellEnvironment(
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

  it("falls back without changing the Host environment when shell loading fails", () => {
    const environment = { HOME: "/Users/example", PATH: "/host/bin", SHELL: "/bin/zsh" };

    expect(
      withUserShellEnvironment(environment, {
        platform: "darwin",
        run: () => ({ status: 1, stdout: Buffer.alloc(0) }),
      }),
    ).toBe(environment);
  });

  it("does not invoke a POSIX shell on Windows", () => {
    const run = vi.fn();
    const environment = { HOME: "C:\\Users\\example", PATH: "C:\\Windows" };

    expect(withUserShellEnvironment(environment, { platform: "win32", run })).toBe(environment);
    expect(run).not.toHaveBeenCalled();
  });
});
