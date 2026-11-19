import { pathToFileURL } from "node:url";
import { discoverMediaPathContract, mediaPathProbeExpression } from "./media-path-contract.mjs";

/** Read only an existing Renderer. Never install policies, reload, mount UI or submit a Turn. */
export async function inspectMediaPaths(client, documentUrl) {
  const page = new URL(documentUrl);
  const scripts = new Map();
  let changed = false;
  const removeReset = client.on("Debugger.globalObjectCleared", () => {
    changed = true;
  });
  const remove = client.on("Debugger.scriptParsed", (event) => {
    if (event.isModule !== true || event.hasSourceURL === true || typeof event.url !== "string")
      return;
    try {
      const url = new URL(event.url);
      if (
        url.protocol === page.protocol &&
        url.host === page.host &&
        url.pathname.endsWith(".js") &&
        !url.search &&
        !url.hash
      ) {
        if (scripts.size >= 1024 && !scripts.has(url.href)) changed = true;
        else scripts.set(url.href, event.scriptId);
      }
    } catch {
      /* Non-module source URLs are not native candidates. */
    }
  });
  try {
    await client.command("Debugger.enable");
    if (scripts.size === 0 || scripts.size > 1024)
      return { state: "unverified", reason: "loaded-module-catalog-unavailable" };
    const modules = [];
    for (const [url, scriptId] of scripts) {
      const { scriptSource } = await client.command("Debugger.getScriptSource", { scriptId });
      if (typeof scriptSource !== "string")
        return { state: "unverified", reason: "loaded-module-source-unavailable" };
      modules.push({ url, source: scriptSource });
    }
    const contract = discoverMediaPathContract(modules);
    if (!contract)
      return { state: "unverified", reason: "native-media-structure-missing-or-ambiguous" };
    if (changed) return { state: "unverified", reason: "renderer-changed-during-inspection" };
    const result = await client.command("Runtime.evaluate", {
      expression: mediaPathProbeExpression(contract),
      awaitPromise: true,
      returnByValue: true,
    });
    return changed ||
      result.exceptionDetails ||
      !["pass", "mismatch", "unverified"].includes(result.result?.value?.state)
      ? { state: "unverified", reason: "native-media-evaluation-unavailable" }
      : result.result.value;
  } catch {
    return { state: "unverified", reason: "native-media-inspection-unavailable" };
  } finally {
    remove();
    removeReset();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--endpoint")
    throw new Error(
      "usage: node tools/renderer-binding/media-path-probe.mjs --endpoint <loopback-http-url>",
    );
  const url = new URL(args[1]);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error("Media path probe requires a loopback HTTP endpoint");
  let client;
  try {
    const { CdpClient, waitForRendererTarget } =
      await import("../../packages/desktop-control/dist/index.js");
    const target = await waitForRendererTarget(url.href, { timeoutMs: 5_000 });
    client = await CdpClient.connect(target.webSocketDebuggerUrl);
    const result = await inspectMediaPaths(client, target.url);
    console.log(JSON.stringify(result));
    if (result.state === "mismatch") process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ state: "unverified", reason: "renderer-unavailable" }));
  } finally {
    client?.close();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
