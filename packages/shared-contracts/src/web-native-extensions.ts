import type { z } from "zod";
import type {
  desktopExtensionLocalizedTextSchema,
  DesktopExtensionDispose,
} from "./desktop-extensions.js";
import type { JsonObject, JsonValue } from "./json-value.js";

export const WEB_EXTENSION_REGIONS = [
  "app",
  "topbar",
  "sidebar",
  "conversation",
  "composer-dock",
] as const;
export type WebExtensionRegion = (typeof WEB_EXTENSION_REGIONS)[number];
export type WebExtensionDispose = DesktopExtensionDispose;
export type WebExtensionMount = {
  container: HTMLElement;
  dispose: () => void;
};
export interface WebExtensionActiveSession {
  readonly id: string;
  readonly title: string;
  readonly cwd: string | null;
  readonly workspaceId: string | null;
  readonly isBlank: boolean;
  readonly isRemote: boolean;
  readonly running: boolean;
}
export type WebExtensionRender = (
  container: HTMLElement,
  signal: AbortSignal,
  /* eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- Render may not need a disposer. */
) => void | WebExtensionDispose | Promise<void | WebExtensionDispose>;
export type WebExtensionContribution = {
  id: string;
  title: z.infer<typeof desktopExtensionLocalizedTextSchema>;
  render: WebExtensionRender;
};

export interface WebExtensionApi {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly apiVersion: 1;
  dom: {
    /** HTMLElement parent or a stable data-cx-region value. Returns undefined if absent. */
    mount(
      target: HTMLElement | WebExtensionRegion,
      position?: "append" | "prepend",
    ): WebExtensionMount | undefined;
    mark(target: Element, name: string): void;
    unmark(target: Element, name: string): void;
  };
  track(dispose: WebExtensionDispose): void;
  assets: { url(path: string): string };
  storage: {
    get(): Promise<JsonObject>;
    set(values: JsonObject): Promise<JsonObject>;
    onChange(listener: (values: JsonObject) => void): () => void;
  };
  backend: { invoke(method: string, params?: JsonValue): Promise<JsonValue> };
  session: {
    /** Current main-view session snapshot, or null when no session is active or a global main panel is shown. */
    getActive(): WebExtensionActiveSession | null;
    /** Subscribe to main-view active-session changes without replaying the initial snapshot. */
    onChange(listener: (session: WebExtensionActiveSession | null) => void): () => void;
  };
  tabIcon?: { set(pngDataUrl: string | null): void };
  settings: { registerPage(page: WebExtensionContribution): () => void };
  panels: {
    register(panel: WebExtensionContribution & { placement: "main" | "sidebar" }): () => void;
  };
}
export interface WebExtensionModule {
  /* eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- A CSS/DOM-only extension may not need a disposer. */
  activate(api: WebExtensionApi): void | WebExtensionDispose | Promise<void | WebExtensionDispose>;
}
