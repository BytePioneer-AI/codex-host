import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const rootOutputs = [
  "build",
  "coverage",
  "playwright-report",
  "target",
  "test-results",
  "tsconfig.tsbuildinfo",
];

async function removePackageOutputs(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);

  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory()) return;

      const entryPath = resolve(directory, entry.name);
      if (entry.name === "dist") {
        await rm(entryPath, { force: true, recursive: true });
        return;
      }

      await removePackageOutputs(entryPath);
    }),
  );
}

await Promise.all(
  rootOutputs.map((output) =>
    rm(resolve(repositoryRoot, output), { force: true, recursive: true }),
  ),
);
await removePackageOutputs(resolve(repositoryRoot, "packages"));
