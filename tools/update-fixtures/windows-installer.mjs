import { readFile, writeFile, lstat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
const execute = promisify(execFile);
const mode = process.argv[2];
const options = new Map();
for (let i = 3; i < process.argv.length; i += 2) {
  if (!process.argv[i].startsWith("--") || !process.argv[i + 1])
    throw new Error("expected named fixture options");
  options.set(process.argv[i].slice(2), process.argv[i + 1]);
}
function required(key) {
  const value = options.get(key);
  if (!value) throw new Error(`missing --${key}`);
  return value;
}
async function material(prefix) {
  const filename = required(prefix),
    info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("installer must be an ordinary local file");
  const bytes = await readFile(filename);
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a)
    throw new Error("installer is not a Windows executable");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== required(`${prefix}-sha256`)) throw new Error(`${prefix} digest mismatch`);
  const version = required(`${prefix}-version`);
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(version))
    throw new Error("fixture version must be explicit semver");
  return { path: await realpath(filename), sha256: digest, version };
}
async function run() {
  if (mode === "smoke") {
    const { runCodexSmoke } = await import("./codex-host-smoke.mjs");
    await runCodexSmoke(required("manifest"));
    return;
  }
  if (mode === "build-v1") {
    const { buildV1Fixture } = await import("./windows-installer-v1.mjs");
    await buildV1Fixture(path.resolve(import.meta.dirname, "../.."), required("manifest"));
    return;
  }
  if (mode === "prepare-v1-materials") {
    const { prepareV1Materials } = await import("./prepare-inno-v1.mjs");
    await prepareV1Materials(
      required("manifest"),
      required("install-root"),
      required("operation"),
      required("output"),
    );
    return;
  }
  if (mode === "prepare") {
    const previous = await material("previous"),
      next = await material("next");
    if (previous.sha256 === next.sha256 || previous.version === next.version)
      throw new Error("need two distinct real installer releases");
    const config = { previous, next, root: path.resolve(required("root")) };
    await writeFile(required("manifest"), JSON.stringify(config, null, 2) + "\n", { flag: "wx" });
    return;
  }
  if (mode !== "run" && mode !== "run-v1")
    throw new Error("use prepare, run, build-v1, run-v1 or smoke");
  if (
    process.platform !== "win32" ||
    process.env.CODEXHOST_DISPOSABLE_WINDOWS_USER !== "fixture-only"
  )
    throw new Error("requires an explicitly authorized disposable Windows profile");
  const { stdout } = await execute(
    "cargo",
    ["test", "-p", "codexhost-updater", "--no-run", "--locked", "--message-format=json"],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  const binary = stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find(
      (value) =>
        value.reason === "compiler-artifact" &&
        value.profile?.test &&
        value.target?.name === "codexhost-updater" &&
        value.executable,
    )?.executable;
  if (!binary) throw new Error("native Updater test executable unavailable");
  const result = await execute(
    binary,
    [
      "--exact",
      mode === "run-v1"
        ? "install::installer_recovery_tests::v1::new_logic_installers_restore_their_actual_added_files"
        : "install::installer_recovery_tests::original_channel_offline_downgrade_and_partial_write_repair",
      "--ignored",
      "--nocapture",
    ],
    {
      env: { ...process.env, CODEXHOST_INNO_FIXTURE: path.resolve(required("manifest")) },
      timeout: 900000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}
run().catch((error) => {
  process.stderr.write(`${error.stdout ?? ""}${error.stderr ?? ""}${error.stack ?? error}\n`);
  process.exitCode = 1;
});
