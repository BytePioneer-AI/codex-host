// Opt-in REAL Codex/Host test driver. Never installs/registers/downloads Codex,
// changes production gates, publishes a release, or substitutes readiness.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildTestBinaries } from "./run.mjs";
const execute = promisify(execFile);
import { createConnection } from "node:net";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  automaticUpdateUnavailableReason,
  compareSemanticVersions,
  defaultUpdateStateDirectory,
  parseDistributionMetadata,
} from "@codexhost/update-manager";
import { updateCheckResultSchema, updateStartResultSchema } from "@codexhost/shared-contracts";
import { fileDigest } from "../../scripts/release/windows/manifest.mjs";
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
function inside(root, candidate) {
  const r = path.relative(root, candidate);
  return r && !path.isAbsolute(r) && r !== ".." && !r.startsWith(`..${path.sep}`);
}
export function validateSmokeConfig(c) {
  if (
    c?.authorization !== "real-codex-host-smoke" ||
    !["npm", "windows-installer"].includes(c.installation)
  )
    throw new Error("Explicit real-codex-host-smoke authorization and original channel required");
  if (!Array.isArray(c.versions) || c.versions.length !== 3)
    throw new Error(
      "Need current, next and subsequent version evidence, not the two software-core 99.x installers",
    );
  const seen = new Set();
  for (const v of c.versions) {
    if (!/^\d+\.\d+\.\d+$/u.test(v.version) || seen.has(v.version))
      throw new Error("Need three distinct exact stable versions");
    seen.add(v.version);
    for (const key of ["launcherSha256", "updaterSha256", "hostSha256"])
      if (!/^[a-f0-9]{64}$/u.test(v[key])) throw new Error(`Missing exact ${key} for ${v.version}`);
  }
  if (
    c.versions.some(
      (v, i) => i > 0 && compareSemanticVersions(c.versions[i - 1].version, v.version) >= 0,
    )
  )
    throw new Error("Smoke stages must be increasing releases");
  if (
    ![c.root, c.resourcesRoot, c.codexDesktopExecutable].every(
      (p) => typeof p === "string" && path.isAbsolute(p),
    )
  )
    throw new Error(
      "Absolute private root, installed resources and pre-existing Codex executable required",
    );
  if (
    c.installation === "npm" &&
    ![c.nodePath, c.npmCliPath, c.npmLauncherPath, c.prefix].every(
      (p) => typeof p === "string" && path.isAbsolute(p),
    )
  )
    throw new Error("npm smoke needs original Node/npm/wrapper/prefix");
  return c;
}
async function json(file, max = 256 * 1024) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max)
    throw new Error(`Not a bounded ordinary file: ${file}`);
  return JSON.parse(await readFile(file, "utf8"));
}
async function verifySoftware(config, expected) {
  const metadata = parseDistributionMetadata(
    await json(path.join(config.resourcesRoot, "app/codexhost-distribution.json")),
  );
  if (
    metadata.version !== expected.version ||
    metadata.target !== "windows-x64" ||
    metadata.distribution !== (config.installation === "npm" ? "npm" : "installer")
  )
    throw new Error("Installed channel/Runtime version does not match the exact stage");
  for (const [file, key] of [
    ["bin/codexhost.exe", "launcherSha256"],
    ["libexec/codexhost-updater.exe", "updaterSha256"],
    ["app/host-runtime.mjs", "hostSha256"],
  ]) {
    if ((await fileDigest(path.join(config.resourcesRoot, file))) !== expected[key])
      throw new Error(`Stage software mismatch: ${expected.version} ${file}`);
  }
}
async function ping(port, nonce) {
  if (!Number.isInteger(port) || port < 1 || !/^[a-f0-9]{32}$/u.test(nonce))
    throw new Error("Invalid Controller endpoint");
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let body = "";
    socket.setTimeout(1000, () => socket.destroy(new Error("Controller timeout")));
    socket.on("connect", () => socket.write(`PING ${nonce}\n`));
    socket.on("data", (chunk) => {
      body += chunk;
      if (body === "ready\n") {
        socket.destroy();
        resolve();
      } else if (body.length > 6) socket.destroy(new Error("Controller rejected readiness"));
    });
    socket.on("error", reject);
    socket.on("end", () => {
      if (body !== "ready\n") reject(new Error("Controller closed before ready"));
    });
  });
}
async function rpc(host, method) {
  const response = await fetch(`http://127.0.0.1:${host.port}/rpc`, {
    method: "POST",
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
    body: JSON.stringify({ method, params: {} }),
    signal: AbortSignal.timeout(20000),
  });
  const reply = await response.json();
  if (!response.ok || reply.error || !("result" in reply))
    throw new Error(`Host ${method} failed: ${reply.error?.message ?? response.status}`);
  return reply.result;
}
async function instance(data, descriptorPath, version, since, previousNonce) {
  const descriptor = await json(descriptorPath, 4096);
  if (descriptor.schema_version !== 1 || descriptor.nonce === previousNonce)
    throw new Error("No fresh runtime descriptor");
  const startup = await json(path.join(data, "diagnostics/launcher-startup-v1.json"));
  if (
    startup.schemaVersion !== 1 ||
    !startup.records.some(
      (r) =>
        r.pid === descriptor.launcher_pid &&
        r.launcherVersion === version &&
        r.outcome === "ready" &&
        r.startedAtMs >= since &&
        r.finishedAtMs >= r.startedAtMs,
    )
  )
    throw new Error("No matching successful Launcher startup record");
  await ping(descriptor.control_port, descriptor.nonce);
  for (const name of await readdir(path.join(data, "console/hosts"))) {
    if (!/^host-\d+\.json$/u.test(name)) continue;
    const host = await json(path.join(data, "console/hosts", name), 4096);
    if (
      host.schemaVersion !== 1 ||
      host.launcherPid !== descriptor.launcher_pid ||
      host.startedAt < since ||
      !/^[a-f0-9]{64}$/u.test(host.token)
    )
      continue;
    const ready = await fetch(`http://127.0.0.1:${host.port}/ready`, {
      headers: { authorization: `Bearer ${host.token}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!ready.ok || (await ready.json()).ready !== true) continue;
    const status = await rpc(host, "codexhost/runtime/status");
    if (
      status.runningVersion === version &&
      status.installedVersion === version &&
      status.restartRequired === false &&
      status.remote === false
    )
      return { host, descriptor };
  }
  throw new Error("Target local Host is not ready");
}
async function until(label, timeout, action, interval = 250) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const result = await action();
      if (result) return result;
    } catch (error) {
      last = error;
    }
    await pause(interval);
  }
  throw new Error(`${label} timed out: ${last?.message ?? "condition unmet"}`);
}
export async function runCodexSmoke(manifest) {
  if (
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    process.env.CODEXHOST_DISPOSABLE_WINDOWS_USER !== "fixture-only" ||
    !process.env.RUNNER_TEMP
  )
    throw new Error(
      "Requires separately authorized disposable Windows x64 interactive profile; this driver is code preparation only until then",
    );
  const config = validateSmokeConfig(await json(manifest));
  const blocked = automaticUpdateUnavailableReason("win32", config.installation);
  // No environment/manifest opt-out. Even after this source policy is enabled,
  // the installed Host/manager/native request gates must independently pass.
  if (blocked) throw new Error(`Real smoke blocked before Desktop launch: ${blocked}`);
  const scratch = await realpath(process.env.RUNNER_TEMP),
    root = path.resolve(config.root);
  if (!inside(scratch, root) || path.dirname(root) !== scratch)
    throw new Error("Smoke root must be a fresh direct RUNNER_TEMP child");
  const resources = await realpath(config.resourcesRoot);
  if (!inside(scratch, resources))
    throw new Error("Only an already installed scratch distribution may be updated");
  if (config.installation === "npm") {
    if (!inside(scratch, await realpath(config.prefix)))
      throw new Error("npm prefix must be private scratch");
    // The protected initial-start observer uses the post-install hoisted root.
    // Nested-to-hoisted software transitions have their separate npm fixture.
    const hoisted = await realpath(
      path.join(config.prefix, "node_modules/@codexhost/cli-win32-x64"),
    );
    if (resources.toLowerCase() !== hoisted.toLowerCase())
      throw new Error("Real smoke initial npm package must already be hoisted");
  }
  const desktop = await realpath(config.codexDesktopExecutable);
  if (!/[/\\]WindowsApps[/\\]OpenAI\.Codex_[^/\\]+[/\\]app[/\\]ChatGPT\.exe$/iu.test(desktop))
    throw new Error(
      "A pre-existing real registered Codex package is required, not the fixture AppX",
    );
  // The operator must first verify an empty interactive session/no independent
  // Codex. Production protected launch also refuses foreign Desktop instances.
  await verifySoftware(config, config.versions[0]);
  await mkdir(root); // never attach to an earlier fixture's descriptors/state
  const environment = { ...process.env };
  for (const key of Object.keys(environment))
    if (key.startsWith("CODEXHOST_") || ["NODE_OPTIONS", "NODE_PATH"].includes(key.toUpperCase()))
      delete environment[key];
  Object.assign(environment, {
    CODEXHOST_DISPOSABLE_WINDOWS_USER: "fixture-only",
    CODEXHOST_DATA_DIR: path.join(root, "data"),
    LOCALAPPDATA: path.join(root, "local-app-data"),
  });
  if (config.installation === "npm")
    Object.assign(environment, {
      CODEXHOST_NPM_NODE_PATH: config.nodePath,
      CODEXHOST_NPM_CLI_PATH: config.npmCliPath,
      CODEXHOST_NPM_LAUNCHER_PATH: config.npmLauncherPath,
      CODEXHOST_NPM_PACKAGE_ROOT: resources,
    });
  const state = defaultUpdateStateDirectory("win32", environment),
    descriptor = path.join(environment.LOCALAPPDATA, "codexhost/desktop-runtime-v1.json");
  const evidence = {
    schemaVersion: 1,
    complete: false,
    realCodex: true,
    installation: config.installation,
    stages: [],
  };
  const save = () =>
    writeFile(path.join(root, "smoke-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  try {
    const since = Date.now();
    const binaries = await buildTestBinaries();
    const requestPath = path.join(root, "initial-startup-request.json");
    await writeFile(
      requestPath,
      JSON.stringify({
        schema_version: 1,
        version: config.versions[0].version,
        wait_pid: process.pid,
        wait_executable: path.join(resources, "bin/codexhost.exe"),
        runtime_descriptor_path: descriptor,
        status_path: path.join(root, "initial-status-unused.json"),
        installation:
          config.installation === "npm"
            ? {
                kind: "npm",
                node_path: config.nodePath,
                npm_cli_path: config.npmCliPath,
                npm_launcher_path: config.npmLauncherPath,
                prefix: config.prefix,
              }
            : {
                kind: "windows-installer",
                installer_path: path.join(root, "unused.exe"),
                artifact_sha256: "0".repeat(64),
                install_root: resources,
              },
      }),
      { flag: "wx" },
    );
    // Initial fixture startup uses the native protected production launch, so
    // it cannot force-close an independent official instance as ordinary launch can.
    await execute(
      binaries.updater,
      [
        "--exact",
        "windows_smoke_tests::initial_protected_real_codex_host",
        "--ignored",
        "--nocapture",
      ],
      {
        env: { ...environment, CODEXHOST_REAL_SMOKE_REQUEST: requestPath },
        timeout: 90000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    let current = await until("initial real Codex/Host", 30000, () =>
      instance(environment.CODEXHOST_DATA_DIR, descriptor, config.versions[0].version, since),
    );
    evidence.stages.push({
      version: config.versions[0].version,
      launcherPid: current.descriptor.launcher_pid,
      hostPid: current.host.pid,
      initial: true,
    });
    await save();
    for (let index = 1; index < 3; index++) {
      const expected = config.versions[index],
        previous = config.versions[index - 1];
      // Official latest/registry routing is NOT overridden. The test owner must
      // make each exact next Release available in sequence, outside this driver.
      const checked = await until(
        `official latest ${expected.version}`,
        15 * 60 * 1000,
        async () => {
          const value = updateCheckResultSchema.parse(
            await rpc(current.host, "codexhost/update/check"),
          );
          return value.latestVersion === expected.version ? value : false;
        },
        60_000,
      );
      if (
        checked.error ||
        !checked.installationAvailable ||
        !checked.updateAvailable ||
        checked.currentVersion !== previous.version
      )
        throw new Error(checked.error ?? "Installed Host did not enable this update");
      const before = new Set(await readdir(state).catch(() => []));
      const started = Date.now(),
        oldNonce = current.descriptor.nonce;
      let startAcknowledged = false;
      try {
        updateStartResultSchema.parse(await rpc(current.host, "codexhost/update/start"));
        startAcknowledged = true;
      } catch {
        /* Observe the one operation; never repeat a possibly accepted start RPC. */
      }
      const operation = await until("unique native operation", 30000, async () => {
        const names = (await readdir(state)).filter(
          (name) => !before.has(name) && name.startsWith(`update-${expected.version}-`),
        );
        if (names.length !== 1) return false;
        return path.join(state, names[0]);
      });
      const helper = path.join(operation, "codexhost-updater.exe");
      await until(
        "installed version's own staged Updater",
        30000,
        async () => (await fileDigest(helper)) === previous.updaterSha256,
      );
      const terminal = await until("actual native apply result", 12 * 60 * 1000, async () => {
        const status = await json(path.join(operation, "status-v1.json"), 65536);
        return ["failed", "succeeded"].includes(status.phase) && status.version === expected.version
          ? status
          : false;
      });
      if (terminal.phase !== "succeeded")
        throw new Error(`Actual apply failed; inspect retained material: ${terminal.error}`);
      await verifySoftware(config, expected);
      const fresh = await until("updated real Codex/Host", 30000, () =>
        instance(environment.CODEXHOST_DATA_DIR, descriptor, expected.version, started, oldNonce),
      );
      if (
        fresh.descriptor.launcher_pid === current.descriptor.launcher_pid ||
        fresh.host.pid === current.host.pid
      )
        throw new Error("Update reused the old instance");
      evidence.stages.push({
        version: expected.version,
        launcherPid: fresh.descriptor.launcher_pid,
        hostPid: fresh.host.pid,
        operation,
        startAcknowledged,
        nativePhase: terminal.phase,
        updaterSha256: previous.updaterSha256,
      });
      await save();
      current = fresh; // No manual relaunch/reinstall between the two updates.
    }
    evidence.complete = true;
    await save();
  } catch (error) {
    evidence.error = String(error.message ?? error).slice(0, 500);
    await save();
    throw error;
  }
  // Leave the final instance and failed-operation materials for explicit owned
  // shutdown/inspection. Never kill by name or delete an unknown install tree.
  return evidence;
}
