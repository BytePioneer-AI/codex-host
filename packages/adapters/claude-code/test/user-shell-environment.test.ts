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

  it("keeps a wrapper's toolchain environment when the Host is not nested in a session", async () => {
    const run = vi.fn(async () => ({
      status: 0,
      stdout: Buffer.from(`${marker}PATH=/shell/bin\0`),
    }));

    const result = await withUserShellEnvironment(
      {
        HOME: "/Users/example",
        PATH: "/host/bin",
        SHELL: "/bin/zsh",
        ANTHROPIC_BASE_URL: "https://gateway.example.com",
        ANTHROPIC_AUTH_TOKEN: "gateway-token",
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000",
      },
      { platform: "darwin", run },
    );

    expect(result.ANTHROPIC_BASE_URL).toBe("https://gateway.example.com");
    expect(result.ANTHROPIC_AUTH_TOKEN).toBe("gateway-token");
    expect(result.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("200000");
    // The probe never seeds toolchain variables, so only the user's shell can add them.
    expect(run).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-ilc", expect.stringContaining("/usr/bin/env -0")],
      expect.objectContaining({
        env: expect.not.objectContaining({
          ANTHROPIC_BASE_URL: expect.anything(),
          ANTHROPIC_AUTH_TOKEN: expect.anything(),
        }),
      }),
    );
  });

  it("discards a parent session's toolchain routing when the Host was launched inside one", async () => {
    const run = vi.fn(async () => ({
      status: 0,
      stdout: Buffer.from(`${marker}ANTHROPIC_API_KEY=sk-ant-user\0PATH=/shell/bin\0`),
    }));

    const result = await withUserShellEnvironment(
      {
        HOME: "/Users/example",
        PATH: "/host/bin",
        SHELL: "/bin/zsh",
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "parent-session",
        CLAUDE_CONFIG_DIR: "/parent/session/config",
        CLAUDE_SECURESTORAGE_CONFIG_DIR: "/parent/session/secure",
        ANTHROPIC_BASE_URL: "https://magpie.example.com",
        ANTHROPIC_MODEL: "group/flash",
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1048576",
        CLAUDE_CODE_AUTO_MODE_SERVER: "0",
      },
      { platform: "darwin", run },
    );

    expect(result.ANTHROPIC_API_KEY).toBe("sk-ant-user");
    expect(result.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(result.ANTHROPIC_MODEL).toBeUndefined();
    expect(result.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
    expect(result.CLAUDE_CODE_AUTO_MODE_SERVER).toBeUndefined();
    expect(result.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(result.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
  });

  it("prefers user shell toolchain values inside a nested Host", async () => {
    const run = vi.fn(async () => ({
      status: 0,
      stdout: Buffer.from(
        `${marker}ANTHROPIC_MODEL=claude-3-7-sonnet\0ANTHROPIC_BASE_URL=https://company.proxy.com\0`,
      ),
    }));

    const result = await withUserShellEnvironment(
      {
        HOME: "/Users/example",
        PATH: "/host/bin",
        SHELL: "/bin/zsh",
        CLAUDECODE: "1",
        ANTHROPIC_MODEL: "group/flash",
        ANTHROPIC_BASE_URL: "https://magpie.example.com",
      },
      { platform: "darwin", run },
    );

    expect(result.ANTHROPIC_MODEL).toBe("claude-3-7-sonnet");
    expect(result.ANTHROPIC_BASE_URL).toBe("https://company.proxy.com");
  });

  it("strips nested session variables inherited from an active parent Claude session", async () => {
    const run = vi.fn(async () => ({
      status: 0,
      stdout: Buffer.from(`${marker}PATH=/shell/bin\0`),
    }));

    const result = await withUserShellEnvironment(
      {
        HOME: "/Users/example",
        PATH: "/host/bin",
        SHELL: "/bin/zsh",
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "session-12345",
        CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/claude.sock",
        CLAUDE_CODE_MESSAGING_TOKEN: "secret-token",
        CLAUDE_PID: "9999",
        CLAUDE_CODE_CHILD_SESSION: "child-1",
        CLAUDE_CODE_ENTRYPOINT: "cli",
        CLAUDE_CODE_SESSION_ATTENDED: "1",
        CLAUDE_CODE_EXECPATH: "/usr/local/bin/claude",
        CLAUDE_EFFORT: "high",
      },
      { platform: "darwin", run },
    );

    expect(result.CLAUDECODE).toBeUndefined();
    expect(result.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(result.CLAUDE_CODE_MESSAGING_SOCKET).toBeUndefined();
    expect(result.CLAUDE_CODE_MESSAGING_TOKEN).toBeUndefined();
    expect(result.CLAUDE_PID).toBeUndefined();
    expect(result.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
    expect(result.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(result.CLAUDE_CODE_SESSION_ATTENDED).toBeUndefined();
    expect(result.CLAUDE_CODE_EXECPATH).toBeUndefined();
    expect(result.CLAUDE_EFFORT).toBeUndefined();
  });

  it("falls back without changing the Host environment when shell loading fails", async () => {
    const environment = { HOME: "/Users/example", PATH: "/host/bin", SHELL: "/bin/zsh" };

    expect(
      await withUserShellEnvironment(environment, {
        platform: "darwin",
        run: async () => ({ status: 1, stdout: Buffer.alloc(0) }),
      }),
    ).toEqual(environment);
  });

  it("does not invoke a POSIX shell on Windows", async () => {
    const run = vi.fn();
    const environment = { HOME: "C:\\Users\\example", PATH: "C:\\Windows" };

    expect(await withUserShellEnvironment(environment, { platform: "win32", run })).toEqual(
      environment,
    );
    expect(run).not.toHaveBeenCalled();
  });
});
