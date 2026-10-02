import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";

import { REMOTE_FAILURE_CHINESE } from "../packages/renderer-extension/src/settings/remote-failure-messages.ts";

const repository = path.resolve(import.meta.dirname, "..");
/** Every place that words a failure the remote connections page can show. */
const SOURCES = [
  "crates/updater/src/ssh.rs",
  "crates/updater/src/remote.rs",
  "packages/host-runtime/src/runtime-maintenance.ts",
  "packages/host-runtime/src/remote-ssh-setup.ts",
  "packages/host-runtime/src/app-server-host.ts",
  "packages/renderer-extension/src/remote-connections-control.ts",
  "packages/renderer-extension/src/codex-ssh-adapter.ts",
];
/** Built from a template in remote.rs rather than written out. */
const TEMPLATED = new Map([
  ["Remote stop failed", "Remote {action} failed"],
  ["Remote install failed", "Remote {action} failed"],
  ["Remote start failed", "Remote {action} failed"],
]);

// The page translates failures by their English wording, because the processes that report
// them have no locale. Rewording one must therefore update its translation as well.
it("translates only remote failures that the code still produces", async () => {
  const code = (
    await Promise.all(SOURCES.map((source) => readFile(path.join(repository, source), "utf8")))
  ).join("\n");
  const stale = Object.keys(REMOTE_FAILURE_CHINESE).filter(
    (message) => !code.includes(TEMPLATED.get(message) ?? message),
  );
  expect(stale).toEqual([]);
});
