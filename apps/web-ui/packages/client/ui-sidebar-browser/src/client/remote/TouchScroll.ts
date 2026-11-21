import type { SidebarBrowserClientMessage } from "@codexhost/shared-contracts/sidebar-browser";

type Point = { readonly x: number; readonly y: number };
type Wheel = Extract<SidebarBrowserClientMessage, { type: "wheel" }>;
const TAP_SLOP = 8;

/** Translates one touch gesture to incremental wheel input. */
export class TouchScroll {
  private distance = 0;

  constructor(
    readonly id: number,
    private readonly origin: Point,
    private x: number,
    private y: number,
  ) {}

  get tapped(): boolean {
    return this.distance <= TAP_SLOP;
  }

  move(x: number, y: number): Wheel | undefined {
    const deltaX = this.x - x;
    const deltaY = this.y - y;
    this.x = x;
    this.y = y;
    this.distance += Math.hypot(deltaX, deltaY);
    return this.tapped ? undefined : { type: "wheel", ...this.origin, deltaX, deltaY };
  }
}
