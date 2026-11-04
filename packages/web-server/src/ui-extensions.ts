/** Persistent Web extension ownership; package code is never imported by this module. */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import {
  webUiExtensionSchema,
  webUiExtensionRegistrySchema,
  type WebUiExtension,
  type WebUiExtensionsState,
} from "@codexhost/shared-contracts";
import type { DataDir } from "./store.ts";
import {
  extensionInstallSpec,
  installExtensionPackage,
  OFFICIAL_NPM_REGISTRY,
} from "./ui-extension-install.ts";

const FILE = "ui-extensions/installed.json";
const entrySchema = webUiExtensionSchema
  .omit({ loadError: true })
  .extend({ installId: z.string().uuid() })
  .strict();
const storeSchema = z
  .object({ version: z.literal(1), extensions: z.array(entrySchema).max(64) })
  .strict();
type Entry = z.infer<typeof entrySchema>;

export interface ExternalUiPlugin {
  readonly id: string;
  readonly directory: string;
}
export interface WebUiExtensionsOptions {
  readonly safeMode?: boolean;
  readonly installPackage?: (directory: string, spec: string, registry: string) => Promise<void>;
  /** Pure asset validation against the actual built-in set; never evaluates plugin JavaScript. */
  readonly validate: (plugins: readonly ExternalUiPlugin[]) => void;
}

export class WebUiExtensions {
  private entries: Entry[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private loadedIds: string[] = [];
  private loadErrors = new Map<string, string>();
  private storeError?: string;

  constructor(
    private readonly data: DataDir,
    private readonly options: WebUiExtensionsOptions,
  ) {
    if (!existsSync(data.path(FILE))) return;
    try {
      this.entries = storeSchema.parse(
        JSON.parse(readFileSync(data.path(FILE), "utf8")),
      ).extensions;
      if (new Set(this.entries.map((entry) => entry.id)).size !== this.entries.length)
        throw new Error("Duplicate extension identity");
    } catch {
      this.entries = [];
      this.storeError =
        "The extension registry is invalid. Restore ui-extensions/installed.json before making changes.";
    }
  }

  state(): WebUiExtensionsState {
    return {
      extensions: this.entries.map((entry): WebUiExtension => {
        const loadError = this.loadErrors.get(entry.id);
        return {
          ...webUiExtensionSchema.parse(entry),
          ...(loadError === undefined ? {} : { loadError }),
        };
      }),
      loadedIds: [...this.loadedIds],
      safeMode: this.options.safeMode === true,
      ...(this.storeError ? { storeError: this.storeError } : {}),
    };
  }

  plugins(enabledOnly = true): ExternalUiPlugin[] {
    return this.entries
      .filter((entry) => !enabledOnly || entry.enabledTargets.includes("web"))
      .map((entry) => this.plugin(entry));
  }

  composed(ids: readonly string[], error?: string): void {
    this.loadedIds = [...ids];
    this.loadErrors.clear();
    if (error)
      for (const entry of this.entries) {
        if (entry.enabledTargets.includes("web")) this.loadErrors.set(entry.id, error);
      }
  }

  install(input: string, registry = OFFICIAL_NPM_REGISTRY): Promise<WebUiExtensionsState> {
    return this.mutate(async () => {
      if (this.entries.length >= 64) throw new Error("At most 64 Web extensions may be installed.");
      const parsed = await extensionInstallSpec(input);
      const selectedRegistry = webUiExtensionRegistrySchema.parse(registry);
      const packages = this.data.path("ui-extensions", "packages");
      await mkdir(packages, { recursive: true });
      const stage = await mkdtemp(join(packages, ".install-"));
      const installId = randomUUID();
      const destination = join(packages, installId);
      let published = false;
      try {
        await (this.options.installPackage ?? installExtensionPackage)(
          stage,
          parsed.installSpec ?? parsed.spec,
          selectedRegistry,
        );
        const root = JSON.parse(await readFile(join(stage, "package.json"), "utf8")) as {
          dependencies?: Record<string, string>;
        };
        const names = Object.keys(root.dependencies ?? {});
        const [name] = names;
        if (names.length !== 1 || name === undefined)
          throw new Error("Installation must contain one direct package.");
        // Validate package identity before using it as a path.
        const identity = webUiExtensionSchema.shape.id.parse(name);
        const directory = join(stage, "node_modules", identity);
        const path = relative(await realpath(stage), await realpath(directory));
        if (path === ".." || path.startsWith(`..${sep}`))
          throw new Error("Installed package escapes its directory.");
        const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
          name?: unknown;
          version?: unknown;
        };
        if (manifest.name !== identity || typeof manifest.version !== "string" || !manifest.version)
          throw new Error("Installed package identity is invalid.");
        if (
          parsed.expected &&
          (identity !== parsed.expected.name ||
            (parsed.expected.version !== undefined && manifest.version !== parsed.expected.version))
        )
          throw new Error(
            "Installed package does not match the requested package identity or version.",
          );
        if (this.entries.some((entry) => entry.id === identity))
          throw new Error(
            "This extension is already installed. Remove it before installing another version.",
          );
        this.options.validate([...this.plugins(), { id: identity, directory }]);
        const entry: Entry = entrySchema.parse({
          id: identity,
          name: identity,
          version: manifest.version,
          format: "dsh",
          supportedTargets: ["web"],
          enabledTargets: [],
          source: parsed.spec,
          installedAt: new Date().toISOString(),
          installId,
        });
        await rename(stage, destination);
        const next = [...this.entries, entry];
        this.save(next);
        published = true;
        return this.state();
      } finally {
        await rm(stage, { recursive: true, force: true });
        if (!published) await rm(destination, { recursive: true, force: true });
      }
    });
  }

  setEnabled(id: string, enabled: boolean): Promise<WebUiExtensionsState> {
    return this.mutate(async () => {
      const entry = this.find(id);
      const next = this.entries.map((item) =>
        item === entry ? { ...item, enabledTargets: enabled ? ["web" as const] : [] } : item,
      );
      // Disabling a broken plugin must remain possible even when another plugin is broken.
      if (enabled)
        this.options.validate(
          next
            .filter((item) => item.enabledTargets.includes("web"))
            .map((item) => this.plugin(item)),
        );
      this.save(next);
      return this.state();
    });
  }

  remove(id: string): Promise<WebUiExtensionsState> {
    return this.mutate(async () => {
      const entry = this.find(id);
      this.save(this.entries.filter((item) => item !== entry));
      await rm(this.data.path("ui-extensions", "packages", entry.installId), {
        recursive: true,
        force: true,
      });
      return this.state();
    });
  }

  private plugin(entry: Entry): ExternalUiPlugin {
    return {
      id: entry.id,
      directory: this.data.path(
        "ui-extensions",
        "packages",
        entry.installId,
        "node_modules",
        entry.id,
      ),
    };
  }

  private find(id: string): Entry {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) throw new Error("Extension is not installed.");
    return entry;
  }

  private save(entries: Entry[]): void {
    this.data.writeJson(FILE, { version: 1, extensions: entries });
    this.entries = entries;
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      if (this.storeError) throw new Error(this.storeError);
      return operation();
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
}
