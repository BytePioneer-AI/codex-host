/** Synchronous verb-based test CLIs, executable by execFile without a shell. */
import {
  chmodSync,
  copyFileSync,
  linkSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "codexhost-test-cli-"));
const windows = process.platform === "win32";
process.once("exit", () =>
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
);
if (windows) {
  const bootstrap = join(root, "bootstrap.cjs");
  writeFileSync(
    bootstrap,
    `
const path = require("node:path");
if (path.dirname(process.execPath).toLowerCase().startsWith(${JSON.stringify(root.toLowerCase())} + path.sep)) {
  const fs = require("node:fs");
  const entry = path.join(path.dirname(process.execPath), "entry.cjs");
  process.argv = [process.execPath, entry, path.basename(process.argv[1] ?? ""), ...process.argv.slice(2)];
  console.log = (...args) => fs.writeSync(1, args.join(" ") + "\\n");
  console.error = (...args) => fs.writeSync(2, args.join(" ") + "\\n");
  require(entry);
  process.exit(0);
}
`,
  );
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --require ${JSON.stringify(bootstrap.replaceAll("\\", "/"))}`;
}

export function nodeCommand(name: string, source: string) {
  const directory = mkdtempSync(join(root, "command-"));
  const command = join(directory, windows ? `${name}.exe` : name);
  const entry = join(directory, "entry.cjs");
  writeFileSync(entry, `#!${process.execPath}\n${source}`);
  if (windows) {
    // Hard links avoid copying Node for every fixture. Never chmod the shared executable.
    try {
      linkSync(process.execPath, command);
    } catch {
      copyFileSync(process.execPath, command);
    }
  } else {
    chmodSync(entry, 0o755);
    symlinkSync(entry, command);
  }
  return {
    directory,
    command,
    environment: windows ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {},
  };
}
