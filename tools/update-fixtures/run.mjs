import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
export function testBinaries(output) {
  const binaries = new Map();
  for (const line of output.split(/\r?\n/u).filter(Boolean)) {
    const value = JSON.parse(line);
    if (
      value.reason === "compiler-artifact" &&
      value.profile?.test &&
      value.target?.kind?.includes("bin") &&
      value.executable
    ) {
      binaries.set(value.target.name, value.executable);
    }
  }
  for (const name of ["codexhost", "codexhost-updater"]) {
    if (!binaries.has(name)) throw new Error(`missing native test binary: ${name}`);
  }
  return { launcher: binaries.get("codexhost"), updater: binaries.get("codexhost-updater") };
}
export async function buildTestBinaries() {
  const { stdout, stderr } = await execute(
    "cargo",
    [
      "test",
      "-p",
      "codexhost-launcher",
      "-p",
      "codexhost-updater",
      "--locked",
      "--no-run",
      "--message-format=json",
    ],
    { cwd: root, maxBuffer: 32 * 1024 * 1024 },
  );
  process.stderr.write(stderr);
  return testBinaries(stdout);
}
export async function run() {
  const binaries = await buildTestBinaries();
  const env = {
    ...process.env,
    CODEXHOST_LAUNCHER_TEST_BINARY: binaries.launcher,
    CODEXHOST_NATIVE_UPDATER_TEST_BINARY: binaries.updater,
  };
  for (const [program, args] of [
    [binaries.updater, ["windows_ready::tests::"]],
    [binaries.updater, ["npm_processes::"]],
    [binaries.updater, ["windows_launch::tests::"]],
    [binaries.updater, ["windows_apply::tests::"]],
    [binaries.updater, ["installer_recovery::tests::"]],
    ...(process.platform === "win32" ? [[binaries.updater, ["windows_handoff_tests::"]]] : []),
    ...(process.platform === "win32"
      ? [
          [
            binaries.launcher,
            [
              "--exact",
              "active_update::windows::tests::two_updates_survive_old_desktop_jobs_including_detached_node_children",
              "--ignored",
              "--nocapture",
            ],
          ],
        ]
      : []),
    ["cargo", ["test", "-p", "codexhost-platform", "--locked", "activation_"]],
    [
      binaries.updater,
      [
        "--exact",
        "install::relaunch_tests::update_and_recovery_relaunch_preserve_an_unowned_desktop",
        "--ignored",
        "--nocapture",
      ],
    ],
    [
      process.execPath,
      [
        path.join(root, "node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        "tests/vitest.config.js",
        "packages/update-manager/test/npm-materials.test.ts",
        "packages/update-manager/test/npm-archive.test.ts",
        "packages/update-manager/test/update-manager.test.ts",
        "packages/update-manager/test/support.test.ts",
        "packages/update-manager/test/launcher-update.test.ts",
        "packages/update-manager/test/installer-recovery.test.ts",
        "packages/host-runtime/test/update-coordinator-handoff.test.ts",
        "packages/host-runtime/test/update-support.test.ts",
        "packages/console-server/test/update-support.test.ts",
        "tools/update-fixtures/fixture-workspace.test.mjs",
        "tools/update-fixtures/codex-host-smoke.test.mjs",
      ],
    ],
  ]) {
    const result = await execute(program, args, {
      cwd: root,
      env,
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    process.stderr.write(`${error.stdout ?? ""}${error.stderr ?? ""}${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
