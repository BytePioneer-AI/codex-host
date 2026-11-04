/** Native Loader lifetime for trusted Web extensions, below the existing backend context. */
import { Context, Service } from "@deepseek-ai/cordis";
import Loader, { EntryTree, Group, type EntryOptions } from "@deepseek-ai/cordis-plugin-loader";
import Include from "@codexhost/dsh-web-include";
import ClientModules from "@deepseek-ai/dsh-client-modules";
import WebServer from "@deepseek-ai/dsh-host-webserver";
import type { WebPluginRuntime, WebPluginRuntimeOptions } from "./plugin-types.ts";
import { resolve as resolveImport } from "import-meta-resolve";
import { pathToFileURL } from "node:url";
import { readWebPluginBundle, type WebPluginBundle } from "./plugin-bundles.ts";
import { sharePluginRuntime } from "./plugin-resolution.ts";

/** Per-installation entry ownership; patch files remain original, read-only package inputs. */
class PackageTree extends EntryTree {
  static inject = ["loader"];
  static readonly [Group.key] = true;
  constructor(
    ctx: Context,
    private readonly bundle: WebPluginBundle,
  ) {
    super(ctx);
    this.ctx.baseUrl = pathToFileURL(bundle.directory + "/").href;
  }
  override write(): void {}
  override import(name: string, getOuterStack?: () => string[]): unknown {
    if (this.bundle.clientOnly.has(name)) return { apply() {} };
    if (name.startsWith("cordis:")) return super.import(name, getOuterStack);
    return import(resolveImport(name, this.ctx.baseUrl!));
  }
  async *[Service.init]() {
    yield () => this.root.stop();
    await this.root.update(this.bundle.entries);
  }
}

class PackageInclude extends Include {
  override import(name: string, getOuterStack?: () => string[]): unknown {
    return name.startsWith("cordis:")
      ? super.import(name, getOuterStack)
      : import(resolveImport(name, this.ctx.baseUrl!));
  }
}

/** Mount once per Web startup. A failed user subtree never disposes the backend's core services. */
export async function mountWebPlugins(
  ctx: Context,
  options: WebPluginRuntimeOptions,
): Promise<WebPluginRuntime> {
  const bundles = options.packages.map(readWebPluginBundle);
  let scope!: Context;
  const lifetime = ctx.plugin(async (child: Context) => {
    scope = child;
    child.effect(
      () => sharePluginRuntime(bundles.map((bundle) => bundle.directory)),
      "Web plugin resolution",
    );
    await child.plugin(Loader, { baseUrl: new URL(".", import.meta.url).href });
    const loader = child.get("loader") as Loader;
    loader.builtins["web-package"] = PackageTree;
    loader.builtins.include = PackageInclude;
    loader.builtins.group = Group;
    await child.plugin(WebServer, {
      address: options.address,
      ...(options.reserved === undefined ? {} : { reserved: options.reserved }),
    });
    await loader.root.update(
      bundles.map((bundle): EntryOptions => ({
        id: bundle.id,
        name: "cordis:web-package",
        config: bundle,
      })),
    );
    await loader.await();
    const failures: string[] = [];
    for (const entry of loader.entries()) {
      if (entry.disabled) continue;
      const fiber = entry.fiber;
      if (fiber === undefined) {
        failures.push(`${entry.id}: failed to import ${entry.options.name}`);
      } else if (fiber.state === 0) {
        const missing = Object.keys(fiber.inject).filter(
          (name) => fiber.ctx.get(name) === undefined,
        );
        failures.push(`${entry.id}: missing services ${missing.join(", ")}`);
      } else if (fiber.state !== 2) {
        try {
          await fiber.await();
        } catch (error) {
          failures.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (fiber.state !== 3) failures.push(`${entry.id}: inactive plugin`);
      }
    }
    if (failures.length) throw new Error(failures.join("\n"));
    // No second HTTP route table: the carrier serves this registry through its public API.
    await child.plugin(ClientModules, { sources: options.builtins, registerWeb: false });
  });
  try {
    await lifetime;
    const clients = scope.get("clientModules") as ClientModules;
    const webServer = scope.get("webServer") as WebServer;
    return {
      clients,
      handle: (req, res) => webServer.handle(req, res),
      upgrade: (req, socket, head) => webServer.upgrade(req, socket, head),
      renderIndex: (html) => webServer.renderIndex(html),
      close: () => lifetime.dispose(),
    };
  } catch (error) {
    await lifetime.dispose();
    throw error;
  }
}
