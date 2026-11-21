/**
 * Slot adapter for Web native extension contributions (settings pages and panels).
 *
 * Bridges plain `HTMLElement` + `AbortSignal` renderers into the existing `settings.section`,
 * `main`, and `sidebar.panellist` slots without requiring extensions to depend on React.
 */
import { createElement, useEffect, useRef, type ReactNode } from "react";
import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type { MainPanelId } from "@deepseek-ai/dsh-client-ui-layout/client";
import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type { WebExtensionContribution, WebExtensionDispose } from "@codexhost/shared-contracts";

/** Default navigation order placing extension contributions after built-in entries. */
const EXTENSION_CONTRIBUTION_ORDER = 100;

interface RegisteredContributionRecord {
  dispose: () => void;
}

/** Resolve localized extension text (`string` or `{ en, "zh-CN" }`) against the active locale. */
export function resolveContributionTitle(
  ctx: ClientContext,
  title: WebExtensionContribution["title"],
): string {
  if (typeof title === "string") return title;
  const active = ctx.get("locale")?.getLocale().active ?? "en";
  if (active.toLowerCase().startsWith("zh")) {
    return title["zh-CN"] || title.en;
  }
  return title.en;
}

function validateContribution(contribution: WebExtensionContribution, kind: string): void {
  if (
    !contribution ||
    typeof contribution !== "object" ||
    typeof contribution.id !== "string" ||
    contribution.id.trim().length === 0
  ) {
    throw new Error(`Web extension ${kind} contribution requires a non-empty string id`);
  }
  if (typeof contribution.render !== "function") {
    throw new Error(
      `Web extension ${kind} contribution "${contribution.id}" requires a render function`,
    );
  }
  const title = contribution.title;
  const validTitle =
    typeof title === "string" ||
    (typeof title === "object" &&
      title !== null &&
      typeof title.en === "string" &&
      typeof title["zh-CN"] === "string");
  if (!validTitle) {
    throw new Error(
      `Web extension ${kind} contribution "${contribution.id}" requires a valid title`,
    );
  }
}

function runDisposerSafely(
  extensionId: string,
  contributionId: string,
  disposer: WebExtensionDispose | undefined,
): void {
  if (typeof disposer !== "function") return;
  try {
    void Promise.resolve(disposer()).catch((error: unknown) => {
      console.error(
        `[web-native-extensions] contribution cleanup failed (${extensionId}/${contributionId})`,
        error,
      );
    });
  } catch (error) {
    console.error(
      `[web-native-extensions] contribution cleanup failed (${extensionId}/${contributionId})`,
      error,
    );
  }
}

/** Generic extension glyph used in `sidebar.panellist` for `placement: "main"` panels. */
function DefaultExtensionPanelIcon({ size }: PropsRuntime<"sidebar.panellist">): ReactNode {
  return createElement(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 16 16",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.4,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true,
    },
    createElement("rect", { x: 2.25, y: 2.25, width: 4.5, height: 4.5, rx: 1 }),
    createElement("rect", { x: 9.25, y: 2.25, width: 4.5, height: 4.5, rx: 1 }),
    createElement("rect", { x: 2.25, y: 9.25, width: 4.5, height: 4.5, rx: 1 }),
    createElement("rect", { x: 9.25, y: 9.25, width: 4.5, height: 4.5, rx: 1 }),
  );
}

interface ContributionHostOptions {
  extensionId: string;
  contributionId: string;
  kind: "settings" | "main" | "sidebar";
  render: WebExtensionContribution["render"];
  extensionSignal: AbortSignal;
  activeControllers: Set<AbortController>;
}

/**
 * Create a React component that owns a plain `HTMLElement` and per-mount `AbortSignal`,
 * isolating synchronous and asynchronous render failures and preventing stale async mounts.
 */
function createContributionComponent({
  extensionId,
  contributionId,
  kind,
  render,
  extensionSignal,
  activeControllers,
}: ContributionHostOptions): () => ReactNode {
  const inline = kind === "sidebar";
  return function WebExtensionContributionHost(): ReactNode {
    const containerRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
      const container = containerRef.current;
      if (container === null || extensionSignal.aborted) return;

      const controller = new AbortController();
      activeControllers.add(controller);
      let cleaned = false;
      let disposeFn: WebExtensionDispose | undefined;

      const teardown = (): void => {
        if (cleaned) return;
        cleaned = true;
        activeControllers.delete(controller);
        extensionSignal.removeEventListener("abort", onExtensionAbort);
        if (!controller.signal.aborted) controller.abort();
        const currentDispose = disposeFn;
        disposeFn = undefined;
        runDisposerSafely(extensionId, contributionId, currentDispose);
        container.replaceChildren();
      };

      const onExtensionAbort = (): void => {
        teardown();
      };
      extensionSignal.addEventListener("abort", onExtensionAbort, { once: true });

      container.replaceChildren();
      try {
        const result = render(container, controller.signal);
        if (
          result !== undefined &&
          result !== null &&
          typeof (result as PromiseLike<unknown>).then === "function"
        ) {
          void Promise.resolve(result).then(
            (resolved) => {
              if (cleaned || controller.signal.aborted || extensionSignal.aborted) {
                runDisposerSafely(
                  extensionId,
                  contributionId,
                  typeof resolved === "function" ? resolved : undefined,
                );
                container.replaceChildren();
                return;
              }
              if (typeof resolved === "function") {
                disposeFn = resolved;
              }
            },
            (error: unknown) => {
              console.error(
                `[web-native-extensions] contribution render failed (${extensionId}/${contributionId})`,
                error,
              );
            },
          );
        } else if (typeof result === "function") {
          if (cleaned || controller.signal.aborted || extensionSignal.aborted) {
            runDisposerSafely(extensionId, contributionId, result);
            container.replaceChildren();
          } else {
            disposeFn = result;
          }
        }
      } catch (error) {
        console.error(
          `[web-native-extensions] contribution render failed (${extensionId}/${contributionId})`,
          error,
        );
      }

      return teardown;
    }, []);

    return createElement("div", {
      ref: containerRef,
      "data-cx-web-ext-contribution": `${extensionId}:${contributionId}`,
      "data-cx-web-ext-id": extensionId,
      "data-cx-web-ext-kind": kind,
      style: inline
        ? { display: "inline-flex", alignItems: "center", justifyContent: "center" }
        : { width: "100%", height: "100%" },
    });
  };
}

/** Manages all slot-backed contributions owned by one extension activation generation. */
export class ExtensionContributionRegistry {
  private readonly settingsPages = new Map<string, RegisteredContributionRecord>();
  private readonly panels = new Map<string, RegisteredContributionRecord>();
  private readonly activeControllers = new Set<AbortController>();
  private disposed = false;

  constructor(
    private readonly ctx: ClientContext,
    private readonly extensionId: string,
    private readonly extensionSignal: AbortSignal,
  ) {}

  registerSettingsPage(page: WebExtensionContribution): () => void {
    this.guard();
    validateContribution(page, "settings page");

    const contributionId = page.id.trim();
    this.settingsPages.get(contributionId)?.dispose();

    const slotId = `cx-ext-settings:${this.extensionId}:${contributionId}`;
    const Component = createContributionComponent({
      extensionId: this.extensionId,
      contributionId,
      kind: "settings",
      render: page.render,
      extensionSignal: this.extensionSignal,
      activeControllers: this.activeControllers,
    });

    const slots = this.ctx.get("slots");
    if (slots === undefined) {
      throw new Error("Slot registry is unavailable");
    }

    const releaseInjection = slots.inject("settings.section", () =>
      slots.register(
        {
          name: "settings.section",
          id: slotId,
          order: EXTENSION_CONTRIBUTION_ORDER,
          label: () => resolveContributionTitle(this.ctx, page.title),
        },
        Component,
      ),
    );

    let released = false;
    const record: RegisteredContributionRecord = {
      dispose: () => {
        if (released) return;
        released = true;
        if (this.settingsPages.get(contributionId) === record) {
          this.settingsPages.delete(contributionId);
        }
        try {
          releaseInjection();
        } catch (error) {
          console.error(
            `[web-native-extensions] failed to unregister settings page (${this.extensionId}/${contributionId})`,
            error,
          );
        }
      },
    };
    this.settingsPages.set(contributionId, record);
    return record.dispose;
  }

  registerPanel(panel: WebExtensionContribution & { placement: "main" | "sidebar" }): () => void {
    this.guard();
    validateContribution(panel, "panel");
    if (panel.placement !== "main" && panel.placement !== "sidebar") {
      throw new Error(
        `Web extension panel "${panel.id}" has unsupported placement "${String(panel.placement)}"`,
      );
    }

    const contributionId = panel.id.trim();
    const key = `${panel.placement}:${contributionId}`;
    this.panels.get(key)?.dispose();

    const slots = this.ctx.get("slots");
    if (slots === undefined) {
      throw new Error("Slot registry is unavailable");
    }

    const panelId =
      `cx-ext-panel:${this.extensionId}:${panel.placement}:${contributionId}` as MainPanelId;
    const label = () => resolveContributionTitle(this.ctx, panel.title);
    const teardowns: Array<() => void> = [];

    if (panel.placement === "main") {
      const MainComponent = createContributionComponent({
        extensionId: this.extensionId,
        contributionId,
        kind: "main",
        render: panel.render,
        extensionSignal: this.extensionSignal,
        activeControllers: this.activeControllers,
      });
      teardowns.push(
        slots.inject("main", () =>
          slots.register(
            {
              name: "main",
              key: panelId,
            },
            MainComponent,
          ),
        ),
      );
      teardowns.push(
        slots.inject("sidebar.panellist", () =>
          slots.register(
            {
              name: "sidebar.panellist",
              id: panelId,
              order: EXTENSION_CONTRIBUTION_ORDER,
              label,
            },
            DefaultExtensionPanelIcon,
          ),
        ),
      );
    } else {
      const SidebarComponent = createContributionComponent({
        extensionId: this.extensionId,
        contributionId,
        kind: "sidebar",
        render: panel.render,
        extensionSignal: this.extensionSignal,
        activeControllers: this.activeControllers,
      });
      // Register a matching lightweight main panel so clicking the sidebar row never throws in layout.selectPanel.
      const SidebarMainFallback = (): ReactNode =>
        createElement("div", {
          "data-cx-web-ext-sidebar-fallback": `${this.extensionId}:${contributionId}`,
          style: { width: "100%", height: "100%" },
        });
      teardowns.push(
        slots.inject("main", () =>
          slots.register(
            {
              name: "main",
              key: panelId,
            },
            SidebarMainFallback,
          ),
        ),
      );
      teardowns.push(
        slots.inject("sidebar.panellist", () =>
          slots.register(
            {
              name: "sidebar.panellist",
              id: panelId,
              order: EXTENSION_CONTRIBUTION_ORDER,
              label,
            },
            SidebarComponent,
          ),
        ),
      );
    }

    let released = false;
    const record: RegisteredContributionRecord = {
      dispose: () => {
        if (released) return;
        released = true;
        if (this.panels.get(key) === record) {
          this.panels.delete(key);
        }
        for (const release of teardowns.splice(0).reverse()) {
          try {
            release();
          } catch (error) {
            console.error(
              `[web-native-extensions] failed to unregister panel (${this.extensionId}/${contributionId})`,
              error,
            );
          }
        }
      },
    };
    this.panels.set(key, record);
    return record.dispose;
  }

  abortAll(): void {
    for (const controller of [...this.activeControllers]) {
      if (!controller.signal.aborted) controller.abort();
    }
    this.activeControllers.clear();
  }

  disposeAll(): void {
    this.disposed = true;
    this.abortAll();
    for (const record of [...this.settingsPages.values()]) record.dispose();
    this.settingsPages.clear();
    for (const record of [...this.panels.values()]) record.dispose();
    this.panels.clear();
  }

  private guard(): void {
    if (this.disposed) throw new Error("Web extension is unloading");
    this.extensionSignal.throwIfAborted();
  }
}
