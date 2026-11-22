import type { SidebarBrowserClientMessage } from "@codexhost/shared-contracts/sidebar-browser";

export type SidebarBrowserInput = Extract<
  SidebarBrowserClientMessage,
  { type: "mouse" | "wheel" | "key" | "text" }
>;

export class SidebarBrowserInputBatcher<Viewer, Page> {
  /** Only the last queued job can accept more input; earlier jobs are sealed. */
  private tail: { viewer: Viewer; page: Page; message: SidebarBrowserInput } | undefined;

  /** Return a reader for a new job, or fold the input into the last job already queued. */
  enqueue(
    viewer: Viewer,
    page: Page,
    message: SidebarBrowserInput,
  ): (() => SidebarBrowserInput) | undefined {
    const tail = this.tail;
    if (tail !== undefined && tail.viewer === viewer && tail.page === page) {
      const combined = coalesce(tail.message, message);
      if (combined !== undefined) {
        tail.message = combined;
        return undefined;
      }
    }

    const job = { viewer, page, message };
    this.tail = message.type === "wheel" || isMove(message) ? job : undefined;
    return () => {
      if (this.tail === job) this.seal();
      return job.message;
    };
  }

  /** Stop extending the last job without removing it from the dispatch order. */
  seal(): void {
    this.tail = undefined;
  }
}

function isMove(message: SidebarBrowserInput): boolean {
  return message.type === "mouse" && message.action === "move";
}

function coalesce(
  previous: SidebarBrowserInput,
  next: SidebarBrowserInput,
): SidebarBrowserInput | undefined {
  if (isMove(previous) && isMove(next)) return next;
  if (
    previous.type === "wheel" &&
    next.type === "wheel" &&
    previous.x === next.x &&
    previous.y === next.y &&
    sameDirection(previous.deltaX, next.deltaX) &&
    sameDirection(previous.deltaY, next.deltaY)
  )
    return {
      ...previous,
      deltaX: previous.deltaX + next.deltaX,
      deltaY: previous.deltaY + next.deltaY,
    };
  return undefined;
}

function sameDirection(a: number, b: number): boolean {
  return a === 0 || b === 0 || Math.sign(a) === Math.sign(b);
}
