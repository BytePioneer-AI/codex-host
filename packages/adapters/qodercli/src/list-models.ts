import { spawn } from "node:child_process";

import { qoderInvocation, resolveQoderExecutable } from "./command.js";

export interface QoderListModelsOptions {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  command?: string;
  timeoutMs?: number;
}

export function readQoderListModels(options: QoderListModelsOptions): Promise<string> {
  const executable = resolveQoderExecutable({
    ...(options.command ? { command: options.command } : {}),
    environment: options.environment,
  });
  const invocation = qoderInvocation(executable, ["--list-models"], options.environment);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.arguments, {
      cwd: options.cwd,
      env: options.environment,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Qoder --list-models timed out"));
    }, options.timeoutMs ?? 20_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `Qoder --list-models exited (${code ?? "signal"})`));
    });
  });
}

export function readQoderStatus(options: QoderListModelsOptions): Promise<string> {
  const executable = resolveQoderExecutable({
    ...(options.command ? { command: options.command } : {}),
    environment: options.environment,
  });
  const invocation = qoderInvocation(executable, ["status"], options.environment);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.arguments, {
      cwd: options.cwd,
      env: options.environment,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Qoder status timed out"));
    }, options.timeoutMs ?? 20_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(`${stdout}\n${stderr}`);
      else
        reject(
          new Error(stderr.trim() || stdout.trim() || `Qoder status exited (${code ?? "signal"})`),
        );
    });
  });
}

export function qoderStatusRequiresAuthentication(text: string): boolean {
  return /not logged in|sign in|authentication required|login required/iu.test(text);
}
