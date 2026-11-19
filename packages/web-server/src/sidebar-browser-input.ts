/** Editable hit areas let a touch viewer open its keyboard within the user's tap gesture. */
import type { Page } from "playwright-core";
import type { SidebarBrowserEditableRegion } from "@codexhost/shared-contracts/sidebar-browser";

/** Read geometry only, including child frames and open shadow roots, without reading field values. */
export async function sidebarBrowserEditableRegions(
  page: Page,
): Promise<SidebarBrowserEditableRegion[]> {
  const regions = await Promise.all(
    page.frames().map(async (frame): Promise<SidebarBrowserEditableRegion[]> => {
      try {
        const local = await frame.evaluate(() => {
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
        });
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
