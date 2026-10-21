import os from "node:os";
import path from "node:path";
import { realpath } from "node:fs/promises";
import {
  pluginResourcePath,
  readPluginConfiguration,
  readPluginFile,
} from "@codexhost/harness-plugin-files";
import {
  HARNESS_PLUGIN_MANIFEST_MAX_BYTES,
  SETTINGS_PLUGIN_HTML_MAX_BYTES,
  SETTINGS_PLUGIN_PAGE_LIMIT,
  settingsPluginManifestSchema,
  settingsPluginReadParamsSchema,
  type SettingsPluginListResult,
  type SettingsPluginReadParams,
} from "@codexhost/shared-contracts";

export class SettingsPlugins {
  readonly #root: string;
  constructor(environment: NodeJS.ProcessEnv) {
    this.#root = path.join(
      environment.CODEXHOST_DATA_DIR
        ? path.resolve(environment.CODEXHOST_DATA_DIR)
        : path.join(os.homedir(), ".codexhost"),
      "settings-plugins",
    );
  }

  async #installation(): Promise<{ root: string; enabled: string[] }> {
    try {
      const root = await realpath(this.#root);
      return { root, enabled: (await readPluginConfiguration(root)).enabled };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return { root: this.#root, enabled: [] };
      throw new Error("Could not read settings plugin configuration", { cause: error });
    }
  }

  async #manifest(root: string, id: string) {
    // 先按安装根校验，再按插件根校验资源，阻止插件目录和文件的符号链接越界。
    const file = await pluginResourcePath(root, `${id}/manifest.json`);
    await pluginResourcePath(path.join(root, id), "manifest.json");
    const manifest = settingsPluginManifestSchema.parse(
      JSON.parse((await readPluginFile(file, HARNESS_PLUGIN_MANIFEST_MAX_BYTES)).toString("utf8")),
    );
    if (manifest.id !== id)
      throw new Error("Settings plugin identity does not match its directory");
    return manifest;
  }

  async list(): Promise<SettingsPluginListResult> {
    const result: SettingsPluginListResult = { pages: [], unavailable: [] };
    const { root, enabled } = await this.#installation();
    for (const id of enabled) {
      try {
        const manifest = await this.#manifest(root, id);
        if (result.pages.length + manifest.pages.length > SETTINGS_PLUGIN_PAGE_LIMIT)
          throw new Error("Too many settings pages");
        result.pages.push(
          ...manifest.pages.map(({ id: pageId, title, icon }) => ({
            id: pageId,
            title,
            icon,
            pluginId: id,
          })),
        );
      } catch {
        result.unavailable.push(id);
      }
    }
    return result;
  }

  async read(input: SettingsPluginReadParams): Promise<{ html: string }> {
    const params = settingsPluginReadParamsSchema.parse(input);
    const { root, enabled } = await this.#installation();
    if (!enabled.includes(params.pluginId)) throw new Error("Settings plugin is disabled");
    const manifest = await this.#manifest(root, params.pluginId);
    const page = manifest.pages.find((page) => page.id === params.pageId);
    if (!page) throw new Error("Settings plugin page not found");
    const file = await pluginResourcePath(root, `${params.pluginId}/${page.entry}`);
    await pluginResourcePath(path.join(root, params.pluginId), page.entry);
    return { html: (await readPluginFile(file, SETTINGS_PLUGIN_HTML_MAX_BYTES)).toString("utf8") };
  }
}
