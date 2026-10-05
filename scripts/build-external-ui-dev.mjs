import { execFile } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { build as esbuild } from "esbuild";

import { buildReleaseHostBundle } from "../packages/host-runtime/scripts/build-release.mjs";

const execute = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const buildRoot = path.join(repositoryRoot, "build");
const hostOutputDirectory = path.join(buildRoot, "external-ui");
const obsidianOutputDirectory = path.join(buildRoot, "obsidian-codexhost");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

async function run(command, arguments_, options = {}) {
  const result = await execute(command, arguments_, {
    cwd: repositoryRoot,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}
async function main() {
  await run(npmCommand, ["run", "build:typescript"]);

  await mkdir(hostOutputDirectory, { recursive: true });
  await buildReleaseHostBundle({
    repositoryRoot,
    outputPath: path.join(hostOutputDirectory, "host-runtime.mjs"),
  });

  const pluginOutput = path.join(hostOutputDirectory, "plugins");
  await rm(pluginOutput, { recursive: true, force: true });
  await cp(
    path.join(repositoryRoot, "packages/host-runtime/dist/plugins"),
    pluginOutput,
    { recursive: true },
  );

  await mkdir(obsidianOutputDirectory, { recursive: true });
  await esbuild({
    absWorkingDir: repositoryRoot,
    entryPoints: ["examples/obsidian-codexhost/src/main.ts"],
    outfile: path.join(obsidianOutputDirectory, "main.js"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["obsidian"],
    alias: {
      "@codexhost/client": path.join(repositoryRoot, "packages/client/src/index.ts"),
    },
  });
  for (const fileName of ["manifest.json", "styles.css"]) {
    await cp(
      path.join(repositoryRoot, "examples/obsidian-codexhost", fileName),
      path.join(obsidianOutputDirectory, fileName),
    );
  }

  process.stdout.write(
    [
      "External UI development artifacts are ready:",
      "  " + path.relative(repositoryRoot, path.join(hostOutputDirectory, "host-runtime.mjs")),
      "  " + path.relative(repositoryRoot, pluginOutput) + "/",
      "  " + path.relative(repositoryRoot, obsidianOutputDirectory) + "/",
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
