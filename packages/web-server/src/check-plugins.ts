/** Validate the composed plugin set and print its boot graph summary. */
import { resolve } from "node:path";
import { WebAssets } from "./web-assets.ts";
import { CLIENT_GLOBALS, CLIENT_PLUGINS } from "./plugins.ts";

const assets = new WebAssets({
  repoRoot: resolve(import.meta.dirname, "../../../apps/web-ui"),
  plugins: CLIENT_PLUGINS,
  globals: CLIENT_GLOBALS,
  title: "CodexHost",
});
console.log(`entries: ${String(assets.graph.entries.length)}`);
for (const batch of assets.graph.batches)
  console.log(`${batch.phase}: ${String(batch.entries.length)}`);
