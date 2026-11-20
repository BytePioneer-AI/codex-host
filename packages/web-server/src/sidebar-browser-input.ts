/** Editable hit areas let a touch viewer open its keyboard within the user's tap gesture. */
import type { Page } from "playwright-core";
import type {
  SidebarBrowserEditableRegion,
  SidebarBrowserServerMessage,
} from "@codexhost/shared-contracts/sidebar-browser";

const EDITABLE_REFRESH_MS = 100;
export const EDITABLE_CHANGE_BINDING = "__codexhostEditableChanged";

type Editables = Extract<SidebarBrowserServerMessage, { type: "editable" }>;

/** Refreshes touch hit areas independently of the picture stream. */
export class SidebarBrowserEditables {
  private metadata: Editables = { type: "editable", generation: 0, regions: [] };
  private lastFrameGeneration = -1;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pictureTimer: ReturnType<typeof setTimeout> | undefined;
  private scanning = false;
  private dirty = false;

  constructor(
    private readonly source: () => { page: Page; ready: boolean } | undefined,
    private readonly send: (message: Editables) => void,
    private readonly snapshot: () => void,
    private readonly pictureDelay: number,
  ) {}

  get current(): Editables {
    return this.metadata;
  }

  frame(generation: number): void {
    this.lastFrameGeneration = generation;
  }

  /** A navigation, frame-tree change or viewport change invalidates the coordinate space. */
  invalidate(): void {
    clearTimeout(this.pictureTimer);
    this.pictureTimer = undefined;
    this.publish(this.metadata.generation + 1, []);
    this.refresh();
  }

  refresh(): void {
    this.dirty = true;
    this.resume();
  }

  /** Pick up a queued refresh when the cast is ready for the current viewport. */
  resume(): void {
    if (!this.dirty || this.scanning || this.timer !== undefined || this.source() === undefined)
      return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.scan();
    }, EDITABLE_REFRESH_MS);
  }

  pause(): void {
    clearTimeout(this.timer);
    clearTimeout(this.pictureTimer);
    this.timer = undefined;
    this.pictureTimer = undefined;
    this.dirty = false;
  }

  private async scan(): Promise<void> {
    const source = this.source();
    if (!source?.ready) return;
    this.dirty = false;
    this.scanning = true;
    const generation = this.metadata.generation;
    try {
      const regions = await sidebarBrowserEditableRegions(source.page);
      if (this.source()?.page !== source.page || this.metadata.generation !== generation) return;
      this.publish(generation, regions);
      // Prefer a natural repaint; a static page may need a picture for the new generation.
      if (
        regions.length > 0 &&
        this.lastFrameGeneration !== generation &&
        this.pictureTimer === undefined
      ) {
        this.pictureTimer = setTimeout(() => {
          this.pictureTimer = undefined;
          if (this.lastFrameGeneration !== generation) this.snapshot();
        }, this.pictureDelay);
      }
    } finally {
      this.scanning = false;
      this.resume();
    }
  }

  private publish(generation: number, regions: readonly SidebarBrowserEditableRegion[]): void {
    this.metadata = { type: "editable", generation, regions };
    this.send(this.metadata);
  }
}

/** Read geometry only, including child frames and open shadow roots, without reading field values. */
async function sidebarBrowserEditableRegions(page: Page): Promise<SidebarBrowserEditableRegion[]> {
  const regions = await Promise.all(
    page.frames().map(async (frame): Promise<SidebarBrowserEditableRegion[]> => {
      try {
        const local = await frame.evaluate(
          ({ binding, interval }) => {
            const scope = window as unknown as Record<string, unknown> & {
              __codexhostEditableObserver?: { watch(root: Document | ShadowRoot): void };
            };
            scope.__codexhostEditableObserver ??= (() => {
              const observed = new WeakSet<Document | ShadowRoot>();
              let last = -Infinity;
              let timer: ReturnType<typeof setTimeout> | undefined;
              const observer = {
                notify(): void {
                  timer = undefined;
                  last = performance.now();
                  const send = scope[binding] as () => Promise<void>;
                  void send().catch(() => undefined);
                },
                changed(): void {
                  if (timer !== undefined) return;
                  const wait = interval - (performance.now() - last);
                  if (wait > 0) timer = setTimeout(observer.notify, wait);
                  else observer.notify();
                },
                watch(root: Document | ShadowRoot): void {
                  if (observed.has(root)) return;
                  observed.add(root);
                  mutations.observe(root, {
                    subtree: true,
                    childList: true,
                    characterData: true,
                    attributes: true,
                    attributeFilter: [
                      "class",
                      "style",
                      "hidden",
                      "open",
                      "disabled",
                      "readonly",
                      "inert",
                      "type",
                      "inputmode",
                      "contenteditable",
                      "width",
                      "height",
                    ],
                  });
                  for (const event of ["scroll", "focusin", "focusout", "load"])
                    root.addEventListener(event, observer.changed, {
                      capture: true,
                      passive: true,
                    });
                },
              };
              const mutations = new MutationObserver(observer.changed);
              return observer;
            })();
            const regions: { x: number; y: number; width: number; height: number }[] = [];
            const textTypes = new Set([
              "text",
              "search",
              "email",
              "url",
              "tel",
              "password",
              "number",
            ]);
            const roots: (Document | ShadowRoot)[] = [document];
            for (const root of roots) {
              scope.__codexhostEditableObserver.watch(root);
              for (const element of root.querySelectorAll("*")) {
                if (element.shadowRoot !== null) roots.push(element.shadowRoot);
                if (!(element instanceof HTMLElement) || element.inputMode === "none") continue;
                const editable =
                  element instanceof HTMLInputElement
                    ? textTypes.has(element.type) &&
                      !element.readOnly &&
                      !element.matches(":disabled")
                    : element instanceof HTMLTextAreaElement
                      ? !element.readOnly && !element.matches(":disabled")
                      : element.isContentEditable && !element.parentElement?.isContentEditable;
                if (!editable || getComputedStyle(element).visibility !== "visible") continue;
                for (const rect of element.getClientRects()) {
                  const x = Math.max(0, rect.left);
                  const y = Math.max(0, rect.top);
                  const right = Math.min(innerWidth, rect.right);
                  const bottom = Math.min(innerHeight, rect.bottom);
                  if (right <= x || bottom <= y) continue;
                  // Ignore fields covered by another element or clipped out of a scroll container.
                  const hit = root.elementFromPoint((x + right) / 2, (y + bottom) / 2);
                  if (hit !== element && (hit === null || !element.contains(hit))) continue;
                  regions.push({ x, y, width: right - x, height: bottom - y });
                }
              }
            }
            return { regions, width: innerWidth, height: innerHeight };
          },
          { binding: EDITABLE_CHANGE_BINDING, interval: EDITABLE_REFRESH_MS },
        );
        if (frame === page.mainFrame()) return local.regions;
        const owner = await frame.frameElement();
        try {
          const box = await owner.boundingBox();
          if (box === null) return [];
          const metrics = await owner.evaluate((element) => ({
            width: (element as HTMLElement).offsetWidth,
            height: (element as HTMLElement).offsetHeight,
            left: (element as HTMLElement).clientLeft,
            top: (element as HTMLElement).clientTop,
            clientWidth: (element as HTMLElement).clientWidth,
            clientHeight: (element as HTMLElement).clientHeight,
          }));
          const sx = box.width / (metrics.width || 1);
          const sy = box.height / (metrics.height || 1);
          const scaleX = (metrics.clientWidth * sx) / (local.width || 1);
          const scaleY = (metrics.clientHeight * sy) / (local.height || 1);
          return local.regions.map((region) => ({
            x: box.x + metrics.left * sx + region.x * scaleX,
            y: box.y + metrics.top * sy + region.y * scaleY,
            width: region.width * scaleX,
            height: region.height * scaleY,
          }));
        } finally {
          await owner.dispose();
        }
      } catch {
        // A frame can navigate or detach while its picture is being streamed.
        return [];
      }
    }),
  );
  return regions.flat();
}
