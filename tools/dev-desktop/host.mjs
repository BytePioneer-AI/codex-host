import path from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { readRunningHost, shouldRestartHost } from "./host-restart.mjs";
import { isWebRunning } from "./interface-processes.mjs";

/** Hash built Host inputs by relative path and contents, never by timestamps. */
export async function developmentHostFingerprint(root) {
  const files = ["package-lock.json"];
  async function visit(directory, inDist = false) {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`;
      if (
        entry.name === "node_modules" ||
        relative === "packages/web-server/dist" ||
        relative === "packages/renderer-extension/dist"
      )
        continue;
      if (entry.isDirectory()) await visit(relative, inDist || entry.name === "dist");
      else if (
        entry.isFile() &&
        inDist &&
        (entry.name.endsWith(".js") ||
          /^packages\/host-runtime\/dist\/plugins\/(?:enabled\.json|[^/]+\/(?:plugin\.mjs|manifest\.json))$/u.test(
            relative,
          ))
      )
        files.push(relative);
    }
  }
  await visit("packages");
  const hash = createHash("sha256");
  for (const relative of files.sort()) {
    const contents = await readFile(path.join(root, relative));
    hash.update(`${relative}\0${contents.length}\0`).update(contents);
  }
  return hash.digest("hex");
}

/** Restart only after comparing the validated build with the live Host. */
export async function restartDevelopmentHost({
  artifacts,
  environment,
  run,
  root = path.resolve(import.meta.dirname, "../.."),
  mode,
  readHost = readRunningHost,
  fingerprint = developmentHostFingerprint,
  webRunning = isWebRunning,
  decide = shouldRestartHost,
}) {
  const env = { ...environment };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CODEXHOST_NPM_") || key === "CODEXHOST_DEV_VERSION") delete env[key];
  }
  const data = path.resolve(env.CODEXHOST_DATA_DIR || path.join(homedir(), ".codexhost"));
  const owner = await readHost(data);
  const currentFingerprint = await fingerprint(root);
  const recordPath = path.join(data, "dev-host-fingerprint.json");
  const runtime = artifacts.hostRuntime;
  const writeFingerprint = async () => {
    await mkdir(data, { recursive: true });
    await writeFile(
      recordPath,
      JSON.stringify({ runtime, fingerprint: currentFingerprint }) + "\n",
    );
  };
  if (!owner) {
    await writeFingerprint();
    return;
  }
  let record;
  try {
    record = JSON.parse(await readFile(recordPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  const changed =
    owner.runtime !== runtime ||
    record?.runtime !== runtime ||
    record?.fingerprint !== currentFingerprint;
  if (
    !(await decide({
      running: true,
      changed,
      mode,
      otherInterfaceRunning: webRunning,
      otherInterface: "Web",
    }))
  )
    return;
  console.log("codexhost dev: restarting shared Host; running tasks will be interrupted");
  const result = await run(
    {
      command: artifacts.launcher,
      arguments: [
        "host",
        "restart",
        "--node",
        artifacts.node,
        "--host-runtime",
        artifacts.hostRuntime,
        "--data",
        data,
      ],
    },
    env,
  );
  if (result.code !== 0) throw new Error("Shared Host restart failed; interface was not started");
  await writeFingerprint();
}
