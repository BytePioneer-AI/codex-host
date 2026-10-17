/** An isolated plugin fixture: exercises Web plugin composition without the real Codex CLI. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FakeChHost } from "./ch-host.ts";

/** Models the real ownership contract when the fixture includes official Codex Threads. */
export class MixedChHost extends FakeChHost {
  override request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (
      method === "codexhost/thread/inspect" &&
      this.threads.get(String(params.threadId))?.modelProvider === "openai"
    ) {
      this.requests.push({ method, params: structuredClone(params) });
      return Promise.resolve({ owner: "codex", locked: true } as T);
    }
    return super.request<T>(method, params);
  }
}

export function writeWebCodexPlugin(root: string): string {
  const plugins = join(root, "plugins");
  const plugin = join(plugins, "codex");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(
    join(plugin, "manifest.json"),
    JSON.stringify({
      manifestVersion: 1,
      id: "codex",
      name: "Web Codex",
      version: "0.0.0",
      adapterApiVersion: 1,
      entry: "./plugin.mjs",
      icon: "./icon.svg",
    }),
  );
  writeFileSync(
    join(plugin, "icon.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#4466aa"/></svg>',
  );
  const factory = pathToFileURL(resolve(import.meta.dirname, "../fake-harness/fake/plugin.ts"));
  writeFileSync(
    join(plugin, "plugin.mjs"),
    `import { createHarnessAdapter as create } from ${JSON.stringify(factory.href)};
export function createHarnessAdapter() { return create({ harnessId: "codex", modelId: "codex-model", modelLabel: "Codex Model" }); }
`,
  );
  return plugins;
}
