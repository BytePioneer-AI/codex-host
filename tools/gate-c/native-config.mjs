import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GateCError } from "./errors.mjs";

const NATIVE_CONFIG_FILES = ["settings.json", "auth.json", "models.json"];

function expandHome(candidate) {
  if (candidate === "~") return os.homedir();
  if (candidate.startsWith("~/") || candidate.startsWith("~\\")) {
    return path.join(os.homedir(), candidate.slice(2));
  }
  return candidate;
}

export function nativeAgentDir(env = process.env) {
  return path.resolve(
    expandHome(env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent")),
  );
}

function copyConfigFile(sourceDir, targetDir, name) {
  const source = path.join(sourceDir, name);
  if (!fs.existsSync(source)) return;
  if (!fs.statSync(source).isFile()) {
    throw new GateCError("NATIVE_CONFIG", `Pi Native Mode config is not a file: ${source}`);
  }
  const target = path.join(targetDir, name);
  fs.copyFileSync(source, target);
  if (process.platform !== "win32") fs.chmodSync(target, 0o600);
}

export function isolateNativeEnvironment(workspace, env) {
  const sourceDir = nativeAgentDir(env);
  const targetDir = path.join(workspace.cwd, ".pi-agent");
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    for (const name of NATIVE_CONFIG_FILES) copyConfigFile(sourceDir, targetDir, name);
  }
  return { ...env, PI_CODING_AGENT_DIR: targetDir };
}
