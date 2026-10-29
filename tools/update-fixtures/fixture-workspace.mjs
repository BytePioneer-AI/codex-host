import { copyFile, mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileDigest } from "../../scripts/release/windows/manifest.mjs";

// Reuse third-party installations, but never reuse the source tree's workspace
// junctions: package exports resolve to dist through their real package root.
export async function linkFixtureDependencies(repository, source, names) {
  const output = path.join(source, "node_modules");
  await mkdir(path.join(output, "@codexhost"), { recursive: true });
  for (const entry of await readdir(path.join(repository, "node_modules"), {
    withFileTypes: true,
  })) {
    if (entry.name === "@codexhost") continue;
    const from = path.join(repository, "node_modules", entry.name),
      to = path.join(output, entry.name);
    if (entry.isFile()) await copyFile(from, to);
    else await symlink(from, to, "junction");
  }
  const workspaces = [];
  for (const name of names.filter((n) =>
    /^packages\/(?:adapters\/)?[^/]+\/package.json$/u.test(n),
  )) {
    const directory = path.dirname(name);
    const { name: packageName } = JSON.parse(await readFile(path.join(source, name), "utf8"));
    if (!packageName?.startsWith("@codexhost/")) throw new Error(`Unexpected workspace ${name}`);
    const local = path.join(source, directory);
    await symlink(local, path.join(output, packageName), "junction");
    workspaces.push({
      name: packageName,
      realpath: await realpath(path.join(output, packageName)),
    });
  }
  return workspaces;
}
function inside(root, file) {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}
export async function assertFixtureInputs(source, workingDirectory, inputs) {
  const local = await realpath(source);
  const firstParty = [];
  for (const input of inputs) {
    const resolved = await realpath(path.resolve(workingDirectory, input));
    const normalized = resolved.replaceAll("\\", "/");
    if (normalized.includes("/packages/") && !normalized.includes("/node_modules/")) {
      if (!inside(local, resolved))
        throw new Error(`Runtime workspace input escaped fixture: ${resolved}`);
      firstParty.push({ path: path.relative(local, resolved), sha256: await fileDigest(resolved) });
    }
  }
  if (!firstParty.length) throw new Error("Runtime bundle has no audited workspace input");
  return firstParty;
}

/** Rebuild the actual payload files with the same release builders, retaining their input evidence. */
export async function auditFixturePayload(source, payloadRoot, workspaces) {
  const evidence = { workspaces, bundles: [] };
  for (const [script, exported, output] of [
    [
      "packages/host-runtime/scripts/build-release.mjs",
      "buildReleaseHostBundle",
      "host-runtime.mjs",
    ],
    [
      "packages/desktop-control/scripts/build-release.mjs",
      "buildDesktopControllerBundle",
      "desktop-controller.mjs",
    ],
    [
      "packages/console-server/scripts/build-release.mjs",
      "buildConsoleServerBundle",
      "console-server.mjs",
    ],
  ]) {
    const builder = await import(pathToFileURL(path.join(source, script)).href);
    const outputPath = path.join(payloadRoot, "app", output);
    const audit = await builder[exported]({ repositoryRoot: source, outputPath });
    evidence.bundles.push({
      output,
      sha256: await fileDigest(outputPath),
      inputs: await assertFixtureInputs(source, source, audit.inputs),
    });
  }
  const rendererRoot = path.join(source, "packages/renderer-extension");
  const { buildRendererBundles } = await import(
    pathToFileURL(path.join(rendererRoot, "scripts/build.mjs")).href
  );
  for (const audit of await buildRendererBundles({ packageRoot: rendererRoot })) {
    const output = {
      "dist/production.js": "renderer-extension.js",
      "dist/console.js": "console-web.js",
    }[audit.outfile];
    if (!output) continue;
    const outputPath = path.join(payloadRoot, "app", output);
    await copyFile(path.join(rendererRoot, audit.outfile), outputPath);
    evidence.bundles.push({
      output,
      sha256: await fileDigest(outputPath),
      inputs: await assertFixtureInputs(source, rendererRoot, audit.inputs),
    });
  }
  const { buildPreinstalledHarnessPlugins } = await import(
    pathToFileURL(path.join(source, "scripts/release/harness-plugins.mjs")).href
  );
  const plugins = await buildPreinstalledHarnessPlugins({
    repositoryRoot: source,
    outputDirectory: path.join(payloadRoot, "app/plugins"),
  });
  // Plugin input paths are relative to pluginRoot (the actual esbuild working directory).
  const { preinstalledHarnessPlugins } = await import(
    pathToFileURL(path.join(source, "scripts/release/harness-plugins.mjs")).href
  );
  for (const plugin of plugins) {
    const pluginRoot = preinstalledHarnessPlugins(source).plugins.find(
      (p) => p.manifest.id === plugin.id,
    ).pluginRoot;
    const output = `plugins/${plugin.id}/plugin.mjs`;
    evidence.bundles.push({
      output,
      sha256: await fileDigest(path.join(payloadRoot, "app", output)),
      inputs: await assertFixtureInputs(source, pluginRoot, plugin.inputs),
    });
  }
  // Not installed into the product and not an activation/readiness receipt.
  await writeFile(
    path.join(path.dirname(payloadRoot), "runtime-source-evidence.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  return evidence;
}
