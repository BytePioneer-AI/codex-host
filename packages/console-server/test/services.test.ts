import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { runServiceCommand, serviceCommand } from "../src/services.js";

it("uses this installation's native stop/Web entrypoint and packaged resources", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "console-service-command-"));
  try {
    for (const resource of ["host-runtime.mjs", "web-server.mjs"])
      await writeFile(path.join(root, resource), "fixture");
    for (const action of ["stop", "web"] as const) {
      expect(
        serviceCommand(
          { appDirectory: root, launcherExecutable: "/fixture/launcher", distribution: null },
          action,
        ),
      ).toEqual({
        command: "/fixture/launcher",
        args: [
          action,
          "--node",
          process.execPath,
          "--host-runtime",
          path.join(root, "host-runtime.mjs"),
          "--web-runtime",
          path.join(root, "web-server.mjs"),
        ],
      });
    }
    const fixture = path.join(root, "fake-launcher.cjs");
    await writeFile(
      fixture,
      `require("node:fs").writeFileSync(process.env.CODEXHOST_DATA_DIR + "/called", process.argv[2]);`,
    );
    await runServiceCommand(process.execPath, [fixture, "stop"], {
      ...process.env,
      CODEXHOST_DATA_DIR: root,
    });
    expect(await readFile(path.join(root, "called"), "utf8")).toBe("stop");
    await writeFile(fixture, 'console.error("fixture stop failed"); process.exitCode = 1;');
    await expect(
      runServiceCommand(process.execPath, [fixture, "stop"], {
        ...process.env,
        CODEXHOST_DATA_DIR: root,
      }),
    ).rejects.toThrow("fixture stop failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
