import { isRendererSettingsIconName, type RendererSettingsIconName } from "./icons.js";

const SETTINGS_PAGE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const MAX_SETTINGS_PAGE_ID_LENGTH = 48;
const MAX_SETTINGS_PAGE_LABEL_LENGTH = 64;

export interface RendererSettingsAsyncHandlers<T> {
  success(value: T): void;
  failure(error: unknown): void;
}

export interface RendererSettingsPageMountContext {
  content: HTMLElement;
  signal: AbortSignal;
  runLatest<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    handlers: RendererSettingsAsyncHandlers<T>,
  ): Promise<void>;
}

export interface RendererSettingsPageDefinition {
  readonly id: string;
  readonly label: string;
  readonly icon: RendererSettingsIconName;
  mount(context: RendererSettingsPageMountContext): (() => void) | undefined;
}

export interface RendererSettingsPageRegistry {
  readonly pages: readonly RendererSettingsPageDefinition[];
  readonly defaultPageId: string;
  getPage(pageId: string): RendererSettingsPageDefinition | undefined;
}

function normalizedPage(
  page: RendererSettingsPageDefinition,
): Readonly<RendererSettingsPageDefinition> {
  if (
    page.id.length === 0 ||
    page.id.length > MAX_SETTINGS_PAGE_ID_LENGTH ||
    !SETTINGS_PAGE_ID_PATTERN.test(page.id)
  ) {
    throw new Error(`Invalid settings page ID: ${page.id || "(empty)"}`);
  }
  const label = page.label.trim();
  if (label.length === 0 || label.length > MAX_SETTINGS_PAGE_LABEL_LENGTH) {
    throw new Error(`Invalid settings page label for ${page.id}`);
  }
  if (!isRendererSettingsIconName(page.icon)) {
    throw new Error(`Unknown settings page icon for ${page.id}`);
  }
  if (typeof page.mount !== "function") {
    throw new Error(`Settings page ${page.id} has no mount function`);
  }
  return Object.freeze({ ...page, label });
}

export function createRendererSettingsPageRegistry(
  definitions: readonly RendererSettingsPageDefinition[],
  defaultPageId = "overview",
): RendererSettingsPageRegistry {
  if (definitions.length === 0) throw new Error("Settings page registry cannot be empty");
  const pages = definitions.map(normalizedPage);
  const byId = new Map<string, RendererSettingsPageDefinition>();
  for (const page of pages) {
    if (byId.has(page.id)) throw new Error(`Duplicate settings page ID: ${page.id}`);
    byId.set(page.id, page);
  }
  if (!byId.has(defaultPageId)) {
    throw new Error(`Default settings page is not registered: ${defaultPageId}`);
  }
  const frozenPages = Object.freeze([...pages]);
  return Object.freeze({
    pages: frozenPages,
    defaultPageId,
    getPage(pageId: string) {
      return byId.get(pageId);
    },
  });
}

export class RendererSettingsNavigationState {
  #activePageId: string;

  constructor(readonly registry: RendererSettingsPageRegistry) {
    this.#activePageId = registry.defaultPageId;
  }

  get activePageId(): string {
    return this.#activePageId;
  }

  select(pageId: string): boolean {
    if (!this.registry.getPage(pageId)) throw new Error(`Unknown settings page: ${pageId}`);
    if (this.#activePageId === pageId) return false;
    this.#activePageId = pageId;
    return true;
  }

  reset(): boolean {
    return this.select(this.registry.defaultPageId);
  }
}

export class RendererSettingsPageScope {
  readonly #pageController = new AbortController();
  #requestController: AbortController | null = null;
  #requestGeneration = 0;
  #disposed = false;

  get signal(): AbortSignal {
    return this.#pageController.signal;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  async runLatest<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    handlers: RendererSettingsAsyncHandlers<T>,
  ): Promise<void> {
    if (this.#disposed) throw new Error("Settings page scope is disposed");
    this.#requestController?.abort();
    const controller = new AbortController();
    this.#requestController = controller;
    const generation = ++this.#requestGeneration;
    const abortRequest = (): void => controller.abort();
    this.signal.addEventListener("abort", abortRequest, { once: true });
    try {
      const value = await operation(controller.signal);
      if (this.#isCurrent(controller, generation)) handlers.success(value);
    } catch (error) {
      if (this.#isCurrent(controller, generation)) handlers.failure(error);
    } finally {
      this.signal.removeEventListener("abort", abortRequest);
      if (this.#requestController === controller) this.#requestController = null;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#requestGeneration += 1;
    this.#requestController?.abort();
    this.#requestController = null;
    this.#pageController.abort();
  }

  #isCurrent(controller: AbortController, generation: number): boolean {
    return (
      !this.#disposed &&
      !controller.signal.aborted &&
      this.#requestController === controller &&
      this.#requestGeneration === generation
    );
  }
}
