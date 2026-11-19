/** Emit shared Web framework packages beside the server, so installed plugins use the same instances. */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { WEB_RUNTIME_PACKAGES } from "@codexhost/dsh-web-backend/plugin-resolution";

export { WEB_RUNTIME_PACKAGES } from "@codexhost/dsh-web-backend/plugin-resolution";

/** Compile imported TypeScript once per shared package, keeping only its public Node entry. */
export async function packWebRuntime(out: string): Promise<void> {
  const require = createRequire(import.meta.url);
  for (const name of WEB_RUNTIME_PACKAGES) {
    const manifestPath = require.resolve(`${name}/package.json`);
    const source = dirname(manifestPath);
    const pkg = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name: string;
      version: string;
      license?: string;
    };
    const directory = join(out, "node_modules", name);
    mkdirSync(directory, { recursive: true });
    await build({
      entryPoints: [fileURLToPath(import.meta.resolve(name))],
      outfile: join(directory, "index.js"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      external: [...WEB_RUNTIME_PACKAGES],
      banner: {
        js: 'import { createRequire as __require } from "node:module"; const require = __require(import.meta.url);',
      },
      logLevel: "warning",
    });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify(
        {
          name: pkg.name,
          version: pkg.version,
          license: pkg.license,
          type: "module",
          exports: { ".": "./index.js", "./package.json": "./package.json" },
        },
        null,
        2,
      ) + "\n",
    );
    if (existsSync(join(source, "LICENSE")))
      cpSync(join(source, "LICENSE"), join(directory, "LICENSE"));
  }
}
