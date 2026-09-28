import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { officialEnvironment } from "../src/app-server-host.js";
import { runDelegationCli } from "../src/delegation-cli.js";
import {
  delegationCliEnvironment,
  delegationNextCommands,
} from "../src/delegation-cli-invocation.js";
import { CODEXHOST_DELEGATION_SKILL, installDelegationSkills } from "../src/delegation-skill.js";

describe("delegation CLI invocation", () => {
  it("selects npm's script and Node together, while keeping explicit and packaged entries", () => {
    const npm = {
      CODEXHOST_NPM_LAUNCHER_PATH: "/npm/bin/codexhost.js",
      CODEXHOST_NPM_NODE_PATH: "/npm/bin/node",
      CODEXHOST_LAUNCHER_EXECUTABLE: "/npm/platform/bin/codexhost",
    };
    expect(delegationCliEnvironment(npm)).toEqual({
      CODEXHOST_CLI_PATH: npm.CODEXHOST_NPM_LAUNCHER_PATH,
      CODEXHOST_CLI_NODE_PATH: npm.CODEXHOST_NPM_NODE_PATH,
    });
    expect(delegationCliEnvironment({ ...npm, CODEXHOST_CLI_PATH: "/custom/codexhost" })).toEqual({
      CODEXHOST_CLI_PATH: "/custom/codexhost",
      CODEXHOST_CLI_NODE_PATH: undefined,
    });
    expect(
      delegationCliEnvironment({
        CODEXHOST_LAUNCHER_EXECUTABLE: "/app/codexhost",
        CODEXHOST_CLI_NODE_PATH: "/stale/node",
      }),
    ).toEqual({ CODEXHOST_CLI_PATH: "/app/codexhost", CODEXHOST_CLI_NODE_PATH: undefined });
    expect(delegationCliEnvironment({})).toEqual({
      CODEXHOST_CLI_PATH: undefined,
      CODEXHOST_CLI_NODE_PATH: undefined,
    });
    expect(officialEnvironment({ ...npm, ...delegationCliEnvironment(npm) })).toEqual({
      CODEXHOST_CLI_PATH: npm.CODEXHOST_NPM_LAUNCHER_PATH,
      CODEXHOST_CLI_NODE_PATH: npm.CODEXHOST_NPM_NODE_PATH,
    });
  });

  it("keeps missing-path follow-ups off PATH", () => {
    expect(delegationNextCommands({}, "child", "darwin").read).toBe(
      "\"$CODEXHOST_CLI_PATH\" thread read 'child'",
    );
    expect(delegationNextCommands({}, "child", "win32").read).toBe(
      "& $env:CODEXHOST_CLI_PATH thread read 'child'",
    );
  });

  it("renders Windows paths as literal PowerShell arguments, including npm scripts", () => {
    expect(
      delegationNextCommands(
        {
          CODEXHOST_CLI_NODE_PATH: String.raw`C:\Program Files\node.exe`,
          CODEXHOST_CLI_PATH: String.raw`C:\it's $literal\codexhost.js`,
        },
        "child",
        "win32",
      ).read,
    ).toBe(
      String.raw`& 'C:\Program Files\node.exe' 'C:\it''s $literal\codexhost.js' thread read 'child'`,
    );
  });

  it.skipIf(process.platform === "win32").each([
    { npm: false, stale: false },
    { npm: false, stale: true },
    { npm: true, stale: false },
    { npm: true, stale: true },
  ])("executes Skill and returned commands without PATH lookup: %j", async ({ npm, stale }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "delegation-invocation-"));
    try {
      const directory = path.join(root, "App 'quote' $literal");
      const bin = path.join(root, "bin");
      await mkdir(directory);
      await mkdir(bin);
      const cli = path.join(directory, npm ? "codexhost.mjs" : "codexhost");
      await writeFile(
        cli,
        npm
          ? 'if (process.env.CODEXHOST_RUNTIME_TOKEN !== "fixture-token") process.exit(43);\nconsole.log(process.argv.slice(2).join("\\n"));\n'
          : '#!/bin/sh\n[ "$CODEXHOST_RUNTIME_TOKEN" = fixture-token ] || exit 43\nprintf "%s\\n" "$@"\n',
      );
      if (!npm) await chmod(cli, 0o755);
      if (stale) {
        await writeFile(path.join(bin, "codexhost"), "#!/bin/sh\nexit 99\n");
        await chmod(path.join(bin, "codexhost"), 0o755);
      }
      const environment = {
        PATH: bin,
        CODEXHOST_CLI_PATH: cli,
        ...(npm ? { CODEXHOST_CLI_NODE_PATH: process.execPath } : {}),
        CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:4321",
        CODEXHOST_RUNTIME_TOKEN: "fixture-token",
      };
      await installDelegationSkills({ homeDirectory: root });
      const skill = await readFile(
        path.join(root, ".agents/skills/codexhost-delegation/SKILL.md"),
        "utf8",
      );
      expect(skill).toBe(CODEXHOST_DELEGATION_SKILL);
      const bootstrap = [...skill.matchAll(/`([^`\n]*delegate --help)`/gu)]
        .map((match) => match[1] ?? "")
        .find((command) =>
          command.startsWith(npm ? '"$CODEXHOST_CLI_NODE_PATH"' : '"$CODEXHOST_CLI_PATH"'),
        );
      if (!bootstrap) throw new Error("Skill is missing the bootstrap command");
      const execute = (command: string) => {
        const result = spawnSync("/bin/sh", ["-c", command], {
          env: environment,
          encoding: "utf8",
          timeout: 5000,
        });
        expect(result.status, result.stderr).toBe(0);
        return result.stdout.trim().split("\n");
      };
      expect(execute(bootstrap)).toEqual(["delegate", "--help"]);
      for (const command of [
        ["delegate", "start", "--harness", "pi", "--task", "review"],
        ["thread", "send", "child", "--message", "continue"],
      ]) {
        const output = new PassThrough();
        const threadId = "child 'quoted' $literal";
        const body = {
          threadId,
          status: "running",
          harnessId: "pi",
          next: {
            read: "/remote/host/codexhost thread read child",
            wait: "codexhost thread wait child",
          },
        };
        expect(
          await runDelegationCli({
            arguments: command,
            environment,
            output,
            fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }),
          }),
        ).toBe(0);
        const result = JSON.parse(output.read().toString());
        expect({ ...result, next: body.next }).toEqual(body);
        expect(execute(result.next.read)).toEqual(["thread", "read", threadId]);
        expect(execute(result.next.wait)).toEqual([
          "thread",
          "wait",
          threadId,
          "--timeout-ms",
          "30000",
        ]);
        expect(JSON.stringify(result)).not.toContain("fixture-token");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
