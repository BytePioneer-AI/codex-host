#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const main = path.join(repositoryRoot, "packages/host-runtime/dist/main.js");
const child = spawn(
  process.execPath,
  [main, "--codexhost-delegation-cli", ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: process.env,
  },
);
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
child.on("error", (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
