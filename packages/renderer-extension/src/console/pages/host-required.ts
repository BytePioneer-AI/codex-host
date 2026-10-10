import { consolePost } from "../api.js";
import { button, h } from "../dom.js";
import type { ConsoleMessages } from "../messages.js";
import type { ConsoleState } from "../state.js";
import { createRendererSettingsIcon } from "../../settings/icons.js";
import type {
  RendererSettingsPageDefinition,
  RendererSettingsPageMountContext,
} from "../../settings/core.js";

function hostRequiredView(
  document: Document,
  messages: ConsoleMessages,
  state: ConsoleState,
): HTMLElement {
  const start = button(
    document,
    [createRendererSettingsIcon("play", 14), messages.start],
    () => {
      start.disabled = true;
      void consolePost("/api/launch")
        .catch(() => undefined)
        .finally(() => window.setTimeout(() => void state.refresh(), 4_000));
    },
    "primary",
  );
  const running = state.overview?.inspect?.runtime.running ?? false;
  const starting = state.overview?.summary.state === "starting";
  start.disabled = starting || running || !state.overview?.launchAvailable;
  return h(
    document,
    "div",
    { className: "console-empty" },
    h(
      document,
      "div",
      { className: "console-empty__icon" },
      createRendererSettingsIcon("unavailable", 22),
    ),
    h(
      document,
      "div",
      { className: "console-empty__title" },
      starting
        ? messages.startingTitle
        : running
          ? messages.hostUnreachableTitle
          : messages.hostRequiredTitle,
    ),
    h(
      document,
      "p",
      { className: "console-empty__body" },
      starting
        ? messages.startingDetail
        : running
          ? messages.hostUnreachableBody
          : messages.hostRequiredBody,
    ),
    running || starting ? null : start,
  );
}

/**
 * A settings page that needs the running Host. Without one it shows how to
 * start codexhost (or the offline fallback), and switches when the Host
 * appears or disappears.
 */
export function hostPage(
  definition: RendererSettingsPageDefinition,
  messages: ConsoleMessages,
  state: ConsoleState,
  offline?: RendererSettingsPageDefinition,
): RendererSettingsPageDefinition {
  return Object.freeze({
    id: definition.id,
    label: definition.label,
    icon: definition.icon,
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      let mountedFor: string | null = null;
      let cleanup: (() => void) | undefined;
      const unmount = (): void => {
        try {
          cleanup?.();
        } catch {
          // A contributed page cannot block console navigation.
        }
        cleanup = undefined;
      };
      const sync = (): void => {
        const available = state.overview?.hostAvailable ?? false;
        const starting = state.overview?.summary.state === "starting";
        const mode = available
          ? "available"
          : starting
            ? "starting"
            : state.overview?.inspect?.runtime.running
              ? "unreachable"
              : "offline";
        if (mode === mountedFor) return;
        mountedFor = mode;
        unmount();
        context.content.replaceChildren();
        if (available) {
          cleanup = definition.mount(context) ?? undefined;
        } else if (offline && !starting) {
          cleanup = offline.mount(context) ?? undefined;
        } else {
          context.content.append(
            h(document, "h1", { className: "settings-section-label" }, definition.label),
            hostRequiredView(document, messages, state),
          );
        }
      };
      sync();
      const unsubscribe = state.subscribe(sync);
      return () => {
        unsubscribe();
        unmount();
      };
    },
  });
}
