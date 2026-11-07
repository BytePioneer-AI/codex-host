/** Provision an unchanged prebuilt package into a disposable test data directory. */
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function seedWebExtension(data: string, source: string): { id: string; directory: string } {
  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as {
    name: string;
    version: string;
  };
  const installId = randomUUID();
  const directory = join(data, "ui-extensions/packages", installId, "node_modules", manifest.name);
  mkdirSync(dirname(directory), { recursive: true });
  cpSync(source, directory, { recursive: true });
  const registry = join(data, "ui-extensions/installed.json");
  if (existsSync(registry)) throw new Error("Extension fixture requires a fresh registry");
  writeFileSync(
    registry,
    JSON.stringify({
      version: 1,
      extensions: [
        {
          id: manifest.name,
          name: manifest.name,
          version: manifest.version,
          format: "dsh",
          supportedTargets: ["web"],
          enabledTargets: ["web"],
          source,
          installedAt: new Date().toISOString(),
          installId,
        },
      ],
    }),
  );
  return { id: manifest.name, directory };
}
