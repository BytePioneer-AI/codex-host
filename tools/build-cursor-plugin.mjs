import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildHarnessPlugin } from "../packages/harness-adapter/scripts/build-plugin.mjs";

const root = process.argv[2];
if (!root || !path.isAbsolute(root)) throw new Error("Pass a new absolute candidate directory");
// Never replace an installed or existing candidate. The caller chooses a fresh output.
await mkdir(root);
const audit = await buildHarnessPlugin({
  pluginRoot: path.resolve("packages/adapters/cursor-cli"),
  outputRoot: path.join(root, "cursor-cli"),
  allowedRuntimePackages: new Set(["@agentclientprotocol/sdk", "diff", "zod"]),
});
await writeFile(
  path.join(root, "enabled.json"),
  JSON.stringify({ version: 1, enabled: ["cursor-cli"] }, null, 2) + "\n",
);
console.log(JSON.stringify({ id: audit.id, root, runtimePackages: audit.runtimePackages }));
