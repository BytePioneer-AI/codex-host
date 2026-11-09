/** Native Loader lifetime for trusted Web extensions, below the existing backend context. */
import { Context, Service } from "@deepseek-ai/cordis";
import Loader, { EntryTree, Group, type Entry } from "@deepseek-ai/cordis-plugin-loader";
import * as ClientHmr from "@deepseek-ai/dsh-client-hmr";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import Include from "@codexhost/dsh-web-include";
import ClientModules from "@deepseek-ai/dsh-client-modules";
import WebServer from "@deepseek-ai/dsh-host-webserver";
import type { WebPluginRuntime, WebPluginRuntimeOptions, WebPluginResult } from "./plugin-types.ts";
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
    const releaseResolution = sharePluginRuntime([this.bundle.directory]);
    yield async () => {
      // Disposers may still import shared framework modules after awaiting work.
      // Cordis drains effects concurrently, so keep resolution until these fibers settle.
      const fibers = [...this.entries()].flatMap((entry) => (entry.fiber ? [entry.fiber] : []));
      this.root.stop();
      for (const fiber of fibers) while (fiber.inertia) await fiber.inertia;
      releaseResolution();
    };
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

/** Report native activation failures without inventing a second lifecycle. */
async function entryFailure(entry: Entry): Promise<string | undefined> {
  if (entry.disabled) return;
  const fiber = entry.fiber;
  if (fiber === undefined) return `${entry.id}: failed to import ${entry.options.name}`;
  try {
    await fiber.await();
  } catch (error) {
    return `${entry.id}: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (fiber.state === 2) return;
  const missing = Object.keys(fiber.inject).filter((name) => fiber.ctx.get(name) === undefined);
  return `${entry.id}: ${missing.length ? `missing services ${missing.join(", ")}` : "inactive plugin"}`;
}

/** Stable Loader, client graph and transport; installed package trees change independently. */
export async function mountWebPlugins(
  ctx: Context,
  options: WebPluginRuntimeOptions,
): Promise<WebPluginRuntime> {
  let scope!: Context;
  let events!: WebRoute["handler"];
  const lifetime = ctx.plugin(async (child: Context) => {
    scope = child;
    await child.plugin(Loader, { baseUrl: new URL(".", import.meta.url).href });
    const loader = child.get("loader") as Loader;
    loader.builtins["web-package"] = PackageTree;
    loader.builtins.include = PackageInclude;
    loader.builtins.group = Group;
    await child.plugin(WebServer, {
      address: options.address,
      ...(options.reserved === undefined ? {} : { reserved: options.reserved }),
    });
    // No second HTTP listener: the carrier serves this registry through its public API.
    await child.plugin(ClientModules, { sources: options.builtins, registerWeb: false });
    // Only the built-in transport receives this route port. User packages retain the
    // reserved-path WebServer above, including its /plugins protection.
    await child.isolate("webServer").plugin(async (transport: Context) => {
      transport.provide("webServer", {
        register(route: WebRoute) {
          events = route.handler;
          return () => {};
        },
      });
      await transport.plugin(ClientHmr);
    });
  });
  try {
    await lifetime;
    const clients = scope.get("clientModules") as ClientModules;
    const webServer = scope.get("webServer") as WebServer;
    const loader = scope.get("loader") as Loader;
    const remove = async (id: string): Promise<void> => {
      // Capture the first disposer call: Cordis's repeated dispose is a no-op,
      // not a second handle to asynchronous cleanup already in progress.
      const releasing = loader.store[id]?.fiber?.dispose();
      loader.remove(id);
      await releasing;
    };
    const update: WebPluginRuntime["update"] = async (packages, changedId) => {
      const desired = new Set(packages.map((pkg) => pkg.id));
      for (const id of Object.keys(loader.store)) {
        if (!desired.has(id)) await remove(id);
      }
      const result: WebPluginResult = { loadedIds: [], loadErrors: {} };
      const added = new Set<string>();
      // Existing entries are not updated: even a forced equal config update can
      // re-evaluate dependencies. Only newly selected installations are imported.
      for (const pkg of packages) {
        if (loader.store[pkg.id] !== undefined) continue;
        // A failed selection stays saved, but unrelated management operations
        // must not retry its code. An explicit enable can attempt it again.
        if (changedId !== undefined && changedId !== pkg.id) continue;
        try {
          const bundle = readWebPluginBundle(pkg);
          await loader.create({ id: pkg.id, name: "cordis:web-package", config: bundle });
          added.add(pkg.id);
        } catch (error) {
          result.loadErrors[pkg.id] = error instanceof Error ? error.message : String(error);
        }
      }
      await loader.await();
      for (const entry of Object.values(loader.store)) {
        const failures: string[] = [];
        for (const item of [entry, ...(entry.subtree?.entries() ?? [])]) {
          const failure = await entryFailure(item);
          if (failure !== undefined) failures.push(failure);
        }
        if (failures.length) {
          result.loadErrors[entry.id] = failures.join("\n");
          // Existing dependents stay owned by Loader while a provider is absent;
          // Cordis reactivates them when that service returns.
          if (added.has(entry.id)) await remove(entry.id);
        } else {
          result.loadedIds.push(entry.id);
        }
      }
      return result;
    };
    if (options.packages.length) {
      const result = await update(options.packages);
      if (Object.keys(result.loadErrors).length)
        throw new Error(Object.values(result.loadErrors).join("\n"));
    }
    return {
      clients,
      update,
      events: (req, res) => events(req, res),
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
