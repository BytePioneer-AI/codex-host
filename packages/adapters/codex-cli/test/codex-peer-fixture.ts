import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

/** A real CLI entrypoint, including the npm-style .cmd launch path on Windows. */
export function writeCodexPeer(root: string, prelude = ""): string {
  const peer = join(root, "codex-peer.cjs");
  writeFileSync(
    peer,
    // Synthetic timers need EOF cleanup; this does not verify termination of CLI descendants.
    `process.stdin.on('end', () => process.exit(0));\n${prelude}\n${readFileSync(resolve("tests/fixtures/codex-auth-peer.cjs"), "utf8")}`,
  );
  const command = join(root, process.platform === "win32" ? "codex.cmd" : "codex");
  if (process.platform === "win32") {
    writeFileSync(command, `@echo off\r\n"${process.execPath}" "%~dp0codex-peer.cjs" %*\r\n`);
  } else {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(command, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(peer)} "$@"\n`);
    chmodSync(command, 0o700);
  }
  return command;
}

/** Wait for dispatch, bounded by the test's cancellation/timeout signal, not process startup speed. */
export async function waitForCodexRequest(
  home: string,
  method: string,
  signal: AbortSignal,
  occurrences = 1,
): Promise<void> {
  while (true) {
    signal.throwIfAborted();
    let log = "";
    try {
      log = readFileSync(join(home, "rpc.jsonl"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const requests = log.split("\n").slice(0, -1);
    if (requests.filter((line) => JSON.parse(line).method === method).length >= occurrences) return;
    await setTimeout(10, undefined, { signal });
  }
}
