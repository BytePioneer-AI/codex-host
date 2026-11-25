/**
 * Web boot kernel. It owns only the module system, Cordis loader, and a
 * framework-free boot page; plugin composition and the renderer handoff are
 * `bootClient` and `mountClient`. Built-in core entries mount the UI first;
 * optional external DSH plugins and the Web native extension host load after
 * mount with full failure isolation so a broken extension never white-screens.
 * @module @deepseek-ai/dsh-client-web/src/boot
 */
import { Context } from "@deepseek-ai/cordis";
import type {
  BootManifest,
  ClientModuleCreateOptions,
  ClientModuleSystem,
  DshWindow,
} from "@deepseek-ai/dsh-client-modules/client";
import {
  startWebNativeExtensionHost,
  type WebNativeExtensionHostHandle,
} from "@deepseek-ai/dsh-client-ui-codexhost/src/client/native-extensions/index.ts";
import { bootClient, partitionBootManifest } from "./boot-client.ts";
import { BootPage } from "./boot-page.ts";
import { PwaInstall } from "./pwa-install.ts";
import { preventIosFocusZoom } from "./ios-focus-zoom.ts";
import { guardIosComposerPageScroll } from "./ios-composer-scroll.ts";
import { mountClient } from "./mount.ts";
import { getStaticModules } from "./seed.ts";
import { installWindowDragRecall } from "./window-drag/recall.ts";
import "./base.css";

/** Module transport hook replaced by jsdom tests. */
export type BootSeams = Pick<ClientModuleCreateOptions, "loadBundle">;

/** Whether `?extensions=off` disabled all optional extensions for this page load. */
export function areExtensionsDisabled(browser: Window | null | undefined): boolean {
  const search = browser?.location?.search;
  if (typeof search !== "string" || search.length === 0) return false;
  return new URLSearchParams(search).get("extensions")?.toLowerCase() === "off";
}

/** Browser boot entry consumed by `apps/web`. */
export class AppWebEntry {
  private readonly container: HTMLElement;
  private readonly seams: BootSeams | undefined;
  private readonly page: BootPage;
  private readonly pwaInstall: PwaInstall | undefined;
  private ctx: Context | undefined;
  private stopDragRecall: (() => void) | undefined;
  private nativeExtensions: WebNativeExtensionHostHandle | undefined;
  private disposed = false;
  private modules!: ClientModuleSystem;
  private manifest!: BootManifest;

  /**
   * Draw the boot page; {@link run} starts the loader.
   * @param container - Application mount point.
   * @param seams - Optional module transport replacement.
   */
  constructor(container: HTMLElement, seams?: BootSeams) {
    this.container = container;
    this.seams = seams;
    const browser = container.ownerDocument.defaultView;
    if (
      browser !== null &&
      !("dshDesktop" in browser) &&
      !("dshDesktopBoot" in browser) &&
      /^https?:$/u.test(browser.location.protocol)
    ) {
      this.pwaInstall = new PwaInstall(browser);
    }
    preventIosFocusZoom();
    guardIosComposerPageScroll();
    this.page = new BootPage(container);
  }

  /**
   * Load and activate built-in core entries, hand the mount point to the UI
   * renderer, then asynchronously activate optional external DSH plugins and
   * the Web native extension host unless `?extensions=off` is active.
   * @param onFailure - Optional carrier-owned fatal presentation; keeps the boot page visible.
   * @returns Resolves after application mount or failure reporting.
   */
  async run(onFailure?: (reason: unknown) => void): Promise<void> {
    try {
      // Boot-readiness gate: whichever bootstrap applies the injection table
      // settles this deferred once every row has taken effect — the served
      // index resolves it in the rendered tail, so the await returns on the
      // next microtask; an asynchronous bootstrap resolves it after its last
      // row, or rejects it into the failure rendering below. An absent global
      // means no bootstrap owns the document and there is nothing to wait for.
      await (globalThis as { __DSH_BOOT_READY__?: { promise: Promise<void> } }).__DSH_BOOT_READY__
        ?.promise;
      const win = globalThis as DshWindow;
      const moduleLoader = win.__ModuleLoader__;
      if (moduleLoader === undefined) {
        throw new Error("web boot: window.__ModuleLoader__ bootstrap facade is missing");
      }
      // A pre-injected transport (the worker preview page) owns bundle bytes;
      // its loadBundle is the default and explicit seams still win. The global
      // is `ClientTransportHooks`, owned by @deepseek-ai/dsh-client-connection;
      // this structural slice reads one optional member without adding a
      // package edge.
      const transport = (
        globalThis as {
          __DSH_TRANSPORT__?: { loadBundle?: ClientModuleCreateOptions["loadBundle"] };
        }
      ).__DSH_TRANSPORT__;
      this.modules = moduleLoader.create({
        boot: win.__DSH_BOOT__,
        staticModules: getStaticModules(),
        ...(transport?.loadBundle === undefined ? {} : { loadBundle: transport.loadBundle }),
        ...this.seams,
      });
      this.manifest = this.modules.manifest;

      const browser = this.container.ownerDocument.defaultView;
      const extensionsOff = areExtensionsDisabled(browser);
      const { core, external } = partitionBootManifest(this.manifest);

      const prefetching = this.prefetchImmediateTier(core);
      const ctx = new Context();
      this.ctx = ctx;
      if (this.pwaInstall !== undefined) ctx.provide("pwaInstall", this.pwaInstall);
      this.page.setTotal(core.plugins.length);
      await prefetching;
      await bootClient({
        ctx,
        modules: this.modules,
        manifest: core,
        onEntryState: (name, state) => {
          if (onFailure === undefined || state !== "failed") this.page.setState(name, state);
        },
      });
      // The shell owns the one watcher that keeps Electron's window drag rects in
      // step with the rows that own them (electron#32341), so no chrome row has to
      // know that trap. It installs before the first mount, so the surface the
      // renderer draws is the one the first frame measures.
      this.stopDragRecall = installWindowDragRecall({ document: this.container.ownerDocument });
      await mountClient(ctx, this.container);

      if (this.disposed || extensionsOff) return;

      // Built-in UI is mounted: load optional external DSH plugins in the background
      // with degraded logging so broken third-party bundles never white-screen the app.
      if (external.length > 0 && win.__DSH_BOOT__ !== undefined) {
        this.loadExternalDshExtensions(
          win.__DSH_BOOT__,
          external.map((row) => row.id),
        );
      }

      // Start the Web native extension host after the built-in UI is ready.
      this.nativeExtensions = startWebNativeExtensionHost({
        ctx,
        document: this.container.ownerDocument,
      });
    } catch (reason) {
      console.error(reason);
      if (onFailure !== undefined) onFailure(reason);
      else this.page.fail(reason instanceof Error ? reason.message : String(reason));
    }
  }

  /** Dispose the native extension host, client plugin tree, and boot page. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.nativeExtensions?.dispose();
    this.nativeExtensions = undefined;
    this.pwaInstall?.dispose();
    this.stopDragRecall?.();
    this.stopDragRecall = undefined;
    const ctx = this.ctx;
    this.ctx = undefined;
    if (ctx !== undefined) await ctx.fiber.dispose();
    this.page.dispose();
  }

  /** Prefetch stage-one core bundles and their dynamic requests before concurrent plugin imports. */
  private async prefetchImmediateTier(manifest: BootManifest): Promise<void> {
    await Promise.all(
      manifest.plugins
        .filter((row) => row.immediately)
        .map((row) =>
          this.modules.prefetch(row.id).catch((_prefetchError: unknown) => {
            // Prefetch only starts transport early; the Loader import retries and reports this bundle failure.
          }),
        ),
    );
  }

  /**
   * Reconcile optional external DSH plugins after built-in UI mount.
   * Failures are degraded and logged without disrupting the mounted application.
   */
  private loadExternalDshExtensions(rawGraph: unknown, externalIds: readonly string[]): void {
    if (this.modules.manifest.rev !== this.manifest.rev) return;
    const externalSet = new Set(externalIds);
    void this.modules.entries
      .sync(rawGraph)
      .then(() => {
        if (this.disposed) return;
        const failures = this.modules.entries.state
          .getSnapshot()
          .failures.filter((failure) => externalSet.has(failure.id));
        for (const failure of failures) {
          console.warn(
            `[web-boot] external DSH extension "${failure.id}" failed to load; continuing with built-in UI: ${failure.message}`,
          );
        }
      })
      .catch((error: unknown) => {
        if (this.disposed) return;
        console.warn(
          "[web-boot] external DSH extension loading failed; continuing with built-in UI",
          error,
        );
      });
  }
}
