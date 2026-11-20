import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { desktopExtensionCatalogSchema } from "@codexhost/shared-contracts";

const root = path.resolve(import.meta.dirname, "..");
if (!process.argv[2] || process.argv.length !== 3)
  throw new Error("Usage: node tools/build-desktop-extension-seeds.mjs <asset-output-dir>");
const output = path.resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(path.join(tmpdir(), "codexhost-extension-seeds-"));
const generatedAt = "2026-01-01T00:00:00.000Z";
try {
  const extensions = [];
  for (const id of ["sidebar-delegation-badges", "sidebar-thread-tree"]) {
    execFileSync(
      process.execPath,
      ["tools/build-desktop-extension.mjs", `packages/desktop-extensions/${id}`, scratch],
      { cwd: root },
    );
    const directory = path.join(scratch, id);
    const files = (await readdir(directory, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map(({ parentPath, name }) => path.relative(directory, path.join(parentPath, name)))
      .sort();
    for (const file of files)
      await utimes(path.join(directory, file), new Date(generatedAt), new Date(generatedAt));
    const assetName = `${id}.zip`;
    const asset = path.join(output, assetName);
    await rm(asset, { force: true });
    execFileSync("zip", ["-X", "-0", "-q", asset, ...files], {
      cwd: directory,
      env: { ...process.env, TZ: "UTC" },
    });
    const { version, name, description, author, repository, details, categories, slots } =
      JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
    extensions.push({
      id,
      version,
      name,
      description,
      author,
      repository,
      details,
      categories,
      slots,
      trustTier: "official",
      downloadUrl: `https://github.com/BytePioneer-AI/codexhost-extensions-registry/releases/download/desktop-extensions-v1/${assetName}`,
      sha256: createHash("sha256")
        .update(await readFile(asset))
        .digest("hex"),
    });
  }
  console.log(
    JSON.stringify(
      desktopExtensionCatalogSchema.parse({ schemaVersion: 1, generatedAt, extensions }),
      null,
      2,
    ),
  );
} finally {
  await rm(scratch, { force: true, recursive: true });
}
